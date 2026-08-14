import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { VERSION } from "../cli/help";
import type { AccessKeyCredential } from "../providers/credentials";
import { fetchAwsCallerIdentity } from "../providers/aws";

const DEFAULT_PROFILE = "default";

/**
 * Builds a fresh MCP server bound to the AWS credentials already unlocked for
 * this `governor serve` process. Never exposes the credentials themselves —
 * tools only return what the wrapped AWS API call returns.
 */
export function createMcpServer(
  awsCredentials: Map<string, AccessKeyCredential>,
): McpServer {
  const server = new McpServer({ name: "governor", version: VERSION });

  server.registerTool(
    "aws_list_profiles",
    {
      title: "List connected AWS profiles",
      description:
        "Lists the AWS profile names currently connected to this governor instance (set up via `governor setup aws --profile <name>`).",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({ profiles: [...awsCredentials.keys()] }),
        },
      ],
    }),
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
    async ({ profile }) => {
      const resolvedProfile = profile ?? DEFAULT_PROFILE;
      const credential = awsCredentials.get(resolvedProfile);
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
    },
  );

  return server;
}
