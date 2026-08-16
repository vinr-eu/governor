import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Vault } from "../../cli/lib/vault";
import { withAudit } from "../../mcp/audit";
import {
  DEFAULT_PROFILE,
  loadAccessKeyCredentials,
  type AccessKeyCredential,
} from "../credentials";
import type { HttpRouteHandler, ProviderPlugin } from "../plugin";
import {
  createS3PresignedDownloadUrl,
  fetchAwsCallerIdentity,
  listS3Buckets,
  searchS3Objects,
} from "./api";

function notConnected(profile: string): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `AWS profile "${profile}" is not connected. Run \`governor setup aws --profile ${profile}\` first.`,
      },
    ],
  };
}

function toErrorResult(err: unknown): CallToolResult {
  return {
    isError: true,
    content: [
      { type: "text", text: err instanceof Error ? err.message : String(err) },
    ],
  };
}

const profileParam = z
  .string()
  .optional()
  .describe(`Profile name to use. Defaults to "${DEFAULT_PROFILE}".`);

// A single profile's credentials can reach buckets in any region, so region
// is a per-call param rather than one fixed value for the whole profile.
// It's just a starting guess, though: a wrong one self-corrects via S3's
// region-redirect response (see `withRegionRedirect` in api.ts), so callers
// rarely need to pass it — mainly useful to skip the extra round trip when
// the region is already known.
const regionParam = z
  .string()
  .optional()
  .describe(
    "AWS region the bucket lives in. Defaults to the AWS_REGION env var, else us-east-1. Optional — a wrong guess is automatically detected and retried against the bucket's real region, so this only saves a round trip when you already know it.",
  );

