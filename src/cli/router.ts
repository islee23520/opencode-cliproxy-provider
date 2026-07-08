import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  doctorCodexConfig,
  printCodexConfig,
  writeCodexConfigFile,
} from "../adapters/codex";
import { setupGrokPlugin, runGrokConfigSync } from "../adapters/grokbuild";
import { diagnosePiAgentRun } from "../adapters/pi-agent";
import { generateSenpiConfig, writeSenpiConfigFile } from "../adapters/senpi";
import { fetchModels } from "../core/models";
import { writeJsonConfigFile } from "../core/config-writer";

export type Target = "opencode" | "codex" | "grokbuild" | "pi-agent-run" | "senpi-config" | "all";

export type CliResult = {
  readonly ok: boolean;
  readonly status: string;
  readonly target?: string;
  readonly dryRun: boolean;
  readonly executed: boolean;
  readonly writes: string[];
  readonly warnings: string[];
};

type SetupOptions = { readonly baseUrl?: string; readonly write: boolean; readonly config?: string; readonly home: string };
type DoctorOptions = { readonly home: string };
type SyncOptions = { readonly home: string; readonly write: boolean };
type PrintConfigOptions = { readonly home: string };

const defaultBaseUrl = "http://[IP]:8317/v1";
const targets = ["opencode", "codex", "grokbuild", "pi-agent-run", "senpi-config"] as const;
const codexProvider = {
  wireApi: "responses",
  envKey: "CLIPROXY_API_KEY",
  requiresOpenAiAuth: true,
} as const;

export function supportedTargets(): readonly Target[] {
  return [...targets, "all"];
}

export function normalizeTarget(input: string): Target | null {
  const normalized = input.trim().toLowerCase();
  switch (normalized) {
    case "opencode":
    case "codex":
    case "grokbuild":
    case "pi-agent-run":
    case "senpi-config":
    case "all":
      return normalized;
    case "grok-build":
    case "gork-build":
      return "grokbuild";
    default:
      return null;
  }
}

export async function runSetup(target: Target, opts: SetupOptions): Promise<CliResult> {
  if (target === "all") {
    return aggregate("all", await Promise.all(targets.map((next) => runSetup(next, opts))));
  }
  switch (target) {
    case "opencode":
      return setupOpencode(opts);
    case "codex":
      return setupCodex(opts);
    case "grokbuild":
      return setupGrokbuild(opts);
    case "pi-agent-run":
      return doctorPiAgentRun(opts.home, opts.write);
    case "senpi-config":
      return setupSenpi(opts);
    default:
      return assertNever(target);
  }
}

export async function runDoctor(target: Target, opts: DoctorOptions): Promise<CliResult> {
  if (target === "all") {
    return aggregate("all", await Promise.all(targets.map((next) => runDoctor(next, opts))));
  }
  switch (target) {
    case "codex":
      return doctorCodex(opts.home);
    case "pi-agent-run":
      return doctorPiAgentRun(opts.home, true);
    case "opencode":
    case "grokbuild":
    case "senpi-config":
      return statusOnly(target, `${target} doctor has no additional checks`, true);
    default:
      return assertNever(target);
  }
}

export async function runSync(target: Target, opts: SyncOptions): Promise<CliResult> {
  if (target === "all") {
    return aggregate("all", await Promise.all(targets.map((next) => runSync(next, opts))));
  }
  if (target !== "grokbuild") {
    return statusOnly(target, `${target} has no sync adapter`, opts.write);
  }
  if (!opts.write) {
    return result({ target, status: "grokbuild sync dry-run skipped; pass --write to mutate", write: false });
  }
  const sync = await runGrokConfigSync(opts.home);
  return result({ target, status: sync.statusMessage, write: true, writes: sync.written ? [grokConfigPath(opts.home)] : [] });
}

export async function runPrintConfig(target: Target, opts: PrintConfigOptions): Promise<CliResult> {
  if (target === "all") {
    return aggregate("all", await Promise.all(targets.map((next) => runPrintConfig(next, opts))));
  }
  switch (target) {
    case "codex":
      return printCodex(opts.home);
    case "opencode":
      return printFile(target, opencodeConfigPath(opts.home));
    case "grokbuild":
      return printFile(target, grokConfigPath(opts.home));
    case "senpi-config":
      return printFile(target, senpiConfigPath(opts.home));
    case "pi-agent-run":
      return doctorPiAgentRun(opts.home, true);
    default:
      return assertNever(target);
  }
}

async function setupOpencode(opts: SetupOptions): Promise<CliResult> {
  const path = opts.config ?? opencodeConfigPath(opts.home);
  const write = await writeJsonConfigFile(path, opencodeConfig(opts.baseUrl ?? defaultBaseUrl), { dryRun: !opts.write, backup: true });
  return writeResult("opencode", write.ok ? "opencode config ready" : write.error.message, opts.write, path, write.written, write.ok ? [] : [write.error.message]);
}

