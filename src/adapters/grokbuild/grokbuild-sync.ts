import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CatalogModel } from "../../core/catalog";
import { writeConfigFile } from "../../core/config-writer";
import { fetchModels as fetchCatalogModels } from "../../core/models";

export type GrokSyncResult = {
  readonly config: string;
  readonly added: readonly string[];
  readonly skipped: number;
};

export type GrokSyncStatus = {
  readonly statusMessage: string;
  readonly written: boolean;
};

export type GrokSyncDependencies = {
  readonly fetchModels?: (baseUrl: string, apiKey?: string) => Promise<readonly CatalogModel[]>;
};

const reasoningEffortVariants = ["low", "medium", "high", "xhigh", "max"] as const;
const nonReasoningKeywords = ["image", "embedding", "video", "composer", "dall-e", "whisper", "tts", "moderation"] as const;

export async function runGrokConfigSync(home: string, dependencies: GrokSyncDependencies = {}): Promise<GrokSyncStatus> {
  const configPath = join(home, ".grok", "config.toml");
  if (!existsSync(configPath)) {
    return { statusMessage: "Cliproxy: no config.toml found", written: false };
  }

  const config = await readFile(configPath, "utf8");
  const baseUrl = extractModelsBaseUrl(config);
  if (!baseUrl) {
    return { statusMessage: "Cliproxy: no models_base_url in config", written: false };
  }
  const apiKey = extractApiKey(config);
  const fetchModels = dependencies.fetchModels ?? fetchCatalogModels;

  let models: readonly CatalogModel[];
  try {
    models = await fetchModels(baseUrl, apiKey ?? undefined);
  } catch (error) {
    if (error instanceof Error) {
      return { statusMessage: "Cliproxy: endpoint unreachable, skipping sync", written: false };
    }
    throw error;
  }
  if (models.length === 0) {
    return { statusMessage: "Cliproxy: no models discovered", written: false };
  }

  const result = syncGrokConfig(config, models, baseUrl, apiKey);
  if (result.added.length === 0) {
    return { statusMessage: `Cliproxy: all ${result.skipped} models already in config`, written: false };
  }

  const write = await writeConfigFile(configPath, result.config, { dryRun: false, backup: true });
  if (!write.ok) {
    return { statusMessage: `Cliproxy: config parse failed: ${write.error.message}`, written: false };
  }
  return {
    statusMessage: `Cliproxy: synced ${result.added.length} new model${result.added.length === 1 ? "" : "s"} (${result.added.join(", ")})`,
    written: write.written,
  };
}

export function syncGrokConfig(
  config: string,
  models: readonly CatalogModel[],
  baseUrl: string,
  apiKey: string | null,
): GrokSyncResult {
  const resolvedBaseUrl = extractModelsBaseUrl(config) ?? baseUrl;
  const modelResult = syncModelSections(config, models, resolvedBaseUrl, apiKey);
  const defaultResult = syncDefaultModel(modelResult.config, models);
  return {
    config: defaultResult.config,
    added: defaultResult.changed ? [...modelResult.added, "models.default"] : modelResult.added,
    skipped: modelResult.skipped,
  };
}

function syncModelSections(config: string, models: readonly CatalogModel[], baseUrl: string, apiKey: string | null): GrokSyncResult {
  const added: string[] = [];
  let skipped = 0;
  let next = config;

  for (const model of models) {
    if (!isSafeGrokModelID(model.id)) {
      continue;
    }
    const supportsReasoning = supportsReasoningEffort(model);
    if (hasModelSection(next, model.id)) {
      skipped += 1;
    } else {
      next = appendSection(next, buildModelSection(model.id, baseUrl, apiKey, model.contextWindow, supportsReasoning));
      added.push(model.id);
    }
    if (supportsReasoning) {
      for (const effort of reasoningEffortVariants) {
        const aliasId = `${model.id} ${effort}`;
        if (hasModelSection(next, aliasId)) {
          continue;
        }
        next = appendSection(next, buildReasoningAliasSection(aliasId, model.id, effort, baseUrl, apiKey, model.contextWindow));
        added.push(aliasId);
      }
    }
  }

  return { config: next, added, skipped };
}

function syncDefaultModel(config: string, models: readonly CatalogModel[]): { readonly changed: boolean; readonly config: string } {
  if (hasDefaultModel(config)) {
    return { changed: false, config };
  }
  const defaultModel = chooseDefaultModel(models);
  return defaultModel ? { changed: true, config: upsertModelsDefault(config, defaultModel) } : { changed: false, config };
}

