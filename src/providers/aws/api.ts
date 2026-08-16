import {
  GetObjectCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import {
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  RDSClient,
} from "@aws-sdk/client-rds";
import { DescribeInstancesCommand, EC2Client } from "@aws-sdk/client-ec2";
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  DescribeLogStreamsCommand,
  FilterLogEventsCommand,
  GetLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  CloudWatchClient,
  GetMetricDataCommand,
  ListMetricsCommand,
} from "@aws-sdk/client-cloudwatch";
import { Signer } from "@aws-sdk/rds-signer";
import {
  DescribeTableCommand,
  DynamoDBClient,
  ListTablesCommand,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { SQL } from "bun";
import type { AccessKeyCredential } from "../credentials";
import { openSsmPortForwardTunnel } from "./ssm-tunnel";

export interface AwsCallerIdentity {
  account?: string;
  arn?: string;
  userId?: string;
}

export async function fetchAwsCallerIdentity(
  credential: AccessKeyCredential,
): Promise<AwsCallerIdentity> {
  const sts = new STSClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    credentials: credential,
  });
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  return {
    account: identity.Account,
    arn: identity.Arn,
    userId: identity.UserId,
  };
}

// One set of credentials can reach buckets in any region, so every S3 call
// takes its region explicitly rather than trusting a single process-wide
// default — falls back to AWS_REGION (or us-east-1) only when the caller
// doesn't know the bucket's actual region yet (e.g. before the first
// `listS3Buckets` call reveals it).
function s3Client(credential: AccessKeyCredential, region?: string): S3Client {
  return new S3Client({
    region: region ?? process.env.AWS_REGION ?? "us-east-1",
    credentials: credential,
  });
}

// S3 rejects a bucket-scoped request made against the wrong region with a
// redirect that names the correct one — the SDK exposes that as an error
// carrying a 301 (or 400 IllegalLocationConstraint) status plus an
// `x-amz-bucket-region` response header. Presigning never sends a request
// (it's pure local signing), so the SDK's own `followRegionRedirects`
// client option can't help there — we read the header ourselves instead.
function redirectedRegion(err: unknown): string | undefined {
  const httpStatusCode = (err as { $metadata?: { httpStatusCode?: number } })
    ?.$metadata?.httpStatusCode;
  if (httpStatusCode !== 301 && httpStatusCode !== 400) return undefined;
  return (err as { $response?: { headers?: Record<string, string> } })
    ?.$response?.headers?.["x-amz-bucket-region"];
}

/**
 * Runs a bucket-scoped S3 call, and if it fails because the bucket lives in
 * a different region than guessed, retries once against the region S3
 * reports back. Returns both the result and the client that succeeded, so
 * callers needing a follow-up call (e.g. presigning) can reuse the
 * now-correct region without guessing again.
 */
async function withRegionRedirect<T>(
  credential: AccessKeyCredential,
  region: string | undefined,
  send: (client: S3Client) => Promise<T>,
): Promise<{ client: S3Client; result: T }> {
  const client = s3Client(credential, region);
  try {
    return { client, result: await send(client) };
  } catch (err) {
    const correctedRegion = redirectedRegion(err);
    if (!correctedRegion) throw err;
    const retryClient = s3Client(credential, correctedRegion);
    return { client: retryClient, result: await send(retryClient) };
  }
}

export interface S3BucketSummary {
  name: string;
  region?: string;
  creationDate?: string;
}

export async function listS3Buckets(
  credential: AccessKeyCredential,
  region?: string,
): Promise<S3BucketSummary[]> {
  const s3 = s3Client(credential, region);
  const result = await s3.send(new ListBucketsCommand({}));
  return (result.Buckets ?? [])
    .filter((bucket) => bucket.Name)
    .map((bucket) => ({
      name: bucket.Name as string,
      region: bucket.BucketRegion,
      creationDate: bucket.CreationDate?.toISOString(),
    }));
}

export interface S3ObjectSummary {
  key: string;
  size?: number;
  lastModified?: string;
  etag?: string;
}

const MAX_S3_SEARCH_RESULTS = 1000;

/**
 * Lists objects in a bucket, optionally narrowed by an S3-native prefix
 * (cheap, server-side) and/or a case-insensitive substring match against
 * the key (client-side, applied after fetching each page). Paginates until
 * `maxResults` is filled or the bucket is exhausted. `region` is just a
 * starting guess — a wrong one self-corrects via `withRegionRedirect` on
 * the first page, then every later page reuses the corrected client.
 */
export async function searchS3Objects(
  credential: AccessKeyCredential,
  bucket: string,
  options: {
    region?: string;
    prefix?: string;
    query?: string;
    maxResults?: number;
  } = {},
): Promise<S3ObjectSummary[]> {
  const maxResults = Math.min(options.maxResults ?? 200, MAX_S3_SEARCH_RESULTS);
  const query = options.query?.toLowerCase();
  const objects: S3ObjectSummary[] = [];
  let continuationToken: string | undefined;

  const fetchPage = (client: S3Client) =>
    client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: options.prefix,
        ContinuationToken: continuationToken,
      }),
    );

  const first = await withRegionRedirect(credential, options.region, fetchPage);
  let s3 = first.client;
  let page = first.result;

  while (true) {
    for (const object of page.Contents ?? []) {
      if (!object.Key) continue;
      if (query && !object.Key.toLowerCase().includes(query)) continue;
      objects.push({
        key: object.Key,
        size: object.Size,
        lastModified: object.LastModified?.toISOString(),
        etag: object.ETag,
      });
      if (objects.length >= maxResults) break;
    }

    continuationToken =
      objects.length < maxResults && page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    if (!continuationToken) break;

    page = await fetchPage(s3);
  }

  return objects;
}

