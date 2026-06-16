# opencode-cliproxy-provider

OpenCode plugin that auto-syncs [Cliproxy](https://github.com/sisyphuslabs/cliproxy) models and reasoning levels.

## What it does

- **Auto-discovers models** from your Cliproxy server (`GET /v1/models?client_version`) and registers them in OpenCode with correct context windows, output limits, and reasoning capabilities.
- **Maps `variant` → `reasoningEffort`** automatically. Set `variant` on any agent (short name or display name) and the provider resolves the correct reasoning effort at request time.
- **Keeps your API key out of `opencode.json`** — stored in a `0o600` file at `~/.config/opencode/cliproxy/auth.json`.

## Install

```bash
bun add opencode-cliproxy-provider
```

Then add to your `opencode.json`:

```jsonc
{
  "plugin": [
    "opencode-cliproxy-provider"
  ],
  "provider": {
    "cliproxy": {
      "options": {
        "baseURL": "http://127.0.0.1:8317/v1"
      },
      "npm": "@ai-sdk/openai-compatible",
      "name": "Cliproxy"
    }
  }
}
```

## API key

Priority order:

1. `CLIPROXY_API_KEY` env var
2. `CLIPROXY_AUTH_FILE` env var (path to a JSON file with `{"apiKey": "..."}`)
3. `~/.config/opencode/cliproxy/auth.json`

To save a key programmatically:

```typescript
import { writeStoredAuth } from "opencode-cliproxy-provider";
writeStoredAuth("sk-your-key");
```

## Variant → Reasoning Effort

The provider reads `variant` from agent configs and translates it to `reasoningEffort` / `reasoning_effort` at the API level. Agent names are normalized generically — display names like `"Hephaestus - Deep Agent"` or `"Prometheus (Plan Builder)"` are resolved to their config keys automatically, no hardcoded aliases needed.

```jsonc
// oh-my-openagent.json or opencode.json
{
  "agents": {
    "my-agent": {
      "model": "cliproxy/gpt-5.5",
      "variant": "high"
    }
  }
}
```

At runtime, reasoning effort priority is:

1. **Agent-level variant** (from config)
2. **Message/model variant** (passed at request time)
3. **Model default** (from Cliproxy catalog)

## How it works

```
config hook          → fetch models, register variants, store agent→variant map
chat.params hook     → resolve agent name, look up variant, set reasoningEffort
```

## License

MIT
