import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Vault } from "../../cli/lib/vault";
import { withAudit } from "../../mcp/audit";
import {
  DEFAULT_PROFILE,
  loadAccessKeyCredentials,
  loadRdsPasswords,
  loadSshBastionKeys,
  type AccessKeyCredential,
  type SshBastionKeyCredential,
} from "../credentials";
import type { HttpRouteHandler, ProviderPlugin } from "../plugin";
import {
  createS3PresignedDownloadUrl,
  describeDynamoDbTable,
  fetchAwsCallerIdentity,
  getCloudWatchMetricData,
  getDynamoDbItem,
  listCloudWatchLogGroups,
  listCloudWatchMetrics,
  listDynamoDbTables,
  listS3Buckets,
  listSqsQueuesByBacklog,
  peekSqsMessages,
  queryDynamoDbTable,
  queryRdsInstance,
  scanDynamoDbTable,
  searchCloudWatchLogs,
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

/**
 * AWS credential plus any RDS passwords stored for its profile (keyed by
 * `<dbIdentifier>::<dbUser>`) and any SSH bastion keys stored for it (keyed
 * by bastion name).
 */
interface AwsCredential extends AccessKeyCredential {
  rdsPasswords: Map<string, string>;
  sshBastionKeys: Map<string, SshBastionKeyCredential>;
}

async function handleIdentity(
  credentials: Map<string, AwsCredential>,
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

export const awsPlugin: ProviderPlugin<AwsCredential> = {
  id: "aws",
  label: "Amazon Web Services",
  authMethod: "access-key",

  async loadCredentials(vault: Vault | undefined) {
    const base = await loadAccessKeyCredentials("aws", vault, {
      accessKeyId: "AWS_ACCESS_KEY_ID",
      secretAccessKey: "AWS_SECRET_ACCESS_KEY",
    });
    const credentials = new Map<string, AwsCredential>();
    for (const [profile, credential] of base) {
      credentials.set(profile, {
        ...credential,
        rdsPasswords: vault
          ? await loadRdsPasswords(vault, profile)
          : new Map(),
        sshBastionKeys: vault
          ? await loadSshBastionKeys(vault, profile)
          : new Map(),
      });
    }
    return credentials;
  },

  registerMcpTools(
    server: McpServer,
    credentials: Map<string, AwsCredential>,
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

    server.registerTool(
      "aws_rds_instance_query",
      {
        title: "Query an RDS database",
        description:
          'Runs one SQL statement against an RDS instance or Aurora cluster, naming it the way a human would — by the identifier shown in the RDS console (e.g. "prod-orders-db") — never by ARN. Reaches it by opening an SSH tunnel through a bastion EC2 instance already inside that VPC — implemented natively against the `ssh2` library, no `ssh` CLI binary required. By default authenticates to the database with a short-lived IAM database-auth token instead of a stored password; if a password was stored for this exact name+dbUser via `governor store rds-password`, that\'s used instead (opt-in, for databases without IAM DB auth turned on). Every name here — name, bastionName, dbUser — is the plain name shown in its console/DB. Requires: (1) either IAM database authentication turned on with dbUser granted the matching DB role, or a password stored via `governor store rds-password`, (2) a bastion EC2 instance with a public IP, network reachability to the database, a unique Name tag, and an SSH key stored via `governor store ssh-key <bastionName>` whose public half is in the bastion\'s authorized_keys. Results are capped at maxRows; the response\'s `truncated` flag says whether more rows exist.',
        inputSchema: {
          name: z
            .string()
            .describe(
              'RDS instance or Aurora cluster identifier as shown in the console, e.g. "prod-orders-db".',
            ),
          bastionName: z
            .string()
            .describe(
              "Name tag of the EC2 instance to tunnel through — must have a public IP, network access to the RDS instance, a unique Name tag, and a key stored via `governor store ssh-key`.",
            ),
          dbUser: z
            .string()
            .describe(
              "Database username configured for IAM authentication (granted rds_iam / the AWS auth plugin) — not a password.",
            ),
          database: z.string().describe("Name of the database to query."),
          sql: z.string().describe("SQL statement to execute."),
          maxRows: z
            .number()
            .int()
            .positive()
            .max(1000)
            .optional()
            .describe("Maximum rows to return (default 200, max 1000)."),
          profile: profileParam,
          region: regionParam,
        },
      },
      withAudit(
        "aws_rds_instance_query",
        async ({
          name,
          bastionName,
          dbUser,
          database,
          sql,
          maxRows,
          profile,
          region,
        }) => {
          const resolvedProfile = profile ?? DEFAULT_PROFILE;
          const credential = credentials.get(resolvedProfile);
          if (!credential) return notConnected(resolvedProfile);
          const password = credential.rdsPasswords.get(`${name}::${dbUser}`);
          const sshKey = credential.sshBastionKeys.get(bastionName);
          if (!sshKey) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `No SSH key stored for bastion "${bastionName}" (profile "${resolvedProfile}"). Run \`governor store ssh-key ${bastionName} --user <ssh-username> --key-file <path>\` first.`,
                },
              ],
            };
          }

          try {
            const result = await queryRdsInstance(credential, {
              name,
              bastionName,
              dbUser,
              database,
              sql,
              region,
              maxRows,
              password,
              ssh: sshKey,
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

    server.registerTool(
      "aws_dynamodb_list_tables",
      {
        title: "List DynamoDB tables",
        description:
          "Lists every DynamoDB table visible to a connected AWS profile in a region. Use this to discover table names before describing, querying, or scanning one.",
        inputSchema: { profile: profileParam, region: regionParam },
      },
      withAudit("aws_dynamodb_list_tables", async ({ profile, region }) => {
        const resolvedProfile = profile ?? DEFAULT_PROFILE;
        const credential = credentials.get(resolvedProfile);
        if (!credential) return notConnected(resolvedProfile);

        try {
          const tables = await listDynamoDbTables(credential, region);
          return {
            content: [{ type: "text", text: JSON.stringify({ tables }) }],
          };
        } catch (err) {
          return toErrorResult(err);
        }
      }),
    );

    server.registerTool(
      "aws_dynamodb_describe_table",
      {
        title: "Describe a DynamoDB table",
        description:
          "Returns a DynamoDB table's status, item count, size, primary key schema, and global secondary indexes. Use this to learn a table's partition/sort key attribute names before calling aws_dynamodb_query_table.",
        inputSchema: {
          tableName: z.string().describe("Name of the DynamoDB table."),
          profile: profileParam,
          region: regionParam,
        },
      },
      withAudit(
        "aws_dynamodb_describe_table",
        async ({ tableName, profile, region }) => {
          const resolvedProfile = profile ?? DEFAULT_PROFILE;
          const credential = credentials.get(resolvedProfile);
          if (!credential) return notConnected(resolvedProfile);

          try {
            const table = await describeDynamoDbTable(
              credential,
              tableName,
              region,
            );
            return { content: [{ type: "text", text: JSON.stringify(table) }] };
          } catch (err) {
            return toErrorResult(err);
          }
        },
      ),
    );

    server.registerTool(
      "aws_dynamodb_get_item",
      {
        title: "Get one DynamoDB item by key",
        description:
          "Fetches a single item from a DynamoDB table by its exact primary key. Returns null if no item has that key. Use aws_dynamodb_describe_table first if you don't already know the partition/sort key attribute names.",
        inputSchema: {
          tableName: z.string().describe("Name of the DynamoDB table."),
          key: z
            .record(z.string(), z.unknown())
            .describe(
              'Primary key of the item, as plain JSON, e.g. {"userId": "123"} or {"userId": "123", "createdAt": "2024-01-01"} for a composite key.',
            ),
          profile: profileParam,
          region: regionParam,
        },
      },
      withAudit(
        "aws_dynamodb_get_item",
        async ({ tableName, key, profile, region }) => {
          const resolvedProfile = profile ?? DEFAULT_PROFILE;
          const credential = credentials.get(resolvedProfile);
          if (!credential) return notConnected(resolvedProfile);

          try {
            const item = await getDynamoDbItem(
              credential,
              tableName,
              key,
              region,
            );
            return {
              content: [
                { type: "text", text: JSON.stringify({ item: item ?? null }) },
              ],
            };
          } catch (err) {
            return toErrorResult(err);
          }
        },
      ),
    );

    const dynamoDbCommonParams = {
      indexName: z
        .string()
        .optional()
        .describe(
          "Name of a global/local secondary index to query/scan instead of the table's primary key.",
        ),
      filterExpression: z
        .string()
        .optional()
        .describe(
          'DynamoDB FilterExpression syntax, applied after the read (does not reduce cost, only what\'s returned), e.g. "attr_gt(price, :minPrice)".',
        ),
      expressionAttributeNames: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          'Placeholders for attribute names that collide with reserved words, e.g. {"#s": "status"}.',
        ),
      expressionAttributeValues: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'Placeholder values referenced by the key/filter expressions, as plain JSON, e.g. {":status": "active"}.',
        ),
      maxItems: z
        .number()
        .int()
        .positive()
        .max(1000)
        .optional()
        .describe("Maximum items to return (default 200, max 1000)."),
      profile: profileParam,
      region: regionParam,
    };

    server.registerTool(
      "aws_dynamodb_query_table",
      {
        title: "Query a DynamoDB table",
        description:
          "Runs a DynamoDB Query: efficient lookup of every item sharing a partition key (and optionally a sort-key condition), via keyConditionExpression using standard DynamoDB expression syntax, e.g. \"userId = :uid AND begins_with(createdAt, :prefix)\". Requires knowing the partition key — use aws_dynamodb_scan_table instead when you don't. Paginates internally up to maxItems; the response's `truncated` flag says whether more matching items exist.",
        inputSchema: {
          tableName: z.string().describe("Name of the DynamoDB table."),
          keyConditionExpression: z
            .string()
            .describe(
              'DynamoDB KeyConditionExpression syntax, e.g. "userId = :uid" or "userId = :uid AND createdAt > :since".',
            ),
          scanIndexForward: z
            .boolean()
            .optional()
            .describe(
              "Sort order on the sort key: true (default) for ascending, false for descending.",
            ),
          ...dynamoDbCommonParams,
        },
      },
      withAudit(
        "aws_dynamodb_query_table",
        async ({
          tableName,
          keyConditionExpression,
          scanIndexForward,
          indexName,
          filterExpression,
          expressionAttributeNames,
          expressionAttributeValues,
          maxItems,
          profile,
          region,
        }) => {
          const resolvedProfile = profile ?? DEFAULT_PROFILE;
          const credential = credentials.get(resolvedProfile);
          if (!credential) return notConnected(resolvedProfile);

          try {
            const result = await queryDynamoDbTable(credential, tableName, {
              keyConditionExpression,
              scanIndexForward,
              indexName,
              filterExpression,
              expressionAttributeNames,
              expressionAttributeValues,
              maxItems,
              region,
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

    server.registerTool(
      "aws_dynamodb_scan_table",
      {
        title: "Scan a DynamoDB table",
        description:
          "Runs a DynamoDB Scan: reads across the whole table/index rather than one partition, optionally narrowed by filterExpression (applied after the read). Slower and more expensive than aws_dynamodb_query_table — prefer that when the partition key is known. Paginates internally up to maxItems; the response's `truncated` flag says whether more items exist.",
        inputSchema: {
          tableName: z.string().describe("Name of the DynamoDB table."),
          ...dynamoDbCommonParams,
        },
      },
      withAudit(
        "aws_dynamodb_scan_table",
        async ({
          tableName,
          indexName,
          filterExpression,
          expressionAttributeNames,
          expressionAttributeValues,
          maxItems,
          profile,
          region,
        }) => {
          const resolvedProfile = profile ?? DEFAULT_PROFILE;
          const credential = credentials.get(resolvedProfile);
          if (!credential) return notConnected(resolvedProfile);

          try {
            const result = await scanDynamoDbTable(credential, tableName, {
              indexName,
              filterExpression,
              expressionAttributeNames,
              expressionAttributeValues,
              maxItems,
              region,
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

    server.registerTool(
      "aws_logs_list_groups",
      {
        title: "List CloudWatch log groups",
        description:
          "Lists CloudWatch Logs log groups visible to a connected AWS profile in a region, with retention period and stored size. Narrow with `prefix` (server-side, cheap). Use this to find a log group's exact name before searching it with aws_logs_search.",
        inputSchema: {
          prefix: z
            .string()
            .optional()
            .describe(
              "Only include log groups whose name starts with this prefix.",
            ),
          maxResults: z
            .number()
            .int()
            .positive()
            .max(1000)
            .optional()
            .describe(
              "Maximum number of log groups to return (default 200, max 1000).",
            ),
          profile: profileParam,
          region: regionParam,
        },
      },
      withAudit(
        "aws_logs_list_groups",
        async ({ prefix, maxResults, profile, region }) => {
          const resolvedProfile = profile ?? DEFAULT_PROFILE;
          const credential = credentials.get(resolvedProfile);
          if (!credential) return notConnected(resolvedProfile);

          try {
            const groups = await listCloudWatchLogGroups(credential, {
              region,
              prefix,
              maxResults,
            });
            return {
              content: [{ type: "text", text: JSON.stringify({ groups }) }],
            };
          } catch (err) {
            return toErrorResult(err);
          }
        },
      ),
    );

    server.registerTool(
      "aws_logs_search",
      {
        title: "Search CloudWatch logs",
        description:
          "Searches a CloudWatch log group for events across every log stream in the group, ordered by time — the read path for debugging and incident response. Two modes, via `order`: \"asc\" (default) runs a forward FilterLogEvents scan matching `filterPattern` within a time range — `startTime`/`endTime` are ISO 8601 timestamps, startTime defaults to 1 hour before endTime (endTime defaults to now) so an omitted range never scans a group's full retention window. \"desc\" is tail mode — the most recent events regardless of how old they turn out to be, resolved directly from the group's most-recently-active streams rather than scanning forward to find them, so it stays cheap even when the last write was long ago; it doesn't support filterPattern (CloudWatch has no server-side filter on that read path) and only considers a bounded number of the most recently active streams. Paginates internally up to maxResults; the response's `truncated` flag says whether more matching events exist.",
        inputSchema: {
          logGroupName: z
            .string()
            .describe(
              'Exact name of the CloudWatch log group to search, e.g. "/aws/lambda/my-function". Use aws_logs_list_groups to find it.',
            ),
          order: z
            .enum(["asc", "desc"])
            .optional()
            .describe(
              '"asc" (default): forward scan matching filterPattern within startTime/endTime. "desc": tail mode — most recent events first-found, regardless of age; no filterPattern support.',
            ),
          filterPattern: z
            .string()
            .optional()
            .describe(
              'CloudWatch Logs filter pattern, e.g. "ERROR" or "?ERROR ?WARN". Omit to match every event. Only valid with order "asc".',
            ),
          logStreamNamePrefix: z
            .string()
            .optional()
            .describe(
              "Only search log streams whose name starts with this prefix.",
            ),
          startTime: z
            .string()
            .optional()
            .describe(
              'ISO 8601 timestamp to search from. In order "asc", defaults to 1 hour before endTime; in order "desc", an optional lower bound (no default).',
            ),
          endTime: z
            .string()
            .optional()
            .describe(
              'ISO 8601 timestamp to search until. In order "asc", defaults to now; in order "desc", an optional upper bound (no default — omit to tail all the way to the latest event).',
            ),
          maxResults: z
            .number()
            .int()
            .positive()
            .max(1000)
            .optional()
            .describe(
              "Maximum number of log events to return (default 200, max 1000).",
            ),
          profile: profileParam,
          region: regionParam,
        },
      },
      withAudit(
        "aws_logs_search",
        async ({
          logGroupName,
          order,
          filterPattern,
          logStreamNamePrefix,
          startTime,
          endTime,
          maxResults,
          profile,
          region,
        }) => {
          const resolvedProfile = profile ?? DEFAULT_PROFILE;
          const credential = credentials.get(resolvedProfile);
          if (!credential) return notConnected(resolvedProfile);

          try {
            const result = await searchCloudWatchLogs(
              credential,
              logGroupName,
              {
                region,
                order,
                filterPattern,
                logStreamNamePrefix,
                startTime,
                endTime,
                maxResults,
              },
            );
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
            };
          } catch (err) {
            return toErrorResult(err);
          }
        },
      ),
    );

    server.registerTool(
      "aws_cloudwatch_list_metrics",
      {
        title: "List CloudWatch metrics",
        description:
          'Discovers which CloudWatch metrics actually exist — namespace, metric name, and dimensions — so you know exactly what to pass to aws_cloudwatch_get_metric_data. Also doubles as free resource inventory: e.g. namespace "AWS/ECS" + metricName "CPUUtilization" returns every {ClusterName, ServiceName} pair currently publishing it; "AWS/RDS" + "FreeStorageSpace" returns every DBInstanceIdentifier. Narrow with namespace/metricName/dimensions (all server-side, cheap) — omitting all of them lists every metric in the account, which can be large.',
        inputSchema: {
          namespace: z
            .string()
            .optional()
            .describe(
              'Filter to metrics in this namespace, e.g. "AWS/RDS", "AWS/ECS", "AWS/Lambda".',
            ),
          metricName: z
            .string()
            .optional()
            .describe(
              'Filter to metrics with this exact name, e.g. "CPUUtilization".',
            ),
          dimensions: z
            .record(z.string(), z.string())
            .optional()
            .describe(
              'Filter to metrics matching these exact dimension values, e.g. {"ClusterName": "prod"}. All given dimensions must match.',
            ),
          maxResults: z
            .number()
            .int()
            .positive()
            .max(1000)
            .optional()
            .describe(
              "Maximum number of metrics to return (default 200, max 1000).",
            ),
          profile: profileParam,
          region: regionParam,
        },
      },
      withAudit(
        "aws_cloudwatch_list_metrics",
        async ({
          namespace,
          metricName,
          dimensions,
          maxResults,
          profile,
          region,
        }) => {
          const resolvedProfile = profile ?? DEFAULT_PROFILE;
          const credential = credentials.get(resolvedProfile);
          if (!credential) return notConnected(resolvedProfile);

          try {
            const metrics = await listCloudWatchMetrics(credential, {
              region,
              namespace,
              metricName,
              dimensions,
              maxResults,
            });
            return {
              content: [{ type: "text", text: JSON.stringify({ metrics }) }],
            };
          } catch (err) {
            return toErrorResult(err);
          }
        },
      ),
    );

    server.registerTool(
      "aws_cloudwatch_get_metric_data",
      {
        title: "Get CloudWatch metric data",
        description:
          "Fetches datapoints for one or more CloudWatch metrics in a single call — batch every metric/resource you need to check here (e.g. CPUUtilization and MemoryUtilization for every ECS service in a cluster, or FreeStorageSpace for every RDS instance) rather than calling this once per metric. Each result carries back its namespace/metricName/dimensions so you can match it to the query that produced it. startTime/endTime default to the last hour ending now, so an omitted range can't accidentally scan a huge span. Use aws_cloudwatch_list_metrics first to find the exact dimensions a resource publishes under.",
        inputSchema: {
          queries: z
            .array(
              z.object({
                namespace: z
                  .string()
                  .describe('CloudWatch namespace, e.g. "AWS/RDS", "AWS/ECS".'),
                metricName: z
                  .string()
                  .describe(
                    'Metric name, e.g. "CPUUtilization", "FreeStorageSpace".',
                  ),
                dimensions: z
                  .record(z.string(), z.string())
                  .optional()
                  .describe(
                    'Exact dimensions identifying the resource, e.g. {"DBInstanceIdentifier": "prod-orders-db"}. Use aws_cloudwatch_list_metrics to find them.',
                  ),
                stat: z
                  .string()
                  .optional()
                  .describe(
                    'Statistic to compute, e.g. "Average" (default), "Sum", "Maximum", "Minimum", "SampleCount", or a percentile like "p99".',
                  ),
              }),
            )
            .min(1)
            .max(100)
            .describe(
              "One or more metrics to fetch in a single call (max 100) — batch everything you need checked here instead of calling this tool once per metric.",
            ),
          period: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Granularity of each datapoint in seconds (default 300). Must be a period CloudWatch supports for the metric's resolution.",
            ),
          startTime: z
            .string()
            .optional()
            .describe(
              "ISO 8601 timestamp to fetch from. Defaults to 1 hour before endTime.",
            ),
          endTime: z
            .string()
            .optional()
            .describe("ISO 8601 timestamp to fetch until. Defaults to now."),
          maxDatapoints: z
            .number()
            .int()
            .positive()
            .max(1000)
            .optional()
            .describe(
              "Maximum datapoints to return per metric (default 200, max 1000).",
            ),
          profile: profileParam,
          region: regionParam,
        },
      },
      withAudit(
        "aws_cloudwatch_get_metric_data",
        async ({
          queries,
          period,
          startTime,
          endTime,
          maxDatapoints,
          profile,
          region,
        }) => {
          const resolvedProfile = profile ?? DEFAULT_PROFILE;
          const credential = credentials.get(resolvedProfile);
          if (!credential) return notConnected(resolvedProfile);

          try {
            const results = await getCloudWatchMetricData(credential, {
              queries,
              region,
              period,
              startTime,
              endTime,
              maxDatapoints,
            });
            return {
              content: [{ type: "text", text: JSON.stringify({ results }) }],
            };
          } catch (err) {
            return toErrorResult(err);
          }
        },
      ),
    );

    server.registerTool(
      "aws_sqs_list_queues_by_backlog",
      {
        title: "List SQS queues ranked by backlog",
        description:
          "Ranks every SQS queue visible to a profile by how clogged it is — worst first — using the sum of messages waiting, in flight, and delayed. Marks `isDlq` on any queue that another scanned queue's RedrivePolicy names as its dead-letter target, so a DLQ quietly filling up (nothing consumes those) stands out from a busy but healthy working queue. Narrow with `prefix` to scan a smaller, known-relevant set. `offset`/`limit` paginate the ranked list (default limit 50, max 200); `truncated` says whether more ranked queues remain after this page, and `scanIncomplete` says whether the account has more queues than were scanned at all (default/max scan 1000, the per-region SQS quota) — in which case the ranking may be missing some.",
        inputSchema: {
          prefix: z
            .string()
            .optional()
            .describe(
              "Only include queues whose name starts with this prefix.",
            ),
          offset: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe(
              "Number of ranked queues to skip (default 0) — for paginating past the first page.",
            ),
          limit: z
            .number()
            .int()
            .positive()
            .max(200)
            .optional()
            .describe("Maximum ranked queues to return (default 50, max 200)."),
          maxScan: z
            .number()
            .int()
            .positive()
            .max(1000)
            .optional()
            .describe(
              "Maximum queues to scan and rank before paginating (default and max 1000, the per-region SQS queue quota).",
            ),
          profile: profileParam,
          region: regionParam,
        },
      },
      withAudit(
        "aws_sqs_list_queues_by_backlog",
        async ({ prefix, offset, limit, maxScan, profile, region }) => {
          const resolvedProfile = profile ?? DEFAULT_PROFILE;
          const credential = credentials.get(resolvedProfile);
          if (!credential) return notConnected(resolvedProfile);

          try {
            const result = await listSqsQueuesByBacklog(credential, {
              region,
              prefix,
              offset,
              limit,
              maxScan,
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

    server.registerTool(
      "aws_sqs_peek_messages",
      {
        title: "Peek at messages in an SQS queue",
        description:
          'Peeks at messages sitting in a queue — including their bodies — without deleting them. SQS has no read-only "list messages" API, so this briefly makes each returned message invisible to real consumers for `visibilityTimeoutSeconds` (default 5s, capped at 60s, kept short so it doesn\'t meaningfully interfere with production processing); governor never deletes what it peeks, so messages simply become visible again once that timeout elapses. SQS has no stable "page 2" cursor — this returns an approximately-random sample of what\'s currently visible, and standard (non-FIFO) queues don\'t guarantee delivery order. Calling this again after the visibility timeout elapses tends to surface a different set of messages, which is the closest approximation of pagination SQS supports.',
        inputSchema: {
          queueUrl: z
            .string()
            .describe(
              "Full URL of the queue to peek, as returned by aws_sqs_list_queues_by_backlog.",
            ),
          maxMessages: z
            .number()
            .int()
            .positive()
            .max(100)
            .optional()
            .describe("Maximum messages to return (default 10, max 100)."),
          visibilityTimeoutSeconds: z
            .number()
            .int()
            .nonnegative()
            .max(60)
            .optional()
            .describe(
              "How long each peeked message is hidden from real consumers, in seconds (default 5, max 60).",
            ),
          profile: profileParam,
          region: regionParam,
        },
      },
      withAudit(
        "aws_sqs_peek_messages",
        async ({
          queueUrl,
          maxMessages,
          visibilityTimeoutSeconds,
          profile,
          region,
        }) => {
          const resolvedProfile = profile ?? DEFAULT_PROFILE;
          const credential = credentials.get(resolvedProfile);
          if (!credential) return notConnected(resolvedProfile);

          try {
            const result = await peekSqsMessages(credential, queueUrl, {
              region,
              maxMessages,
              visibilityTimeoutSeconds,
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

  registerHttpRoutes(
    credentials: Map<string, AwsCredential>,
  ): Record<string, HttpRouteHandler> {
    return {
      "/providers/aws/identity": () =>
        handleIdentity(credentials, DEFAULT_PROFILE),
      "/providers/aws/:profile/identity": (req) =>
        handleIdentity(credentials, req.params.profile as string),
    };
  },
};
