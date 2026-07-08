import { fetchModels, modelsCatalogPayload } from "./models";
import { normalizeWireRequest } from "./reasoning";

const DEFAULT_UPSTREAM_BASE_URL = "http://127.0.0.1:8317/v1";

export interface CliproxyRouterOptions {
  readonly upstreamBaseURL?: string;
  readonly apiKey?: string;
}

function upstreamRoot(baseURL: string | undefined): string {
  return (baseURL || DEFAULT_UPSTREAM_BASE_URL).replace(/\/$/, "");
}

function forwardedHeaders(request: Request, apiKey: string | undefined): Headers {
  const headers = new Headers(request.headers);
  headers.delete("host");
  if (apiKey && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${apiKey}`);
  }
  return headers;
}

async function forwardRequest(
  request: Request,
  upstreamURL: string,
  apiKey: string | undefined,
  body: unknown
): Promise<Response> {
  return fetch(upstreamURL, {
    method: request.method,
    headers: forwardedHeaders(request, apiKey),
    body: JSON.stringify(body),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeChatBody(body: unknown): unknown {
  if (!isRecord(body) || typeof body.model !== "string") {
    return body;
  }
  const wire = normalizeWireRequest(
    body.model,
    typeof body.reasoning_effort === "string" ? body.reasoning_effort : undefined
  );
  return {
    ...body,
    model: wire.model,
    ...(wire.reasoningEffort ? { reasoning_effort: wire.reasoningEffort } : {}),
  };
}

function isGoogleAntigravityModel(model: string): boolean {
  return model.startsWith("google-antigravity/");
}

function responsesBodyFromChatBody(body: Record<string, unknown>): Record<string, unknown> {
  return {
    model: body.model,
    input: body.messages,
    stream: body.stream === true,
  };
}

function chatChunkLine(id: string, model: string, content: string): string {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: { content },
        finish_reason: null,
      },
    ],
  })}`;
}

function doneChatChunkLine(id: string, model: string): string {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  })}`;
}

function outputDeltaFromResponsesEvent(event: unknown): string | undefined {
  if (!isRecord(event) || event.type !== "response.output_text.delta") {
    return;
  }
  return typeof event.delta === "string" ? event.delta : undefined;
}

function outputTextFromResponsesSSE(text: string): string {
  let content = "";
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) {
      continue;
    }
    const data = line.slice("data: ".length);
    if (data === "[DONE]") {
      continue;
    }
    try {
      const delta = outputDeltaFromResponsesEvent(JSON.parse(data));
      if (delta !== undefined) {
        content += delta;
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        continue;
      }
      throw error;
    }
  }
  return content;
}

function chatSSEFromOutputText(content: string, model: string): string {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const lines: string[] = [];
  if (content) {
    lines.push(chatChunkLine(id, model, content));
  }
  lines.push(doneChatChunkLine(id, model));
  lines.push("data: [DONE]");
  return `${lines.join("\n\n")}\n\n`;
}

function chatCompletionFromOutputText(content: string, model: string): Response {
  return Response.json({
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
  });
}

async function forwardGoogleAntigravityChat(
  request: Request,
  root: string,
  apiKey: string | undefined,
  body: Record<string, unknown>
): Promise<Response> {
  const response = await forwardRequest(
    request,
    `${root}/responses`,
    apiKey,
    responsesBodyFromChatBody(body)
  );
  if (!response.ok) {
    return response;
  }
  const model = typeof body.model === "string" ? body.model : "google-antigravity";
  const content = outputTextFromResponsesSSE(await response.text());
  if (body.stream === true) {
    return new Response(chatSSEFromOutputText(content, model), {
      headers: { "Content-Type": "text/event-stream" },
    });
  }
  return chatCompletionFromOutputText(content, model);
}

export function createCliproxyRouterHandler(options: CliproxyRouterOptions = {}) {
  const root = upstreamRoot(options.upstreamBaseURL);
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ ok: true, upstreamBaseURL: root });
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      const models = await fetchModels(root, options.apiKey);
      if (url.searchParams.has("client_version")) {
        return Response.json(modelsCatalogPayload(models));
      }
      return Response.json({
        data: models.map((model) => ({
          id: model.id,
          object: "model",
          owned_by: "cliproxy",
        })),
      });
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      const rawBody = await request.json();
      if (
        isRecord(rawBody) &&
        typeof rawBody.model === "string" &&
        isGoogleAntigravityModel(rawBody.model)
      ) {
        return forwardGoogleAntigravityChat(request, root, options.apiKey, rawBody);
      }
      const body = normalizeChatBody(rawBody);
      return forwardRequest(
        request,
        `${root}/chat/completions`,
        options.apiKey,
        body
      );
    }
    if (url.pathname.startsWith("/v1/")) {
      const upstreamURL = `${root}${url.pathname.slice(3)}${url.search}`;
      return fetch(upstreamURL, {
        method: request.method,
        headers: forwardedHeaders(request, options.apiKey),
        body: request.body,
      });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
}

export function serveCliproxyRouter(options: CliproxyRouterOptions & {
  readonly hostname?: string;
  readonly port?: number;
} = {}): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    fetch: createCliproxyRouterHandler(options),
  });
}
