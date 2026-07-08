#!/usr/bin/env node
import { fetchModels, modelsCatalogPayload, readStoredAuth, serveCliproxyRouter } from "./core";
import { normalizeTarget, runDoctor, runPrintConfig, runSetup, runSync, supportedTargets, type Target } from "./cli/router";

type Command = "setup" | "serve" | "models" | "sync" | "doctor" | "print-config" | "help";

type CliArgs = {
  command: Command;
  target: Target | null;
  rawTarget?: string;
  baseUrl?: string;
  upstreamBaseUrl?: string;
  apiKey?: string;
  host?: string;
  port?: number;
  catalog: boolean;
  help: boolean;
  json: boolean;
  write: boolean;
  config?: string;
};

const defaultBaseUrl = "http://[IP]:8317/v1";

function parseArgs(argv: readonly string[]): CliArgs {
  const first = argv[0];
  if (first === "grokbuild") {
    const subcommand = argv[1] === "setup" ? "setup" : "sync";
    const flags = argv.slice(argv[1] === "setup" || argv[1] === "sync" ? 2 : 1);
    return {
      command: subcommand,
      target: "grokbuild",
      rawTarget: "grokbuild",
      catalog: flags.includes("--catalog"),
      help: flags.includes("--help") || flags.includes("-h"),
      json: flags.includes("--json"),
      write: subcommand === "sync" ? flags.includes("--write") : flags.includes("--write"),
      ...parseFlagValues(flags),
    };
  }
  const command = parseCommand(first);
  const targetIndex = command === "setup" && first !== "setup" ? 0 : 1;
  const rawTarget = argv[targetIndex]?.startsWith("-") ? undefined : argv[targetIndex];
  const flags = argv.slice(rawTarget ? targetIndex + 1 : targetIndex);
  return {
    command,
    target: normalizeTarget(rawTarget ?? "opencode"),
    ...(rawTarget ? { rawTarget } : {}),
    catalog: flags.includes("--catalog"),
    help: flags.includes("--help") || flags.includes("-h"),
    json: flags.includes("--json"),
    write: flags.includes("--write"),
    ...parseFlagValues(flags),
  };
}

function parseCommand(value: string | undefined): Command {
  switch (value) {
    case "setup":
    case "serve":
    case "models":
    case "sync":
    case "doctor":
    case "print-config":
    case "help":
      return value;
    default:
      return "setup";
  }
}

function parseFlagValues(flags: readonly string[]): Partial<CliArgs> {
  const values: Partial<CliArgs> = {};
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    const next = flags[index + 1];
    if (!next) {
      continue;
    }
    switch (flag) {
      case "--baseURL":
      case "--base-url":
      case "-u":
        values.baseUrl = next;
        index += 1;
        break;
      case "--upstream-baseURL":
      case "--upstream-base-url":
        values.upstreamBaseUrl = next;
        index += 1;
        break;
      case "--apiKey":
      case "--api-key":
      case "-k":
        values.apiKey = next;
        index += 1;
        break;
      case "--host":
        values.host = next;
        index += 1;
        break;
      case "--port":
      case "-p": {
        const port = Number.parseInt(next, 10);
        if (Number.isFinite(port)) {
          values.port = port;
        }
        index += 1;
        break;
      }
      case "--config":
        values.config = next;
        index += 1;
        break;
    }
  }
  return values;
}

function printHelp(): void {
  console.log(`
cliproxy-provider

Usage:
  npx cliproxy-provider setup [target] [--dry-run] [--write] [--json]
  npx cliproxy-provider sync [target] [--write] [--json]
  npx cliproxy-provider doctor [target] [--json]
  npx cliproxy-provider print-config [target] [--json]
  npx cliproxy-provider serve [options]
  npx cliproxy-provider models [options]

Targets:
  ${supportedTargets().join(", ")}

Legacy alias:
  npx opencode-cliproxy-provider <command> [options]

Options:
  --baseURL, -u <url>       Cliproxy server URL (default: ${defaultBaseUrl})
  --upstream-base-url <url> Upstream Cliproxy URL for serve/models
  --apiKey, -k <key>        Legacy fallback API key for router/models commands
  --host <host>             Router host for serve (default: [IP])
  --port, -p <port>         Router port for serve (default: random free port)
  --config <path>           Override setup/print config path where supported
  --catalog                 Print catalog shape from models command
  --json                    Print command result as JSON
  --write                   Mutate files; setup/sync dry-run by default
  -h, --help                Show this help
`);
}

async function runModels(args: CliArgs): Promise<void> {
  const baseUrl = args.upstreamBaseUrl ?? args.baseUrl ?? defaultBaseUrl;
  const models = await fetchModels(baseUrl, args.apiKey ?? readStoredAuth()?.apiKey);
  console.log(JSON.stringify(args.catalog ? modelsCatalogPayload(models) : { data: models }, null, 2));
}

function runServe(args: CliArgs): void {
  const upstreamBaseURL = args.upstreamBaseUrl ?? args.baseUrl ?? defaultBaseUrl;
  const server = serveCliproxyRouter({
    upstreamBaseURL,
    apiKey: args.apiKey ?? readStoredAuth()?.apiKey,
    hostname: args.host,
    port: args.port,
  });
  console.log(JSON.stringify({ ok: true, url: `http://${server.hostname}:${server.port}`, upstreamBaseURL }));
}

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "";
}

function ensureTarget(args: CliArgs): Target {
  if (args.target) {
    return args.target;
  }
  console.error(`Unknown target: ${args.rawTarget ?? ""}. Supported targets: ${supportedTargets().join(", ")}`);
  process.exit(1);
}

function printCommandResult(result: Awaited<ReturnType<typeof runSetup>>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(result.status);
  for (const warning of result.warnings) {
    console.error(warning);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.command === "help") {
    printHelp();
    return;
  }
  if (args.command === "models") {
    await runModels(args);
    return;
  }
  if (args.command === "serve") {
    runServe(args);
    return;
  }
  const home = homeDir();
  const target = ensureTarget(args);
  switch (args.command) {
    case "setup":
      printCommandResult(await runSetup(target, { baseUrl: args.baseUrl, write: args.write, config: args.config, home }), args.json);
      return;
    case "sync":
      printCommandResult(await runSync(target, { home, write: args.write }), args.json);
      return;
    case "doctor":
      printCommandResult(await runDoctor(target, { home }), args.json);
      return;
    case "print-config":
      printCommandResult(await runPrintConfig(target, { home }), args.json);
      return;
    default:
      assertNever(args.command);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected command: ${String(value)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
