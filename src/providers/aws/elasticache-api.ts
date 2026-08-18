import {
  DescribeCacheClustersCommand,
  DescribeReplicationGroupsCommand,
  ElastiCacheClient,
} from "@aws-sdk/client-elasticache";
import { RedisClient } from "bun";
import type { AccessKeyCredential } from "../credentials";
import { resolveBastionAddress } from "./api";
import { openSshPortForwardTunnel } from "../ssh-tunnel";

// Unlike RDS, an ElastiCache replication group/cluster has no
// `PubliclyAccessible` flag at all — it's VPC-only by design, so in practice
// `bastionName` is required rather than optional. The direct path (no
// bastion) is still supported for the case where `governor serve` itself
// runs inside the target VPC (or a peered one), but there's no AWS-reported
// flag to check up front the way RDS's is — an unreachable direct attempt
// just times out with a normal connection error.
//
// There's also no IAM database-auth-token equivalent for ElastiCache the way
// `@aws-sdk/rds-signer` provides for RDS — no AWS SDK package for it exists.
// Authentication is purely the replication group's own AUTH token (opt-in,
// same as RDS's stored-password path), required whenever `AuthTokenEnabled`
// is on.

interface ElastiCacheEndpointLocation {
  host: string;
  port: number;
  engine: string;
  authTokenEnabled: boolean;
  transitEncryptionEnabled: boolean;
}

function isNotFoundError(err: unknown): boolean {
  return (
    typeof (err as { name?: string })?.name === "string" &&
    (err as { name: string }).name.includes("NotFound")
  );
}

/**
 * Resolves `name` to a connectable endpoint, trying it first as a
 * replication group identifier (Valkey/Redis OSS — the common case), then as
 * a standalone cache cluster identifier (Memcached, or a Redis cluster not
 * part of a replication group). For a cluster-mode-enabled replication group
 * this returns the configuration endpoint (client-side sharding); otherwise
 * the primary node group's endpoint.
 */
async function resolveElastiCacheEndpoint(
  credential: AccessKeyCredential,
  name: string,
  region: string,
): Promise<ElastiCacheEndpointLocation> {
  const elasticache = new ElastiCacheClient({ region, credentials: credential });

  try {
    const result = await elasticache.send(
      new DescribeReplicationGroupsCommand({ ReplicationGroupId: name }),
    );
    const group = result.ReplicationGroups?.[0];
    if (group) {
      const endpoint = group.ClusterEnabled
        ? group.ConfigurationEndpoint
        : group.NodeGroups?.[0]?.PrimaryEndpoint;
      if (endpoint?.Address && endpoint.Port) {
        return {
          host: endpoint.Address,
          port: endpoint.Port,
          engine: group.Engine ?? "redis",
          authTokenEnabled: group.AuthTokenEnabled ?? false,
          transitEncryptionEnabled: group.TransitEncryptionEnabled ?? false,
        };
      }
    }
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }

  try {
    const result = await elasticache.send(
      new DescribeCacheClustersCommand({
        CacheClusterId: name,
        ShowCacheNodeInfo: true,
      }),
    );
    const cluster = result.CacheClusters?.[0];
    if (cluster) {
      const endpoint = cluster.ConfigurationEndpoint ?? cluster.CacheNodes?.[0]?.Endpoint;
      if (endpoint?.Address && endpoint.Port) {
        return {
          host: endpoint.Address,
          port: endpoint.Port,
          engine: cluster.Engine ?? "memcached",
          authTokenEnabled: cluster.AuthTokenEnabled ?? false,
          transitEncryptionEnabled: cluster.TransitEncryptionEnabled ?? false,
        };
      }
    }
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }

  throw new Error(
    `No ElastiCache replication group or cache cluster named "${name}" was found in region ${region}.`,
  );
}

export interface ElastiCacheCommandResult {
  result: unknown;
}

/**
 * Runs one Redis command against an ElastiCache replication group or cache
 * cluster, naming it the way the console does — never by ARN. Reached the
 * same two ways as `queryRdsInstance`: through an SSH tunnel via a bastion
 * EC2 instance when `bastionName` is given, or directly to the resource's
 * own endpoint otherwise (only realistic when governor itself already has
 * network access to the VPC, since ElastiCache has no public-endpoint mode).
 *
 * Only Valkey/Redis OSS engines are supported — Bun's Redis client only
 * speaks the Redis wire protocol, so a Memcached cluster fails with a clear
 * error rather than a confusing connection failure.
 */
export async function runElastiCacheRedisCommand(
  credential: AccessKeyCredential,
  options: {
    name: string;
    bastionName?: string;
    command: string;
    args?: string[];
    region?: string;
    authToken?: string;
    ssh?: {
      username: string;
      privateKey: string;
      passphrase?: string;
      port?: number;
    };
  },
): Promise<ElastiCacheCommandResult> {
  const region = options.region ?? process.env.AWS_REGION ?? "us-east-1";

  const [location, bastionAddress] = await Promise.all([
    resolveElastiCacheEndpoint(credential, options.name, region),
    options.bastionName
      ? resolveBastionAddress(credential, options.bastionName, region)
      : Promise.resolve(undefined),
  ]);

  if (location.engine === "memcached") {
    throw new Error(
      `"${options.name}" is a Memcached cluster — only Valkey/Redis OSS clusters can be queried (Bun's Redis client only speaks the Redis wire protocol).`,
    );
  }

  if (location.authTokenEnabled && !options.authToken) {
    throw new Error(
      `"${options.name}" has AuthTokenEnabled — store one with \`governor store redis-auth-token ${options.name}\` first.`,
    );
  }

  const tunnel =
    bastionAddress && options.ssh
      ? await openSshPortForwardTunnel({
          host: bastionAddress,
          port: options.ssh.port,
          username: options.ssh.username,
          privateKey: options.ssh.privateKey,
          passphrase: options.ssh.passphrase,
          remoteHost: location.host,
          remotePort: location.port,
        })
      : undefined;

  const host = tunnel ? "127.0.0.1" : location.host;
  const port = tunnel ? tunnel.localPort : location.port;

  // Tunneled + in-transit encryption on: the TLS handshake reaches the real
  // ElastiCache endpoint through the tunnel, but we connect via 127.0.0.1, so
  // hostname/CA verification is skipped — same tradeoff as the RDS tunnel
  // path, covered by the already-authenticated SSH hop instead.
  //
  // Direct + in-transit encryption on: full TLS verification against the
  // real endpoint hostname.
  //
  // In-transit encryption off (either path): plain `redis://` — nothing to
  // verify, and when tunneled the SSH hop is the only encryption in play.
  const scheme = location.transitEncryptionEnabled ? "rediss" : "redis";
  const authPrefix = options.authToken
    ? `:${encodeURIComponent(options.authToken)}@`
    : "";
  const url = `${scheme}://${authPrefix}${host}:${port}`;

  const client = new RedisClient(url, {
    connectionTimeout: 15_000,
    tls:
      tunnel && location.transitEncryptionEnabled
        ? { rejectUnauthorized: false }
        : undefined,
  });

  try {
    const result = await client.send(options.command, options.args ?? []);
    return { result };
  } finally {
    client.close();
    await tunnel?.close();
  }
}
