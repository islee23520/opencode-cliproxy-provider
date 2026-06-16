const FETCH_TIMEOUT_MS = 10_000;

interface ModelsResponse {
  data?: Array<{
    id: string;
    object?: string;
    owned_by?: string;
    [key: string]: unknown;
  }>;
}

interface CatalogModelsResponse {
  models?: Array<Record<string, unknown>>;
}

export interface DiscoveredModel {
  id: string;
  name: string;
  contextWindow?: number;
  outputLimit?: number;
  defaultReasoningLevel?: string;
  supportedReasoningLevels: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeReasoningLevel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return;
  }
  const normalized = value.trim().toLowerCase();
  return /^[a-z][a-z0-9_-]*$/.test(normalized) ? normalized : undefined;
}

function reasoningLevels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const levels = value
    .map((level) => {
      if (isRecord(level)) {
        return normalizeReasoningLevel(level.effort);
      }
      return normalizeReasoningLevel(level);
    })
    .filter((level): level is string => Boolean(level));
  return Array.from(new Set(levels));
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseCatalogModels(data: unknown): DiscoveredModel[] {
  if (!isRecord(data) || !Array.isArray((data as CatalogModelsResponse).models)) {
    return [];
  }
  const discovered: DiscoveredModel[] = [];
  for (const model of (data as CatalogModelsResponse).models || []) {
    const id =
      typeof model.slug === "string"
        ? model.slug
        : typeof model.id === "string"
          ? model.id
          : "";
    if (!id) {
      continue;
    }
    const levels = reasoningLevels(model.supported_reasoning_levels);
    const defaultLevel = normalizeReasoningLevel(model.default_reasoning_level);
    discovered.push({
      id,
      name: typeof model.display_name === "string" ? model.display_name : id,
      contextWindow:
        numberValue(model.context_window) ?? numberValue(model.max_context_window),
      outputLimit:
        numberValue(model.max_output_tokens) ??
        numberValue(model.output_token_limit) ??
        numberValue(model.default_max_tokens),
      defaultReasoningLevel:
        defaultLevel && levels.includes(defaultLevel) ? defaultLevel : undefined,
      supportedReasoningLevels: levels,
    });
  }
  return discovered;
}

function parseOpenAIModels(data: unknown): DiscoveredModel[] {
  if (!isRecord(data) || !Array.isArray((data as ModelsResponse).data)) {
    return [];
  }
  const discovered: DiscoveredModel[] = [];
  for (const model of (data as ModelsResponse).data || []) {
    const id = typeof model?.id === "string" ? model.id : "";
    if (!id) {
      continue;
    }
    discovered.push({
      id,
      name: id,
      contextWindow:
        numberValue(model.context_window) ??
        numberValue(model.max_context_window) ??
        numberValue(model.max_model_len),
      outputLimit:
        numberValue(model.max_output_tokens) ??
        numberValue(model.output_token_limit) ??
        numberValue(model.default_max_tokens),
      supportedReasoningLevels: [],
    });
  }
  return discovered;
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
