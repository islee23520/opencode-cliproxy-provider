import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogModel } from "../../core/catalog";
import { ConfigParseError, parseConfigFile } from "../../core/config-writer";
import {
  generateSenpiExtension,
  updateSenpiSettings,
  writeSenpiExtension,
} from "./senpi-config";

const baseUrl = "http://[IP]:8317/v1";
const literalApiKey = "sk-live-secret";
const extensionPath = ".senpi/extensions/cliproxy-provider.ts";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cliproxy-senpi-config-"));
}

async function writeSettings(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}

function catalogModel(overrides: Partial<CatalogModel>): CatalogModel {
  return {
    id: "gpt-5.5",
    name: "GPT 5.5",
    contextWindow: 400_000,
    outputLimit: 16_384,
    reasoning: { supported: [] },
    serviceTiers: [],
    visibility: "visible",
    capabilities: {},
    supportedReasoningLevels: [],
    ...overrides,
  };
}

describe("Senpi TypeScript extension generation", () => {
  test("generates a Senpi extension that registers the Cliproxy provider", () => {
    // Given: one text-only catalog model.
    const catalog = [catalogModel({ id: "gpt-5.5", name: "GPT 5.5" })];

    // When: the Senpi extension source is rendered.
    const extension = generateSenpiExtension(catalog, { baseUrl });

    // Then: it exports an ExtensionAPI function and registers Cliproxy at runtime.
    expect(extension).toContain('import type { ExtensionAPI } from "@earendil-works/pi-agent-core";');
    expect(extension).toContain("export default function(pi: ExtensionAPI): void {");
    expect(extension).toContain('pi.registerProvider("cliproxy", {');
    expect(extension).toContain(`baseUrl: ${JSON.stringify(baseUrl)}`);
    expect(extension).toContain('api: "openai-responses"');
  });

  test("maps catalog model metadata to ProviderModelConfig fields", () => {
    // Given: a catalog model with context and output limits.
    const catalog = [
      catalogModel({
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        contextWindow: 200_000,
        outputLimit: 64_000,
      }),
    ];

    // When: the extension source is rendered.
    const extension = generateSenpiExtension(catalog, { baseUrl });

    // Then: the generated model entry uses Senpi ProviderModelConfig names.
    expect(extension).toContain('id: "claude-sonnet-4-5"');
    expect(extension).toContain('name: "Claude Sonnet 4.5"');
    expect(extension).toContain("reasoning: false");
    expect(extension).toContain('input: ["text"]');
    expect(extension).toContain("cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }");
    expect(extension).toContain("contextWindow: 200000");
    expect(extension).toContain("maxTokens: 64000");
  });

  test("adds thinkingLevelMap for reasoning-capable models", () => {
    // Given: a model that supports only low and high thinking levels.
    const catalog = [
      catalogModel({
        id: "glm-5.2[1m]",
        name: "GLM 5.2",
        reasoning: { supported: ["low", "high"], default: "high" },
        supportedReasoningLevels: ["low", "high"],
      }),
    ];

    // When: the extension source is rendered.
    const extension = generateSenpiExtension(catalog, { baseUrl });

    // Then: Senpi's four canonical thinking levels are present and unsupported levels map to null.
    expect(extension).toContain("reasoning: true");
    expect(extension).toContain("thinkingLevelMap: {");
    expect(extension).toContain("minimal: null");
    expect(extension).toContain('low: "low"');
    expect(extension).toContain("medium: null");
    expect(extension).toContain('high: "high"');
  });

  test("enables image input for image or media capable models", () => {
    // Given: catalog models with image and media capabilities.
    const catalog = [
      catalogModel({ id: "vision-model", name: "Vision", capabilities: { image: true } }),
      catalogModel({ id: "media-model", name: "Media", capabilities: { media: true } }),
    ];

    // When: the extension source is rendered.
    const extension = generateSenpiExtension(catalog, { baseUrl });

    // Then: both models can receive image inputs in Senpi.
    expect(extension.match(/input: \["text", "image"\]/g)).toHaveLength(2);
  });

  test("uses an environment apiKey reference and never embeds literal keys", () => {
    // Given: a caller-specified environment variable name.
    const catalog = [catalogModel({})];

    // When: the extension source is rendered.
    const extension = generateSenpiExtension(catalog, { baseUrl, apiKeyEnvVar: "SENPI_CLIPROXY_KEY" });

    // Then: apiKey is an env reference rather than a secret literal.
    expect(extension).toContain('apiKey: "$SENPI_CLIPROXY_KEY"');
    expect(extension).not.toContain(literalApiKey);
  });
});

