import { describe, expect, mock, spyOn, test } from "bun:test";
import { plugin } from "./index";

type TestConfig = {
  provider: {
    cliproxy: {
      options?: {
        baseURL?: string;
        apiKey?: string;
      };
      models?: Record<string, Record<string, unknown>>;
    };
  };
};

function makeConfigWithoutOptions(): TestConfig {
  return {
    provider: {
      cliproxy: {},
    },
  };
}

function makeConfig(baseURL: string): TestConfig {
  return {
    provider: {
      cliproxy: {
        options: { baseURL },
      },
    },
  };
}

describe("OpenCode adapter", () => {
  test("applies discovered model metadata and reasoning variants to provider config", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        Response.json({
          models: [
            {
              slug: "glm-4.5[1m]",
              display_name: "GLM 4.5 1M",
              max_output_tokens: 65_536,
            },
          ],
        }),
    });
    try {
      const hooks = await plugin({} as never);
      const config = makeConfig(`http://127.0.0.1:${upstream.port}/v1`);

      await hooks.config?.(config as never);

      expect(config.provider.cliproxy.models?.["glm-4.5[1m]"]).toEqual({
        name: "GLM 4.5 1M",
        limit: {
          context: 1_000_000,
          output: 65_536,
        },
        reasoning: true,
        variants: {
          low: { reasoningEffort: "low", reasoning_effort: "low" },
          medium: { reasoningEffort: "medium", reasoning_effort: "medium" },
          high: { reasoningEffort: "high", reasoning_effort: "high" },
          xhigh: { reasoningEffort: "xhigh", reasoning_effort: "xhigh" },
        },
        supported_reasoning_levels: ["low", "medium", "high", "xhigh"],
        options: {
          reasoningEffort: "high",
          reasoning_effort: "high",
        },
      });
    } finally {
      upstream.stop(true);
    }
  });

  test("uses default baseURL when provider options are missing", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        Response.json({
          data: [{ id: "gpt-5.5" }],
        }),
    });
    const oldBaseURL = process.env.CLIPROXY_BASE_URL;
    process.env.CLIPROXY_BASE_URL = `http://127.0.0.1:${upstream.port}/v1`;
    try {
      const hooks = await plugin({} as never);
      const config = makeConfigWithoutOptions();

      const configHook = hooks.config;
      expect(configHook).toBeDefined();
      if (configHook) {
        await configHook(config as never);
      }

      const routerBaseURL = config.provider.cliproxy.options?.baseURL;
      expect(routerBaseURL).toStartWith("http://127.0.0.1:");
      expect(routerBaseURL).not.toBe(`http://127.0.0.1:${upstream.port}/v1`);
      expect(config.provider.cliproxy.models?.["gpt-5.5"]).toEqual({
        name: "gpt-5.5",
      });
    } finally {
      if (oldBaseURL === undefined) {
        delete process.env.CLIPROXY_BASE_URL;
      } else {
        process.env.CLIPROXY_BASE_URL = oldBaseURL;
      }
      upstream.stop(true);
    }
  });

  test("routes configured OpenCode baseURL through an embedded responses-compatible router", async () => {
    let upstreamResponsesBody: unknown;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/v1/models") {
          return Response.json({
            data: [{ id: "google-antigravity/gemini-pro-agent" }],
          });
        }
        if (url.pathname === "/v1/responses") {
          upstreamResponsesBody = await request.json();
          return new Response(
            [
              'data: {"type":"response.output_text.delta","delta":"OK"}',
              "data: [DONE]",
              "",
            ].join("\n"),
            { headers: { "Content-Type": "text/event-stream" } }
          );
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    });
    try {
      const hooks = await plugin({} as never);
      const config = makeConfig(`http://127.0.0.1:${upstream.port}/v1`);

      await hooks.config?.(config as never);

      const routerBaseURL = config.provider.cliproxy.options?.baseURL;
      expect(routerBaseURL).toStartWith("http://127.0.0.1:");
      const response = await fetch(`${routerBaseURL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "google-antigravity/gemini-pro-agent",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        }),
      });

      expect(response.status).toBe(200);
      expect(upstreamResponsesBody).toEqual({
        model: "google-antigravity/gemini-pro-agent",
        input: [{ role: "user", content: "hello" }],
        stream: true,
      });
      expect(await response.text()).toContain('"object":"chat.completion.chunk"');
    } finally {
      upstream.stop(true);
    }
  });
});
