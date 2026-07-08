import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { redactSecrets } from "../../core/redaction";
import { type WriteOptions, type WriteResult, writeConfigFile } from "../../core/config-writer";

const codexProviderId = "cliproxy";

export type CodexProviderOptions = {
  readonly baseUrl: string;
  readonly wireApi: string;
  readonly envKey: string;
  readonly requiresOpenAiAuth: boolean;
};

export type CodexProviderStatus = "configured" | "drifted" | "missing";

export type CodexProviderUpsertResult = {
  readonly config: string;
  readonly status: CodexProviderStatus;
  readonly activeProviderChanged: boolean;
};

export type CodexConfigWriteOptions = WriteOptions & {
  readonly redact?: readonly string[];
};

export type CodexConfigWriteResult = {
  readonly provider: CodexProviderUpsertResult;
  readonly write: WriteResult;
};

export type CodexDoctorResult = {
  readonly ok: boolean;
  readonly provider: CodexProviderUpsertResult;
  readonly diagnostics: readonly string[];
};

type TomlValue = string | boolean;

type TomlTable = Record<string, TomlValue>;

type TableBlock = {
  readonly start: number;
  readonly end: number;
  readonly body: string;
};

export function upsertCodexProvider(config: string, opts: CodexProviderOptions): CodexProviderUpsertResult {
  const activeProvider = readTopLevelTomlString(config, "model_provider");
  const providerBlock = tableBlock(config, `model_providers.${codexProviderId}`);
  const status = providerStatus(providerBlock, opts);
  if (status === "drifted") {
    return { config, status, activeProviderChanged: false };
  }

  const activeProviderChanged = activeProvider === undefined;
  const withActiveProvider = activeProviderChanged
    ? upsertTopLevelString(config, "model_provider", codexProviderId)
    : config;
  const nextConfig = status === "configured"
    ? withActiveProvider
    : upsertTable(withActiveProvider, `model_providers.${codexProviderId}`, providerLines(opts));
  return { config: nextConfig, status, activeProviderChanged };
}

export async function writeCodexConfigFile(
  path: string,
  opts: CodexProviderOptions,
  writeOptions: CodexConfigWriteOptions,
): Promise<CodexConfigWriteResult> {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const provider = upsertCodexProvider(current, opts);
  const write = await writeConfigFile(path, provider.config, writeOptions);
  return { provider, write: redactWriteResult(write, writeOptions.redact ?? []) };
}

export async function printCodexConfig(path: string, redactions: readonly string[] = []): Promise<string> {
  return redactSecrets(await readFile(path, "utf8"), redactions);
}

export async function doctorCodexConfig(
  path: string,
  opts: CodexProviderOptions,
  redactions: readonly string[] = [],
): Promise<CodexDoctorResult> {
  const exists = existsSync(path);
  const config = exists ? readFileSync(path, "utf8") : "";
  const provider = upsertCodexProvider(config, opts);
  const diagnostics = doctorDiagnostics(exists, config, provider, redactions);
  return { ok: diagnostics.length === 1 && diagnostics[0] === "Codex Cliproxy provider is configured.", provider, diagnostics };
}

function doctorDiagnostics(
  configExists: boolean,
  config: string,
  provider: CodexProviderUpsertResult,
  redactions: readonly string[],
): readonly string[] {
  const diagnostics: string[] = [];
  if (!configExists) {
    diagnostics.push("Codex config is missing at the user-level config path.");
  }
  switch (provider.status) {
    case "missing":
      diagnostics.push("Cliproxy provider block is missing.");
      break;
    case "drifted":
      diagnostics.push(`Cliproxy provider block drifted; refusing to overwrite user-managed values:\n${redactSecrets(config, redactions)}`);
      break;
    case "configured":
      diagnostics.push("Codex Cliproxy provider is configured.");
      break;
    default:
      assertNever(provider.status);
  }
  const activeProvider = readTopLevelTomlString(config, "model_provider");
  if (activeProvider && activeProvider !== codexProviderId) {
    diagnostics.push(`Codex active provider is user-managed: ${JSON.stringify(activeProvider)}.`);
  }
  return diagnostics;
}

