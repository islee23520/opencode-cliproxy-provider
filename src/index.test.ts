import { describe, expect, test } from "bun:test";
import { cliproxyAuthHook, plugin } from "./index";

type TestConfig = {
  provider: {
    cliproxy: {
      options: {
        baseURL: string;
        apiKey?: string;
      };
      models?: Record<string, Record<string, unknown>>;
    };
  };
  agent?: Record<string, { variant?: string }>;
};

type ChatParamsInput = {
  provider: {
    options: Record<string, unknown>;
    info: Record<string, unknown>;
    source: "config";
  };
  model: {
    providerID: string;
    modelID: string;
    id?: string;
    variant?: string;
  };
  agent: string;
  message: {
    variant?: string;
  };
  sessionID: string;
};

type ChatParamsOutput = {
  temperature: number;
  topP: number;
  topK: number;
  maxOutputTokens?: number;
  options: Record<string, unknown>;
};

function makeConfig(baseURL: string): TestConfig {
  return {
    provider: {
      cliproxy: {
        options: { baseURL },
      },
    },
  };
}

function makeChatInput(
  overrides: Partial<ChatParamsInput> = {}
): ChatParamsInput {
  return {
    provider: {
      source: "config",
      info: {},
      options: {},
    },
    model: {
      providerID: "cliproxy",
      modelID: "reasoning-model",
    },
    agent: "build",
    message: {},
    sessionID: "session-test",
    ...overrides,
  };
}

function makeChatOutput(): ChatParamsOutput {
  return {
    temperature: 0,
    topP: 1,
    topK: 0,
    maxOutputTokens: undefined,
    options: {},
  };
}

describe("OpenCode auth hook", () => {
  test("loads api auth into provider apiKey options", async () => {
    const options = await cliproxyAuthHook.loader?.(
      () =>
        Promise.resolve({
          type: "api",
          key: " sk-test ",
        }),
      {
        id: "cliproxy",
        name: "Cliproxy",
        source: "config",
        env: [],
        options: {},
        models: {},
      }
    );

    expect(options).toEqual({ apiKey: "sk-test" });
  });

  test("registers OpenCode native api key login method for cliproxy", () => {
    const method = cliproxyAuthHook.methods[0];

    expect(cliproxyAuthHook.provider).toBe("cliproxy");
    expect(method).toEqual({
      type: "api",
      label: "API key",
    });
  });
});

describe("OpenCode config hooks", () => {
  test("syncs discovered model metadata into the cliproxy provider config", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        Response.json({
          models: [
            {
              slug: "reasoning-model",
              display_name: "Reasoning Model",
              context_window: 131_072,
              max_output_tokens: 16_384,
              default_reasoning_level: "medium",
              supported_reasoning_levels: ["low", "medium", "high"],
            },
          ],
        }),
    });
    try {
      const hooks = await plugin({} as never);
      const config = makeConfig(`http://127.0.0.1:${upstream.port}/v1`);

      await hooks.config?.(config as never);

      expect(config.provider.cliproxy.models?.["reasoning-model"]).toEqual({
        name: "Reasoning Model",
        limit: {
          context: 131_072,
          output: 16_384,
        },
        reasoning: true,
        variants: {
          low: { reasoningEffort: "low", reasoning_effort: "low" },
          medium: { reasoningEffort: "medium", reasoning_effort: "medium" },
          high: { reasoningEffort: "high", reasoning_effort: "high" },
        },
        supported_reasoning_levels: ["low", "medium", "high"],
        options: {
          reasoningEffort: "medium",
          reasoning_effort: "medium",
        },
      });
    } finally {
      upstream.stop(true);
    }
  });

  test("resolves reasoning effort from agent, message variant, model variant, then model default", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        Response.json({
          models: [
            {
              slug: "reasoning-model",
              display_name: "Reasoning Model",
              default_reasoning_level: "medium",
              supported_reasoning_levels: ["low", "medium", "high"],
            },
          ],
        }),
    });
    try {
      const hooks = await plugin({} as never);
      const config = makeConfig(`http://127.0.0.1:${upstream.port}/v1`);
      config.agent = {
        build: { variant: "high" },
      };
      await hooks.config?.(config as never);

      const agentOutput = makeChatOutput();
      await hooks["chat.params"]?.(makeChatInput() as never, agentOutput as never);
      expect(agentOutput.options).toEqual({
        reasoningEffort: "high",
        reasoning_effort: "high",
      });

      const messageOutput = makeChatOutput();
      await hooks["chat.params"]?.(
        makeChatInput({ agent: "review", message: { variant: "low" } }) as never,
        messageOutput as never
      );
      expect(messageOutput.options).toEqual({
        reasoningEffort: "low",
        reasoning_effort: "low",
      });

      const modelVariantOutput = makeChatOutput();
      await hooks["chat.params"]?.(
        makeChatInput({
          agent: "review",
          model: {
            providerID: "cliproxy",
            modelID: "reasoning-model",
            variant: "high",
          },
        }) as never,
        modelVariantOutput as never
      );
      expect(modelVariantOutput.options).toEqual({
        reasoningEffort: "high",
        reasoning_effort: "high",
      });

      const defaultOutput = makeChatOutput();
      await hooks["chat.params"]?.(
        makeChatInput({ agent: "review" }) as never,
        defaultOutput as never
      );
      expect(defaultOutput.options).toEqual({
        reasoningEffort: "medium",
        reasoning_effort: "medium",
      });
    } finally {
      upstream.stop(true);
    }
  });

  test("skips unsupported reasoning efforts for discovered model levels", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        Response.json({
          models: [
            {
              slug: "reasoning-model",
              display_name: "Reasoning Model",
              supported_reasoning_levels: ["low", "medium"],
            },
          ],
        }),
    });
    try {
      const hooks = await plugin({} as never);
      const config = makeConfig(`http://127.0.0.1:${upstream.port}/v1`);
      await hooks.config?.(config as never);
      const output = makeChatOutput();

      await hooks["chat.params"]?.(
        makeChatInput({ message: { variant: "high" } }) as never,
        output as never
      );

      expect(output.options).toEqual({});
    } finally {
      upstream.stop(true);
    }
  });
});
