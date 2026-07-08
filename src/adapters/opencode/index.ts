import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import { fetchModels, serveCliproxyRouter } from "../../core";
import { cliproxyAuthHook, readStoredAuth, writeStoredAuth } from "./auth";
import {
  applyAgents,
  applyApiKey,
  applyBaseURL,
  applyModels,
  applyReasoningParams,
  type MutableConfig,
} from "./config";

const DEFAULT_BASE_URL = "http://127.0.0.1:10100/v1";
const ROUTER_HOSTNAME = "127.0.0.1";

let embeddedRouter: ReturnType<typeof serveCliproxyRouter> | undefined;
let embeddedRouterUpstreamBaseURL: string | undefined;
let embeddedRouterApiKey: string | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function embeddedRouterBaseURL(upstreamBaseURL: string, apiKey: string | undefined): string {
  if (
    !embeddedRouter ||
    embeddedRouterUpstreamBaseURL !== upstreamBaseURL ||
    embeddedRouterApiKey !== apiKey
  ) {
    embeddedRouter?.stop(true);
    embeddedRouter = serveCliproxyRouter({
      hostname: ROUTER_HOSTNAME,
      upstreamBaseURL,
      apiKey,
    });
    embeddedRouterUpstreamBaseURL = upstreamBaseURL;
    embeddedRouterApiKey = apiKey;
  }
  return `http://${ROUTER_HOSTNAME}:${embeddedRouter.port}/v1`;
}

export { cliproxyAuthHook, writeStoredAuth };

export const plugin: Plugin = (_ctx) =>
  Promise.resolve({
    config: async (config) => {
      const cfg = config as MutableConfig;
      const provider = cfg.provider?.cliproxy;
      if (!provider) {
        return;
      }

      const options = isRecord(provider.options) ? provider.options : {};
      const configuredBaseURL =
        typeof options.baseURL === "string" && options.baseURL.trim()
          ? options.baseURL.trim()
          : undefined;
      const baseURL =
        configuredBaseURL ?? process.env.CLIPROXY_BASE_URL?.trim() ?? DEFAULT_BASE_URL;

      const configuredApiKey =
        typeof options.apiKey === "string" && options.apiKey.trim()
          ? options.apiKey.trim()
          : undefined;
      const stored = configuredApiKey
        ? { apiKey: configuredApiKey }
        : readStoredAuth(baseURL);
      const apiKey = stored?.apiKey;
      applyBaseURL(cfg, embeddedRouterBaseURL(baseURL, apiKey));
      if (stored && !configuredApiKey) {
        applyApiKey(cfg, stored.apiKey);
      }

      applyAgents(cfg);
      try {
        const models = await fetchModels(baseURL, apiKey);
        applyModels(cfg, models);
      } catch (error) {
        console.error(
          "[opencode-cliproxy-provider] Failed to sync models:",
          error instanceof Error ? error.message : String(error)
        );
      }
    },
    "chat.params": (input, output) => {
      applyReasoningParams(input, output);
      return Promise.resolve();
    },
    auth: cliproxyAuthHook,
  });

export const server = plugin;

const pluginModule = {
  id: "cliproxy-provider",
  server,
} satisfies PluginModule;

export default pluginModule;