function providerStatus(block: TableBlock | undefined, opts: CodexProviderOptions): CodexProviderStatus {
  if (!block) {
    return "missing";
  }
  const table = parseTomlTable(block.body);
  return table.base_url === opts.baseUrl &&
    table.wire_api === opts.wireApi &&
    table.env_key === opts.envKey &&
    table.requires_openai_auth === opts.requiresOpenAiAuth
    ? "configured"
    : "drifted";
}

function providerLines(opts: CodexProviderOptions): readonly string[] {
  return [
    `base_url = ${JSON.stringify(opts.baseUrl)}`,
    `wire_api = ${JSON.stringify(opts.wireApi)}`,
    `env_key = ${JSON.stringify(opts.envKey)}`,
    `requires_openai_auth = ${opts.requiresOpenAiAuth}`,
  ];
}

function readTopLevelTomlString(config: string, key: string): string | undefined {
  const pattern = new RegExp(`^${escapeRegExp(key)}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*$`, "m");
  const match = pattern.exec(topLevelToml(config));
  const raw = match?.[1];
  return raw ? parseJsonString(raw) : undefined;
}

function upsertTopLevelString(config: string, key: string, value: string): string {
  const line = `${key} = ${JSON.stringify(value)}`;
  const pattern = new RegExp(`^${escapeRegExp(key)}\\s*=.*$`, "m");
  if (pattern.test(topLevelToml(config))) {
    return config.replace(pattern, line);
  }
  return `${line}\n${config.replace(/^\n+/, "")}`;
}

function upsertTable(config: string, table: string, lines: readonly string[]): string {
  const block = tableBlock(config, table);
  const content = `[${table}]\n${lines.join("\n")}\n`;
  if (!block) {
    return `${config.replace(/\n?$/, "\n")}\n${content}`;
  }
  return `${config.slice(0, block.start)}${content}${config.slice(block.end)}`;
}

function tableBlock(config: string, table: string): TableBlock | undefined {
  const header = `[${table}]`;
  const headerPattern = new RegExp(`^\\s*${escapeRegExp(header)}\\s*$`, "m");
  const match = headerPattern.exec(config);
  if (!match) {
    return;
  }
  const start = match.index;
  const bodyStart = start + match[0].length;
  const remainder = config.slice(bodyStart);
  const nextTable = /^\s*\[[^\]]+]\s*$/m.exec(remainder);
  const end = nextTable ? bodyStart + nextTable.index : config.length;
  return { start, end, body: config.slice(bodyStart, end) };
}

function topLevelToml(config: string): string {
  const firstTable = /^\s*\[[^\]]+]\s*$/m.exec(config);
  return firstTable ? config.slice(0, firstTable.index) : config;
}

function parseTomlTable(body: string): TomlTable {
  const table: TomlTable = {};
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const equals = trimmed.indexOf("=");
    if (equals <= 0) {
      continue;
    }
    const key = trimmed.slice(0, equals).trim();
    const value = trimmed.slice(equals + 1).trim();
    if (value === "true") {
      table[key] = true;
    } else if (value === "false") {
      table[key] = false;
    } else if (value.startsWith('"') && value.endsWith('"')) {
      const parsed = parseJsonString(value);
      if (parsed) {
        table[key] = parsed;
      }
    }
  }
  return table;
}

function parseJsonString(value: string): string | undefined {
  const parsed: unknown = JSON.parse(value);
  return typeof parsed === "string" ? parsed : undefined;
}

function redactWriteResult(result: WriteResult, redactions: readonly string[]): WriteResult {
  if (redactions.length === 0) {
    return result;
  }
  const diff = redactSecrets(result.diff, redactions);
  return result.ok ? { ...result, diff } : { ...result, diff };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertNever(value: never): never {
  throw new Error(`Unexpected Codex provider status: ${String(value)}`);
}
