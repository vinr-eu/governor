import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import type { AccessKeyCredential } from "../../providers/credentials";
import { parseFlags } from "../lib/flags";
import { logger } from "../lib/logger";
import { promptPassword } from "../lib/prompt";
import { listProfiles, profileKey, Vault, vaultExists } from "../lib/vault";

const DEFAULT_PROFILE = "default";

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

  const sts = new STSClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    credentials: credential,
  });

  try {
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    return Response.json({
      profile,
      account: identity.Account,
      arn: identity.Arn,
      userId: identity.UserId,
    });
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

  const server = Bun.serve({
    port,
    routes: {
      "/health": () => Response.json({ status: "ok" }),
      "/mcp": () =>
        Response.json({
          name: "governor",
          protocol: "mcp",
          status: "stub",
          message: "MCP protocol handling is not implemented yet.",
        }),
      "/providers/aws/identity": async () =>
        handleAwsIdentity(awsCredentials, DEFAULT_PROFILE),
      "/providers/aws/:profile/identity": async (req) =>
        handleAwsIdentity(awsCredentials, req.params.profile),
    },
  });

  logger.success(
    `Governor MCP endpoint listening on http://localhost:${server.port}`,
  );
  logger.info("Press Ctrl+C to stop.");

  await new Promise<void>(() => {});
}
