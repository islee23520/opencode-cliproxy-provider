import { describe, expect, test } from "bun:test";
import { redactApiKey, redactSecrets } from "./redaction";

describe("auth redaction", () => {
  test("redacts sentinel values from output", () => {
    const sentinel = "sk-test-secret";

    const redacted = redactSecrets(`token=${sentinel}\ndiff: + ${sentinel}`, [sentinel]);

    expect(redacted).toContain("[REDACTED]");
    expect(redacted.includes(sentinel)).toBe(false);
  });

  test("masks api keys except the last four characters", () => {
    expect(redactApiKey("sk-live-abcdef123456")).toBe("****************3456");
    expect(redactApiKey("abc")).toBe("***");
  });
});