describe("Senpi extension/settings file writes", () => {
  test("dry-run leaves the extension file unchanged and write creates TypeScript", async () => {
    // Given: a target extension path and generated source.
    const dir = await makeTempDir();
    const path = join(dir, extensionPath);
    const content = generateSenpiExtension([catalogModel({})], { baseUrl });

    // When: dry-run is requested.
    const dryRun = await writeSenpiExtension(path, content, { dryRun: true });

    // Then: no file is created.
    expect(dryRun.ok).toBe(true);
    expect(dryRun.written).toBe(false);
    expect(existsSync(path)).toBe(false);

    // When: write mode is requested.
    const write = await writeSenpiExtension(path, content, { dryRun: false });

    // Then: the TypeScript extension file is written.
    expect(write.ok).toBe(true);
    expect(write.written).toBe(true);
    expect(await readFile(path, "utf8")).toBe(content);
  });

  test("settings update preserves existing keys and registers extension", async () => {
    // Given: an existing Senpi settings file with unrelated user preferences.
    const dir = await makeTempDir();
    const path = join(dir, ".senpi", "settings.json");
    await writeSettings(
      path,
      JSON.stringify({ theme: "dark", defaultModel: "gpt-5.5", extensions: ["./custom.ts"] }, null, 2),
    );

    // When: settings are updated for Cliproxy.
    const result = await updateSenpiSettings(path, {
      defaultProvider: "cliproxy",
      extensions: [extensionPath],
      dryRun: false,
    });

    // Then: unrelated keys remain and extension/default provider are present.
    expect(result.ok).toBe(true);
    expect(result.written).toBe(true);
    expect(parseConfigFile(path)).toEqual({
      theme: "dark",
      defaultModel: "gpt-5.5",
      extensions: ["./custom.ts", extensionPath],
      defaultProvider: "cliproxy",
    });
  });

  test("settings dry-run leaves existing settings unchanged", async () => {
    // Given: an existing settings file.
    const dir = await makeTempDir();
    const path = join(dir, ".senpi", "settings.json");
    const original = `${JSON.stringify({ theme: "light", extensions: ["./custom.ts"] }, null, 2)}\n`;
    await writeSettings(path, original);

    // When: settings update runs in dry-run mode.
    const result = await updateSenpiSettings(path, {
      defaultProvider: "cliproxy",
      extensions: [extensionPath],
      dryRun: true,
    });

    // Then: the file is not changed.
    expect(result.ok).toBe(true);
    expect(result.written).toBe(false);
    expect(await readFile(path, "utf8")).toBe(original);
  });

  test("malformed settings JSON raises a typed error before writing", async () => {
    // Given: invalid existing settings JSON.
    const dir = await makeTempDir();
    const path = join(dir, ".senpi", "settings.json");
    await writeSettings(path, "{bad json");

    // When: settings update is attempted.
    let writeError: unknown;
    try {
      await updateSenpiSettings(path, { extensions: [extensionPath], dryRun: false });
    } catch (error) {
      writeError = error;
    }

    // Then: the original invalid file remains untouched.
    expect(writeError).toBeInstanceOf(ConfigParseError);
    expect(await readFile(path, "utf8")).toBe("{bad json");
  });
});
