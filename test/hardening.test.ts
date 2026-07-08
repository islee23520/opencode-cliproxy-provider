/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorCodexConfig, writeCodexConfigFile } from "../src/adapters/codex/codex-config";
import { diagnosePiAgentRun, explainPiAgentRunDiagnostics } from "../src/adapters/pi-agent/pi-agent-run";
import { generateSenpiConfig, writeSenpiConfigFile } from "../src/adapters/senpi/senpi-config";
import { normalizeTarget } from "../src/cli/router";
import type { CatalogModel } from "../src/core/catalog";
import { parseCatalogModels } from "../src/core/catalog";
import { ConfigParseError, writeConfigFile } from "../src/core/config-writer";
import { fetchModels } from "../src/core/models";

const secret = "sk-test-secret";
const baseUrl = "http://[IP]:8317/v1";
const codexProvider = {
  baseUrl,
  wireApi: "responses",
  envKey: "CLIPROXY_API_KEY",
  requiresOpenAiAuth: true,
} as const;

type CliOutput = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

async function makeHome(prefix: string): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), prefix)), "home");
}

async function runCli(home: string, args: readonly string[]): Promise<CliOutput> {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function minimalModel(id: string): CatalogModel {
  return {
    id,
    name: id,
    reasoning: { supported: [] },
    serviceTiers: [],
    visibility: "visible",
    capabilities: {},
    supportedReasoningLevels: [],
  };
}

describe("final hardening", () => {
  test("redacts secrets from setup codex dry-run json CLI output", async () => {
    // Given: a dry-run Codex setup invocation carrying a literal secret-like URL value.
    const home = await makeHome("cliproxy-hardening-cli-");

    // When: setup emits machine-readable output.
    const result = await runCli(home, ["setup", "codex", "--dry-run", "--json", "--base-url", `http://${secret}.local/v1`]);

    // Then: the command succeeds without writing or leaking the sentinel.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, target: "codex", dryRun: true, executed: false });
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
  });

  test("reports unreachable Cliproxy endpoints with a clear diagnostic", async () => {
    // Given: an unreachable local Cliproxy endpoint.
    const unusedPort = 9;

    // When: model discovery attempts to contact it.
    const result = await fetchModels(`http://[IP]:${unusedPort}/v1`).then(
      () => "unexpected success",
      (error: unknown) => error,
    );

    // Then: the adapter returns a normal Error object with fetch context, not a crash artifact.
    expect(result).toBeInstanceOf(Error);
    if (result instanceof Error) {
      expect(result.message).toContain("fetch");
    }
  });

  test("handles catalog models with only an id field", () => {
    // Given: a minimal catalog payload from a sparse Cliproxy endpoint.
    const payload = { models: [{ id: "minimal-model" }] };

    // When: the shared parser normalizes the payload.
    const models = parseCatalogModels(payload);

    // Then: missing metadata falls back to safe defaults.
    expect(models).toEqual([minimalModel("minimal-model")]);
  });

  test("reports drifted Codex provider config without overwriting it", async () => {
    // Given: user-managed Codex TOML that does not match the expected Cliproxy provider contract.
    const home = await makeHome("cliproxy-hardening-codex-drift-");
    const path = join(home, ".codex", "config.toml");
    const drifted = [
      'model_provider = "cliproxy"',
      "",
      "[model_providers.cliproxy]",
      'base_url = "http://[IP]:9999/v1"',
      'wire_api = "chat"',
      'env_key = "OTHER_KEY"',
      "requires_openai_auth = false",
      "",
    ].join("\n");
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(path, drifted, "utf8");

    // When: setup is asked to write the Codex provider.
    const result = await writeCodexConfigFile(path, codexProvider, { dryRun: false, backup: true });

    // Then: drift is surfaced and the existing user-managed block is preserved byte-for-byte.
    expect(result.provider.status).toBe("drifted");
    expect(result.write.written).toBe(false);
    expect(await readFile(path, "utf8")).toBe(drifted);
    const doctor = await doctorCodexConfig(path, codexProvider, [baseUrl]);
    expect(doctor.diagnostics.join("\n")).toContain("Cliproxy provider block drifted");
  });

  test("malformed JSON and TOML config writes return typed errors without mutation", async () => {
    // Given: malformed next config payloads and valid existing temp files.
    const home = await makeHome("cliproxy-hardening-malformed-");
    const jsonPath = join(home, "config.json");
    const tomlPath = join(home, "config.toml");
    await mkdir(home, { recursive: true });
    await writeFile(jsonPath, '{"enabled":true}\n', "utf8");
    await writeFile(tomlPath, 'enabled = true\n', "utf8");

    // When: malformed replacement content is evaluated.
    const jsonResult = await writeConfigFile(jsonPath, "{bad json", { dryRun: false, backup: true });
    const tomlResult = await writeConfigFile(tomlPath, "= bad\n", { dryRun: false, backup: true });

    // Then: both failures are typed and both original files remain unchanged.
    expect(jsonResult.ok).toBe(false);
    expect(tomlResult.ok).toBe(false);
    if (!jsonResult.ok) {
      expect(jsonResult.error).toBeInstanceOf(ConfigParseError);
    }
    if (!tomlResult.ok) {
      expect(tomlResult.error).toBeInstanceOf(ConfigParseError);
    }
    expect(await readFile(jsonPath, "utf8")).toBe('{"enabled":true}\n');
    expect(await readFile(tomlPath, "utf8")).toBe('enabled = true\n');
  });

  test("normalizes GrokBuild target aliases", () => {
    // Given: the supported GrokBuild spellings and historical typo.
    const targets = ["grok-build", "gork-build"] as const;

    // When/Then: both aliases select the same canonical adapter target.
    expect(targets.map((target) => normalizeTarget(target))).toEqual(["grokbuild", "grokbuild"]);
  });

  test("keeps pi-agent-run diagnostics and Senpi config output separated", async () => {
    // Given: isolated temp paths for diagnostics-only Pi and generated Senpi config.
    const home = await makeHome("cliproxy-hardening-pi-senpi-");
    const senpiPath = join(home, ".senpi", "senpi-config.json");

    // When: Pi diagnostics and Senpi config generation run independently.
    const piDiagnostics = explainPiAgentRunDiagnostics(diagnosePiAgentRun({ home, path: "" }));
    const senpiWrite = await writeSenpiConfigFile(
      senpiPath,
      generateSenpiConfig([minimalModel("gpt-5.5")], { baseUrl }),
      { dryRun: false, backup: true },
    );
    const senpiConfig = await readFile(senpiPath, "utf8");

    // Then: each surface mentions only its own host responsibility.
    expect(piDiagnostics).toContain("pi-agent-run");
    expect(piDiagnostics).not.toContain("Senpi");
    expect(senpiWrite.ok).toBe(true);
    expect(senpiConfig).toContain("cliproxy");
    expect(senpiConfig).not.toContain("pi-agent run");
  });
});
