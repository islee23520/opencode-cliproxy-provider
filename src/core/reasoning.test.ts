import { describe, expect, test } from "bun:test";
import { parseCatalogModels } from "./catalog";
import {
  mapReasoningLevelForModel,
  normalizeWireRequest,
  stripBracketedModelSuffix,
} from "./reasoning";

describe("core reasoning", () => {
  test("maps GLM reasoning levels to provider wire values", () => {
    expect(mapReasoningLevelForModel("glm-5.2", "low")).toBe("high");
    expect(mapReasoningLevelForModel("glm-5.2", "medium")).toBe("high");
    expect(mapReasoningLevelForModel("glm-5.2", "high")).toBe("high");
    expect(mapReasoningLevelForModel("glm-5.2", "xhigh")).toBe("max");
  });

  test("passes non-GLM reasoning levels through unchanged", () => {
    expect(mapReasoningLevelForModel("gpt-5.5", "medium")).toBe("medium");
  });

  test("strips bracketed suffixes only when requested for wire use", () => {
    expect(stripBracketedModelSuffix("glm-5.2[1m]")).toBe("glm-5.2");
    expect(stripBracketedModelSuffix("gpt-5.5")).toBe("gpt-5.5");
  });

  test("ignores unsupported efforts for models with supported reasoning levels", () => {
    expect(mapReasoningLevelForModel("glm-5.2", "ultra")).toBeUndefined();
  });

  test("normalizes chat wire model and reasoning effort", () => {
    expect(normalizeWireRequest("glm-5.2[1m]", "xhigh")).toEqual({
      model: "glm-5.2",
      reasoningEffort: "max",
    });
  });

  test("preserves service-tier catalog metadata without applying it to wire", () => {
    const models = parseCatalogModels({
      models: [
        {
          slug: "glm-5.2[1m]",
          display_name: "GLM 5.2 1M",
          service_tiers: [{ id: "priority" }],
        },
      ],
    });

    expect(models[0]?.id).toBe("glm-5.2[1m]");
    expect(models[0]?.serviceTiers).toEqual(["priority"]);
    expect(normalizeWireRequest("glm-5.2[1m]", "medium")).toEqual({
      model: "glm-5.2",
      reasoningEffort: "high",
    });
  });
});