const DEFAULT_PRESIGNED_URL_TTL_SECONDS = 300;
const MAX_PRESIGNED_URL_TTL_SECONDS = 3600;

/**
 * Hands back a time-limited, read-only download URL instead of the object
 * bytes or the underlying credentials — the whole point of exposing this to
 * agents rather than raw S3 access. `HeadObject` first so callers get a
 * clear "not found" instead of a signed URL to a 404 — and doubles as the
 * region probe: presigning never sends a request, so a wrong `region`
 * guess can only be caught and corrected here, before we sign.
 */
export async function createS3PresignedDownloadUrl(
  credential: AccessKeyCredential,
  bucket: string,
  key: string,
  options: { region?: string; expiresInSeconds?: number } = {},
): Promise<string> {
  const { client } = await withRegionRedirect(credential, options.region, (c) =>
    c.send(new HeadObjectCommand({ Bucket: bucket, Key: key })),
  );

  const ttl = Math.min(
    Math.max(1, options.expiresInSeconds ?? DEFAULT_PRESIGNED_URL_TTL_SECONDS),
    MAX_PRESIGNED_URL_TTL_SECONDS,
  );
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: ttl },
  );
}

export interface RdsQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
}

const DEFAULT_RDS_QUERY_MAX_ROWS = 200;
const MAX_RDS_QUERY_MAX_ROWS = 1000;

// Every real RDS/Aurora setup reaches the DB by opening a network connection
// — the Data API's HTTPS-only path only exists for Aurora with it explicitly
// turned on, and even then still requires a Secrets Manager secret to exist.
// So this always goes through an SSM Session Manager tunnel via a bastion
// EC2 instance already inside the target's VPC (no inbound security group
// rule, public IP, or SSH key needed), and authenticates with a short-lived
// IAM database-auth token instead of a stored password — no DB secret is
// ever persisted by governor.

interface RdsEndpointLocation {
  host: string;
  port: number;
  adapter: "postgres" | "mysql";
}

function adapterForEngine(engine: string): "postgres" | "mysql" | undefined {
  if (engine.includes("postgres")) return "postgres";
  if (engine.includes("mysql") || engine.includes("mariadb")) return "mysql";
  return undefined;
}

function isNotFoundError(err: unknown): boolean {
  return (
    typeof (err as { name?: string })?.name === "string" &&
    (err as { name: string }).name.includes("NotFound")
  );
}

/**
 * Resolves `name` to a connectable endpoint, trying it first as a plain RDS
 * instance identifier, then as an Aurora cluster identifier (using the
 * cluster's own stable writer endpoint, which — unlike a specific member
 * instance's endpoint — doesn't change across failover).
 */
async function resolveRdsEndpoint(
  credential: AccessKeyCredential,
  name: string,
  region: string,
): Promise<RdsEndpointLocation> {
  const rds = new RDSClient({ region, credentials: credential });

  try {
    const result = await rds.send(
      new DescribeDBInstancesCommand({ DBInstanceIdentifier: name }),
    );
    const instance = result.DBInstances?.[0];
    if (instance?.Endpoint?.Address && instance.Endpoint.Port) {
      const adapter = adapterForEngine(instance.Engine ?? "");
      if (!adapter) {
        throw new Error(
          `RDS instance "${name}" uses engine "${instance.Engine}", which isn't supported — only Postgres- and MySQL-compatible engines are.`,
        );
      }
      return {
        host: instance.Endpoint.Address,
        port: instance.Endpoint.Port,
        adapter,
      };
    }
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }

  try {
    const result = await rds.send(
      new DescribeDBClustersCommand({ DBClusterIdentifier: name }),
    );
    const cluster = result.DBClusters?.[0];
    if (cluster?.Endpoint && cluster.Port) {
      const adapter = adapterForEngine(cluster.Engine ?? "");
      if (!adapter) {
        throw new Error(
          `Aurora cluster "${name}" uses engine "${cluster.Engine}", which isn't supported — only Postgres- and MySQL-compatible engines are.`,
        );
      }
      return { host: cluster.Endpoint, port: cluster.Port, adapter };
    }
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }

  throw new Error(
    `No RDS instance or Aurora cluster named "${name}" was found in region ${region}.`,
  );
}

async function resolveBastionInstanceId(
  credential: AccessKeyCredential,
  bastionName: string,
  region: string,
): Promise<string> {
  const ec2 = new EC2Client({ region, credentials: credential });
  const result = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: "tag:Name", Values: [bastionName] },
        { Name: "instance-state-name", Values: ["running"] },
      ],
    }),
  );
  const instances = (result.Reservations ?? []).flatMap(
    (r) => r.Instances ?? [],
  );
  if (instances.length === 0) {
    throw new Error(
      `No running EC2 instance named "${bastionName}" was found in region ${region}.`,
    );
  }
  if (instances.length > 1) {
    throw new Error(
      `${instances.length} running EC2 instances are named "${bastionName}" (${instances
        .map((i) => i.InstanceId)
        .join(", ")}) — the Name tag must be unique to use it as a bastion.`,
    );
  }
  const instanceId = instances[0]?.InstanceId;
  if (!instanceId) {
    throw new Error(`Bastion instance "${bastionName}" has no instance id.`);
  }
  return instanceId;
}

