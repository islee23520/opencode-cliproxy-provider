const redacted = "[REDACTED]";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactSecrets(text: string, sentinels: readonly string[]): string {
  return sentinels
    .filter((sentinel) => sentinel.length > 0)
    .reduce(
      (current, sentinel) => current.replace(new RegExp(escapeRegExp(sentinel), "g"), redacted),
      text,
    );
}

export function redactApiKey(key: string): string {
  if (key.length <= 4) {
    return "*".repeat(key.length);
  }

  return `${"*".repeat(key.length - 4)}${key.slice(-4)}`;
}
