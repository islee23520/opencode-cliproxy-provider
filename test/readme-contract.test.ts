/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const readme = readFileSync("README.md", "utf8");

test("README documents unified host CLI contract", () => {
  expect(readme).toContain("setup codex");
  expect(readme).toContain("setup grokbuild");
  expect(readme).toContain("setup pi-agent-run");
  expect(readme).toContain("setup senpi-config");
  expect(readme).toContain("dry-run");
  expect(readme).toContain("--write");
  expect(readme).toContain("Codex user-level config");
});

test("README does not guarantee project-local Codex provider support", () => {
  expect(readme).not.toContain("project-local Codex provider support");
  expect(readme).not.toContain("Codex project-local config is supported");
  expect(readme).not.toContain("Codex project-local provider config works");
});
