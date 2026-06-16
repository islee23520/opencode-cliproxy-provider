#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

// ---------------------------------------------------------------------------
// Path helpers — mirror src/index.ts
// ---------------------------------------------------------------------------

function configHome(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

function opencodeConfigDir(): string {
  return join(configHome(), "opencode");
}

function authFilePath(): string {
  return (
    process.env.CLIPROXY_AUTH_FILE ||
    join(opencodeConfigDir(), "cliproxy", "auth.json")
  );
}

function opencodeJsonPath(): string {
  const dir = opencodeConfigDir();
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return join(dir, "opencode.json");
}

// ---------------------------------------------------------------------------
// Auth — 0o600 file outside opencode.json
// ---------------------------------------------------------------------------

function writeStoredAuth(apiKey: string): void {
  const path = authFilePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ apiKey }, null, 2), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// opencode.json read/write (JSONC-safe)
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseJSONC(text: string): unknown {
  return JSON.parse(
    text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1"),
  );
}

function readOpencodeConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const data = parseJSONC(readFileSync(path, "utf8"));
    return isRecord(data) ? data : {};
  } catch {
    return {};
  }
}

function writeOpencodeConfig(path: string, config: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

interface SetupOptions {
  baseURL: string;
  apiKey: string;
  providerNpm?: string;
}

function applySetup(config: Record<string, unknown>, opts: SetupOptions): Record<string, unknown> {
  const result = { ...config };

  // plugin array
  const existingPlugin = Array.isArray(result.plugin) ? result.plugin as unknown[] : [];
  if (!existingPlugin.includes("opencode-cliproxy-provider")) {
    result.plugin = [...existingPlugin, "opencode-cliproxy-provider"];
  }

  // provider.cliproxy
  if (!isRecord(result.provider)) {
    result.provider = {};
  }
  const provider = isRecord(result.provider) ? result.provider : {};
  result.provider = {
    ...provider,
    cliproxy: {
      options: {
        ...(isRecord(provider.cliproxy) && isRecord(provider.cliproxy.options)
          ? provider.cliproxy.options
          : {}),
        baseURL: opts.baseURL,
      },
      npm: opts.providerNpm ?? "@ai-sdk/openai-compatible",
      name: "Cliproxy",
    },
  };

  return result;
}

// ---------------------------------------------------------------------------
// Interactive prompts
// ---------------------------------------------------------------------------

async function prompt(rl: readline.Interface, question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || defaultValue || "";
}

async function promptHidden(rl: readline.Interface, question: string): Promise<string> {
  // readline.question doesn't hide input, but this is the simplest cross-runtime approach.
  // The key lives in a 0o600 file, not displayed.
  const answer = (await rl.question(`${question}: `)).trim();
  return answer;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { baseURL?: string; apiKey?: string; npm?: string; help?: boolean } {
  const args: { baseURL?: string; apiKey?: string; npm?: string; help?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--baseURL" || arg === "--base-url" || arg === "-u") {
      args.baseURL = argv[++i];
    } else if (arg === "--apiKey" || arg === "--api-key" || arg === "-k") {
      args.apiKey = argv[++i];
    } else if (arg === "--npm") {
      args.npm = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`
opencode-cliproxy-provider setup

Usage:
  npx opencode-cliproxy-provider [options]
  bunx opencode-cliproxy-provider [options]

Options:
  --baseURL, -u <url>      Cliproxy server URL (e.g. http://127.0.0.1:8317/v1)
  --apiKey, -k <key>       API key (stored in ~/.config/opencode/cliproxy/auth.json)
  --npm <package>          Provider npm package (default: @ai-sdk/openai-compatible)
  -h, --help               Show this help

Without flags, runs interactively.
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const configPath = opencodeJsonPath();
  const existing = readOpencodeConfig(configPath);
  const existingProvider = isRecord(existing.provider) && isRecord(existing.provider.cliproxy);
  const existingBaseURL =
    existingProvider &&
    isRecord((existing.provider as Record<string, unknown>).cliproxy) &&
    isRecord(((existing.provider as Record<string, Record<string, unknown>>).cliproxy).options)
      ? ((existing.provider as Record<string, Record<string, Record<string, unknown>>>).cliproxy.options).baseURL as string
      : undefined;

  let baseURL = args.baseURL;
  let apiKey = args.apiKey;

  // Interactive mode if missing required args
  if (!baseURL || !apiKey) {
    const rl = readline.createInterface({ input, output });
    try {
      if (!baseURL) {
        baseURL = await prompt(
          rl,
          "Cliproxy server URL",
          baseURL || existingBaseURL || "http://127.0.0.1:8317/v1",
        );
      }
      if (!apiKey) {
        apiKey = await promptHidden(rl, "API key");
      }
    } finally {
      rl.close();
    }
  }

  if (!baseURL) {
    console.error("Error: baseURL is required.");
    process.exit(1);
  }

  // Apply
  const updated = applySetup(existing, {
    baseURL,
    apiKey: apiKey || "",
    providerNpm: args.npm,
  });

  writeOpencodeConfig(configPath, updated);

  if (apiKey) {
    writeStoredAuth(apiKey);
    console.log(`✓ API key saved to ${authFilePath()}`);
  }

  console.log(`✓ Plugin registered in ${configPath}`);
  console.log(`✓ Provider cliproxy → ${baseURL}`);
  console.log("\nDone. Restart opencode to activate.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
