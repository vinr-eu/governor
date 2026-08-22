const SLACK_API_BASE = "https://slack.com/api";

interface SlackApiResponse {
  ok: boolean;
  error?: string;
}

/**
 * Posts a message with an Approve/Deny button pair (Slack's Block Kit
 * "actions" block) to a channel. Each button's `value` carries the
 * requestId and its own decision as JSON — the Socket Mode client
 * (`socket-mode.ts`) reads it straight back off the click, no server-side
 * lookup needed to know which button was pressed.
 */
export async function postApprovalMessage(
  botToken: string,
  options: {
    channel: string;
    text: string;
    requestId: string;
    approveLabel: string;
    denyLabel: string;
  },
): Promise<{ channel: string; ts: string }> {
  const res = await fetch(`${SLACK_API_BASE}/chat.postMessage`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: options.channel,
      text: options.text,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: options.text } },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              style: "primary",
              text: { type: "plain_text", text: options.approveLabel },
              action_id: "governor_approve",
              value: JSON.stringify({
                requestId: options.requestId,
                decision: "approved",
              }),
            },
            {
              type: "button",
              style: "danger",
              text: { type: "plain_text", text: options.denyLabel },
              action_id: "governor_deny",
              value: JSON.stringify({
                requestId: options.requestId,
                decision: "denied",
              }),
            },
          ],
        },
      ],
    }),
  });

  const data = (await res.json()) as SlackApiResponse & {
    channel?: string;
    ts?: string;
  };
  if (!data.ok || !data.channel || !data.ts) {
    throw new Error(
      `Slack chat.postMessage failed: ${data.error ?? "unknown error"}`,
    );
  }
  return { channel: data.channel, ts: data.ts };
}

/**
 * Replaces the original approval message via the `response_url` Slack hands
 * back on every interaction — without needing the bot token or another
 * `chat.update` call keyed by channel+ts. Callers pass `blocks` to keep the
 * original message content (the tool name/args) visible and only swap the
 * buttons for a decision line, rather than wiping the whole message down to
 * just "Approved by alice". Slack tags the result "(edited)" — there's no
 * way to suppress that — but the alternative (leaving the buttons live
 * forever after a decision) is worse.
 */
export async function updateSlackMessage(
  responseUrl: string,
  options: { text: string; blocks?: Record<string, unknown>[] },
): Promise<void> {
  const res = await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      replace_original: true,
      text: options.text,
      blocks: options.blocks,
    }),
  });
  if (!res.ok) {
    throw new Error(`Slack response_url update failed: HTTP ${res.status}`);
  }
}

/**
 * Requests a fresh, single-use WebSocket URL for a Socket Mode connection —
 * governor's outbound-only alternative to an inbound webhook. The URL is
 * valid to connect with for only ~30s, so callers should dial it
 * immediately, not cache it.
 */
export async function openSocketModeConnection(
  appToken: string,
): Promise<string> {
  const res = await fetch(`${SLACK_API_BASE}/apps.connections.open`, {
    method: "POST",
    headers: { Authorization: `Bearer ${appToken}` },
  });
  const data = (await res.json()) as SlackApiResponse & { url?: string };
  if (!data.ok || !data.url) {
    throw new Error(
      `Slack apps.connections.open failed: ${data.error ?? "unknown error"}`,
    );
  }
  return data.url;
}
