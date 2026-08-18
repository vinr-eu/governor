import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Vault } from "../cli/lib/vault";

export type HttpRouteHandler = (
  req: Bun.BunRequest,
) => Response | Promise<Response>;

/**
 * The contract every provider implements to plug into governor. `server.ts`,
 * `serve.ts`, and `setup.ts` only ever talk to providers through this
 * interface — adding a provider means implementing it and adding one entry
 * to `PROVIDER_PLUGINS` in `providers/index.ts`, no other file changes.
 */
export interface ProviderPlugin<TCredential = unknown> {
  id: string;
  label: string;
  authMethod: "access-key" | "api-key" | "connection-string";

  /**
   * Overrides the default "run `governor setup <id>`" guidance that `setup`
   * and `serve` show when this provider isn't configured — for a provider
   * whose credentials are all managed through `governor store` instead of
   * `governor setup` (e.g. `mongodb`, one connection string per cluster
   * rather than one account-wide credential).
   */
  setupHint?: string;

  /** Resolve this provider's credentials: from `vault` if one is unlocked, otherwise env vars. */
  loadCredentials(vault: Vault | undefined): Promise<Map<string, TCredential>>;

  /** Register this provider's tools on the shared MCP server. */
  registerMcpTools(
    server: McpServer,
    credentials: Map<string, TCredential>,
  ): void;

  /** Register this provider's REST routes (path -> handler) to merge into `Bun.serve`. */
  registerHttpRoutes?(
    credentials: Map<string, TCredential>,
  ): Record<string, HttpRouteHandler>;
}
