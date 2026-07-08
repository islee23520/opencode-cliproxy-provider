import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";

export type ConfigScalar = string | number | boolean;

export type TomlConfig = Record<string, ConfigScalar>;

export type WriteOptions = {
  readonly dryRun: boolean;
  readonly backup: boolean;
};

export type WriteResult =
  | { readonly ok: true; readonly written: boolean; readonly backedUp?: string; readonly diff: string }
  | { readonly ok: false; readonly written: false; readonly backedUp?: string; readonly diff: string; readonly error: ConfigParseError };

const defaultWriteOptions = {
  dryRun: true,
  backup: true,
} as const satisfies Required<WriteOptions>;

export class ConfigParseError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = "ConfigParseError";
    this.path = path;
  }
}

export function generateBackupPath(path: string, date = new Date()): string {
  const timestamp = date.toISOString().replace(/[-:.]/g, "");
  return `${path}.backup-${timestamp}`;
}

export function upsertManagedBlock(content: string, blockName: string, blockContent: string): string {
  const start = `# BEGIN cliproxy managed block: ${blockName}`;
  const end = `# END cliproxy managed block: ${blockName}`;
  const block = `${start}\n${blockContent.replace(/\n?$/, "\n")}${end}`;
  const pattern = new RegExp(`${escapeRegExp(start)}\\n[\\s\\S]*?\\n${escapeRegExp(end)}`);

  if (pattern.test(content)) {
    return content.replace(pattern, block);
  }

  return `${content.replace(/\n?$/, "\n")}${block}\n`;
}

export function parseConfigFile(path: string): unknown {
  return parseConfigContent(path, readFileSync(path, "utf8"));
}

export function formatJsonConfig(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function formatTomlConfig(config: TomlConfig): string {
  const lines = Object.entries(config).map(([key, value]) => `${key} = ${formatTomlScalar(value)}`);
  return `${lines.join("\n")}\n`;
}

export function writeJsonConfigFile(path: string, value: unknown, options: WriteOptions = defaultWriteOptions): Promise<WriteResult> {
  return writeConfigFile(path, formatJsonConfig(value), options);
}

export function writeTomlConfigFile(path: string, value: TomlConfig, options: WriteOptions = defaultWriteOptions): Promise<WriteResult> {
  return writeConfigFile(path, formatTomlConfig(value), options);
}

export async function writeConfigFile(
  path: string,
  content: string,
  options: WriteOptions = defaultWriteOptions,
): Promise<WriteResult> {
  const resolvedOptions = options;
  const currentContent = existsSync(path) ? readFileSync(path, "utf8") : "";

  try {
    parseConfigContent(path, content);
  } catch (error) {
    if (error instanceof ConfigParseError) {
      return { ok: false, written: false, diff: createDiff(path, currentContent, content), error };
    }
    throw error;
  }

  const diff = createDiff(path, currentContent, content);
  if (currentContent === content) {
    return { ok: true, written: false, diff: "" };
  }
  if (resolvedOptions.dryRun) {
    return { ok: true, written: false, diff };
  }

  await mkdir(dirname(path), { recursive: true });
  const backedUp = resolvedOptions.backup && existsSync(path) ? generateBackupPath(path) : undefined;
  if (backedUp) {
    await copyFile(path, backedUp);
  }
  await writeFile(path, content, "utf8");

  return backedUp
    ? { ok: true, written: true, backedUp, diff }
    : { ok: true, written: true, diff };
}

function parseConfigContent(path: string, content: string): unknown {
  switch (extname(path)) {
    case ".json":
      return parseJson(path, content);
    case ".toml":
      return parseToml(path, content);
    default:
      throw new ConfigParseError(path, `Unsupported config extension: ${extname(path) || "none"}`);
  }
}

function parseJson(path: string, content: string): unknown {
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ConfigParseError(path, error.message);
    }
    throw error;
  }
}

function parseToml(path: string, content: string): Record<string, ConfigScalar> {
  const parsed: Record<string, ConfigScalar> = {};
  const lines = content.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      continue;
    }
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex <= 0) {
      throw new ConfigParseError(path, `Malformed TOML line ${index + 1}`);
    }
    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(key) || value === "") {
      throw new ConfigParseError(path, `Malformed TOML line ${index + 1}`);
    }
    parsed[key] = parseTomlScalar(path, value, index + 1);
  }

  return parsed;
}

function parseTomlScalar(path: string, value: string, line: number): ConfigScalar {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return Number(value);
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "string") {
      return parsed;
    }
  }

  throw new ConfigParseError(path, `Unsupported TOML value on line ${line}`);
}

function formatTomlScalar(value: ConfigScalar): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function createDiff(path: string, before: string, after: string): string {
  if (before === after) {
    return "";
  }

  return [`--- ${path}`, `+++ ${path}`, ...prefixLines("-", before), ...prefixLines("+", after)].join("\n");
}

function prefixLines(prefix: string, content: string): readonly string[] {
  const lines = content.replace(/\n$/, "").split("\n");
  return lines.length === 1 && lines[0] === "" ? [] : lines.map((line) => `${prefix}${line}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