// BigInt/Date/Buffer values from the DB driver aren't JSON-serializable as-is
// (JSON.stringify throws on bigint) — this brings them down to plain JSON
// the same way decodeField does for the Data API path above.
function toJsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  return value;
}

/**
 * Runs one SQL statement against an RDS instance or Aurora cluster — reached
 * through an SSM tunnel via a bastion EC2 instance already inside its VPC,
 * and authenticated with a short-lived IAM database-auth token instead of a
 * stored password, so governor never persists a DB secret at all.
 *
 * Every name here — the database, the bastion, the DB user — is the plain
 * human-readable name shown in each console, not an ARN or instance id.
 */
export async function queryRdsInstance(
  credential: AccessKeyCredential,
  options: {
    name: string;
    bastionName: string;
    dbUser: string;
    database: string;
    sql: string;
    region?: string;
    maxRows?: number;
  },
): Promise<RdsQueryResult> {
  const maxRows = Math.min(
    options.maxRows ?? DEFAULT_RDS_QUERY_MAX_ROWS,
    MAX_RDS_QUERY_MAX_ROWS,
  );
  const region = options.region ?? process.env.AWS_REGION ?? "us-east-1";

  const [{ host, port, adapter }, bastionInstanceId] = await Promise.all([
    resolveRdsEndpoint(credential, options.name, region),
    resolveBastionInstanceId(credential, options.bastionName, region),
  ]);

  const tunnel = await openSsmPortForwardTunnel(credential, {
    instanceId: bastionInstanceId,
    remoteHost: host,
    remotePort: port,
    region,
  });

  const signer = new Signer({
    hostname: host,
    port,
    region,
    username: options.dbUser,
    credentials: credential,
  });

  // The TLS handshake happens over the SSM tunnel to the real RDS endpoint,
  // but we connect via 127.0.0.1 — the server cert's hostname will never
  // match that, so hostname/CA verification is skipped below. The hop is
  // still encrypted; what's skipped is validating who's on the other end,
  // which the already-authenticated SSM tunnel covers.
  const sql = new SQL({
    adapter,
    hostname: "127.0.0.1",
    port: tunnel.localPort,
    database: options.database,
    username: options.dbUser,
    password: () => signer.getAuthToken(),
    tls: { rejectUnauthorized: false },
  });

  try {
    const records = (await sql.unsafe(options.sql)) as Record<
      string,
      unknown
    >[];
    const columns = records.length > 0 ? Object.keys(records[0] as object) : [];
    const rows = records
      .slice(0, maxRows)
      .map((record) =>
        Object.fromEntries(
          Object.entries(record).map(([key, value]) => [
            key,
            toJsonSafe(value),
          ]),
        ),
      );

    return { columns, rows, truncated: records.length > maxRows };
  } finally {
    await sql.close({ timeout: 5 });
    await tunnel.close();
  }
}

// DynamoDB tools are read-only (list/describe/get/query/scan) — unlike the
// RDS tool above, there's no arbitrary-statement escape hatch, since a
// single item-level PutItem/UpdateItem/DeleteItem call has no equivalent
// blast-radius guard the way a bounded SELECT does.

function dynamoDbClient(
  credential: AccessKeyCredential,
  region?: string,
): DynamoDBDocumentClient {
  const client = new DynamoDBClient({
    region: region ?? process.env.AWS_REGION ?? "us-east-1",
    credentials: credential,
  });
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
}

export async function listDynamoDbTables(
  credential: AccessKeyCredential,
  region?: string,
): Promise<string[]> {
  const ddb = dynamoDbClient(credential, region);
  const tables: string[] = [];
  let exclusiveStartTableName: string | undefined;

  do {
    const page = await ddb.send(
      new ListTablesCommand({
        ExclusiveStartTableName: exclusiveStartTableName,
      }),
    );
    tables.push(...(page.TableNames ?? []));
    exclusiveStartTableName = page.LastEvaluatedTableName;
  } while (exclusiveStartTableName);

  return tables;
}

export interface DynamoDbKeyElement {
  attributeName: string;
  keyType: "HASH" | "RANGE";
}

export interface DynamoDbTableDescription {
  name: string;
  status?: string;
  itemCount?: number;
  sizeBytes?: number;
  keySchema: DynamoDbKeyElement[];
  globalSecondaryIndexes: { name: string; keySchema: DynamoDbKeyElement[] }[];
}

export async function describeDynamoDbTable(
  credential: AccessKeyCredential,
  tableName: string,
  region?: string,
): Promise<DynamoDbTableDescription> {
  const ddb = dynamoDbClient(credential, region);
  const result = await ddb.send(
    new DescribeTableCommand({ TableName: tableName }),
  );
  const table = result.Table;
  if (!table) {
    throw new Error(`No DynamoDB table named "${tableName}" was found.`);
  }

  const toKeySchema = (
    schema?: { AttributeName?: string; KeyType?: string }[],
  ): DynamoDbKeyElement[] =>
    (schema ?? [])
      .filter((k) => k.AttributeName && k.KeyType)
      .map((k) => ({
        attributeName: k.AttributeName as string,
        keyType: k.KeyType as "HASH" | "RANGE",
      }));

  return {
    name: tableName,
    status: table.TableStatus,
    itemCount: table.ItemCount,
    sizeBytes: table.TableSizeBytes,
    keySchema: toKeySchema(table.KeySchema),
    globalSecondaryIndexes: (table.GlobalSecondaryIndexes ?? []).map((gsi) => ({
      name: gsi.IndexName ?? "",
      keySchema: toKeySchema(gsi.KeySchema),
    })),
  };
}

