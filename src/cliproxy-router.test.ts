import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createCliproxyRouterHandler } from "./cliproxy-router";

const GOOGLE_ANTIGRAVITY_MODELS = [
  "google-antigravity/gemini-3-flash-agent",
  "google-antigravity/gemini-3.1-pro-high",
  "google-antigravity/gemini-3.1-pro-low",
  "google-antigravity/gemini-3.1-pro-preview",
  "google-antigravity/gemini-3.5-flash-extra-low",
  "google-antigravity/gemini-3.5-flash-high",
  "google-antigravity/gemini-3.5-flash-low",
  "google-antigravity/gemini-3.5-flash-mid",
  "google-antigravity/gemini-pro-agent",
] as const;

describe("cliproxy router", () => {
  let upstream: ReturnType<typeof Bun.serve>;
  let router: ReturnType<typeof Bun.serve>;
  let upstreamChatBody: unknown;
  let upstreamResponsesBody: unknown;
  let genericForwardHeaders: Headers | undefined;

  beforeAll(() => {
    upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/v1/models" && url.searchParams.has("client_version")) {
          return Response.json({ models: [] });
        }
        if (url.pathname === "/v1/models") {
          return Response.json({
            data: [{ id: "glm-5.2[1m]" }, { id: "gpt-image-2" }],
          });
        }
        if (url.pathname === "/v1/chat/completions") {
          upstreamChatBody = await request.json();
          if (isGoogleAntigravityRequest(upstreamChatBody)) {
            return Response.json(
              {
                error: {
                  message: "Provider 'google-antigravity' does not support /v1/chat/completions",
                  type: "invalid_request_error",
                  code: "invalid_request_error",
                },
              },
              { status: 400 }
            );
          }
          return Response.json({
            id: "chatcmpl-test",
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
              },
            ],
          });
        }
        if (url.pathname === "/v1/responses") {
          upstreamResponsesBody = await request.json();
          if (isGoogleAntigravityRequest(upstreamResponsesBody)) {
            return new Response(
              [
                'data: {"type":"response.output_text.delta","delta":"OK"}',
                'data: {"type":"response.completed","response":{"id":"resp-test","model":"google-antigravity/gemini-pro-agent"}}',
                "data: [DONE]",
                "",
              ].join("\n"),
              {
                headers: { "Content-Type": "text/event-stream" },
              }
            );
          }
          genericForwardHeaders = new Headers(request.headers);
          return Response.json({ ok: true, query: url.search });
        }
        return new Response("not found", { status: 404 });
      },
    });

    router = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: createCliproxyRouterHandler({
        upstreamBaseURL: `http://127.0.0.1:${upstream.port}/v1`,
        apiKey: "router-secret",
      }),
    });
  });

  afterAll(() => {
    router.stop(true);
    upstream.stop(true);
  });

  test("advertises GLM reasoning metadata from a plain OpenAI models payload", async () => {
    const response = await fetch(`http://127.0.0.1:${router.port}/v1/models?client_version=opencode`);

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      readonly models: readonly {
        readonly slug: string;
        readonly supported_reasoning_levels?: readonly string[];
        readonly default_reasoning_level?: string;
        readonly context_window?: number;
      }[];
    };
    const glm = payload.models.find((model) => model.slug === "glm-5.2[1m]");

    expect(glm?.supported_reasoning_levels).toEqual(["low", "medium", "high", "xhigh"]);
    expect(glm?.default_reasoning_level).toBe("high");
    expect(glm?.context_window).toBe(1_000_000);
  });

  test("reports health with the configured upstream base URL", async () => {
    const response = await fetch(`http://127.0.0.1:${router.port}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      upstreamBaseURL: `http://127.0.0.1:${upstream.port}/v1`,
    });
  });

  test("returns plain OpenAI model shape without stripping catalog model IDs", async () => {
    const response = await fetch(`http://127.0.0.1:${router.port}/v1/models`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [
        { id: "glm-5.2[1m]", object: "model", owned_by: "cliproxy" },
        { id: "gpt-image-2", object: "model", owned_by: "cliproxy" },
      ],
    });
  });

  test("maps GLM xhigh reasoning to max and strips the 1M suffix on chat wire calls", async () => {
    const response = await fetch(`http://127.0.0.1:${router.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "glm-5.2[1m]",
        messages: [{ role: "user", content: "hello" }],
        reasoning_effort: "xhigh",
      }),
    });

    expect(response.status).toBe(200);
    expect(upstreamChatBody).toEqual({
      model: "glm-5.2",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "max",
    });
  });

  for (const model of GOOGLE_ANTIGRAVITY_MODELS) {
    test(`routes ${model} chat requests through responses and returns chat chunks`, async () => {
      const response = await fetch(`http://127.0.0.1:${router.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        }),
      });

      expect(response.status).toBe(200);
      expect(upstreamResponsesBody).toEqual({
        model,
        input: [{ role: "user", content: "hello" }],
        stream: true,
      });
      expect(await response.text()).toContain('"object":"chat.completion.chunk"');
    });
  }

  test("returns a non-streaming chat completion for google-antigravity requests without stream", async () => {
    const response = await fetch(`http://127.0.0.1:${router.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google-antigravity/gemini-pro-agent",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: expect.stringContaining("chatcmpl-"),
      object: "chat.completion",
      model: "google-antigravity/gemini-pro-agent",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "OK" },
          finish_reason: "stop",
        },
      ],
    });
  });

  test("forwards generic v1 requests with path, query, body, and router api key", async () => {
    const response = await fetch(`http://127.0.0.1:${router.port}/v1/responses?trace=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "glm-5.2[1m]", input: "hello" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, query: "?trace=1" });
    expect(genericForwardHeaders?.get("authorization")).toBe("Bearer router-secret");
  });
});

function isGoogleAntigravityRequest(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "model" in body &&
    typeof body.model === "string" &&
    body.model.startsWith("google-antigravity/")
  );
}
