/**
 * In-memory store for pending/decided approval requests, shared by the
 * approval gate (`src/mcp/approval-gate.ts`, which creates an entry and
 * polls it) and the Socket Mode client (`socket-mode.ts`, which decides it
 * when a button is clicked) — module-level state is the only way both sides
 * see the same entry, since the Socket Mode connection has no MCP session
 * to carry it through. Not persisted: a `governor serve` restart drops
 * every pending approval.
 */
export interface ApprovalRequest {
  status: "pending" | "approved" | "denied";
  channel: string;
  createdAt: string;
  decidedBy?: string;
  decidedAt?: string;
}

const approvals = new Map<string, ApprovalRequest>();

export function createApproval(requestId: string, channel: string): void {
  approvals.set(requestId, {
    status: "pending",
    channel,
    createdAt: new Date().toISOString(),
  });
}

export function getApproval(requestId: string): ApprovalRequest | undefined {
  return approvals.get(requestId);
}

/**
 * Applies a decision received over the Socket Mode connection. Returns
 * `undefined` for an unknown requestId (e.g. a `governor serve` restart
 * since it was created). A requestId that's already decided is left
 * untouched and returned as-is — this is what makes a double-click on
 * Approve/Deny harmless rather than overwriting who actually decided.
 */
export function decideApproval(
  requestId: string,
  decision: "approved" | "denied",
  decidedBy: string,
): ApprovalRequest | undefined {
  const entry = approvals.get(requestId);
  if (!entry || entry.status !== "pending") return entry;
  entry.status = decision;
  entry.decidedBy = decidedBy;
  entry.decidedAt = new Date().toISOString();
  return entry;
}