export async function getDynamoDbItem(
  credential: AccessKeyCredential,
  tableName: string,
  key: Record<string, unknown>,
  region?: string,
): Promise<Record<string, unknown> | undefined> {
  const ddb = dynamoDbClient(credential, region);
  const result = await ddb.send(
    new GetCommand({ TableName: tableName, Key: key }),
  );
  return result.Item;
}

export interface DynamoDbQueryOptions {
  region?: string;
  indexName?: string;
  keyConditionExpression: string;
  filterExpression?: string;
  expressionAttributeNames?: Record<string, string>;
  expressionAttributeValues?: Record<string, unknown>;
  scanIndexForward?: boolean;
  maxItems?: number;
}

export interface DynamoDbItemsResult {
  items: Record<string, unknown>[];
  truncated: boolean;
}

const DEFAULT_DYNAMODB_MAX_ITEMS = 200;
const MAX_DYNAMODB_MAX_ITEMS = 1000;

/**
 * Runs a DynamoDB Query — requires a partition-key equality condition (and
 * optionally a sort-key condition) via `keyConditionExpression`, the same
 * expression syntax the AWS SDK/console use. Paginates internally until
 * `maxItems` is filled or the table/index is exhausted; `truncated` says
 * whether more matching items exist beyond the cap.
 */
export async function queryDynamoDbTable(
  credential: AccessKeyCredential,
  tableName: string,
  options: DynamoDbQueryOptions,
): Promise<DynamoDbItemsResult> {
  const maxItems = Math.min(
    options.maxItems ?? DEFAULT_DYNAMODB_MAX_ITEMS,
    MAX_DYNAMODB_MAX_ITEMS,
  );
  const ddb = dynamoDbClient(credential, options.region);

  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let truncated = false;

  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: options.indexName,
        KeyConditionExpression: options.keyConditionExpression,
        FilterExpression: options.filterExpression,
        ExpressionAttributeNames: options.expressionAttributeNames,
        ExpressionAttributeValues: options.expressionAttributeValues,
        ScanIndexForward: options.scanIndexForward,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of page.Items ?? []) {
      if (items.length >= maxItems) {
        truncated = true;
        break;
      }
      items.push(item);
    }
    exclusiveStartKey =
      items.length < maxItems ? page.LastEvaluatedKey : undefined;
    if (page.LastEvaluatedKey && items.length >= maxItems) truncated = true;
  } while (exclusiveStartKey);

  return { items, truncated };
}

export interface DynamoDbScanOptions {
  region?: string;
  indexName?: string;
  filterExpression?: string;
  expressionAttributeNames?: Record<string, string>;
  expressionAttributeValues?: Record<string, unknown>;
  maxItems?: number;
}

/**
 * Runs a DynamoDB Scan — reads the whole table/index rather than a single
 * partition, narrowed only after the fact by an optional `filterExpression`.
 * Use `queryDynamoDbTable` instead whenever the partition key is known;
 * reach for this when it isn't (the DynamoDB analog of `aws_s3_search_objects`
 * scanning a bucket by substring rather than a known key).
 */
export async function scanDynamoDbTable(
  credential: AccessKeyCredential,
  tableName: string,
  options: DynamoDbScanOptions = {},
): Promise<DynamoDbItemsResult> {
  const maxItems = Math.min(
    options.maxItems ?? DEFAULT_DYNAMODB_MAX_ITEMS,
    MAX_DYNAMODB_MAX_ITEMS,
  );
  const ddb = dynamoDbClient(credential, options.region);

  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let truncated = false;

  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: tableName,
        IndexName: options.indexName,
        FilterExpression: options.filterExpression,
        ExpressionAttributeNames: options.expressionAttributeNames,
        ExpressionAttributeValues: options.expressionAttributeValues,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of page.Items ?? []) {
      if (items.length >= maxItems) {
        truncated = true;
        break;
      }
      items.push(item);
    }
    exclusiveStartKey =
      items.length < maxItems ? page.LastEvaluatedKey : undefined;
    if (page.LastEvaluatedKey && items.length >= maxItems) truncated = true;
  } while (exclusiveStartKey);

  return { items, truncated };
}

function cloudWatchLogsClient(
  credential: AccessKeyCredential,
  region?: string,
): CloudWatchLogsClient {
  return new CloudWatchLogsClient({
    region: region ?? process.env.AWS_REGION ?? "us-east-1",
    credentials: credential,
  });
}

export interface LogGroupSummary {
  name: string;
  storedBytes?: number;
  retentionInDays?: number;
  creationTime?: string;
}

const DEFAULT_LOG_GROUPS_MAX_RESULTS = 200;
const MAX_LOG_GROUPS_MAX_RESULTS = 1000;

