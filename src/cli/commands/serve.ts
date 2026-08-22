import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  configureApprovalGate,
  DEFAULT_GATED_TOOLS,
} from "../../mcp/approval-gate";
import { createMcpServer } from "../../mcp/server";
import { PROVIDER_PLUGINS } from "../../providers";
import { DEFAULT_PROFILE } from "../../providers/credentials";
import type { SlackCredential } from "../../providers/slack/credentials";
import { startSlackSocketMode } from "../../providers/slack/socket-mode";
import { parseFlags } from "../lib/flags";
import { logger } from "../lib/logger";
import { promptPassword } from "../lib/prompt";
import { Vault, vaultExists } from "../lib/vault";

const DEFAULT_APPROVAL_TIMEOUT_SECONDS = 300;

const mcpTransports = new Map<
  string,
  WebStandardStreamableHTTPServerTransport
>();

async function handleMcp(
  req: Request,
  credentialsByProvider: Map<string, Map<string, unknown>>,
): Promise<Response> {
  const sessionId = req.headers.get("mcp-session-id") ?? undefined;

  if (sessionId) {
    const transport = mcpTransports.get(sessionId);
    if (!transport) {
      return Response.json(
        {
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found" },
          id: null,
        },
        { status: 404 },
      );
    }
    return transport.handleRequest(req);
  }

  if (req.method !== "POST") {
    return Response.json(
      {
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid session ID provided",
        },
        id: null,
      },
      { status: 400 },
    );
  }

  const body = await req.json().catch(() => undefined);
  if (!isInitializeRequest(body)) {
    return Response.json(
      {
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid session ID provided",
        },
        id: null,
      },
      { status: 400 },
    );
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      mcpTransports.set(sid, transport);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) mcpTransports.delete(transport.sessionId);
  };

  const mcpServer = createMcpServer(credentialsByProvider);
  await mcpServer.connect(transport);
  return transport.handleRequest(req, { parsedBody: body });
}

/**
 * Unlocks the vault once (if one exists) and lets every provider plugin
 * resolve its own credentials against it, falling back to env vars when
 * there's no vault at all. Centralizing the unlock means N providers never
 * means N master-password prompts.
 */
async function loadAllCredentials(): Promise<
  Map<string, Map<string, unknown>>
> {
  let vault: Vault | undefined;
  if (await vaultExists()) {
    const password = process.stdin.isTTY
      ? await promptPassword("Master password to unlock the vault:")
      : process.env.GOVERNOR_MASTER_PASSWORD;

    if (!password) {
      throw new Error(
        "Vault found but no password available. Set GOVERNOR_MASTER_PASSWORD in non-interactive environments.",
      );
    }
    vault = await Vault.open(password);
  }

  const credentialsByProvider = new Map<string, Map<string, unknown>>();
  for (const plugin of PROVIDER_PLUGINS) {
    credentialsByProvider.set(plugin.id, await plugin.loadCredentials(vault));
  }
  return credentialsByProvider;
}

