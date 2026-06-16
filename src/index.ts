import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Config, Plugin, PluginModule } from "@opencode-ai/plugin";
import {
  type DiscoveredModel,
  fetchModels,
  normalizeReasoningLevel,
} from "./models";

const PROVIDER_ID = "cliproxy";
const reasoningLevelsByModel = new Map<string, Set<string>>();
const defaultReasoningLevelByModel = new Map<string, string>();
const reasoningLevelByAgent = new Map<string, string>();

// ---------------------------------------------------------------------------
// Secret storage — apiKey lives OUTSIDE opencode.json in a 0o600 file.
// ---------------------------------------------------------------------------

function configHome(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

function authFilePath(): string {
  return (
    process.env.CLIPROXY_AUTH_FILE ||
    join(configHome(), "opencode", "cliproxy", "auth.json")
  );
}

function opencodeConfigDir(): string {
  return join(configHome(), "opencode");
}

function ohMyOpenAgentConfigPaths(): string[] {
  const dir = opencodeConfigDir();
  return [
    join(dir, "oh-my-openagent.json"),
    join(dir, "oh-my-openagent.jsonc"),
    join(dir, "oh-my-opencode.json"),
    join(dir, "oh-my-opencode.jsonc"),
  ];
}

interface StoredAuth {
  apiKey: string;
}

function readStoredAuth(): StoredAuth | undefined {
  // 1. Env var override (highest priority)
  const envKey = (process.env.CLIPROXY_API_KEY || "").trim();
  if (envKey) {
    return { apiKey: envKey };
  }

  // 2. Secret file
  const path = authFilePath();
  if (!existsSync(path)) {
    return;
  }
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredAuth>;
    if (typeof data.apiKey === "string" && data.apiKey.trim()) {
      return { apiKey: data.apiKey.trim() };
    }
  } catch {
    // Corrupt file — fall through
  }
  return;
}

/** Programmatically save the apiKey to the secret file (0o600). */
export function writeStoredAuth(apiKey: string): void {
  const path = authFilePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ apiKey } satisfies StoredAuth, null, 2), {
    mode: 0o600,
  });
}

type MutableConfig = Config & {
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

// ---------------------------------------------------------------------------
// Config mutation
// ---------------------------------------------------------------------------

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

function applyApiKey(config: MutableConfig, apiKey: string): void {
  const provider = ensureProvider(config);
  if (!provider.options) {
    provider.options = {};
  }
  provider.options.apiKey = apiKey;
}

function reasoningVariantOptions(
  levels: string[]
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

function applyModels(config: MutableConfig, models: DiscoveredModel[]): void {
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

function applyAgents(config: MutableConfig): void {
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

function applyReasoningParams(input: unknown, output: unknown): void {
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

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export const plugin: Plugin = (_ctx) =>
  Promise.resolve({
    config: async (config) => {
      const cfg = config as MutableConfig;
      const provider = cfg.provider?.[PROVIDER_ID];
      if (!provider) {
        return;
      }

      const options = isRecord(provider.options) ? provider.options : {};
      const baseURL = typeof options.baseURL === "string" ? options.baseURL : "";
      if (!baseURL) {
        console.error(
          "[opencode-cliproxy-provider] No baseURL configured for provider.cliproxy.options.baseURL"
        );
        return;
      }

      const stored = readStoredAuth();
      if (stored) {
        applyApiKey(cfg, stored.apiKey);
      }

      applyAgents(cfg);
      try {
        const models = await fetchModels(baseURL, stored?.apiKey);
        applyModels(cfg, models);
      } catch (error) {
        console.error(
          "[opencode-cliproxy-provider] Failed to sync models:",
          error instanceof Error ? error.message : String(error)
        );
      }
    },
    "chat.params": (input, output) => {
      applyReasoningParams(input, output);
      return Promise.resolve();
    },
  });

export const server = plugin;

const pluginModule = {
  id: "opencode-cliproxy-provider",
  server,
} satisfies PluginModule;

export default pluginModule;