export async function listCloudWatchLogGroups(
  credential: AccessKeyCredential,
  options: { region?: string; prefix?: string; maxResults?: number } = {},
): Promise<LogGroupSummary[]> {
  const maxResults = Math.min(
    options.maxResults ?? DEFAULT_LOG_GROUPS_MAX_RESULTS,
    MAX_LOG_GROUPS_MAX_RESULTS,
  );
  const logs = cloudWatchLogsClient(credential, options.region);

  const groups: LogGroupSummary[] = [];
  let nextToken: string | undefined;

  do {
    const page = await logs.send(
      new DescribeLogGroupsCommand({
        logGroupNamePrefix: options.prefix,
        nextToken,
      }),
    );
    for (const group of page.logGroups ?? []) {
      if (!group.logGroupName) continue;
      groups.push({
        name: group.logGroupName,
        storedBytes: group.storedBytes,
        retentionInDays: group.retentionInDays,
        creationTime:
          group.creationTime !== undefined
            ? new Date(group.creationTime).toISOString()
            : undefined,
      });
      if (groups.length >= maxResults) break;
    }
    nextToken = groups.length < maxResults ? page.nextToken : undefined;
  } while (nextToken);

  return groups;
}

export interface LogEvent {
  timestamp?: string;
  message?: string;
  logStreamName?: string;
}

export interface LogSearchResult {
  events: LogEvent[];
  truncated: boolean;
}

const DEFAULT_LOG_SEARCH_MAX_RESULTS = 200;
const MAX_LOG_SEARCH_MAX_RESULTS = 1000;
const DEFAULT_LOG_SEARCH_LOOKBACK_MS = 60 * 60 * 1000;

/**
 * Runs CloudWatch Logs FilterLogEvents against one log group — the read path
 * for debugging/incident response, since it searches across every log
 * stream in the group ordered by time rather than requiring a specific
 * stream name up front. `startTime`/`endTime` default to the last hour
 * ending now, so an omitted range can't accidentally scan a group's entire
 * retention window. Paginates internally until `maxResults` is filled or the
 * range is exhausted; `truncated` says whether more matching events exist.
 *
 * `order: "desc"` switches to tail mode (see `tailCloudWatchLogs` below)
 * instead of this forward scan — it doesn't support `filterPattern` and
 * ignores the default 1-hour lookback, since its cost doesn't scale with
 * how far back it has to look the way a forward scan's does.
 */
export async function searchCloudWatchLogs(
  credential: AccessKeyCredential,
  logGroupName: string,
  options: {
    region?: string;
    filterPattern?: string;
    logStreamNamePrefix?: string;
    startTime?: string;
    endTime?: string;
    maxResults?: number;
    order?: "asc" | "desc";
  } = {},
): Promise<LogSearchResult> {
  const maxResults = Math.min(
    options.maxResults ?? DEFAULT_LOG_SEARCH_MAX_RESULTS,
    MAX_LOG_SEARCH_MAX_RESULTS,
  );

  if (options.order === "desc") {
    if (options.filterPattern) {
      throw new Error(
        'order "desc" (tail mode) can\'t be combined with filterPattern — CloudWatch\'s tail read (GetLogEvents) has no server-side filter, only FilterLogEvents does. Drop filterPattern, or use order "asc" with an explicit time range instead.',
      );
    }
    return tailCloudWatchLogs(credential, logGroupName, {
      region: options.region,
      logStreamNamePrefix: options.logStreamNamePrefix,
      startTime: options.startTime,
      endTime: options.endTime,
      maxResults,
    });
  }

  const endTime = options.endTime ? Date.parse(options.endTime) : Date.now();
  if (Number.isNaN(endTime)) {
    throw new Error(`Invalid endTime: "${options.endTime}"`);
  }
  const startTime = options.startTime
    ? Date.parse(options.startTime)
    : endTime - DEFAULT_LOG_SEARCH_LOOKBACK_MS;
  if (Number.isNaN(startTime)) {
    throw new Error(`Invalid startTime: "${options.startTime}"`);
  }

  const logs = cloudWatchLogsClient(credential, options.region);

  const events: LogEvent[] = [];
  let nextToken: string | undefined;
  let truncated = false;

  do {
    const page = await logs.send(
      new FilterLogEventsCommand({
        logGroupName,
        logStreamNamePrefix: options.logStreamNamePrefix,
        filterPattern: options.filterPattern,
        startTime,
        endTime,
        nextToken,
        limit: Math.max(1, maxResults - events.length),
      }),
    );
    for (const event of page.events ?? []) {
      if (events.length >= maxResults) {
        truncated = true;
        break;
      }
      events.push({
        timestamp:
          event.timestamp !== undefined
            ? new Date(event.timestamp).toISOString()
            : undefined,
        message: event.message,
        logStreamName: event.logStreamName,
      });
    }
    nextToken = events.length < maxResults ? page.nextToken : undefined;
    if (page.nextToken && events.length >= maxResults) truncated = true;
  } while (nextToken);

  return { events, truncated };
}

const TAIL_STREAM_FAN_OUT_CAP = 20;
const TAIL_STREAM_PREFIX_SCAN_CAP = 250;

/**
 * Finds the log group's most-recently-active streams — the ones tail mode
 * needs to read from. `DescribeLogStreams` can sort by `LastEventTime`
 * directly, which is exactly this ordering, but AWS doesn't let that be
 * combined with `logStreamNamePrefix` in the same call. So when narrowing by
 * stream name, this instead pages through matching streams (bounded by
 * `TAIL_STREAM_PREFIX_SCAN_CAP`) and sorts by recency itself.
 */
