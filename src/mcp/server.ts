import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "../cli/help";
import { PROVIDER_PLUGINS } from "../providers";

/**
 * Builds a fresh MCP server bound to the credentials already unlocked for
 * this `governor serve` process. Never exposes the credentials themselves —
 * tools only return what the wrapped provider API call returns.
 *
 * `credentialsByProvider` is keyed by provider id (see `PROVIDER_PLUGINS`),
 * each value being that provider's own `Map<profile, credential>`.
 */
export function createMcpServer(
  credentialsByProvider: Map<string, Map<string, unknown>>,
): McpServer {
  const server = new McpServer({ name: "governor", version: VERSION });

  for (const plugin of PROVIDER_PLUGINS) {
    const credentials = credentialsByProvider.get(plugin.id) ?? new Map();
    plugin.registerMcpTools(server, credentials);
  }

  return server;
}