// Hash before comparing so timingSafeEqual never sees mismatched-length
// buffers (which it throws on) and so token length itself isn't observable.
function tokensMatch(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

function requireAuth(req: Request, token: string): Response | undefined {
  const header = req.headers.get("authorization") ?? "";
  const [scheme, value] = header.split(" ");
  if (scheme !== "Bearer" || !value || !tokensMatch(value, token)) {
    // Audit failed auth attempts (path/method only — never the attempted
    // token) so repeated probing shows up somewhere.
    logger.warn(
      `Unauthorized request: ${req.method} ${new URL(req.url).pathname}`,
    );
    return Response.json(
      { error: 'Unauthorized. Include "Authorization: Bearer <token>".' },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
    );
  }
  return undefined;
}

export async function runServe(args: string[]) {
  const { flags } = parseFlags(args);
  const port = Number(flags.port ?? 8787);
  // Bun.serve defaults to 0.0.0.0 (all interfaces); default to loopback only
  // so the MCP/provider endpoints aren't reachable from the network unless
  // the operator explicitly opts in with --host.
  const host = typeof flags.host === "string" ? flags.host : "127.0.0.1";

  let credentialsByProvider: Map<string, Map<string, unknown>>;
  try {
    credentialsByProvider = await loadAllCredentials();
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  for (const plugin of PROVIDER_PLUGINS) {
    const credentials = credentialsByProvider.get(plugin.id) ?? new Map();
    logger.info(
      credentials.size > 0
        ? `${plugin.label} credentials loaded for profiles: ${[...credentials.keys()].join(", ")} (held in memory, never exposed to callers).`
        : (plugin.setupHint ??
            `No ${plugin.label} credentials found — run \`governor setup ${plugin.id}\` or set the provider's env vars.`),
    );
  }

  // Which tools are gated defaults to DEFAULT_GATED_TOOLS (active
  // automatically once Slack is configured, no flag needed) — passing
  // --require-approval overrides that default list outright, and
  // --require-approval "" disables gating even if Slack is configured.
  const requireApprovalFlag = flags["require-approval"];
  if (
    requireApprovalFlag !== undefined &&
    typeof requireApprovalFlag !== "string"
  ) {
    logger.error(
      '--require-approval requires a comma-separated tool list (or "" to disable).',
    );
    process.exitCode = 1;
    return;
  }
  const requireApprovalGiven = requireApprovalFlag !== undefined;
  const gatedTools = requireApprovalGiven
    ? new Set(
        requireApprovalFlag
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean),
      )
    : new Set(DEFAULT_GATED_TOOLS);

  if (gatedTools.size > 0) {
    const slackCredentials = (credentialsByProvider.get("slack") ??
      new Map()) as Map<string, SlackCredential>;
    const slackCredential =
      slackCredentials.get(DEFAULT_PROFILE) ??
      slackCredentials.values().next().value;

    if (!slackCredential) {
      if (requireApprovalGiven) {
        logger.error(
          `--require-approval was given (${[...gatedTools].join(", ")}) but no Slack credentials are configured. Run \`governor store slack-credential\` first.`,
        );
        process.exitCode = 1;
        return;
      }
      logger.info(
        `${[...gatedTools].join(", ")} would require Slack approval by default, but no Slack credentials are configured — running ungated. Run \`governor store slack-credential\` to enable, or pass --require-approval "" to silence this.`,
      );
    } else {
      const approvalTimeoutFlag = flags["approval-timeout-seconds"];
      if (
        approvalTimeoutFlag !== undefined &&
        typeof approvalTimeoutFlag !== "string"
      ) {
        logger.error("--approval-timeout-seconds requires a value.");
        process.exitCode = 1;
        return;
      }
      const timeoutSeconds = approvalTimeoutFlag
        ? Number(approvalTimeoutFlag)
        : DEFAULT_APPROVAL_TIMEOUT_SECONDS;
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
        logger.error("--approval-timeout-seconds must be a positive number.");
        process.exitCode = 1;
        return;
      }

      configureApprovalGate({
        credential: slackCredential,
        gatedTools,
        timeoutSeconds,
      });
      startSlackSocketMode(slackCredential);
      logger.warn(
        `Approval required via Slack (channel ${slackCredential.channel}, ${timeoutSeconds}s timeout) before: ${[...gatedTools].join(", ")}.`,
      );
    }
  }

  const mcpToken =
    process.env.GOVERNOR_MCP_TOKEN ?? randomBytes(24).toString("base64url");
  if (process.env.GOVERNOR_MCP_TOKEN) {
    logger.info("MCP bearer token loaded from GOVERNOR_MCP_TOKEN.");
  } else {
    logger.warn(
      `Generated a one-time MCP bearer token for this run: ${mcpToken}`,
    );
    logger.warn(
      "It won't be shown again and isn't persisted anywhere — copy it now, or set GOVERNOR_MCP_TOKEN to pin a stable value across restarts.",
    );
  }
  logger.info(
    '/mcp and /providers/* require an "Authorization: Bearer <token>" header.',
  );

  const providerRoutes: Record<
    string,
    (req: Bun.BunRequest) => Response | Promise<Response>
  > = {};
  for (const plugin of PROVIDER_PLUGINS) {
    if (!plugin.registerHttpRoutes) continue;
    const credentials = credentialsByProvider.get(plugin.id) ?? new Map();
    const routes = plugin.registerHttpRoutes(credentials);
    for (const [path, handler] of Object.entries(routes)) {
      providerRoutes[path] = (req) => {
        const unauthorized = requireAuth(req, mcpToken);
        return unauthorized ?? handler(req);
      };
    }
  }

  const server = Bun.serve({
    port,
    hostname: host,
    routes: {
      "/health": () => Response.json({ status: "ok" }),
      "/mcp": async (req, server) => {
        // Bun closes a connection that's gone quiet for 10s (the default
        // idleTimeout), measured from the last byte sent — not from request
        // start. The MCP transport flushes SSE headers immediately but
        // doesn't write the actual response until the tool call resolves,
        // so any tool slower than that (a big RDS query, a wide DynamoDB
        // scan, aws_logs_search order="desc" falling back to its
        // expanding scan) would otherwise get its connection killed
        // mid-response with no error, just a truncated stream.
        server.timeout(req, 0);
        const unauthorized = requireAuth(req, mcpToken);
        return unauthorized ?? handleMcp(req, credentialsByProvider);
      },
      ...providerRoutes,
    },
  });

  logger.success(
    `Governor MCP endpoint listening on http://${server.hostname}:${server.port}`,
  );
  logger.info("Press Ctrl+C to stop.");

  await new Promise<void>(() => {});
}
