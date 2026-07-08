import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ConfigParseError,
  formatJsonConfig,
  formatTomlConfig,
  generateBackupPath,
  parseConfigFile,
  upsertManagedBlock,
  writeConfigFile,
  writeJsonConfigFile,
  writeTomlConfigFile,
} from "./config-writer";
import { redactSecrets } from "./redaction";

const secretSentinel = "sk-test-secret";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cliproxy-config-writer-"));
}

describe("safe config writer", () => {
  test("dry-run reports a redacted diff and leaves files unchanged", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "config.json");
    const original = '{"apiKey":"old"}\n';
    await writeFile(path, original, "utf8");

    const result = await writeConfigFile(path, `{"apiKey":"${secretSentinel}"}\n`, {
      dryRun: true,
      backup: true,
    });
    const redactedDiff = redactSecrets(result.diff, [secretSentinel]);

    expect(result.ok).toBe(true);
    expect(result.written).toBe(false);
    expect(redactedDiff.includes(secretSentinel)).toBe(false);
    expect(redactedDiff).toContain("[REDACTED]");
    expect(await readFile(path, "utf8")).toBe(original);
  });

  test("write creates a timestamped backup before modifying", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "config.json");
    const original = '{"enabled":false}\n';
    await writeFile(path, original, "utf8");

    const result = await writeConfigFile(path, '{"enabled":true}\n', {
      dryRun: false,
      backup: true,
    });

    expect(result.ok).toBe(true);
    expect(result.written).toBe(true);
    expect(result.backedUp?.startsWith(`${path}.backup-`)).toBe(true);
    expect(await readFile(result.backedUp ?? "", "utf8")).toBe(original);
    expect(await readFile(path, "utf8")).toBe('{"enabled":true}\n');
  });

  test("second identical write is a no-op", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "config.toml");
    const content = 'enabled = true\nname = "cliproxy"\n';
    await writeFile(path, content, "utf8");

    const result = await writeConfigFile(path, content, {
      dryRun: false,
      backup: true,
    });
    const files = await readdir(dir);

    expect(result).toEqual({ ok: true, written: false, diff: "" });
    expect(files).toEqual(["config.toml"]);
    expect(await readFile(path, "utf8")).toBe(content);
  });

  test("malformed JSON returns a typed error without modifying the file", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "config.json");
    const original = '{"enabled":true}\n';
    await writeFile(path, original, "utf8");

    const result = await writeConfigFile(path, "{bad json", {
      dryRun: false,
      backup: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected malformed JSON to fail");
    }
    expect(result.written).toBe(false);
    expect(result.error).toBeInstanceOf(ConfigParseError);
    expect(await readFile(path, "utf8")).toBe(original);
  });

  test("malformed TOML returns a typed error without modifying the file", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "config.toml");
    const original = 'enabled = true\n';
    await writeFile(path, original, "utf8");

    const result = await writeConfigFile(path, "= bad\n", {
      dryRun: false,
      backup: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected malformed TOML to fail");
    }
    expect(result.written).toBe(false);
    expect(result.error).toBeInstanceOf(ConfigParseError);
    expect(await readFile(path, "utf8")).toBe(original);
  });

  test("managed blocks replace only their own marked content", () => {
    const original = 'keep = true\n# BEGIN cliproxy managed block: auth\nold = true\n# END cliproxy managed block: auth\nother = "same"\n';

    const updated = upsertManagedBlock(original, "auth", 'token = "redacted"');

    expect(updated).toBe('keep = true\n# BEGIN cliproxy managed block: auth\ntoken = "redacted"\n# END cliproxy managed block: auth\nother = "same"\n');
  });

  test("parses semantic JSON and simple TOML config files", async () => {
    const dir = await makeTempDir();
    const jsonPath = join(dir, "config.json");
    const tomlPath = join(dir, "config.toml");
    await writeFile(jsonPath, '{"enabled":true}\n', "utf8");
    await writeFile(tomlPath, 'enabled = true\nname = "cliproxy"\n', "utf8");

    expect(parseConfigFile(jsonPath)).toEqual({ enabled: true });
    expect(parseConfigFile(tomlPath)).toEqual({ enabled: true, name: "cliproxy" });
  });

  test("formats and writes semantic JSON and TOML config files", async () => {
    const dir = await makeTempDir();
    const jsonPath = join(dir, "semantic.json");
    const tomlPath = join(dir, "semantic.toml");

    const jsonResult = await writeJsonConfigFile(jsonPath, { enabled: true }, { dryRun: false, backup: true });
    const tomlResult = await writeTomlConfigFile(
      tomlPath,
      { enabled: true, name: "cliproxy" },
      { dryRun: false, backup: true },
    );

    expect(jsonResult.ok).toBe(true);
    expect(tomlResult.ok).toBe(true);
    expect(formatJsonConfig({ enabled: true })).toBe('{\n  "enabled": true\n}\n');
    expect(formatTomlConfig({ enabled: true, name: "cliproxy" })).toBe('enabled = true\nname = "cliproxy"\n');
    expect(parseConfigFile(jsonPath)).toEqual({ enabled: true });
    expect(parseConfigFile(tomlPath)).toEqual({ enabled: true, name: "cliproxy" });
  });

  test("generates backup paths next to the target", () => {
    expect(generateBackupPath("/tmp/config.toml", new Date("2026-07-03T01:02:03.004Z"))).toBe(
      "/tmp/config.toml.backup-20260703T010203004Z",
    );
  });
});
