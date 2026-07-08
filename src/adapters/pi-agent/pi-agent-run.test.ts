import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { diagnosePiAgentRun, explainPiAgentRunDiagnostics } from "./pi-agent-run";

const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalCliproxyApiKey = process.env.CLIPROXY_API_KEY;

afterEach(() => {
  process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  process.env.CLIPROXY_API_KEY = originalCliproxyApiKey;
});

describe("pi-agent run diagnostics", () => {
  test("reports the local pi-agent run command when pi-agent is executable on PATH", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "pi-agent-run-"));
    const piAgentPath = join(binDir, "pi-agent");
    await writeFile(piAgentPath, "#!/bin/sh\nexit 0\n");
    await chmod(piAgentPath, 0o755);

    const diagnostics = diagnosePiAgentRun({ home: "/tmp/home", path: binDir });

    expect(diagnostics.available).toBe(true);
    expect(diagnostics.command).toBe("pi-agent");
    expect(diagnostics.args).toEqual(["run"]);
    expect(diagnostics.requiredFiles).toEqual(["~/.grok/plugins/lfg", "~/.grok/lfg.json"]);
    expect(explainPiAgentRunDiagnostics(diagnostics)).toContain("no fallback adapter");
  });

  test("reports fail-closed diagnostics when pi-agent is missing", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "pi-agent-run-missing-"));
    await mkdir(join(binDir, "nested"));

    const diagnostics = diagnosePiAgentRun({ home: "/tmp/home", path: binDir });
    const diagnosticText = explainPiAgentRunDiagnostics(diagnostics);

    expect(diagnostics.available).toBe(false);
    expect(diagnostics.command).toBe("pi-agent");
    expect(diagnostics.args).toEqual(["run"]);
    expect(diagnosticText).toContain("not found on PATH");
    expect(diagnosticText).toContain("fails closed");
    expect(diagnosticText).toContain("will not launch a fallback adapter");
  });

  test("redacts API keys in env recommendations", () => {
    process.env.OPENAI_API_KEY = "sk-test-secret-123456";
    process.env.CLIPROXY_API_KEY = "sk-cliproxy-secret-abcdef";

    const diagnostics = diagnosePiAgentRun({ home: "/tmp/home", path: "" });
    const output = JSON.stringify(diagnostics.envRecommendations);

    expect(diagnostics.envRecommendations.OPENAI_BASE_URL).toBe("http://127.0.0.1:8317/v1");
    expect(diagnostics.envRecommendations.OPENAI_API_KEY).toBe("*****************3456");
    expect(output.includes("sk-test-secret-123456")).toBe(false);
    expect(output.includes("sk-cliproxy-secret-abcdef")).toBe(false);
  });
});
