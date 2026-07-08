import type { AuthHook } from "@opencode-ai/plugin";
import { apiKeyFromAuth, readStoredAuth, writeStoredAuth } from "../../core/auth";

export const PROVIDER_ID = "cliproxy";

export { apiKeyFromAuth, readStoredAuth, writeStoredAuth };

export const cliproxyAuthHook = {
  provider: PROVIDER_ID,
  loader: async (auth, _provider) => {
    const apiKey = apiKeyFromAuth(await auth());
    return apiKey ? { apiKey } : {};
  },
  methods: [
    {
      type: "api",
      label: "API key",
    },
  ],
} satisfies AuthHook;
