import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type WriteResult, writeConfigFile } from "../../core/config-writer";

type GrokSetupOptions = {
  readonly dryRun: boolean;
  readonly target?: string;
};

const pluginDirName = "grok-cliproxy-provider";
const hookPayload = {
  hooks: {
    SessionStart: [
      {
        hooks: [
          {
            type: "command",
            command: "cliproxy-provider grokbuild sync",
            timeout: 5,
            description: "cliproxy model auto-sync (SessionStart)",
            statusMessage: "Cliproxy: syncing models",
          },
        ],
      },
    ],
  },
} as const;

type HookPayload = {
  readonly hooks: {
    readonly SessionStart: readonly [
      {
        readonly hooks: readonly [
          {
            readonly type: "command";
            readonly command: string;
            readonly timeout: number;
            readonly description: string;
            readonly statusMessage: string;
          },
        ];
      },
    ];
  };
};

export async function setupGrokPlugin(home: string, opts: GrokSetupOptions): Promise<WriteResult> {
  normalizeGrokTarget(opts.target ?? "grokbuild");
  const pluginRoot = join(home, ".grok", "plugins", pluginDirName);
  const pluginHooksPath = join(pluginRoot, "hooks", "hooks.json");
  const activeHooksPath = join(home, ".grok", "hooks", "hooks.json");
  const payload = `${JSON.stringify(hookPayload, null, 2)}\n`;
  const activePayload = `${JSON.stringify(resolveHookPayload(pluginRoot), null, 2)}\n`;

  if (!opts.dryRun) {
    await mkdir(join(pluginRoot, "hooks"), { recursive: true });
    await mkdir(join(home, ".grok", "hooks"), { recursive: true });
    await writeFile(pluginHooksPath, payload, "utf8");
  }
  return writeConfigFile(activeHooksPath, activePayload, { dryRun: opts.dryRun, backup: true });
}

function normalizeGrokTarget(target: string): string {
  return target.trim().toLowerCase() === "gork-build" ? "grokbuild" : target.trim().toLowerCase();
}

function resolveHookPayload(pluginRoot: string): HookPayload {
  return {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              ...hookPayload.hooks.SessionStart[0].hooks[0],
              command: hookPayload.hooks.SessionStart[0].hooks[0].command.replace(/\$\{GROK_PLUGIN_ROOT\}/g, pluginRoot),
            },
          ],
        },
      ],
    },
  };
}