async function mostRecentlyActiveLogStreams(
  logs: CloudWatchLogsClient,
  logGroupName: string,
  options: { logStreamNamePrefix?: string; fanOut: number },
): Promise<string[]> {
  if (!options.logStreamNamePrefix) {
    const page = await logs.send(
      new DescribeLogStreamsCommand({
        logGroupName,
        orderBy: "LastEventTime",
        descending: true,
        limit: options.fanOut,
      }),
    );
    return (page.logStreams ?? [])
      .filter((stream) => stream.logStreamName)
      .map((stream) => stream.logStreamName as string);
  }

  const candidates: { name: string; lastEventTimestamp: number }[] = [];
  let nextToken: string | undefined;
  do {
    const page = await logs.send(
      new DescribeLogStreamsCommand({
        logGroupName,
        logStreamNamePrefix: options.logStreamNamePrefix,
        nextToken,
        limit: 50,
      }),
    );
    for (const stream of page.logStreams ?? []) {
      if (!stream.logStreamName) continue;
      candidates.push({
        name: stream.logStreamName,
        lastEventTimestamp: stream.lastEventTimestamp ?? -Infinity,
      });
    }
    nextToken =
      candidates.length < TAIL_STREAM_PREFIX_SCAN_CAP
        ? page.nextToken
        : undefined;
  } while (nextToken);

  candidates.sort((a, b) => b.lastEventTimestamp - a.lastEventTimestamp);
  return candidates.slice(0, options.fanOut).map((candidate) => candidate.name);
}

interface RawTailEvent {
  timestampMs: number;
  message?: string;
  logStreamName: string;
}

function toTailResult(
  events: RawTailEvent[],
  maxResults: number,
): LogSearchResult {
  events.sort((a, b) => a.timestampMs - b.timestampMs);
  const tail = events.slice(-maxResults).map((event) => ({
    timestamp: new Date(event.timestampMs).toISOString(),
    message: event.message,
    logStreamName: event.logStreamName,
  }));
  return { events: tail, truncated: events.length > maxResults };
}

/**
 * Reads each of `streamNames` backward from its tail via
 * GetLogEvents(startFromHead: false) and merges the results. Cost is
 * bounded by streamNames.length × maxResults regardless of how old the
 * matching events turn out to be — the fast path when the streams are
 * actually still listed (see the fallback below for when they aren't).
 */
async function tailKnownLogStreams(
  logs: CloudWatchLogsClient,
  logGroupName: string,
  streamNames: string[],
  options: { startTime?: number; endTime?: number; maxResults: number },
): Promise<RawTailEvent[]> {
  const streamPages = await Promise.all(
    streamNames.map((logStreamName) =>
      logs.send(
        new GetLogEventsCommand({
          logGroupName,
          logStreamName,
          startFromHead: false,
          startTime: options.startTime,
          endTime: options.endTime,
          limit: options.maxResults,
        }),
      ),
    ),
  );

  const events: RawTailEvent[] = [];
  streamPages.forEach((page, i) => {
    for (const event of page.events ?? []) {
      if (event.timestamp === undefined) continue;
      events.push({
        timestampMs: event.timestamp,
        message: event.message,
        logStreamName: streamNames[i] as string,
      });
    }
  });
  return events;
}

const TAIL_SCAN_INITIAL_WINDOW_MS = 15 * 60 * 1000;
const TAIL_SCAN_MAX_DOUBLINGS = 20;
const TAIL_SCAN_PER_WINDOW_EVENT_CAP = 2000;

/**
 * Fallback tail strategy for when DescribeLogStreams comes back empty even
 * though the group demonstrably has events — CloudWatch stops listing a
 * stream via DescribeLogStreams some time after its last write, while
 * FilterLogEvents can still retrieve its events for as long as the group's
 * retention keeps them. (Confirmed empirically: a group whose last write was
 * over a year ago returned zero streams from DescribeLogStreams but real
 * events from FilterLogEvents.) This instead runs FilterLogEvents over a
 * window anchored at `endTime`/now, doubling the window backward
 * (15m, 30m, 1h, ...) until it collects `maxResults` events or hits
 * `startTime`/`TAIL_SCAN_MAX_DOUBLINGS` — cheap when the tail is recent,
 * more expensive the further back it turns out to be, unlike the
 * stream-based path whose cost doesn't depend on age at all.
 */
async function tailViaExpandingScan(
  logs: CloudWatchLogsClient,
  logGroupName: string,
  options: {
    logStreamNamePrefix?: string;
    startTime?: number;
    endTime?: number;
    maxResults: number;
  },
): Promise<RawTailEvent[]> {
  const anchorEnd = options.endTime ?? Date.now();
  let windowMs = TAIL_SCAN_INITIAL_WINDOW_MS;
  let events: RawTailEvent[] = [];

  for (let attempt = 0; attempt < TAIL_SCAN_MAX_DOUBLINGS; attempt++) {
    const windowStart =
      options.startTime !== undefined
        ? Math.max(options.startTime, anchorEnd - windowMs)
        : anchorEnd - windowMs;

    events = [];
    let nextToken: string | undefined;
    do {
      const page = await logs.send(
        new FilterLogEventsCommand({
          logGroupName,
          logStreamNamePrefix: options.logStreamNamePrefix,
          startTime: windowStart,
          endTime: anchorEnd,
          nextToken,
        }),
      );
      for (const event of page.events ?? []) {
        if (event.timestamp === undefined) continue;
        events.push({
          timestampMs: event.timestamp,
          message: event.message,
          logStreamName: event.logStreamName ?? "",
        });
      }
      nextToken =
        events.length < TAIL_SCAN_PER_WINDOW_EVENT_CAP
          ? page.nextToken
          : undefined;
    } while (nextToken);

    if (events.length >= options.maxResults) break;
    if (options.startTime !== undefined && windowStart <= options.startTime) {
      break;
    }
    windowMs *= 2;
  }

  return events;
}

