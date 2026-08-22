import { awsPlugin } from "./aws";
import { mongodbPlugin } from "./mongodb";
import { slackPlugin } from "./slack";
import type { ProviderPlugin } from "./plugin";

/**
 * Every provider governor knows about. This is the one place a new provider
 * gets wired in — implement `ProviderPlugin` in a `providers/<name>/`
 * folder and add it here; `mcp/server.ts`, `serve.ts`, and `setup.ts` all
 * work generically off this list.
 */
export const PROVIDER_PLUGINS: ProviderPlugin[] = [
  awsPlugin,
  mongodbPlugin,
  slackPlugin,
];

export function findProviderPlugin(id: string): ProviderPlugin | undefined {
  return PROVIDER_PLUGINS.find((p) => p.id === id);
}
