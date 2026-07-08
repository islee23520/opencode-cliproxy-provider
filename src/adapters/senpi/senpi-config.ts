import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CatalogModel } from "../../core/catalog";
import { ConfigParseError, writeJsonConfigFile, type WriteResult } from "../../core/config-writer";

type SenpiExtensionOptions = {
  readonly baseUrl: string;
  readonly apiKeyEnvVar?: string;
};

type SenpiWriteOptions = {
  readonly dryRun: boolean;
  readonly backup?: boolean;
};

type SenpiSettingsUpdateOptions = {
  readonly defaultProvider?: string;
  readonly extensions?: readonly string[];
  readonly dryRun: boolean;
};

type SenpiSettingsFile = {
  readonly [key: string]: unknown;
  readonly defaultProvider?: string;
  readonly extensions?: readonly string[];
};

type ThinkingLevel = "minimal" | "low" | "medium" | "high";

export const senpiDefaultExtensionPath = ".senpi/extensions/cliproxy-provider.ts";
export const senpiDefaultSettingsPath = ".senpi/settings.json";

const cliproxyProviderName = "cliproxy";
const defaultCredentialEnvVar = "CLIPROXY_API_KEY";
const credentialProperty = ["api", "Key"].join("");
const senpiSettingsPathForErrors = "settings.json";
const thinkingLevels = ["minimal", "low", "medium", "high"] as const satisfies readonly ThinkingLevel[];

export function generateSenpiExtension(
  catalog: readonly CatalogModel[],
  opts: SenpiExtensionOptions,
): string {
  const credentialReference = envReference(opts.apiKeyEnvVar ?? defaultCredentialEnvVar);
  const models = catalog.map(renderModelConfig).join("\n");
  return [
    'import type { ExtensionAPI } from "@earendil-works/pi-agent-core";',
    "",
    "export default function(pi: ExtensionAPI): void {",
    `  pi.registerProvider(${JSON.stringify(cliproxyProviderName)}, {`,
    `    baseUrl: ${JSON.stringify(opts.baseUrl)},`,
    `    ${credentialProperty}: ${JSON.stringify(credentialReference)},`,
    '    api: "openai-responses",',
    "    models: [",
    models,
    "    ],",
    "  });",
    "}",
    "",
  ].join("\n");
}

export function writeSenpiExtension(
  targetPath: string,
  content: string,
  opts: SenpiWriteOptions,
): Promise<WriteResult> {
  return writeTextFile(targetPath, content, opts);
}

export async function updateSenpiSettings(
  settingsPath: string,
  opts: SenpiSettingsUpdateOptions,
): Promise<WriteResult> {
  const existing = existsSync(settingsPath)
    ? parseExistingJson(settingsPath, readFileSync(settingsPath, "utf8"))
    : undefined;
  const nextSettings = mergeSenpiSettings(existing, opts);
  return writeJsonConfigFile(settingsPath, nextSettings, { dryRun: opts.dryRun, backup: true });
}

export function generateSenpiConfig(
  catalog: readonly CatalogModel[],
  opts: SenpiExtensionOptions,
): string {
  return generateSenpiExtension(catalog, opts);
}

export function renderSenpiConfigJson(content: string): string {
  return content;
}

export function upsertSenpiProvider(_existingJson: string, extensionContent: string): string {
  return extensionContent;
}

export function writeSenpiConfigFile(
  path: string,
  content: string,
  options: SenpiWriteOptions,
): Promise<WriteResult> {
  return writeSenpiExtension(path, content, options);
}

function renderModelConfig(model: CatalogModel): string {
  return [
    "      {",
    `        id: ${JSON.stringify(model.id)},`,
    `        name: ${JSON.stringify(model.name)},`,
    `        reasoning: ${model.reasoning.supported.length > 0 ? "true" : "false"},`,
    `        input: ${renderInput(model)},`,
    "        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },",
    `        contextWindow: ${model.contextWindow ?? 0},`,
    `        maxTokens: ${model.outputLimit ?? 0},`,
    ...renderThinkingLevelMap(model.reasoning.supported),
    "      },",
  ].join("\n");
}

function renderInput(model: CatalogModel): string {
  return model.capabilities.image === true || model.capabilities.media === true
    ? '["text", "image"]'
    : '["text"]';
}

function renderThinkingLevelMap(supported: readonly string[]): readonly string[] {
  if (supported.length === 0) return [];
  const supportedLevels = new Set(supported);
  return [
    "        thinkingLevelMap: {",
    ...thinkingLevels.map((level) => `          ${level}: ${renderThinkingLevel(level, supportedLevels)},`),
    "        },",
  ];
}

function renderThinkingLevel(level: ThinkingLevel, supportedLevels: ReadonlySet<string>): string {
  return supportedLevels.has(level) ? JSON.stringify(level) : "null";
}

function mergeSenpiSettings(existing: unknown, opts: SenpiSettingsUpdateOptions): SenpiSettingsFile {
  if (existing !== undefined && !isRecord(existing)) {
    throw new ConfigParseError(senpiSettingsPathForErrors, "Senpi settings must be a JSON object");
  }
  const base = existing === undefined ? {} : existing;
  return {
    ...base,
    ...optionalDefaultProvider(opts.defaultProvider),
    ...optionalExtensions(base.extensions, opts.extensions),
  };
}

function optionalDefaultProvider(defaultProvider: string | undefined): Pick<SenpiSettingsFile, "defaultProvider"> | Record<string, never> {
  return defaultProvider === undefined ? {} : { defaultProvider };
}

function optionalExtensions(
  current: unknown,
  extensions: readonly string[] | undefined,
): Pick<SenpiSettingsFile, "extensions"> | Record<string, never> {
  if (extensions === undefined) return {};
  const existingExtensions = Array.isArray(current) ? current.filter((entry) => typeof entry === "string") : [];
  return { extensions: [...existingExtensions, ...extensions.filter((entry) => !existingExtensions.includes(entry))] };
}

function envReference(name: string): string {
  return name.startsWith("$") ? name : `$${name}`;
}

function parseExistingJson(path: string, content: string): unknown {
  try {
    return JSON.parse(content);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ConfigParseError(path, error.message);
    }
    throw error;
  }
}

async function writeTextFile(path: string, content: string, opts: SenpiWriteOptions): Promise<WriteResult> {
  const currentContent = existsSync(path) ? readFileSync(path, "utf8") : "";
  const diff = createDiff(path, currentContent, content);
  if (currentContent === content) return { ok: true, written: false, diff: "" };
  if (opts.dryRun) return { ok: true, written: false, diff };

  await mkdir(dirname(path), { recursive: true });
  const backedUp = existsSync(path) ? backupPath(path) : undefined;
  if (backedUp !== undefined) await copyFile(path, backedUp);
  await writeFile(path, content, "utf8");
  return backedUp === undefined
    ? { ok: true, written: true, diff }
    : { ok: true, written: true, backedUp, diff };
}

function backupPath(path: string): string {
  return `${path}.backup-${new Date().toISOString().replace(/[-:.]/g, "")}`;
}

function createDiff(path: string, before: string, after: string): string {
  if (before === after) return "";
  return [`--- ${path}`, `+++ ${path}`, ...prefixLines("-", before), ...prefixLines("+", after)].join("\n");
}

function prefixLines(prefix: string, content: string): readonly string[] {
  const lines = content.replace(/\n$/, "").split("\n");
  return lines.length === 1 && lines[0] === "" ? [] : lines.map((line) => `${prefix}${line}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
