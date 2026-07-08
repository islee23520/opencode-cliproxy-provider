import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogModel } from "../../core/catalog";
import { runGrokConfigSync, syncGrokConfig } from "./grokbuild-sync";

const models = [
  catalogModel("gpt-5.5", 400_000, ["low", "medium", "high"]),
  catalogModel("claude-sonnet-4-6", 200_000, []),
  catalogModel("glm-5.2", undefined, ["low", "medium", "high", "xhigh"]),
] as const satisfies readonly CatalogModel[];

function catalogModel(id: string, contextWindow: number | undefined, levels: readonly string[]): CatalogModel {
  return {
    id,
    name: id,
    ...(contextWindow ? { contextWindow } : {}),
    reasoning: { supported: levels },
    serviceTiers: [],
    visibility: "visible",
    capabilities: {},
    supportedReasoningLevels: levels,
  };
}

function section(config: string, name: string): string {
  const start = config.indexOf(`[${name}]`);
  if (start === -1) {
    return "";
  }
  const rest = config.slice(start + name.length + 2);
  const next = /\n\[[^\n]+\]/.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

async function makeHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cliproxy-grokbuild-sync-"));
}

async function writeGrokConfig(home: string, config: string): Promise<string> {
  const path = join(home, ".grok", "config.toml");
  await mkdir(join(home, ".grok"), { recursive: true });
  await writeFile(path, config, { encoding: "utf8" });
  return path;
}

describe("GrokBuild config sync", () => {
  test("adds missing model sections from endpoints.models_base_url", () => {
    const baseUrl = "http://127.0.0.1:8317/v1";
    const original = `[endpoints]\nmodels_base_url = "${baseUrl}"\n\n[model."grok-4.3"]\nmodel = "grok-4.3"\nbase_url = "${baseUrl}"\n\n`;

    const result = syncGrokConfig(original, models, baseUrl, "test-key-123");

    expect(result.added).toContain("gpt-5.5");
    expect(result.added).toContain("gpt-5.5 high");
    expect(result.added).toContain("models.default");
    expect(result.config).toContain('[model."gpt-5.5"]');
    expect(section(result.config, 'model."gpt-5.5"')).toContain("supports_reasoning_effort = true");
    expect(section(result.config, 'model."gpt-5.5 high"')).toContain('model = "gpt-5.5(high)"');
    expect(section(result.config, 'model."gpt-5.5 high"')).not.toContain("supports_reasoning_effort");
    expect(result.config).toContain('api_key = "test-key-123"');
    expect(section(result.config, "models")).toContain('default = "gpt-5.5"');
  });

  test("is idempotent after the first sync", () => {
    const baseUrl = "http://127.0.0.1:8317/v1";
    const original = `[endpoints]\nmodels_base_url = "${baseUrl}"\n`;

    const first = syncGrokConfig(original, models, baseUrl, null);
    const second = syncGrokConfig(first.config, models, baseUrl, null);

    expect(second.config).toBe(first.config);
    expect(second.added).toEqual([]);
    expect(second.skipped).toBe(models.length);
  });

  test("preserves files and returns a nonblocking warning when endpoint is unreachable", async () => {
    const home = await makeHome();
    const path = await writeGrokConfig(home, '[endpoints]\nmodels_base_url = "http://127.0.0.1:1/v1"\n');
    const before = await readFile(path, "utf8");

    const result = await runGrokConfigSync(home, { fetchModels: async () => { throw new TypeError("offline"); } });

    expect(result.statusMessage).toBe("Cliproxy: endpoint unreachable, skipping sync");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("handles missing config.toml gracefully", async () => {
    const home = await makeHome();

    const result = await runGrokConfigSync(home);

    expect(result.statusMessage).toBe("Cliproxy: no config.toml found");
  });

  test("rejects unsafe model IDs", () => {
    const baseUrl = "http://127.0.0.1:8317/v1";
    const unsafeModels = [
      catalogModel("safe-model", undefined, []),
      catalogModel("bad]model", undefined, []),
      catalogModel("bad\nmodel", undefined, []),
      catalogModel("bad[ok]", undefined, []),
    ];

    const result = syncGrokConfig(`[endpoints]\nmodels_base_url = "${baseUrl}"\n`, unsafeModels, baseUrl, null);

    expect(result.config).toContain('[model."safe-model"]');
    expect(result.config).not.toContain("bad]model");
    expect(result.config).not.toContain("bad\nmodel");
    expect(result.config).not.toContain("bad[ok]");
  });
});