async function handleIdentity(
  credentials: Map<string, AccessKeyCredential>,
  profile: string,
): Promise<Response> {
  const credential = credentials.get(profile);
  if (!credential) {
    return Response.json(
      {
        error: `AWS profile "${profile}" is not set up. Run \`governor setup aws --profile ${profile}\` first.`,
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

export const awsPlugin: ProviderPlugin<AccessKeyCredential> = {
  id: "aws",
  label: "Amazon Web Services",
  authMethod: "access-key",

  loadCredentials(vault: Vault | undefined) {
    return loadAccessKeyCredentials("aws", vault, {
      accessKeyId: "AWS_ACCESS_KEY_ID",
      secretAccessKey: "AWS_SECRET_ACCESS_KEY",
    });
  },

  registerMcpTools(
    server: McpServer,
    credentials: Map<string, AccessKeyCredential>,
  ) {
    server.registerTool(
      "aws_list_profiles",
      {
        title: "List connected AWS profiles",
        description:
          "Lists the AWS profile names currently connected to this governor instance (set up via `governor setup aws --profile <name>`).",
        inputSchema: {},
      },
      withAudit("aws_list_profiles", async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({ profiles: [...credentials.keys()] }),
          },
        ],
      })),
    );

    server.registerTool(
      "aws_get_caller_identity",
      {
        title: "AWS Get Caller Identity",
        description:
          "Returns the AWS account id, ARN, and user id for a connected profile by calling STS GetCallerIdentity.",
        inputSchema: { profile: profileParam },
      },
      withAudit("aws_get_caller_identity", async ({ profile }) => {
        const resolvedProfile = profile ?? DEFAULT_PROFILE;
        const credential = credentials.get(resolvedProfile);
        if (!credential) return notConnected(resolvedProfile);

        try {
          const identity = await fetchAwsCallerIdentity(credential);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ profile: resolvedProfile, ...identity }),
              },
            ],
          };
        } catch (err) {
          return toErrorResult(err);
        }
      }),
    );

    server.registerTool(
      "aws_s3_list_buckets",
      {
        title: "List S3 buckets",
        description:
          "Lists every S3 bucket visible to a connected AWS profile, with name, region, and creation date. Use this to discover which buckets exist — and which region each lives in — before searching or downloading from one.",
        inputSchema: { profile: profileParam, region: regionParam },
      },
      withAudit("aws_s3_list_buckets", async ({ profile, region }) => {
        const resolvedProfile = profile ?? DEFAULT_PROFILE;
        const credential = credentials.get(resolvedProfile);
        if (!credential) return notConnected(resolvedProfile);

        try {
          const buckets = await listS3Buckets(credential, region);
          return {
            content: [{ type: "text", text: JSON.stringify({ buckets }) }],
          };
        } catch (err) {
          return toErrorResult(err);
        }
      }),
    );

    server.registerTool(
      "aws_s3_search_objects",
      {
        title: "Search objects in an S3 bucket",
        description:
          "Lists/searches objects in an S3 bucket, returning key, size, last-modified, and etag for each match. Narrow results with `prefix` (fast, server-side) and/or `query` (case-insensitive substring match against the key). Does not return object contents — use aws_s3_get_download_url for that.",
        inputSchema: {
          bucket: z.string().describe("Name of the S3 bucket to search."),
          prefix: z
            .string()
            .optional()
            .describe("Only include keys starting with this prefix."),
          query: z
            .string()
            .optional()
            .describe(
              "Case-insensitive substring to match against object keys, e.g. a filename.",
            ),
          maxResults: z
            .number()
            .int()
            .positive()
            .max(1000)
            .optional()
            .describe(
              "Maximum number of matching objects (default 200, max 1000).",
            ),
          profile: profileParam,
          region: regionParam,
        },
      },
      withAudit(
        "aws_s3_search_objects",
        async ({ bucket, prefix, query, maxResults, profile, region }) => {
          const resolvedProfile = profile ?? DEFAULT_PROFILE;
          const credential = credentials.get(resolvedProfile);
          if (!credential) return notConnected(resolvedProfile);

          try {
            const objects = await searchS3Objects(credential, bucket, {
              region,
              prefix,
              query,
              maxResults,
            });
            return {
              content: [
                { type: "text", text: JSON.stringify({ bucket, objects }) },
              ],
            };
          } catch (err) {
            return toErrorResult(err);
          }
        },
      ),
    );

    server.registerTool(
      "aws_s3_get_download_url",
      {
        title: "Get a presigned S3 download URL",
        description:
          "Returns a time-limited, read-only presigned URL to download one S3 object directly — never the object bytes or credentials themselves. Fails clearly if the object doesn't exist. Use aws_s3_search_objects first to find the exact key.",
        inputSchema: {
          bucket: z.string().describe("Name of the S3 bucket."),
          key: z
            .string()
            .describe("Exact object key to generate a download URL for."),
          expiresInSeconds: z
            .number()
            .int()
            .positive()
            .max(3600)
            .optional()
            .describe("URL validity in seconds (default 300, max 3600)."),
          profile: profileParam,
          region: regionParam,
        },
      },
      withAudit(
        "aws_s3_get_download_url",
        async ({ bucket, key, expiresInSeconds, profile, region }) => {
          const resolvedProfile = profile ?? DEFAULT_PROFILE;
          const credential = credentials.get(resolvedProfile);
          if (!credential) return notConnected(resolvedProfile);

          try {
            const url = await createS3PresignedDownloadUrl(
              credential,
              bucket,
              key,
              { region, expiresInSeconds },
            );
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ bucket, key, url }),
                },
              ],
            };
          } catch (err) {
            return toErrorResult(err);
          }
        },
      ),
    );
  },

  registerHttpRoutes(
    credentials: Map<string, AccessKeyCredential>,
  ): Record<string, HttpRouteHandler> {
    return {
      "/providers/aws/identity": () =>
        handleIdentity(credentials, DEFAULT_PROFILE),
      "/providers/aws/:profile/identity": (req) =>
        handleIdentity(credentials, req.params.profile as string),
    };
  },
};
