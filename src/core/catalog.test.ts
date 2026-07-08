import { describe, expect, test } from "bun:test";
import { parseCatalogModels, parseOpenAIModels } from "./catalog";

describe("Core catalog: normalize Cliproxy model metadata once for all hosts", () => {
  test("normalizes enriched models metadata into host-neutral catalog models", () => {
    const models = parseCatalogModels({
      models: [
        {
          slug: "gpt-5.5",
          display_name: "GPT 5.5",
          context_window: 400_000,
          max_output_tokens: 128_000,
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            { effort: "low", description: "Fast" },
            { effort: "medium" },
            "HIGH",
            "not valid",
          ],
          service_tiers: [{ id: "default" }, "priority", "bad tier"],
          description: "General purpose model",
          deprecated: true,
          source: "cliproxy-registry",
        },
      ],
    });

    expect(models).toEqual([
      {
        id: "gpt-5.5",
        name: "GPT 5.5",
        contextWindow: 400_000,
        outputLimit: 128_000,
        reasoning: {
          supported: ["low", "medium", "high"],
          default: "medium",
        },
        serviceTiers: ["default", "priority"],
        visibility: "visible",
        capabilities: {},
        description: "General purpose model",
        deprecated: true,
        source: "cliproxy-registry",
        defaultReasoningLevel: "medium",
        supportedReasoningLevels: ["low", "medium", "high"],
      },
    ]);
  });

  test("normalizes plain OpenAI data payload metadata", () => {
    const models = parseOpenAIModels({
      data: [
        {
          id: "plain-model",
          max_model_len: 65_536,
          output_token_limit: 8_192,
        },
      ],
    });

    expect(models).toEqual([
      {
        id: "plain-model",
        name: "plain-model",
        contextWindow: 65_536,
        outputLimit: 8_192,
        reasoning: { supported: [] },
        serviceTiers: [],
        visibility: "visible",
        capabilities: {},
        supportedReasoningLevels: [],
      },
    ]);
  });

  test("falls back cleanly when metadata is missing", () => {
    expect(parseCatalogModels({ models: [{ id: "minimal-model" }] })).toEqual([
      {
        id: "minimal-model",
        name: "minimal-model",
        reasoning: { supported: [] },
        serviceTiers: [],
        visibility: "visible",
        capabilities: {},
        supportedReasoningLevels: [],
      },
    ]);
  });

  test("promotes GLM catalog models to high default reasoning", () => {
    const models = parseCatalogModels({
      models: [
        {
          slug: "glm-5.2[1m]",
          default_reasoning_level: "medium",
          supported_reasoning_levels: ["low", "medium", "high", "xhigh"],
        },
      ],
    });

    expect(models[0]).toMatchObject({
      id: "glm-5.2[1m]",
      contextWindow: 1_000_000,
      reasoning: {
        supported: ["low", "medium", "high", "xhigh"],
        default: "high",
      },
      defaultReasoningLevel: "high",
    });
  });

  test("normalizes image and media visibility flags", () => {
    const models = parseCatalogModels({
      models: [
        { slug: "gpt-image-2", display_name: "Image", visibility: "hide" },
        { slug: "grok-imagine-video", display_name: "Video", visibility: "hidden" },
      ],
    });

    expect(models.map((model) => model.capabilities)).toEqual([
      { image: true },
      { media: true },
    ]);
    expect(models.map((model) => model.visibility)).toEqual(["hidden", "hidden"]);
  });

  test("rejects malformed IDs in enriched models and plain data payloads", () => {
    expect(
      parseCatalogModels({
        models: [{ slug: "safe-model" }, { slug: "bad]model" }, { id: "bad\nmodel" }],
      }).map((model) => model.id)
    ).toEqual(["safe-model"]);

    expect(
      parseOpenAIModels({
        data: [{ id: "plain-safe" }, { id: "plain]bad" }, { id: "plain\tbad" }],
      }).map((model) => model.id)
    ).toEqual(["plain-safe"]);
  });
});
