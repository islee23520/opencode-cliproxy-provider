import { constants, existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { redactApiKey } from "../../core/redaction";

const piAgentCommand = "pi-agent";
const piAgentArgs = ["run"] as const;
const requiredFiles = ["~/.grok/plugins/lfg", "~/.grok/lfg.json"] as const;
const defaultCliproxyBaseUrl = "http://127.0.0.1:8317/v1";
const missingApiKeyRecommendation = "Set OPENAI_API_KEY to the Cliproxy API key; diagnostics never print the raw key.";

export type PiAgentRunDiagnostics = {
  readonly command: string;
  readonly args: readonly string[];
  readonly available: boolean;
  readonly envRecommendations: Record<string, string>;
  readonly requiredFiles: readonly string[];
};

export function diagnosePiAgentRun(opts: { readonly home: string; readonly path?: string }): PiAgentRunDiagnostics {
  return {
    command: piAgentCommand,
    args: piAgentArgs,
    available: commandAvailable(piAgentCommand, opts.path ?? process.env.PATH ?? ""),
    envRecommendations: buildEnvRecommendations(),
    requiredFiles,
  };
}

export function explainPiAgentRunDiagnostics(diagnostics: PiAgentRunDiagnostics): string {
  if (diagnostics.available) {
    return "pi-agent run is available; launch it directly with no fallback adapter.";
  }

  return "pi-agent command was not found on PATH; pi-agent-run fails closed and will not launch a fallback adapter.";
}

function commandAvailable(command: string, pathValue: string): boolean {
  return pathValue
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .some((entry) => isExecutable(join(entry, command)));
}

function isExecutable(path: string): boolean {
  if (!existsSync(path)) {
    return false;
  }

  const stats = statSync(path);
  return stats.isFile() && (stats.mode & constants.X_OK) !== 0;
}

function buildEnvRecommendations(): Record<string, string> {
  const openAiApiKey = process.env.OPENAI_API_KEY;
  const cliproxyApiKey = process.env.CLIPROXY_API_KEY;
  const recommendedApiKey = openAiApiKey ?? cliproxyApiKey;
  return {
    OPENAI_BASE_URL: defaultCliproxyBaseUrl,
    OPENAI_API_KEY: recommendedApiKey ? redactApiKey(recommendedApiKey) : missingApiKeyRecommendation,
  };
}
