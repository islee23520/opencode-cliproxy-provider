import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { printCodexConfig, upsertCodexProvider, writeCodexConfigFile } from "./codex-config";

const providerOptions = {
  baseUrl: "http://127.0.0.1:8317/v1",
  wireApi: "responses",
  envKey: "CLIPROXY_API_KEY",
  requiresOpenAiAuth: true,
} as const;

async function makeTempConfigPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cliproxy-codex-config-"));
  return join(dir, "config.toml");
}

describe("Codex provider config", () => {
  test("adds active cliproxy provider and provider block when config is empty", () => {
    // Given: an empty user-level Codex config.
    const config = "";

    // When: the Cliproxy provider is upserted.
    const result = upsertCodexProvider(config, providerOptions);

    // Then: Codex gets an active cliproxy provider and a complete provider block.
    expect(result.status).toBe("missing");
    expect(result.activeProviderChanged).toBe(true);
    expect(result.config).toContain('model_provider = "cliproxy"');
    expect(result.config).toContain("[model_providers.cliproxy]");
    expect(result.config).toContain('base_url = "http://127.0.0.1:8317/v1"');
    expect(result.config).toContain('wire_api = "responses"');
    expect(result.config).toContain('env_key = "CLIPROXY_API_KEY"');
    expect(result.config).toContain("requires_openai_auth = true");
  });

  test("keeps a user-managed active provider while adding cliproxy", () => {
    // Given: Codex already has a non-cliproxy active provider.
    const config = 'model_provider = "openai"\n';

    // When: the Cliproxy provider is upserted.
    const result = upsertCodexProvider(config, providerOptions);

    // Then: the active provider is preserved and only the cliproxy table is added.
    expect(result.status).toBe("missing");
    expect(result.activeProviderChanged).toBe(false);
    expect(result.config).toContain('model_provider = "openai"');
    expect(result.config).not.toContain('model_provider = "cliproxy"');
    expect(result.config).toContain("[model_providers.cliproxy]");
  });

  test("leaves a drifted cliproxy provider block unchanged", () => {
    // Given: a user-managed cliproxy block differs from the expected provider contract.
    const config = [
      'model_provider = "cliproxy"',
      "",
      "[model_providers.cliproxy]",
      'base_url = "http://127.0.0.1:9999/v1"',
      'wire_api = "chat"',
      'env_key = "OTHER_KEY"',
      "requires_openai_auth = false",
      "",
    ].join("\n");

    // When: the Cliproxy provider is upserted.
    const result = upsertCodexProvider(config, providerOptions);

    // Then: drift is reported and no user-managed values are overwritten.
    expect(result.status).toBe("drifted");
    expect(result.activeProviderChanged).toBe(false);
    expect(result.config).toBe(config);
  });

  test("second write is an idempotent no-op", async () => {
    // Given: a temp Codex config written by the adapter once.
    const path = await makeTempConfigPath();
    const first = await writeCodexConfigFile(path, providerOptions, { dryRun: false, backup: true });

    // When: the same provider contract is written again.
    const second = await writeCodexConfigFile(path, providerOptions, { dryRun: false, backup: true });

    // Then: the second write reports no file mutation.
    expect(first.write.ok).toBe(true);
    expect(first.write.written).toBe(true);
    expect(second.provider.status).toBe("configured");
    expect(second.write).toEqual({ ok: true, written: false, diff: "" });
  });

  test("dry-run reports a redacted diff and does not write", async () => {
    // Given: a temp Codex config path and a sentinel that must not be printed.
    const path = await makeTempConfigPath();
    const secretBaseUrl = "http://token-secret.local/v1";

    // When: the write is evaluated as a dry-run.
    const result = await writeCodexConfigFile(
      path,
      { ...providerOptions, baseUrl: secretBaseUrl },
      { dryRun: true, backup: true, redact: [secretBaseUrl] },
    );

    // Then: the diff is redacted and the temp file is still absent.
    expect(result.write.ok).toBe(true);
    expect(result.write.written).toBe(false);
    expect(result.write.diff.includes(secretBaseUrl)).toBe(false);
    expect(result.write.diff).toContain("[REDACTED]");
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("print output redacts configured sentinels", async () => {
    // Given: a temp config containing a sensitive value.
    const path = await makeTempConfigPath();
    await writeFile(path, 'api_key = "sk-test-secret"\n', "utf8");

    // When: the config is printed through the adapter.
    const printed = await printCodexConfig(path, ["sk-test-secret"]);

    // Then: no secret value appears in output.
    expect(printed).toContain("[REDACTED]");
    expect(printed.includes("sk-test-secret")).toBe(false);
    expect(await readFile(path, "utf8")).toContain("sk-test-secret");
  });
});
