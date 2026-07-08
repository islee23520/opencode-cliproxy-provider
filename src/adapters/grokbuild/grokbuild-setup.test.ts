import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupGrokPlugin } from "./grokbuild-setup";

async function makeHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cliproxy-grokbuild-setup-"));
}

describe("GrokBuild plugin setup", () => {
  test("installs SessionStart hook payload that invokes the package-owned sync command", async () => {
    const home = await makeHome();

    const result = await setupGrokPlugin(home, { dryRun: false });

    expect(result.ok).toBe(true);
    expect(result.written).toBe(true);
    const hooks = JSON.parse(await readFile(join(home, ".grok", "hooks", "hooks.json"), "utf8"));
    expect(Object.keys(hooks.hooks)).toEqual(["SessionStart"]);
    const command = hooks.hooks.SessionStart[0].hooks[0].command;
    expect(command).toContain("cliproxy-provider grokbuild sync");
    expect(command).not.toContain("@opencode-ai/plugin");
  });

  test("normalizes gork-build alias to the grokbuild target", async () => {
    const home = await makeHome();

    await setupGrokPlugin(home, { dryRun: false, target: "gork-build" });

    const hooks = await readFile(join(home, ".grok", "plugins", "grok-cliproxy-provider", "hooks", "hooks.json"), "utf8");
    expect(hooks).toContain("grokbuild sync");
    expect(hooks).not.toContain("gork-build");
  });
});
