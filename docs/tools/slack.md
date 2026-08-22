# Slack

Slack backs governor's own **approval gate** — it isn't an MCP tool an agent calls. Whenever a Slack credential is
configured, `aws_rds_instance_query`, `aws_elasticache_redis_command`, and `aws_s3_list_buckets` require a human to
click Approve/Deny in Slack before they run, automatically, no flag needed — invisible to (and un-skippable by) the
calling agent. The agent just sees the tool call take longer than usual and either succeed or come back denied.

The gate is applied centrally, at the tool-registration layer (`src/mcp/server.ts`), not inside each tool's own code
— so which tools are gated is purely a name in a list (`DEFAULT_GATED_TOOLS` in `src/mcp/approval-gate.ts`, or
`--require-approval` below), never a per-provider code change. It works for any tool from any provider, not just
AWS's.

There is no `slack_*` MCP tool. If you're looking for tool docs to point an agent at, there's nothing here to add —
this page is entirely about configuring the gate.

Governor connects to Slack via **Socket Mode** — an outbound WebSocket governor itself opens, not an inbound
webhook. Approve/Deny clicks arrive over that connection. Nothing about governor needs to be exposed to the
internet: no public URL, no reverse proxy, no tunnel, `--host` stays at its loopback-only default. This is
deliberate — governor's whole design is outbound-only (it calls out to AWS/MongoDB/Slack; nothing calls in except
the agent itself over `/mcp`), and Socket Mode is the one Slack integration style that doesn't break that.

## Setting it up

### 1. Create a Slack app

At <https://api.slack.com/apps>:

- **Socket Mode** → turn it on.
- **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes** → add scope `connections:write` →
  copy the token (starts with `xapp-`).
- **OAuth & Permissions** → bot token scope `chat:write` → install to workspace → copy the **Bot User OAuth Token**
  (starts with `xoxb-`).
- **Interactivity & Shortcuts** → turn it on. (Required for button clicks to be delivered at all, even under Socket
  Mode — but leave the Request URL field blank; with Socket Mode on, interaction payloads are delivered over the
  socket instead, so there is no URL to fill in.)
- Invite the bot to the channel you want approval requests posted to (`/invite @<your-bot-name>` in that channel),
  and note the channel's ID.

### 2. Store the credential

```sh
governor store slack-credential --channel <channel-id> [--profile name] [--bot-token value] [--app-token value]
# prompts for the bot token, app-level token, and channel (whichever weren't passed as flags),
# then the vault's master password
```

`governor setup slack` isn't a thing — running it just points you back at `governor store slack-credential`. If no
vault exists at all (env-var fallback, e.g. CI), `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN`/`SLACK_APPROVAL_CHANNEL` are
used for a single profile named `"default"`.

### 3. (Optional) override which tools are gated

That's it — as soon as `governor store slack-credential` has been run and `governor serve` is restarted, it opens a
Socket Mode connection and the default gated tools (`aws_rds_instance_query`, `aws_elasticache_redis_command`,
`aws_s3_list_buckets`) require approval automatically. To change that list:

```sh
governor serve --require-approval aws_rds_instance_query,mongodb_query
# --require-approval "" disables gating entirely, even with Slack configured
# optional: --approval-timeout-seconds 300 (the default)
```

`--require-approval` takes a comma-separated list of MCP tool names and **replaces** the default list outright (not
additively) — pass every tool you want gated, from any provider. If the resulting list is non-empty but no Slack
credentials are configured, `governor serve` refuses to start rather than silently running ungated; if it's the
default list (no flag given at all) and Slack isn't configured, those tools just run ungated, logged once at
startup. Either way, the Socket Mode connection only opens when the gate actually ends up active — no Slack
connection at all if nothing ends up gated.

## What actually happens on a gated call

1. The agent calls a gated tool (e.g. `aws_rds_instance_query`) exactly as it always would.
2. Before the tool's own handler runs at all — before any of its own validation (profile exists, bastion key found,
   etc.) — governor posts a message to the configured channel: the tool name plus the call's arguments as JSON, so
   the approver sees exactly what's about to run (the SQL statement, the Redis command and args) — informed consent,
   not a blind "approve?". Because this happens ahead of the tool's own validation, a call that would've failed
   anyway (e.g. an unknown profile) still triggers a Slack post before failing.
3. The tool call blocks (polling in-process, ~1s interval) until someone clicks Approve/Deny, or until
   `--approval-timeout-seconds` elapses (default 300s).
4. The click is delivered to governor over the Socket Mode connection, acknowledged within Slack's 3s window, then
   handled asynchronously.
5. **Approved** → the tool's real handler runs and its result (or its own error, e.g. "not connected") comes back
   normally. **Denied, timed out, or Slack unreachable** → all fail closed: the tool call returns an error, the
   handler never runs.
6. The Slack message updates in place via the click's `response_url`: the original request (tool name + args) stays
   visible, the now-stale Approve/Deny buttons are removed, and a line showing who decided and how
   (`✅ Approved by @alice` / `❌ Denied by @alice`) is appended below it. Slack tags this "(edited)" — there's no way
   to suppress that — but it keeps the buttons from staying clickable forever.

Which tools are gated, the channel, and the timeout are all operator-configured at `governor serve` startup — there
is no parameter an agent can pass to add, skip, or redirect an approval request.

### Error shapes worth knowing

| Symptom                                                                                                       | Meaning                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `governor serve` refuses to start: `--require-approval was given ... but no Slack credentials are configured` | Run `governor store slack-credential` first, or drop the tool(s) from `--require-approval`.                                                                                                                                                                              |
| A gated tool call returns `"..." requires Slack approval but the request couldn't be posted`                  | Usually `not_in_channel` — invite the bot to the configured channel (`/invite @<your-bot-name>`) — or the bot token is wrong/revoked.                                                                                                                                    |
| Clicking Approve/Deny appears to do nothing, and the call eventually returns `"..." timed out waiting Ns...`  | The Socket Mode connection likely never came up — check `governor serve`'s startup log for "Slack Socket Mode connected."; if it's not there, verify the app-level token (starts with `xapp-`, scope `connections:write`) and that Socket Mode is turned on for the app. |
| Startup log repeats `Slack Socket Mode: connection closed — reconnecting...`                                  | The app-level token is invalid/revoked, or Socket Mode was turned off in the Slack app — `apps.connections.open` will keep failing until fixed.                                                                                                                          |
| A gated tool call returns `"..." was denied via Slack by <user>`                                              | Working as intended — a human clicked Deny.                                                                                                                                                                                                                              |
| A gated tool call returns `"..." timed out waiting Ns for a Slack approval decision`                          | Nobody clicked within `--approval-timeout-seconds` — treated as denied, not retried automatically.                                                                                                                                                                       |