/**
 * Tails a log group: its most recent events, oldest-first, without needing
 * to know how far back they actually are. Unlike the forward scan above
 * (FilterLogEvents has no reverse mode), this first tries the group's
 * most-recently-active streams via DescribeLogStreams and reads each one
 * backward with GetLogEvents(startFromHead: false) — see
 * `tailKnownLogStreams`. If that comes back empty, it falls back to
 * `tailViaExpandingScan`, since DescribeLogStreams is known to stop listing
 * streams some time after their last write even while their events remain
 * queryable.
 *
 * Tradeoffs either path inherits: no `filterPattern` (neither GetLogEvents
 * nor this fallback's per-window scan filters server-side — the fallback
 * could in principle, but doesn't yet), and the stream-based path only
 * considers the `fanOut` most recently active streams — fine for the common
 * case of a handful of active streams, but an event sitting in a stream
 * outside that set won't surface there (the fallback, when it triggers,
 * doesn't have this gap since it reads the group directly).
 */
async function tailCloudWatchLogs(
  credential: AccessKeyCredential,
  logGroupName: string,
  options: {
    region?: string;
    logStreamNamePrefix?: string;
    startTime?: string;
    endTime?: string;
    maxResults: number;
  },
): Promise<LogSearchResult> {
  const startTime = options.startTime
    ? Date.parse(options.startTime)
    : undefined;
  if (options.startTime && Number.isNaN(startTime)) {
    throw new Error(`Invalid startTime: "${options.startTime}"`);
  }
  const endTime = options.endTime ? Date.parse(options.endTime) : undefined;
  if (options.endTime && Number.isNaN(endTime)) {
    throw new Error(`Invalid endTime: "${options.endTime}"`);
  }

  const logs = cloudWatchLogsClient(credential, options.region);
  const fanOut = Math.min(options.maxResults, TAIL_STREAM_FAN_OUT_CAP);
  const streamNames = await mostRecentlyActiveLogStreams(logs, logGroupName, {
    logStreamNamePrefix: options.logStreamNamePrefix,
    fanOut,
  });

  let events =
    streamNames.length > 0
      ? await tailKnownLogStreams(logs, logGroupName, streamNames, {
          startTime,
          endTime,
          maxResults: options.maxResults,
        })
      : [];

  if (events.length === 0) {
    events = await tailViaExpandingScan(logs, logGroupName, {
      logStreamNamePrefix: options.logStreamNamePrefix,
      startTime,
      endTime,
      maxResults: options.maxResults,
    });
  }

  return toTailResult(events, options.maxResults);
}

function cloudWatchClient(
  credential: AccessKeyCredential,
  region?: string,
): CloudWatchClient {
  return new CloudWatchClient({
    region: region ?? process.env.AWS_REGION ?? "us-east-1",
    credentials: credential,
  });
}

export interface CloudWatchMetricIdentity {
  namespace: string;
  metricName: string;
  dimensions: Record<string, string>;
}

const DEFAULT_METRICS_MAX_RESULTS = 200;
const MAX_METRICS_MAX_RESULTS = 1000;

/**
 * Discovers which CloudWatch metrics actually exist (namespace, metric name,
 * dimensions) rather than requiring the caller to already know the exact
 * dimension values a service publishes under. This doubles as free resource
 * inventory: e.g. namespace "AWS/ECS" + metricName "CPUUtilization" returns
 * every {ClusterName, ServiceName} pair currently publishing it, without a
 * dedicated ECS tool.
 */
export async function listCloudWatchMetrics(
  credential: AccessKeyCredential,
  options: {
    region?: string;
    namespace?: string;
    metricName?: string;
    dimensions?: Record<string, string>;
    maxResults?: number;
  } = {},
): Promise<CloudWatchMetricIdentity[]> {
  const maxResults = Math.min(
    options.maxResults ?? DEFAULT_METRICS_MAX_RESULTS,
    MAX_METRICS_MAX_RESULTS,
  );
  const cw = cloudWatchClient(credential, options.region);

  const metrics: CloudWatchMetricIdentity[] = [];
  let nextToken: string | undefined;

  do {
    const page = await cw.send(
      new ListMetricsCommand({
        Namespace: options.namespace,
        MetricName: options.metricName,
        Dimensions: options.dimensions
          ? Object.entries(options.dimensions).map(([Name, Value]) => ({
              Name,
              Value,
            }))
          : undefined,
        NextToken: nextToken,
      }),
    );
    for (const metric of page.Metrics ?? []) {
      if (!metric.Namespace || !metric.MetricName) continue;
      metrics.push({
        namespace: metric.Namespace,
        metricName: metric.MetricName,
        dimensions: Object.fromEntries(
          (metric.Dimensions ?? [])
            .filter((d) => d.Name && d.Value)
            .map((d) => [d.Name as string, d.Value as string]),
        ),
      });
      if (metrics.length >= maxResults) break;
    }
    nextToken = metrics.length < maxResults ? page.NextToken : undefined;
  } while (nextToken);

  return metrics;
}

export interface CloudWatchMetricQuery {
  namespace: string;
  metricName: string;
  dimensions?: Record<string, string>;
  stat?: string;
}

