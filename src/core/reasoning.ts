export const GLM_REASONING_LEVELS = ["low", "medium", "high", "xhigh"] as const;

export const GLM_REASONING_WIRE_MAP: Readonly<Record<string, string>> = {
  none: "none",
  minimal: "none",
  low: "high",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
};

export type InferredReasoningMetadata = {
  readonly contextWindow?: number;
  readonly defaultReasoningLevel?: string;
  readonly supportedReasoningLevels: readonly string[];
};

export type WireRequestNormalization = {
  readonly model: string;
  readonly reasoningEffort?: string;
};

export function normalizeReasoningLevel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return;
  }
  const normalized = value.trim().toLowerCase();
  return /^[a-z][a-z0-9_-]*$/.test(normalized) ? normalized : undefined;
}

export function stripBracketedModelSuffix(modelID: string): string {
  return modelID.replace(/\[[^\]]*\]\s*$/, "");
}

function isGLMModel(id: string): boolean {
  return stripBracketedModelSuffix(id).toLowerCase().startsWith("glm-");
}

export function inferReasoningMetadata(
  modelID: string
): InferredReasoningMetadata {
  const contextWindow = /\[1m\]\s*$/i.test(modelID) ? 1_000_000 : undefined;
  if (isGLMModel(modelID)) {
    return {
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      defaultReasoningLevel: "high",
      supportedReasoningLevels: GLM_REASONING_LEVELS,
    };
  }
  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    supportedReasoningLevels: [],
  };
}

export function mapReasoningLevelForModel(
  modelID: string,
  effort: string | undefined
): string | undefined {
  if (!effort) {
    return;
  }
  const normalized = normalizeReasoningLevel(effort);
  if (!normalized) {
    return;
  }
  if (isGLMModel(modelID)) {
    return normalized in GLM_REASONING_WIRE_MAP
      ? GLM_REASONING_WIRE_MAP[normalized]
      : undefined;
  }
  return normalized;
}

export function normalizeWireRequest(
  model: string,
  reasoningEffort: string | undefined
): WireRequestNormalization {
  const mappedReasoningEffort = mapReasoningLevelForModel(model, reasoningEffort);
  return {
    model: stripBracketedModelSuffix(model),
    ...(mappedReasoningEffort ? { reasoningEffort: mappedReasoningEffort } : {}),
  };
}
