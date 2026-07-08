import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeTarget, runDoctor, runSetup } from "./router";

async function makeHome(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "cliproxy-cli-router-")), "home");
}

async function runCli(home: string, args: readonly string[]): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
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

describe("CLI command router", () => {
  test("setup codex dry-run succeeds without writing files", async () => {
    // Given: an isolated HOME with no Codex config.
    const home = await makeHome();

    // When: Codex setup is evaluated as a dry-run.
    const result = await runSetup("codex", { home, write: false });

    // Then: the command succeeds, reports no execution, and leaves disk untouched.
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.executed).toBe(false);
    expect(result.writes).toEqual([]);
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
  });

  test("setup codex dry-run exits zero through the CLI", async () => {
    // Given: an isolated HOME for the CLI process.
    const home = await makeHome();

    // When: Codex setup runs without --write.
    const result = await runCli(home, ["setup", "codex", "--dry-run", "--json"]);

    // Then: the process exits successfully and no Codex config is written.
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).executed).toBe(false);
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
  });

  test("setup all dry-run result serializes with executed false", async () => {
    // Given: an isolated HOME for every host adapter.
    const home = await makeHome();

    // When: every setup route is evaluated as JSON output would see it.
    const result = await runSetup("all", { home, write: false });

    // Then: the aggregate remains a dry-run and JSON preserves executed false.
    const parsed = JSON.parse(JSON.stringify(result));
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.executed).toBe(false);
  });

  test("setup all dry-run json exits zero through the CLI", async () => {
    // Given: an isolated HOME for all host adapters.
    const home = await makeHome();

    // When: setup all runs with JSON output and no --write.
    const result = await runCli(home, ["setup", "all", "--dry-run", "--json"]);

    // Then: the JSON result preserves dry-run execution state.
    const parsed = JSON.parse(result.stdout);
    expect(result.exitCode).toBe(0);
    expect(parsed.executed).toBe(false);
  });

  test("doctor codex exits through an ok router result", async () => {
    // Given: an isolated HOME with no Codex config.
    const home = await makeHome();

    // When: Codex doctor runs.
    const result = await runDoctor("codex", { home });

    // Then: doctor returns a command result instead of throwing.
    expect(result.ok).toBe(true);
    expect(result.target).toBe("codex");
    expect(result.executed).toBe(true);
  });

  test("doctor codex exits zero through the CLI", async () => {
    // Given: an isolated HOME with no Codex config.
    const home = await makeHome();

    // When: Codex doctor runs through the CLI.
    const result = await runCli(home, ["doctor", "codex", "--json"]);

    // Then: the process exits successfully with a JSON command result.
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).target).toBe("codex");
  });

  test("unknown target normalizes to null for supported-list handling", () => {
    // Given: a target outside the CLI contract.
    const input = "unknown-host";

    // When: the target is normalized.
    const result = normalizeTarget(input);

    // Then: the parser rejects it so the CLI can print the supported target list.
    expect(result).toBeNull();
  });

  test("unknown target exits nonzero with supported list through the CLI", async () => {
    // Given: an isolated HOME for an invalid target invocation.
    const home = await makeHome();

    // When: setup is called with an unknown target.
    const result = await runCli(home, ["setup", "unknown-host"]);

    // Then: the CLI rejects the target and prints the supported list.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Supported targets");
    expect(result.stderr).toContain("grokbuild");
  });

  test("gork-build normalizes to grokbuild", () => {
    // Given: the historical typo alias.
    const input = "gork-build";

    // When: the target is normalized.
    const result = normalizeTarget(input);

    // Then: the GrokBuild adapter target is selected.
    expect(result).toBe("grokbuild");
  });
});
