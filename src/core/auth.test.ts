import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStoredAuth } from "./auth";

const previousHome = process.env.HOME;
const previousConfigHome = process.env.XDG_CONFIG_HOME;
const previousAuthFile = process.env.CLIPROXY_AUTH_FILE;
const previousApiKey = process.env.CLIPROXY_API_KEY;

function setHomeWithAuthFiles(): string {
  const home = mkdtempSync(join(tmpdir(), "cliproxy-auth-"));
  const opencodeDir = join(home, ".config", "opencode", "cliproxy");
  const codexDir = join(home, ".codex");
  mkdirSync(opencodeDir, { recursive: true });
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(
    join(opencodeDir, "auth.json"),
    JSON.stringify({ apiKey: "stale-local-key" })
  );
  writeFileSync(
    join(codexDir, "auth.json"),
    JSON.stringify({ tokens: { access_token: "codex-access-token" } })
  );
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.CLIPROXY_AUTH_FILE = join(opencodeDir, "auth.json");
  delete process.env.CLIPROXY_API_KEY;
  return home;
}

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  if (previousConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousConfigHome;
  }
  if (previousAuthFile === undefined) {
    delete process.env.CLIPROXY_AUTH_FILE;
  } else {
    process.env.CLIPROXY_AUTH_FILE = previousAuthFile;
  }
  if (previousApiKey === undefined) {
    delete process.env.CLIPROXY_API_KEY;
  } else {
    process.env.CLIPROXY_API_KEY = previousApiKey;
  }
});

describe("stored auth", () => {
  test("prefers Codex access token for the local OpenCodex responses proxy", () => {
    const home = setHomeWithAuthFiles();
    try {
      expect(readStoredAuth("http://127.0.0.1:10100/v1")?.apiKey).toBe(
        "codex-access-token"
      );
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test("keeps stored Cliproxy key for non-OpenCodex endpoints", () => {
    const home = setHomeWithAuthFiles();
    try {
      expect(readStoredAuth("http://127.0.0.1:8317/v1")?.apiKey).toBe(
        "stale-local-key"
      );
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });
});
