import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../cli/lib/logger";

/**
 * Wraps an MCP tool handler with audit logging (tool name, outcome,
 * duration). Provider plugins should wrap every tool handler they register
 * with this — it's the only record of which tools were invoked, since
 * nothing else in governor logs individual MCP calls.
 */
export function withAudit<TArgs extends unknown[]>(
  toolName: string,
  handler: (...args: TArgs) => Promise<CallToolResult>,
): (...args: TArgs) => Promise<CallToolResult> {
  return async (...args: TArgs) => {
    const start = Date.now();
    try {
      const result = await handler(...args);
      logger.info(
        `mcp tool call: ${toolName} (${result.isError ? "error" : "ok"}, ${Date.now() - start}ms)`,
      );
      return result;
    } catch (err) {
      logger.error(
        `mcp tool call: ${toolName} (threw, ${Date.now() - start}ms): ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  };
}
