import { describe, expect, test } from "bun:test";
import {
  fetchModels,
  inferModelMetadata,
  mapReasoningLevelForModel,
  stripBracketedModelSuffix,
} from "./models";

describe("GLM model metadata", () => {
  test("infers GLM 1M context and Codex-compatible reasoning levels", () => {
    expect(inferModelMetadata("glm-5.2[1m]")).toEqual({
      contextWindow: 1_000_000,
      defaultReasoningLevel: "high",
      supportedReasoningLevels: ["low", "medium", "high", "xhigh"],
    });
  });

  test("maps GLM xhigh to the provider max wire value", () => {
    expect(mapReasoningLevelForModel("glm-5.2", "low")).toBe("high");
    expect(mapReasoningLevelForModel("glm-5.2", "medium")).toBe("high");
    expect(mapReasoningLevelForModel("glm-5.2", "high")).toBe("high");
    expect(mapReasoningLevelForModel("glm-5.2", "xhigh")).toBe("max");
    expect(mapReasoningLevelForModel("glm-5.2[1m]", "medium")).toBe("high");
  });

  test("strips bracketed model suffixes only for OpenAI-compatible wire calls", () => {
    expect(stripBracketedModelSuffix("glm-5.2[1m]")).toBe("glm-5.2");
    expect(stripBracketedModelSuffix("gpt-5.5")).toBe("gpt-5.5");
  });

  test("promotes upstream GLM catalog defaults to high", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        Response.json({
          models: [
            {
              slug: "glm-5.2",
              display_name: "GLM 5.2",
              default_reasoning_level: "medium",
              supported_reasoning_levels: ["low", "medium", "high", "xhigh"],
            },
          ],
        }),
    });
    try {
      const models = await fetchModels(`http://127.0.0.1:${server.port}/v1`);

      expect(models[0]?.defaultReasoningLevel).toBe("high");
    } finally {
      server.stop(true);
    }
  });

  test("tries catalog discovery first and falls back to plain OpenAI models when catalog errors", async () => {
    const seenPaths: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        seenPaths.push(`${url.pathname}${url.search}`);
        if (url.searchParams.has("client_version")) {
          return new Response("catalog unavailable", { status: 503 });
        }
        return Response.json({
          data: [{ id: "plain-model", max_context_window: 8_192 }],
        });
      },
    });
    try {
      const models = await fetchModels(`http://127.0.0.1:${server.port}/v1`);

      expect(seenPaths).toEqual(["/v1/models?client_version", "/v1/models"]);
      expect(models).toEqual([
        {
          id: "plain-model",
          name: "plain-model",
          contextWindow: 8_192,
          reasoning: { supported: [] },
          serviceTiers: [],
          visibility: "visible",
          capabilities: {},
          supportedReasoningLevels: [],
        },
      ]);
    } finally {
      server.stop(true);
    }
  });

  test("falls back to plain OpenAI models when catalog discovery returns empty", async () => {
    const seenPaths: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        seenPaths.push(`${url.pathname}${url.search}`);
        if (url.searchParams.has("client_version")) {
          return Response.json({ models: [] });
        }
        return Response.json({ data: [{ id: "fallback-model" }] });
      },
    });
    try {
      const models = await fetchModels(`http://127.0.0.1:${server.port}/v1`);

      expect(seenPaths).toEqual(["/v1/models?client_version", "/v1/models"]);
      expect(models.map((model) => model.id)).toEqual(["fallback-model"]);
    } finally {
      server.stop(true);
    }
  });

  test("rejects unsafe model IDs from the plain OpenAI models fallback", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        if (url.searchParams.has("client_version")) {
          return Response.json({ models: [] });
        }
        return Response.json({
          data: [{ id: "safe-model" }, { id: "bad]id" }],
        });
      },
    });
    try {
      const models = await fetchModels(`http://127.0.0.1:${server.port}/v1`);

      expect(models.map((model) => model.id)).toEqual(["safe-model"]);
    } finally {
      server.stop(true);
    }
  });
});
