import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Vault } from "../../cli/lib/vault";
import { withAudit } from "../../mcp/audit";
import { DEFAULT_PROFILE } from "../credentials";
import type { ProviderPlugin } from "../plugin";
import { queryMongoDb } from "./api";
import {
  listMongoDbProfiles,
  loadMongoDbBastions,
  loadMongoDbUris,
  type MongoBastionCredential,
} from "./credentials";

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

/**
 * Every stored MongoDB URI for a profile (keyed by the cluster nickname it
 * was stored under) plus every stored bastion (keyed by bastion name).
 * Unlike the AWS credential, there's no account-wide secret underneath this
 * — each entry is independently opted into via `governor store`.
 */
interface MongoDbCredential {
  uris: Map<string, string>;
  bastions: Map<string, MongoBastionCredential>;
}

export const mongodbPlugin: ProviderPlugin<MongoDbCredential> = {
  id: "mongodb",
  label: "MongoDB",
  authMethod: "connection-string",
  setupHint:
    "MongoDB has no `governor setup` step — store a connection URI per cluster with `governor store mongodb-uri <cluster-name>` (and, for bastion access, `governor store mongodb-bastion-key <bastion-name>`).",

  async loadCredentials(vault: Vault | undefined) {
    const credentials = new Map<string, MongoDbCredential>();

    if (vault) {
      for (const profile of await listMongoDbProfiles()) {
        credentials.set(profile, {
          uris: await loadMongoDbUris(vault, profile),
          bastions: await loadMongoDbBastions(vault, profile),
        });
      }
      return credentials;
    }

    // No vault at all: fall back to a single cluster named "default" from
    // MONGODB_URI, mirroring the access-key providers' env-var fallback.
    const uri = process.env.MONGODB_URI;
    if (uri) {
      credentials.set(DEFAULT_PROFILE, {
        uris: new Map([[DEFAULT_PROFILE, uri]]),
        bastions: new Map(),
      });
    }
    return credentials;
  },

  registerMcpTools(
    server: McpServer,
    credentials: Map<string, MongoDbCredential>,
  ) {
    server.registerTool(
      "mongodb_query",
      {
        title: "Query a MongoDB database",
        description:
          "Runs one read against a MongoDB database/collection on a cluster, naming it by whatever nickname it was stored under via `governor store mongodb-uri` — never the connection string itself. Pass `filter` for a `find`-style query (default `{}`, i.e. every document), or `pipeline` for an `aggregate` pipeline when a filter alone can't express it (joins via `$lookup`, grouping, etc.) — read-only, mirroring aws_dynamodb tools rather than aws_rds_instance_query: there's no write escape hatch, since a single MongoDB write has no equivalent blast-radius guard the way a bounded find/aggregate does. If `bastionName` is given, reaches the cluster by opening an SSH tunnel through a bastion host stored via `governor store mongodb-bastion-key` — only supported for a standard single-host \"mongodb://\" URI (an SRV/Atlas-style \"mongodb+srv://\" URI resolves to multiple hosts via DNS, which a single tunnel can't represent, and fails clearly if combined with bastionName). If `bastionName` is omitted, connects directly using the stored URI as-is — the common case for Atlas, where the URI's own TLS/auth/SRV settings are honored exactly as `mongosh` would. Results are capped at limit; the response's `truncated` flag says whether more documents matched.",
        inputSchema: {
          name: z
            .string()
            .describe(
              'Cluster nickname the connection URI was stored under via `governor store mongodb-uri`, e.g. "prod-atlas".',
            ),
          bastionName: z
            .string()
            .optional()
            .describe(
              'Name of a bastion host stored via `governor store mongodb-bastion-key` to tunnel through. Omit to connect directly using the stored URI. Only supported for a single-host "mongodb://" URI, not "mongodb+srv://".',
            ),
          database: z.string().describe("Name of the database to query."),
          collection: z.string().describe("Name of the collection to query."),
          filter: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              'MongoDB query filter as plain JSON, e.g. {"status": "active"}. Ignored if `pipeline` is given. Defaults to {} (match every document).',
            ),
          projection: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              'Fields to include/exclude, e.g. {"name": 1, "_id": 0}. Ignored if `pipeline` is given.',
            ),
          sort: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              'Sort order, e.g. {"createdAt": -1}. Ignored if `pipeline` is given.',
            ),
          pipeline: z
            .array(z.record(z.string(), z.unknown()))
            .optional()
            .describe(
              'Aggregation pipeline stages, e.g. [{"$match": {"status": "active"}}, {"$group": {"_id": "$region", "count": {"$sum": 1}}}]. When given, runs `aggregate` instead of `find` and `filter`/`projection`/`sort` are ignored.',
            ),
          limit: z
            .number()
            .int()
            .positive()
            .max(1000)
            .optional()
            .describe("Maximum documents to return (default 200, max 1000)."),
          profile: profileParam,
        },
      },
      withAudit(
        "mongodb_query",
        async ({
          name,
          bastionName,
          database,
          collection,
          filter,
          projection,
          sort,
          pipeline,
          limit,
          profile,
        }) => {
          const resolvedProfile = profile ?? DEFAULT_PROFILE;
          const credential = credentials.get(resolvedProfile);
          if (!credential) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `No MongoDB clusters connected for profile "${resolvedProfile}". Run \`governor store mongodb-uri ${name} --uri <connection-string>\` first.`,
                },
              ],
            };
          }

          const uri = credential.uris.get(name);
          if (!uri) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `No MongoDB URI stored for cluster "${name}" (profile "${resolvedProfile}"). Run \`governor store mongodb-uri ${name} --uri <connection-string>\` first.`,
                },
              ],
            };
          }

          let bastion: MongoBastionCredential | undefined;
          if (bastionName) {
            bastion = credential.bastions.get(bastionName);
            if (!bastion) {
              return {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: `No bastion stored for "${bastionName}" (profile "${resolvedProfile}"). Run \`governor store mongodb-bastion-key ${bastionName}\` first.`,
                  },
                ],
              };
            }
          }

          try {
            const result = await queryMongoDb(uri, {
              database,
              collection,
              filter,
              projection,
              sort,
              pipeline,
              limit,
              bastion: bastion
                ? {
                    address: bastion.host,
                    port: bastion.port,
                    username: bastion.username,
                    privateKey: bastion.privateKey,
                    passphrase: bastion.passphrase,
                  }
                : undefined,
            });
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
            };
          } catch (err) {
            return toErrorResult(err);
          }
        },
      ),
    );
  },
};