function chooseDefaultModel(models: readonly CatalogModel[]): string | null {
  const textModels = models.filter(supportsReasoningEffort).map((model) => model.id);
  return textModels.find((id) => id === "gpt-5.5") ?? textModels.find((id) => id.startsWith("gpt-5.")) ?? textModels.find((id) => id.startsWith("grok-4.")) ?? textModels.find((id) => id.startsWith("gemini-3")) ?? textModels[0] ?? null;
}

function supportsReasoningEffort(model: CatalogModel): boolean {
  const lower = model.id.toLowerCase();
  return !nonReasoningKeywords.some((keyword) => lower.includes(keyword));
}

function isSafeGrokModelID(id: string): boolean {
  return id.trim().length > 0 && !/[\x00-\x1f\x7f\]]/.test(id);
}

function hasDefaultModel(config: string): boolean {
  const body = tomlSectionBody(config, "models");
  return body !== null && /^\s*default\s*=\s*.+$/m.test(body);
}

function upsertModelsDefault(config: string, modelId: string): string {
  const header = "[models]";
  const line = `default = ${tomlString(modelId)}`;
  const start = config.indexOf(header);
  if (start === -1) {
    return appendSection(config, `${header}\n${line}\n`);
  }
  const bodyStart = start + header.length;
  const rest = config.slice(bodyStart);
  const nextHeader = /\n\[[^\n]+\]/.exec(rest);
  const end = nextHeader ? bodyStart + nextHeader.index : config.length;
  return `${config.slice(0, end).trimEnd()}\n${line}${config.slice(end)}`;
}

function tomlSectionBody(config: string, sectionName: string): string | null {
  const header = `[${sectionName}]`;
  const start = config.indexOf(header);
  if (start === -1) {
    return null;
  }
  const bodyStart = start + header.length;
  const rest = config.slice(bodyStart);
  const nextHeader = /\n\[[^\n]+\]/.exec(rest);
  return nextHeader ? rest.slice(0, nextHeader.index) : rest;
}

export function extractModelsBaseUrl(config: string): string | null {
  const body = tomlSectionBody(config, "endpoints");
  const match = body ? /^\s*models_base_url\s*=\s*(.+)$/m.exec(body) : null;
  return match?.[1] ? parseTomlStringValue(match[1].trim()) : null;
}

function extractApiKey(config: string): string | null {
  const match = /\[model\.[^\]]+\]\n(?:[^\n]*\n)*?\s*api_key\s*=\s*(.+)$/m.exec(config);
  return match?.[1] ? parseTomlStringValue(match[1].trim()) : null;
}

function hasModelSection(config: string, modelId: string): boolean {
  return config.includes(makeModelSectionHeader(modelId)) || (/^[a-zA-Z0-9_-]+$/.test(modelId) && config.includes(`[model.${modelId}]`));
}

function buildModelSection(modelId: string, baseUrl: string, apiKey: string | null, contextWindow: number | undefined, supportsReasoning: boolean): string {
  const lines = modelSectionBaseLines(modelId, baseUrl, apiKey, contextWindow);
  if (supportsReasoning) {
    lines.push("supports_reasoning_effort = true");
  }
  return `${makeModelSectionHeader(modelId)}\n${lines.join("\n")}\n`;
}

function buildReasoningAliasSection(aliasId: string, modelId: string, effort: string, baseUrl: string, apiKey: string | null, contextWindow: number | undefined): string {
  return `${makeModelSectionHeader(aliasId)}\n${modelSectionBaseLines(`${modelId}(${effort})`, baseUrl, apiKey, contextWindow).join("\n")}\n`;
}

function modelSectionBaseLines(modelId: string, baseUrl: string, apiKey: string | null, contextWindow: number | undefined): string[] {
  return [
    `model = ${tomlString(modelId)}`,
    `base_url = ${tomlString(baseUrl)}`,
    ...(apiKey !== null ? [`api_key = ${tomlString(apiKey)}`] : []),
    ...(contextWindow ? [`context_window = ${contextWindow}`] : []),
  ];
}

function makeModelSectionHeader(modelId: string): string {
  return `[model.${tomlString(modelId)}]`;
}

function appendSection(config: string, section: string): string {
  const trimmed = config.trimEnd();
  return trimmed.length === 0 ? section : `${trimmed}\n\n${section}`;
}

function parseTomlStringValue(raw: string): string | null {
  if (raw.startsWith('"""') || raw.startsWith("'''")) {
    return null;
  }
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return raw.length > 0 ? raw : null;
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
