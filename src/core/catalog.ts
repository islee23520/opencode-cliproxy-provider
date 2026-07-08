import {
  inferReasoningMetadata,
  normalizeReasoningLevel,
  stripBracketedModelSuffix,
} from "./reasoning";

type CatalogModelInput = Record<string, unknown>;

export type CatalogModelVisibility = "visible" | "hidden";

export type CatalogCapabilities = {
  readonly image?: boolean;
  readonly media?: boolean;
  readonly nonReasoning?: boolean;
};

export type CatalogReasoning = {
  readonly supported: readonly string[];
  readonly default?: string;
};

export interface CatalogModel {
  readonly id: string;
  readonly name: string;
  readonly contextWindow?: number;
  readonly outputLimit?: number;
  readonly reasoning: CatalogReasoning;
  readonly serviceTiers: readonly string[];
  readonly visibility: CatalogModelVisibility;
  readonly capabilities: CatalogCapabilities;
  readonly description?: string;
  readonly deprecated?: boolean;
  readonly source?: string;
  readonly defaultReasoningLevel?: string;
  readonly supportedReasoningLevels: readonly string[];
}

interface ModelsResponse {
  readonly data?: readonly CatalogModelInput[];
}

interface CatalogModelsResponse {
  readonly models?: readonly CatalogModelInput[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function isSafeModelID(id: string): boolean {
  return id.trim().length > 0 && !/[\x00-\x1f\x7f\]]/.test(id.replace(/\[[^\]]*\]$/, ""));
}

function reasoningLevels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const levels = value
    .map((level) => normalizeReasoningLevel(isRecord(level) ? level.effort : level))
    .filter((level): level is string => Boolean(level));
  return Array.from(new Set(levels));
}

function positiveIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function serviceTierID(value: unknown): string | undefined {
  const tier = isRecord(value) ? value.id : value;
  if (typeof tier !== "string") {
    return;
  }
  const normalized = tier.trim().toLowerCase();
  return /^[a-z][a-z0-9_-]*$/.test(normalized) ? normalized : undefined;
}

function serviceTiers(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(value.map(serviceTierID).filter((tier): tier is string => Boolean(tier))));
}

function imageModelID(id: string): boolean {
  return /(^|[-_])image([-_]|$)/i.test(stripBracketedModelSuffix(id));
}

function mediaModelID(id: string): boolean {
  return /(^|[-_])(video|audio|media)([-_]|$)/i.test(stripBracketedModelSuffix(id));
}

function visibility(value: unknown, id: string): CatalogModelVisibility {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "hide" || normalized === "hidden") {
      return "hidden";
    }
  }
  return imageModelID(id) || mediaModelID(id) ? "hidden" : "visible";
}

function capabilities(model: CatalogModelInput, id: string, levels: readonly string[]): CatalogCapabilities {
  return {
    ...(imageModelID(id) ? { image: true } : {}),
    ...(mediaModelID(id) ? { media: true } : {}),
    ...(levels.length === 0 && model.supported_reasoning_levels !== undefined
      ? { nonReasoning: true }
      : {}),
  };
}

function reasoningForModel(id: string, suppliedLevels: readonly string[], defaultLevel: string | undefined): CatalogReasoning {
  const inferred = inferReasoningMetadata(id);
  const supported = suppliedLevels.length > 0 ? suppliedLevels : inferred.supportedReasoningLevels;
  const inferredDefault =
    inferred.defaultReasoningLevel && supported.includes(inferred.defaultReasoningLevel)
      ? inferred.defaultReasoningLevel
      : undefined;
  const resolvedDefault = inferredDefault ?? (defaultLevel && supported.includes(defaultLevel) ? defaultLevel : undefined);
  return {
    supported,
    ...(resolvedDefault ? { default: resolvedDefault } : {}),
  };
}

function catalogModel(model: CatalogModelInput, id: string, name: string): CatalogModel {
  const levels = reasoningLevels(model.supported_reasoning_levels);
  const reasoning = reasoningForModel(id, levels, normalizeReasoningLevel(model.default_reasoning_level));
  const inferred = inferReasoningMetadata(id);
  const description = stringValue(model.description);
  const source = stringValue(model.source);
  return {
    id,
    name,
    ...(positiveIntegerValue(model.context_window) ??
    positiveIntegerValue(model.max_context_window) ??
    positiveIntegerValue(model.max_model_len)
      ? {
          contextWindow:
            positiveIntegerValue(model.context_window) ??
            positiveIntegerValue(model.max_context_window) ??
            positiveIntegerValue(model.max_model_len),
        }
      : inferred.contextWindow
        ? { contextWindow: inferred.contextWindow }
        : {}),
    ...(positiveIntegerValue(model.max_output_tokens) ??
    positiveIntegerValue(model.output_token_limit) ??
    positiveIntegerValue(model.default_max_tokens)
      ? {
          outputLimit:
            positiveIntegerValue(model.max_output_tokens) ??
            positiveIntegerValue(model.output_token_limit) ??
            positiveIntegerValue(model.default_max_tokens),
        }
      : {}),
    reasoning,
    serviceTiers: serviceTiers(model.service_tiers),
    visibility: visibility(model.visibility, id),
    capabilities: capabilities(model, id, reasoning.supported),
    ...(description ? { description } : {}),
    ...(typeof model.deprecated === "boolean" ? { deprecated: model.deprecated } : {}),
    ...(source ? { source } : {}),
    ...(reasoning.default ? { defaultReasoningLevel: reasoning.default } : {}),
    supportedReasoningLevels: reasoning.supported,
  };
}

export function parseCatalogModels(data: unknown): CatalogModel[] {
  if (!isRecord(data) || !Array.isArray((data as CatalogModelsResponse).models)) {
    return [];
  }
  const discovered: CatalogModel[] = [];
  for (const model of (data as CatalogModelsResponse).models || []) {
    const id = stringValue(model.slug) ?? stringValue(model.id);
    if (!id || !isSafeModelID(id)) {
      continue;
    }
    discovered.push(catalogModel(model, id, stringValue(model.display_name) ?? id));
  }
  return discovered;
}

export function parseOpenAIModels(data: unknown): CatalogModel[] {
  if (!isRecord(data) || !Array.isArray((data as ModelsResponse).data)) {
    return [];
  }
  const discovered: CatalogModel[] = [];
  for (const model of (data as ModelsResponse).data || []) {
    const id = stringValue(model.id);
    if (!id || !isSafeModelID(id)) {
      continue;
    }
    discovered.push(catalogModel(model, id, id));
  }
  return discovered;
}
