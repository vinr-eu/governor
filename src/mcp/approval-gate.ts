import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../cli/lib/logger";
import { postApprovalMessage } from "../providers/slack/api";
import {
  createApproval,
  getApproval,
  type ApprovalRequest,
} from "../providers/slack/approvals";
import type { SlackCredential } from "../providers/slack/credentials";

/**
 * Cross-cutting "get a human's approval before doing this" gate. Applied
 * centrally in `mcp/server.ts` (which wraps every tool's registration, for
 * every provider) rather than inline in individual tool handlers — gating a
 * tool is purely a config change (`DEFAULT_GATED_TOOLS` /
 * `--require-approval`), never a per-provider code edit.
 *
 * Deliberately NOT exposed as an MCP tool: the calling agent never sees
 * this happen and has no way to skip it — the gate is entirely
 * operator-configured and operator-authenticated (Slack credentials come
 * from the vault, not from anything the agent passes in).
 *
 * Which tools are gated defaults to `DEFAULT_GATED_TOOLS` below — active
 * automatically the moment Slack credentials exist, no flag required.
 * `governor serve --require-approval <tool>,...` overrides that default
 * list outright (not additively); `--require-approval ""` disables gating
 * even if Slack is configured.
 */
export const DEFAULT_GATED_TOOLS = [
  "aws_s3_list_buckets",
  "aws_rds_instance_query",
  "aws_elasticache_redis_command",
];

interface GateConfig {
  credential: SlackCredential;
  gatedTools: ReadonlySet<string>;
  timeoutSeconds: number;
}

let gateConfig: GateConfig | undefined;

export function configureApprovalGate(config: GateConfig): void {
  gateConfig = config;
}

const POLL_INTERVAL_MS = 1000;

async function waitForDecision(
  requestId: string,
  timeoutSeconds: number,
): Promise<ApprovalRequest> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let entry = getApproval(requestId)!;
  while (entry.status === "pending" && Date.now() < deadline) {
    await Bun.sleep(POLL_INTERVAL_MS);
    entry = getApproval(requestId)!;
  }
  return entry;
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

export type ApprovalOutcome =
  { approved: true } | { approved: false; result: CallToolResult };

/**
 * No-op (returns approved) unless the gate is configured (see
 * `configureApprovalGate`, called from `serve.ts`) and `toolName` is in its
 * gated set. When it applies, posts an approve/deny request to the
 * configured Slack channel with `summary` (a human-readable description of
 * exactly what's about to run — the whole point is informed consent, not a
 * blind "approve?"), blocks up to `timeoutSeconds`, and fails closed: a
 * denial, a timeout, or Slack being unreachable are all treated as "don't
 * proceed." Logs its own outcome — a denied/timed-out/errored call never
 * reaches the tool's own `withAudit` wrapper, since the gate sits outside
 * it, so this is the only record of a gated call that didn't go through.
 */
export async function requireApproval(
  toolName: string,
  summary: string,
): Promise<ApprovalOutcome> {
  if (!gateConfig?.gatedTools.has(toolName)) return { approved: true };

  const { credential, timeoutSeconds } = gateConfig;
  const requestId = randomUUID();

  try {
    await postApprovalMessage(credential.botToken, {
      channel: credential.channel,
      text: `*Approval requested:* \`${toolName}\`\n\`\`\`\n${summary}\n\`\`\``,
      requestId,
      approveLabel: "Approve",
      denyLabel: "Deny",
    });
  } catch (err) {
    logger.error(
      `approval gate: ${toolName} — couldn't post to Slack: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      approved: false,
      result: errorResult(
        `"${toolName}" requires Slack approval but the request couldn't be posted: ${err instanceof Error ? err.message : String(err)}`,
      ),
    };
  }
  createApproval(requestId, credential.channel);
  logger.info(`approval gate: ${toolName} — posted, requestId ${requestId}`);

  const entry = await waitForDecision(requestId, timeoutSeconds);

  if (entry.status === "approved") {
    logger.info(
      `approval gate: ${toolName} — approved by ${entry.decidedBy ?? "unknown"} (requestId ${requestId})`,
    );
    return { approved: true };
  }
  if (entry.status === "denied") {
    logger.warn(
      `approval gate: ${toolName} — denied by ${entry.decidedBy ?? "unknown"} (requestId ${requestId})`,
    );
    return {
      approved: false,
      result: errorResult(
        `"${toolName}" was denied via Slack by ${entry.decidedBy ?? "unknown"}.`,
      ),
    };
  }
  logger.warn(
    `approval gate: ${toolName} — timed out after ${timeoutSeconds}s (requestId ${requestId})`,
  );
  return {
    approved: false,
    result: errorResult(
      `"${toolName}" timed out waiting ${timeoutSeconds}s for a Slack approval decision (requestId ${requestId}) — treated as denied.`,
    ),
  };
}