async function setupCodex(opts: SetupOptions): Promise<CliResult> {
  const path = opts.config ?? codexConfigPath(opts.home);
  const write = await writeCodexConfigFile(path, { ...codexProvider, baseUrl: opts.baseUrl ?? defaultBaseUrl }, { dryRun: !opts.write, backup: true, redact: [opts.baseUrl ?? defaultBaseUrl] });
  return writeResult("codex", `codex provider ${write.provider.status}`, opts.write, path, write.write.written, write.write.ok ? [] : [write.write.error.message]);
}

async function setupGrokbuild(opts: SetupOptions): Promise<CliResult> {
  const write = await setupGrokPlugin(opts.home, { dryRun: !opts.write, target: "grokbuild" });
  return writeResult("grokbuild", write.ok ? "grokbuild hooks ready" : write.error.message, opts.write, join(opts.home, ".grok", "hooks", "hooks.json"), write.written, write.ok ? [] : [write.error.message]);
}

async function setupSenpi(opts: SetupOptions): Promise<CliResult> {
  const baseUrl = opts.baseUrl ?? defaultBaseUrl;
  const catalog = opts.write ? await fetchModels(baseUrl) : [];
  const write = await writeSenpiConfigFile(opts.config ?? senpiConfigPath(opts.home), generateSenpiConfig(catalog, { baseUrl }), { dryRun: !opts.write, backup: true });
  return writeResult("senpi-config", write.ok ? "senpi config ready" : write.error.message, opts.write, senpiConfigPath(opts.home), write.written, write.ok ? [] : [write.error.message]);
}

async function doctorCodex(home: string): Promise<CliResult> {
  const doctor = await doctorCodexConfig(codexConfigPath(home), { ...codexProvider, baseUrl: defaultBaseUrl }, [defaultBaseUrl]);
  return result({ target: "codex", status: doctor.diagnostics.join("\n"), write: true, warnings: doctor.ok ? [] : [...doctor.diagnostics] });
}

function doctorPiAgentRun(home: string, write: boolean): CliResult {
  const diagnostics = diagnosePiAgentRun({ home });
  const warnings = diagnostics.available ? [] : ["pi-agent command was not found on PATH"];
  return result({ target: "pi-agent-run", status: diagnostics.available ? "pi-agent run is available" : warnings[0], write, warnings });
}

async function printCodex(home: string): Promise<CliResult> {
  const path = codexConfigPath(home);
  const status = existsSync(path) ? await printCodexConfig(path) : "Codex config is missing at the user-level config path.";
  return result({ target: "codex", status, write: true, warnings: existsSync(path) ? [] : [status] });
}

function printFile(target: Exclude<Target, "all" | "codex" | "pi-agent-run">, path: string): CliResult {
  const exists = existsSync(path);
  const status = exists ? readFileSync(path, "utf8") : `${target} config is missing at ${path}`;
  return result({ target, status, write: true, warnings: exists ? [] : [status] });
}

function opencodeConfig(baseUrl: string): Record<string, unknown> {
  return { plugin: ["cliproxy-provider"], provider: { cliproxy: { options: { baseURL: baseUrl }, npm: "@ai-sdk/openai-compatible", name: "Cliproxy" } } };
}

function aggregate(target: Target, results: readonly CliResult[]): CliResult {
  return {
    ok: results.every((entry) => entry.ok),
    status: results.map((entry) => `${entry.target ?? "unknown"}: ${entry.status}`).join("\n"),
    target,
    dryRun: results.every((entry) => entry.dryRun),
    executed: results.some((entry) => entry.executed),
    writes: results.flatMap((entry) => entry.writes),
    warnings: results.flatMap((entry) => entry.warnings),
  };
}

function statusOnly(target: Exclude<Target, "all">, status: string, write: boolean): CliResult {
  return result({ target, status, write });
}

function writeResult(target: Exclude<Target, "all">, status: string, write: boolean, path: string, written: boolean, warnings: readonly string[]): CliResult {
  return result({ target, status, write, writes: written ? [path] : [], warnings });
}

function result(opts: { readonly target: Exclude<Target, "all">; readonly status: string; readonly write: boolean; readonly writes?: readonly string[]; readonly warnings?: readonly string[]; readonly ok?: boolean }): CliResult {
  return { ok: opts.ok ?? true, status: opts.status, target: opts.target, dryRun: !opts.write, executed: opts.write, writes: [...(opts.writes ?? [])], warnings: [...(opts.warnings ?? [])] };
}

function opencodeConfigPath(home: string): string {
  return join(home, ".config", "opencode", "opencode.json");
}

function codexConfigPath(home: string): string {
  return join(home, ".codex", "config.toml");
}

function grokConfigPath(home: string): string {
  return join(home, ".grok", "config.toml");
}

function senpiConfigPath(home: string): string {
  return join(home, ".senpi", "senpi-config.json");
}

function assertNever(value: never): never {
  throw new Error(`Unexpected target: ${String(value)}`);
}
