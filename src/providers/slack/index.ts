import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Vault } from "../../cli/lib/vault";
import { loadSlackCredentials, type SlackCredential } from "./credentials";
import type { ProviderPlugin } from "../plugin";

/**
 * Unlike every other provider, this one exposes no MCP tools at all — an
 * agent never talks to Slack directly. Its only job is to back the approval
 * gate (`src/mcp/approval-gate.ts`): governor itself posts to Slack and
 * blocks before running a gated tool, invisible to (and un-skippable by)
 * the calling agent.
 *
 * This plugin just resolves the credential (vault-backed, via `governor
 * store slack-credential`). The actual Slack connection — an outbound
 * Socket Mode WebSocket, not an inbound webhook, so nothing about governor
 * needs to be exposed to the internet — is started separately from
 * `serve.ts` (see `socket-mode.ts`), once, only when the approval gate is
 * actually active.
 */
export const slackPlugin: ProviderPlugin<SlackCredential> = {
  id: "slack",
  label: "Slack",
  authMethod: "api-key",
  setupHint:
    "Slack has no `governor setup` step — store a bot token, app-level token, and approval channel with `governor store slack-credential`. Then gate specific tools with `governor serve --require-approval <tool>,...` (or rely on the default gated-tool list).",

  async loadCredentials(vault: Vault | undefined) {
    return loadSlackCredentials(vault);
  },

  registerMcpTools(
    _server: McpServer,
    _credentials: Map<string, SlackCredential>,
  ) {
    // No agent-facing tools — see the module doc comment above.
  },
};
