import { logger } from "../../cli/lib/logger";
import { openSocketModeConnection, updateSlackMessage } from "./api";
import { decideApproval } from "./approvals";
import type { SlackCredential } from "./credentials";

// Slack's interaction payload has many more fields than this — only what
// the handler below actually reads.
interface SlackInteractionPayload {
  type?: string;
  actions?: { action_id: string; value?: string }[];
  user?: { id: string; username?: string };
  response_url?: string;
  message?: { blocks?: Record<string, unknown>[] };
}

interface SocketModeEnvelope {
  type: string;
  envelope_id?: string;
  payload?: SlackInteractionPayload | string;
  reason?: string;
}

async function handleInteractionPayload(
  payload: SlackInteractionPayload,
): Promise<void> {
  const action = payload.actions?.[0];
  if (!action?.value) return;

  let value: { requestId?: string; decision?: "approved" | "denied" };
  try {
    value = JSON.parse(action.value);
  } catch {
    return;
  }
  if (!value.requestId || !value.decision) return;

  const decidedBy = payload.user?.username ?? payload.user?.id ?? "unknown";
  const updated = decideApproval(value.requestId, value.decision, decidedBy);
  if (!updated || !payload.response_url) return;

  const emoji = value.decision === "approved" ? ":white_check_mark:" : ":x:";
  const label = value.decision === "approved" ? "Approved" : "Denied";
  const statusLine = `${emoji} *${label}* by ${decidedBy}`;

  // Keep the original message (tool name + args) visible — drop only the
  // "actions" block (the buttons, now stale) and append the decision as its
  // own context line, rather than replacing the whole message with just
  // "Approved by alice" and losing what was actually approved.
  const originalBlocks = payload.message?.blocks ?? [];
  const blocks = [
    ...originalBlocks.filter((block) => block.type !== "actions"),
    { type: "context", elements: [{ type: "mrkdwn", text: statusLine }] },
  ];

  await updateSlackMessage(payload.response_url, {
    text: `${label} by ${decidedBy}`,
    blocks,
  }).catch((err) =>
    logger.error(
      `Failed to update Slack message after decision: ${err instanceof Error ? err.message : String(err)}`,
    ),
  );
}

const RECONNECT_DELAY_MS = 2000;

/**
 * Opens governor's outbound connection to Slack (Socket Mode) so button
 * clicks reach the approval gate without exposing any inbound port —
 * governor calls out to Slack, Slack never calls in, matching the
 * outbound-only shape of every other provider here. Reconnects on any
 * close (Slack's own "disconnect" notices always precede a close, so a
 * single close-triggered reconnect covers both). Fire-and-forget: there is
 * no stop(), since `governor serve` runs until the process exits.
 */
export function startSlackSocketMode(credential: SlackCredential): void {
  connect();

  async function connect(): Promise<void> {
    let url: string;
    try {
      url = await openSocketModeConnection(credential.appToken);
    } catch (err) {
      logger.error(
        `Slack Socket Mode: couldn't open a connection (${err instanceof Error ? err.message : String(err)}) — retrying in ${RECONNECT_DELAY_MS}ms.`,
      );
      setTimeout(connect, RECONNECT_DELAY_MS);
      return;
    }

    const ws = new WebSocket(url);

    ws.addEventListener("open", () => {
      logger.info("Slack Socket Mode connected.");
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      let envelope: SocketModeEnvelope;
      try {
        envelope = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (envelope.type === "interactive" && envelope.envelope_id) {
        // Ack within Slack's 3s window — the payload is handled afterward,
        // asynchronously, so a slow decideApproval/response_url update
        // never risks Slack treating this as an unacked event.
        ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
        const payload =
          typeof envelope.payload === "string"
            ? JSON.parse(envelope.payload)
            : envelope.payload;
        if (payload) void handleInteractionPayload(payload);
        return;
      }

      if (envelope.type === "disconnect") {
        logger.warn(
          `Slack Socket Mode: server requested a reconnect (${envelope.reason ?? "unknown"}).`,
        );
        // the "close" event that follows shortly after triggers the actual reconnect
      }
    });

    ws.addEventListener("close", () => {
      logger.warn(
        `Slack Socket Mode: connection closed — reconnecting in ${RECONNECT_DELAY_MS}ms.`,
      );
      setTimeout(connect, RECONNECT_DELAY_MS);
    });

    ws.addEventListener("error", () => {
      logger.error("Slack Socket Mode: connection error.");
    });
  }
}
