import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Vault } from "../../cli/lib/vault";
import { withAudit } from "../../mcp/audit";
import {
  DEFAULT_PROFILE,
  loadAccessKeyCredentials,
  type AccessKeyCredential,
} from "../credentials";
import type { HttpRouteHandler, ProviderPlugin } from "../plugin";
import { fetchAwsCallerIdentity } from "./api";

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
        inputSchema: {
          profile: z
            .string()
            .optional()
            .describe(`Profile name to use. Defaults to "${DEFAULT_PROFILE}".`),
        },
      },
      withAudit("aws_get_caller_identity", async ({ profile }) => {
        const resolvedProfile = profile ?? DEFAULT_PROFILE;
        const credential = credentials.get(resolvedProfile);
        if (!credential) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `AWS profile "${resolvedProfile}" is not connected. Run \`governor setup aws --profile ${resolvedProfile}\` first.`,
              },
            ],
          };
        }

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
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: err instanceof Error ? err.message : String(err),
              },
            ],
          };
        }
      }),
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
