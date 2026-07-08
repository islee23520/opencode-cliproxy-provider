import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorCodexConfig } from "./codex-config";

const providerOptions = {
  baseUrl: "http://127.0.0.1:8317/v1",
  wireApi: "responses",
  envKey: "CLIPROXY_API_KEY",
  requiresOpenAiAuth: true,
} as const;

async function makeTempConfigPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cliproxy-codex-doctor-"));
  return join(dir, "config.toml");
}

describe("Codex config doctor", () => {
  test("reports a missing user-level config without touching disk", async () => {
    // Given: no Codex config exists at the temp path.
    const path = await makeTempConfigPath();

    // When: doctor inspects the path.
    const result = await doctorCodexConfig(path, providerOptions);

    // Then: the missing provider is actionable and no write is performed.
    expect(result.ok).toBe(false);
    expect(result.provider.status).toBe("missing");
    expect(result.diagnostics.join("\n")).toContain("Codex config is missing");
    expect(result.diagnostics.join("\n")).toContain("Cliproxy provider block is missing");
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("reports configured cliproxy provider as healthy", async () => {
    // Given: a complete user-level Codex config.
    const path = await makeTempConfigPath();
    await writeFile(
      path,
      [
        'model_provider = "cliproxy"',
        "",
        "[model_providers.cliproxy]",
        'base_url = "http://127.0.0.1:8317/v1"',
        'wire_api = "responses"',
        'env_key = "CLIPROXY_API_KEY"',
        "requires_openai_auth = true",
        "",
      ].join("\n"),
      "utf8",
    );

    // When: doctor inspects the path.
    const result = await doctorCodexConfig(path, providerOptions);

    // Then: no warning is emitted.
    expect(result.ok).toBe(true);
    expect(result.provider.status).toBe("configured");
    expect(result.diagnostics).toEqual(["Codex Cliproxy provider is configured."]);
  });

  test("warns when the active provider is user-managed", async () => {
    // Given: the provider block is configured but active provider remains openai.
    const path = await makeTempConfigPath();
    await writeFile(
      path,
      [
        'model_provider = "openai"',
        "",
        "[model_providers.cliproxy]",
        'base_url = "http://127.0.0.1:8317/v1"',
        'wire_api = "responses"',
        'env_key = "CLIPROXY_API_KEY"',
        "requires_openai_auth = true",
        "",
      ].join("\n"),
      "utf8",
    );

    // When: doctor inspects the path.
    const result = await doctorCodexConfig(path, providerOptions);

    // Then: provider config is accepted, with an active-provider warning.
    expect(result.ok).toBe(false);
    expect(result.provider.status).toBe("configured");
    expect(result.diagnostics).toContain('Codex active provider is user-managed: "openai".');
  });

  test("reports drift without leaking sensitive config values", async () => {
    // Given: a drifted config containing a sensitive base URL token.
    const path = await makeTempConfigPath();
    const sensitiveUrl = "http://token-secret.local/v1";
    await writeFile(
      path,
      [
        'model_provider = "cliproxy"',
        "",
        "[model_providers.cliproxy]",
        `base_url = "${sensitiveUrl}"`,
        'wire_api = "chat"',
        'env_key = "OTHER_KEY"',
        "requires_openai_auth = false",
        "",
      ].join("\n"),
      "utf8",
    );

    // When: doctor inspects with redaction sentinels.
    const result = await doctorCodexConfig(path, providerOptions, [sensitiveUrl]);

    // Then: drift is reported and the sensitive value is redacted.
    expect(result.ok).toBe(false);
    expect(result.provider.status).toBe("drifted");
    expect(result.diagnostics.join("\n")).toContain("Cliproxy provider block drifted");
    expect(result.diagnostics.join("\n")).toContain("[REDACTED]");
    expect(result.diagnostics.join("\n").includes(sensitiveUrl)).toBe(false);
  });
});
