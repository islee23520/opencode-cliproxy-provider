import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface StoredAuth {
  readonly apiKey: string;
}

function configHome(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

export function opencodeConfigDir(): string {
  return join(configHome(), "opencode");
}

export function authFilePath(): string {
  return (
    process.env.CLIPROXY_AUTH_FILE ||
    join(opencodeConfigDir(), "cliproxy", "auth.json")
  );
}

function codexAuthFilePath(): string {
  return join(process.env.HOME || homedir(), ".codex", "auth.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function apiKeyFromAuth(auth: unknown): string | undefined {
  if (!isRecord(auth)) {
    return;
  }
  const type = auth.type;
  const key = auth.key;
  if ((type === "api" || type === "wellknown") && typeof key === "string") {
    const trimmed = key.trim();
    return trimmed || undefined;
  }
  return;
}

function codexAccessToken(): string | undefined {
  const path = codexAuthFilePath();
  if (!existsSync(path)) {
    return;
  }
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(data) || !isRecord(data.tokens)) {
      return;
    }
    const token = data.tokens.access_token;
    return typeof token === "string" && token.trim() ? token.trim() : undefined;
  } catch {
    return;
  }
}

function prefersCodexAuth(baseURL: string | undefined): boolean {
  return Boolean(baseURL?.includes("127.0.0.1:10100"));
}

function readCliproxyAuthFile(): StoredAuth | undefined {
  const path = authFilePath();
  if (!existsSync(path)) {
    return;
  }
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(data) && typeof data.apiKey === "string" && data.apiKey.trim()
      ? { apiKey: data.apiKey.trim() }
      : undefined;
  } catch {
    return;
  }
}

export function readStoredAuth(baseURL?: string): StoredAuth | undefined {
  const envKey = (process.env.CLIPROXY_API_KEY || "").trim();
  if (envKey) {
    return { apiKey: envKey };
  }

  if (prefersCodexAuth(baseURL)) {
    const token = codexAccessToken();
    if (token) {
      return { apiKey: token };
    }
  }

  return readCliproxyAuthFile();
}

export function writeStoredAuth(apiKey: string): void {
  const path = authFilePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ apiKey } satisfies StoredAuth, null, 2), {
    mode: 0o600,
  });
}