export interface CloudWatchMetricDatapoint {
  timestamp: string;
  value: number;
}

export interface CloudWatchMetricResult extends CloudWatchMetricIdentity {
  stat: string;
  datapoints: CloudWatchMetricDatapoint[];
  truncated: boolean;
}

const DEFAULT_METRIC_STAT = "Average";
const DEFAULT_METRIC_PERIOD_SECONDS = 300;
const DEFAULT_METRIC_DATA_MAX_DATAPOINTS = 200;
const MAX_METRIC_DATA_MAX_DATAPOINTS = 1000;
const MAX_METRIC_DATA_QUERIES = 100;
const DEFAULT_METRIC_DATA_LOOKBACK_MS = 60 * 60 * 1000;

const metricQueryId = (index: number) => `m${index}`;

/**
 * Fetches datapoints for one or more metrics in a single CloudWatch
 * GetMetricData call, batched via CloudWatch's own MetricDataQueries rather
 * than one API call per metric — the shape a "scan every service/instance
 * for anomalies" question actually needs (e.g. CPU + memory across every
 * ECS service in a cluster) instead of N round trips. `startTime`/`endTime`
 * default to the last hour ending now, same as `searchCloudWatchLogs`, so an
 * omitted range can't accidentally scan a huge span. Paginates internally
 * until every query's `maxDatapoints` cap is hit or the range is exhausted;
 * each result's `truncated` flag says whether more datapoints exist beyond
 * the cap.
 */
export async function getCloudWatchMetricData(
  credential: AccessKeyCredential,
  options: {
    queries: CloudWatchMetricQuery[];
    region?: string;
    period?: number;
    startTime?: string;
    endTime?: string;
    maxDatapoints?: number;
  },
): Promise<CloudWatchMetricResult[]> {
  if (options.queries.length === 0) {
    throw new Error("queries must contain at least one metric.");
  }
  if (options.queries.length > MAX_METRIC_DATA_QUERIES) {
    throw new Error(
      `Too many queries (${options.queries.length}) — max ${MAX_METRIC_DATA_QUERIES} per call.`,
    );
  }

  const maxDatapoints = Math.min(
    options.maxDatapoints ?? DEFAULT_METRIC_DATA_MAX_DATAPOINTS,
    MAX_METRIC_DATA_MAX_DATAPOINTS,
  );
  const period = options.period ?? DEFAULT_METRIC_PERIOD_SECONDS;

  const endTime = options.endTime ? Date.parse(options.endTime) : Date.now();
  if (Number.isNaN(endTime)) {
    throw new Error(`Invalid endTime: "${options.endTime}"`);
  }
  const startTime = options.startTime
    ? Date.parse(options.startTime)
    : endTime - DEFAULT_METRIC_DATA_LOOKBACK_MS;
  if (Number.isNaN(startTime)) {
    throw new Error(`Invalid startTime: "${options.startTime}"`);
  }

  const cw = cloudWatchClient(credential, options.region);

  const metricDataQueries = options.queries.map((query, index) => ({
    Id: metricQueryId(index),
    MetricStat: {
      Metric: {
        Namespace: query.namespace,
        MetricName: query.metricName,
        Dimensions: query.dimensions
          ? Object.entries(query.dimensions).map(([Name, Value]) => ({
              Name,
              Value,
            }))
          : undefined,
      },
      Period: period,
      Stat: query.stat ?? DEFAULT_METRIC_STAT,
    },
    ReturnData: true,
  }));

  const collected = new Map<string, { timestampMs: number; value: number }[]>(
    metricDataQueries.map((q) => [q.Id, []]),
  );
  const truncatedIds = new Set<string>();

  let nextToken: string | undefined;
  do {
    const page = await cw.send(
      new GetMetricDataCommand({
        MetricDataQueries: metricDataQueries,
        StartTime: new Date(startTime),
        EndTime: new Date(endTime),
        ScanBy: "TimestampAscending",
        NextToken: nextToken,
      }),
    );

    for (const result of page.MetricDataResults ?? []) {
      if (!result.Id) continue;
      const bucket = collected.get(result.Id);
      if (!bucket) continue;
      const timestamps = result.Timestamps ?? [];
      const values = result.Values ?? [];
      for (let i = 0; i < timestamps.length; i++) {
        if (bucket.length >= maxDatapoints) {
          truncatedIds.add(result.Id);
          break;
        }
        const timestamp = timestamps[i];
        const value = values[i];
        if (!timestamp || value === undefined) continue;
        bucket.push({ timestampMs: timestamp.getTime(), value });
      }
      if (bucket.length >= maxDatapoints) truncatedIds.add(result.Id);
    }

    const allFull = [...collected.values()].every(
      (bucket) => bucket.length >= maxDatapoints,
    );
    nextToken = allFull ? undefined : page.NextToken;
  } while (nextToken);

  return options.queries.map((query, index) => {
    const bucket = collected.get(metricQueryId(index)) ?? [];
    bucket.sort((a, b) => a.timestampMs - b.timestampMs);
    return {
      namespace: query.namespace,
      metricName: query.metricName,
      dimensions: query.dimensions ?? {},
      stat: query.stat ?? DEFAULT_METRIC_STAT,
      datapoints: bucket.map((point) => ({
        timestamp: new Date(point.timestampMs).toISOString(),
        value: point.value,
      })),
      truncated: truncatedIds.has(metricQueryId(index)),
    };
  });
}
