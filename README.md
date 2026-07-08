# cliproxy-provider

Unified [Cliproxy](https://github.com/sisyphuslabs/cliproxy) provider/router package for multiple coding agent hosts. It installs host-specific configuration, prints generated config, runs diagnostics, syncs verified hooks, and can serve a local OpenAI-compatible router in front of a Cliproxy `/v1` endpoint.

## Overview

`cliproxy-provider` gives OpenCode, Codex, GrokBuild, pi-agent-run diagnostics, and Senpi/Pi-style config generation one package and one CLI:

- Discovers Cliproxy models from `GET /v1/models?client_version` for router/model surfaces.
- Keeps host adapters separate while sharing model, reasoning, redaction, and safe-write primitives.
- Preserves OpenCode plugin behavior, including provider registration and auth-file fallback.
- Supports Codex user-level config only; project-local Codex config is intentionally not claimed or written.
- Installs only fixture-verified GrokBuild hook wiring.
- Treats pi-agent-run as diagnostics-only and Senpi/Pi as config-generation-only.

## Host Support Matrix

| Host | Setup Command | Config Path | Status |
|---|---|---|---|
| OpenCode | `setup opencode` | `~/.config/opencode/opencode.json` | Full plugin support |
| Codex | `setup codex` | `~/.codex/config.toml` | Codex user-level config (project-local unsupported) |
| GrokBuild | `setup grokbuild` | `~/.grok/config.toml` | Model sync hook |
| pi-agent-run | `doctor pi-agent-run` | PATH + `~/.grok/` | Diagnostics only |
| Senpi/Pi | `setup senpi-config` | Caller-specified JSON | Config generation only |

`setup pi-agent-run` is accepted by the unified setup router, but it reports the same diagnostics-only pi-agent-run status instead of writing host provider config.

## Install

```bash
bun add cliproxy-provider
# or
npm install cliproxy-provider
```

The package exposes the `cliproxy-provider` binary. The legacy `opencode-cliproxy-provider` binary remains available for compatibility.

## Quick Start

Preview all supported host setup actions without mutating files:

```bash
npx cliproxy-provider setup all --dry-run
```

Write a specific host config only when the dry-run output looks right:

```bash
npx cliproxy-provider setup opencode --write
npx cliproxy-provider setup codex --write
npx cliproxy-provider setup grokbuild --write
npx cliproxy-provider setup senpi-config --config ./senpi-config.json --write
```

Run pi-agent-run diagnostics separately:

```bash
npx cliproxy-provider doctor pi-agent-run
```

## CLI Commands

All setup and sync commands are dry-run by default. Pass `--write` to mutate files. Pass `--json` for machine-readable command results.

### `setup <target>`

Generates or prepares host configuration for `opencode`, `codex`, `grokbuild`, `pi-agent-run`, `senpi-config`, or `all`.

```bash
npx cliproxy-provider setup codex --dry-run
npx cliproxy-provider setup grokbuild --write
npx cliproxy-provider setup pi-agent-run --json
```

Aliases `grok-build` and `gork-build` normalize to `grokbuild`.

### `sync <target>`

Runs host sync operations. Today only `grokbuild` has a sync adapter; other targets report that no sync adapter exists.

```bash
npx cliproxy-provider sync grokbuild --write
```

### `doctor <target>`

Runs diagnostics. Codex checks the user-level provider config, and pi-agent-run checks PATH plus expected Grok/LFG files under `~/.grok/`.

```bash
npx cliproxy-provider doctor codex
npx cliproxy-provider doctor pi-agent-run --json
```

### `print-config <target>`

Prints the current host config where the adapter has a config file path. For pi-agent-run it prints diagnostics because there is no provider config file to print.

```bash
npx cliproxy-provider print-config codex
npx cliproxy-provider print-config opencode --json
```

### `serve`

Starts a local OpenAI-compatible router that forwards to the upstream Cliproxy endpoint.

```bash
npx cliproxy-provider serve --host [IP] --port 8321 --upstream-base-url http://[IP]:8317/v1
```

Point compatible clients at:

```text
http://[IP]:8321/v1
```

### `models`

Prints discovered Cliproxy models as OpenAI-compatible model data. Add `--catalog` to print the normalized catalog shape.

```bash
npx cliproxy-provider models --upstream-base-url http://[IP]:8317/v1
npx cliproxy-provider models --catalog --json
```

### `help`

Prints CLI usage, targets, legacy alias, and common options.

```bash
npx cliproxy-provider help
```

## Safety Policy

- **dry-run first:** `setup` and `sync` do not mutate files unless `--write` is passed. `--dry-run` is documented for readability; dry-run is already the default.
- **explicit mutation:** `--write` is required before adapters write or sync files.
- **machine output:** `--json` emits structured command results for scripts and CI.
- **secret redaction:** config writer and diagnostics paths redact configured secrets/API keys in user-visible output.
- **backup on write:** file-writing adapters request backups when they mutate config files.
- **host boundaries:** adapters only claim the host behavior they implement; diagnostics-only and generation-only paths do not imply live host consumption.

## API Key

Preferred OpenCode path:

```bash
opencode auth login -p cliproxy -m "API key"
```

Runtime priority order for OpenCode/router-compatible paths:

1. OpenCode auth for provider `cliproxy`
2. Existing `provider.cliproxy.options.apiKey`
3. `CLIPROXY_API_KEY` environment variable
4. `CLIPROXY_AUTH_FILE` environment variable pointing at JSON like `{ "apiKey": "..." }`
5. `~/.config/opencode/cliproxy/auth.json`

Legacy fallback file helper:

```typescript
import { writeStoredAuth } from "cliproxy-provider";

writeStoredAuth("sk-your-key");
```

For generated external-host config, prefer environment-variable references such as `CLIPROXY_API_KEY` over embedding secrets in config files.

## Known Limitations

- Codex project-local config is unsupported; use `setup codex` for the user-level `~/.codex/config.toml` path.
- GrokBuild hook events are limited to the verified fixture-backed event set installed by `setup grokbuild`.
- pi-agent-run is diagnostics-only; `doctor pi-agent-run` checks availability and expected local files but does not launch a fallback adapter.
- `senpi-config` is generation-only; `setup senpi-config` writes or prints config but does not prove live Senpi/Pi host consumption.

## Migration

### From `codex-cliproxy-provider`

Install `cliproxy-provider`, then run the unified Codex setup command:

```bash
npx cliproxy-provider setup codex --dry-run
npx cliproxy-provider setup codex --write
```

This targets the Codex user-level config at `~/.codex/config.toml`.

### From `grok-cliproxy-provider`

Install `cliproxy-provider`, then run the unified GrokBuild setup command:

```bash
npx cliproxy-provider setup grokbuild --dry-run
npx cliproxy-provider setup grokbuild --write
```

Use the sync command when you need the verified GrokBuild model sync hook to refresh model config:

```bash
npx cliproxy-provider sync grokbuild --write
```

## License

MIT
