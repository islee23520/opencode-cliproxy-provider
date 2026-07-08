import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "@opencode-ai/plugin";
import {
  type DiscoveredModel,
  opencodeConfigDir,
  normalizeReasoningLevel,
} from "../../core";
import { PROVIDER_ID } from "./auth";

const reasoningLevelsByModel = new Map<string, Set<string>>();
const defaultReasoningLevelByModel = new Map<string, string>();
const reasoningLevelByAgent = new Map<string, string>();

export type MutableConfig = Config & {
  agent?: Record<string, Record<string, unknown>>;
  agents?: Record<string, Record<string, unknown>>;
  provider?: Record<
    string,
    {
      models?: Record<string, Record<string, unknown>>;
      options?: Record<string, unknown>;
      name?: string;
      npm?: string;
    }
  >;
};

function ohMyOpenAgentConfigPaths(): string[] {
  const dir = opencodeConfigDir();
  return [
    join(dir, "oh-my-openagent.json"),
    join(dir, "oh-my-openagent.jsonc"),
    join(dir, "oh-my-opencode.json"),
    join(dir, "oh-my-opencode.jsonc"),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAgentName(value: string): string {
  return value
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, "")
    .replace(/^\d+\|/, "")
    .replace(/^[\\/"']+|[\\/"']+$/g, "")
    .replace(/\s*[-–—]\s+.*$/, "")
    .replace(/\s*[(\[].*$/, "")
    .trim()
    .toLowerCase();
}

function parseJSONConfig(text: string): unknown {
  return JSON.parse(
    text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
  );
}

function configuredAgentsFromFile(): Record<string, Record<string, unknown>> {
  for (const path of ohMyOpenAgentConfigPaths()) {
    if (!existsSync(path)) {
      continue;
    }
    try {
      const data = parseJSONConfig(readFileSync(path, "utf8"));
      if (!isRecord(data) || !isRecord(data.agents)) {
        continue;
      }
      return Object.fromEntries(
        Object.entries(data.agents).filter((entry): entry is [string, Record<string, unknown>] =>
          isRecord(entry[1])
        )
      );
    } catch {
      return {};
    }
  }
  return {};
}

function ensureProvider(config: MutableConfig): NonNullable<
  MutableConfig["provider"]
>[typeof PROVIDER_ID] {
  if (!config.provider) {
    config.provider = {};
  }
  if (!config.provider[PROVIDER_ID]) {
    config.provider[PROVIDER_ID] = {};
  }
  return config.provider[PROVIDER_ID];
}

export function applyApiKey(config: MutableConfig, apiKey: string): void {
  const provider = ensureProvider(config);
  if (!provider.options) {
    provider.options = {};
  }
  provider.options.apiKey = apiKey;
}

export function applyBaseURL(config: MutableConfig, baseURL: string): void {
  const provider = ensureProvider(config);
  if (!provider.options) {
    provider.options = {};
  }
  provider.options.baseURL = baseURL;
}

function reasoningVariantOptions(
  levels: readonly string[]
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    levels.map((level) => [
      level,
      { reasoningEffort: level, reasoning_effort: level },
    ])
  );
}

function configuredAgents(
  config: MutableConfig
): Record<string, Record<string, unknown>> {
  return {
    ...configuredAgentsFromFile(),
    ...(isRecord(config.agents) ? config.agents : {}),
    ...(isRecord(config.agent) ? config.agent : {}),
  };
}

export function applyModels(config: MutableConfig, models: DiscoveredModel[]): void {
  const provider = ensureProvider(config);
  if (!provider.models) {
    provider.models = {};
  }
  for (const model of models) {
    const current = provider.models[model.id] || {};
    const next: Record<string, unknown> = {
      ...current,
      name: typeof current.name === "string" ? current.name : model.name,
    };
    if (model.contextWindow && model.outputLimit) {
      next.limit = {
        ...(isRecord(current.limit) ? current.limit : {}),
        context: model.contextWindow,
        output: model.outputLimit,
      };
    }
    if (model.supportedReasoningLevels.length > 0) {
      reasoningLevelsByModel.set(
        model.id,
        new Set(model.supportedReasoningLevels)
      );
      next.reasoning = true;
      next.variants = {
        ...(isRecord(current.variants) ? current.variants : {}),
        ...reasoningVariantOptions(model.supportedReasoningLevels),
      };
      next.supported_reasoning_levels = model.supportedReasoningLevels;
      if (model.defaultReasoningLevel) {
        defaultReasoningLevelByModel.set(model.id, model.defaultReasoningLevel);
        next.options = {
          ...(isRecord(current.options) ? current.options : {}),
          reasoningEffort: model.defaultReasoningLevel,
          reasoning_effort: model.defaultReasoningLevel,
        };
      }
    } else {
      reasoningLevelsByModel.delete(model.id);
      defaultReasoningLevelByModel.delete(model.id);
    }
    provider.models[model.id] = next;
  }
}

export function applyAgents(config: MutableConfig): void {
  reasoningLevelByAgent.clear();
  for (const [agent, value] of Object.entries(configuredAgents(config))) {
    const variant = normalizeReasoningLevel(value.variant);
    if (variant) {
      reasoningLevelByAgent.set(normalizeAgentName(agent), variant);
    }
  }
}

function inputProviderID(input: unknown): string | undefined {
  if (!isRecord(input) || !isRecord(input.model)) {
    return;
  }
  return typeof input.model.providerID === "string"
    ? input.model.providerID
    : undefined;
}

function inputModelID(input: unknown): string | undefined {
  if (!isRecord(input) || !isRecord(input.model)) {
    return;
  }
  if (typeof input.model.modelID === "string") {
    return input.model.modelID;
  }
  return typeof input.model.id === "string" ? input.model.id : undefined;
}

function inputAgent(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return;
  }
  if (typeof input.agent === "string") {
    return normalizeAgentName(input.agent);
  }
  if (isRecord(input.agent) && typeof input.agent.name === "string") {
    return normalizeAgentName(input.agent.name);
  }
  return;
}

function inputVariant(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return;
  }
  if (isRecord(input.message)) {
    const messageVariant = normalizeReasoningLevel(input.message.variant);
    if (messageVariant) {
      return messageVariant;
    }
  }
  if (!isRecord(input.model)) {
    return;
  }
  return normalizeReasoningLevel(input.model.variant);
}

export function applyReasoningParams(input: unknown, output: unknown): void {
  if (!isRecord(output) || inputProviderID(input) !== PROVIDER_ID) {
    return;
  }
  const modelID = inputModelID(input);
  const agent = inputAgent(input);
  const effort =
    (agent ? reasoningLevelByAgent.get(agent) : undefined) ??
    inputVariant(input) ??
    (modelID ? defaultReasoningLevelByModel.get(modelID) : undefined);
  if (!effort) {
    return;
  }
  const supported = modelID ? reasoningLevelsByModel.get(modelID) : undefined;
  if (supported && !supported.has(effort)) {
    return;
  }
  const options = isRecord(output.options) ? output.options : {};
  output.options = options;
  options.reasoningEffort = effort;
  options.reasoning_effort = effort;
}
