import {
  type CatalogModel,
  parseCatalogModels as parseCatalogPayloadModels,
  parseOpenAIModels as parseOpenAIPayloadModels,
} from "./catalog";
import { inferReasoningMetadata } from "./reasoning";

const FETCH_TIMEOUT_MS = 10_000;

export type { CatalogModel };
export {
  GLM_REASONING_LEVELS,
  GLM_REASONING_WIRE_MAP,
  mapReasoningLevelForModel,
  normalizeReasoningLevel,
  normalizeWireRequest,
  stripBracketedModelSuffix,
} from "./reasoning";
export type DiscoveredModel = CatalogModel;

export interface InferredModelMetadata {
  contextWindow?: number;
  defaultReasoningLevel?: string;
  supportedReasoningLevels: string[];
}

export function inferModelMetadata(modelID: string): InferredModelMetadata {
  const metadata = inferReasoningMetadata(modelID);
  return {
    ...metadata,
    supportedReasoningLevels: [...metadata.supportedReasoningLevels],
  };
}

function parseCatalogModels(data: unknown): DiscoveredModel[] {
  return parseCatalogPayloadModels(data);
}

function parseOpenAIModels(data: unknown): DiscoveredModel[] {
  return parseOpenAIPayloadModels(data);
}

export function modelsCatalogPayload(models: DiscoveredModel[]): {
  models: Array<Record<string, unknown>>;
} {
  return {
    models: models.map((model) => ({
      id: model.id,
      slug: model.id,
      display_name: model.name,
      ...(model.contextWindow ? { context_window: model.contextWindow } : {}),
      ...(model.outputLimit ? { max_output_tokens: model.outputLimit } : {}),
      ...(model.defaultReasoningLevel
        ? { default_reasoning_level: model.defaultReasoningLevel }
        : {}),
      supported_reasoning_levels: model.supportedReasoningLevels,
    })),
  };
}

async function fetchJSON(url: string, apiKey?: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const response = await fetch(url, {
      signal: controller.signal,
      headers,
    });
    if (!response.ok) {
      throw new Error(
        `cliproxy models fetch failed: ${response.status} ${await response.text()}`
      );
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchModels(
  baseURL: string,
  apiKey?: string
): Promise<DiscoveredModel[]> {
  const root = baseURL.replace(/\/$/, "");
  const catalogURL = `${root}/models?client_version`;
  const plainURL = `${root}/models`;
  try {
    const catalog = parseCatalogModels(await fetchJSON(catalogURL, apiKey));
    if (catalog.length > 0) {
      return catalog;
    }
  } catch {
  }

  const plain = parseOpenAIModels(await fetchJSON(plainURL, apiKey));
  const deduped = new Map<string, DiscoveredModel>();
  for (const model of plain) {
    deduped.set(model.id, model);
  }
  return Array.from(deduped.values());
}
