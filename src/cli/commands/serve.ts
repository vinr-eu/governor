import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "../../mcp/server";
import type { AccessKeyCredential } from "../../providers/credentials";
import { fetchAwsCallerIdentity } from "../../providers/aws";
import { parseFlags } from "../lib/flags";
import { logger } from "../lib/logger";
import { promptPassword } from "../lib/prompt";
import { listProfiles, profileKey, Vault, vaultExists } from "../lib/vault";

const DEFAULT_PROFILE = "default";

// MCP sessions live for the lifetime of this process. A session's transport is
// created on its "initialize" request and reused for every later request that
// carries its Mcp-Session-Id — required because the SDK ties protocol state
// (has-initialized, pending SSE streams) to a single transport instance, so a
// fresh transport per request can never get past "Server not initialized".
const mcpTransports = new Map<string, WebStandardStreamableHTTPServerTransport>();

async function handleMcp(
  req: Request,
  awsCredentials: Map<string, AccessKeyCredential>,
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
        error: { code: -32000, message: "Bad Request: No valid session ID provided" },
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
        error: { code: -32000, message: "Bad Request: No valid session ID provided" },
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

  const mcpServer = createMcpServer(awsCredentials);
  await mcpServer.connect(transport);
  return transport.handleRequest(req, { parsedBody: body });
}

// Loaded once at startup and held only in this process's memory — callers get
// results back over HTTP, never the credential itself. Throws if a vault exists
// but can't be unlocked: that's a real error, not "no credentials configured",
// and must stop startup rather than silently degrading.
async function loadAwsCredentials(): Promise<Map<string, AccessKeyCredential>> {
  const credentials = new Map<string, AccessKeyCredential>();

  if (await vaultExists()) {
    const password = process.stdin.isTTY
      ? await promptPassword("Master password to unlock the vault:")
      : process.env.GOVERNOR_MASTER_PASSWORD;

    if (!password) {
      throw new Error(
        "Vault found but no password available. Set GOVERNOR_MASTER_PASSWORD in non-interactive environments.",
      );
    }

    const vault = await Vault.open(password);
    for (const profile of await listProfiles("aws")) {
      const credential = vault.get<AccessKeyCredential>(
        profileKey("aws", profile),
      );
      if (credential) credentials.set(profile, credential);
    }
    return credentials;
  }

  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (accessKeyId && secretAccessKey) {
    credentials.set(DEFAULT_PROFILE, { accessKeyId, secretAccessKey });
  }
  return credentials;
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
    return Response.json(
      { error: 'Unauthorized. Include "Authorization: Bearer <token>".' },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
    );
  }
  return undefined;
}

async function handleAwsIdentity(
  credentials: Map<string, AccessKeyCredential>,
  profile: string,
) {
  const credential = credentials.get(profile);
  if (!credential) {
    return Response.json(
      {
        error: `AWS profile "${profile}" is not connected. Run \`governor connect aws --profile ${profile}\` first.`,
      },
      { status: 503 },
    );
  }

  try {
    const identity = await fetchAwsCallerIdentity(credential);
    return Response.json({ profile, ...identity });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}

export async function runServe(args: string[]) {
  const { flags } = parseFlags(args);
  const port = Number(flags.port ?? 8787);
  // Bun.serve defaults to 0.0.0.0 (all interfaces); default to loopback only
  // so the MCP/provider endpoints aren't reachable from the network unless
  // the operator explicitly opts in with --host.
  const host = typeof flags.host === "string" ? flags.host : "127.0.0.1";

  let awsCredentials: Map<string, AccessKeyCredential>;
  try {
    awsCredentials = await loadAwsCredentials();
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  logger.info(
    awsCredentials.size > 0
      ? `AWS credentials loaded for profiles: ${[...awsCredentials.keys()].join(", ")} (held in memory, never exposed to callers).`
      : "No AWS credentials found — run `governor connect aws` or set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY.",
  );

  const mcpToken = process.env.GOVERNOR_MCP_TOKEN ?? randomBytes(24).toString("base64url");
  if (process.env.GOVERNOR_MCP_TOKEN) {
    logger.info("MCP bearer token loaded from GOVERNOR_MCP_TOKEN.");
  } else {
    logger.warn(`Generated a one-time MCP bearer token for this run: ${mcpToken}`);
    logger.warn(
      "It won't be shown again and isn't persisted anywhere — copy it now, or set GOVERNOR_MCP_TOKEN to pin a stable value across restarts.",
    );
  }
  logger.info(
    '/mcp and /providers/* require an "Authorization: Bearer <token>" header.',
  );

  const server = Bun.serve({
    port,
    hostname: host,
    routes: {
      "/health": () => Response.json({ status: "ok" }),
      "/mcp": async (req) => {
        const unauthorized = requireAuth(req, mcpToken);
        return unauthorized ?? handleMcp(req, awsCredentials);
      },
      "/providers/aws/identity": async (req) => {
        const unauthorized = requireAuth(req, mcpToken);
        return unauthorized ?? handleAwsIdentity(awsCredentials, DEFAULT_PROFILE);
      },
      "/providers/aws/:profile/identity": async (req) => {
        const unauthorized = requireAuth(req, mcpToken);
        return (
          unauthorized ??
          handleAwsIdentity(awsCredentials, req.params.profile)
        );
      },
    },
  });

  logger.success(
    `Governor MCP endpoint listening on http://${server.hostname}:${server.port}`,
  );
  logger.info("Press Ctrl+C to stop.");

  await new Promise<void>(() => {});
}
