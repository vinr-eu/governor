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
import { Signer } from "@aws-sdk/rds-signer";
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
  return typeof (err as { name?: string })?.name === "string" &&
    (err as { name: string }).name.includes("NotFound");
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
      return { host: instance.Endpoint.Address, port: instance.Endpoint.Port, adapter };
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
  const instances = (result.Reservations ?? []).flatMap((r) => r.Instances ?? []);
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
    const records = (await sql.unsafe(options.sql)) as Record<string, unknown>[];
    const columns = records.length > 0 ? Object.keys(records[0] as object) : [];
    const rows = records
      .slice(0, maxRows)
      .map((record) =>
        Object.fromEntries(
          Object.entries(record).map(([key, value]) => [key, toJsonSafe(value)]),
        ),
      );

    return { columns, rows, truncated: records.length > maxRows };
  } finally {
    await sql.close({ timeout: 5 });
    await tunnel.close();
  }
}
