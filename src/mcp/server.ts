import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireApproval } from "./approval-gate";
import { VERSION } from "../cli/help";
import { PROVIDER_PLUGINS } from "../providers";

/**
 * Wraps `registerTool` so every tool call is checked against the approval
 * gate before it runs — centrally, at registration time, so gating a tool
 * is purely a config change (`DEFAULT_GATED_TOOLS` / `--require-approval`),
 * never a per-provider code edit. A provider's own `registerMcpTools` looks
 * completely unaware this exists.
 *
 * Every other property is forwarded to the real server, bound to it (not to
 * this proxy) so methods relying on the SDK's private class fields keep
 * working — only `registerTool` itself is intercepted.
 */
function withApprovalGating(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "registerTool") {
        return (
          name: string,
          config: unknown,
          cb: (...cbArgs: unknown[]) => unknown,
        ) => {
          const gatedCb = async (...cbArgs: unknown[]) => {
            const gate = await requireApproval(
              name,
              JSON.stringify(cbArgs[0] ?? {}, null, 2),
            );
            if (!gate.approved) return gate.result;
            return cb(...cbArgs);
          };
          // SDK's registerTool generics don't collapse cleanly through a
          // proxy shim — runtime behavior is what matters here, not the
          // tool-specific arg/return types.
          return (target.registerTool as (...a: unknown[]) => unknown)(
            name,
            config,
            gatedCb,
          );
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as McpServer;
}

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
  const gatedServer = withApprovalGating(server);

  for (const plugin of PROVIDER_PLUGINS) {
    const credentials = credentialsByProvider.get(plugin.id) ?? new Map();
    plugin.registerMcpTools(gatedServer, credentials);
  }

  return server;
}
