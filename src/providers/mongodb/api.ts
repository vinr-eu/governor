import {
  Binary,
  Decimal128,
  Long,
  MongoClient,
  ObjectId,
  Timestamp,
  type Sort,
} from "mongodb";
import { openSshPortForwardTunnel, type SshTunnel } from "../ssh-tunnel";

export interface MongoQueryResult {
  documents: Record<string, unknown>[];
  truncated: boolean;
}

const DEFAULT_MAX_DOCS = 200;
const MAX_MAX_DOCS = 1000;
const CONNECT_TIMEOUT_MS = 15_000;

// Read-only by design, the same call MongoDB's own tools (mongosh, Compass)
// make against a `find`/`aggregate`: a `filter` covers the common case, and
// `pipeline` is the escape hatch for anything a filter can't express
// ($lookup, $group, $unwind, …) — the closest equivalent to RDS's arbitrary
// SQL string, minus the write path. Unlike RDS, a single MongoDB write
// (updateOne/deleteMany/…) has no equivalent blast-radius guard the way a
// bounded find/aggregate does, so — mirroring the DynamoDB tools' reasoning
// — there's no write escape hatch here either.

// ObjectId/Date/Decimal128/Long/Timestamp/Binary values from the driver
// aren't JSON-serializable as-is (JSON.stringify either throws or silently
// mangles them) — this brings them down to plain JSON, the same role
// `toJsonSafe` plays for the RDS driver's bigint/Date/Buffer values.
function toJsonSafe(value: unknown): unknown {
  if (value instanceof ObjectId) return value.toHexString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Decimal128) return value.toString();
  if (value instanceof Long) return value.toString();
  if (value instanceof Timestamp) return value.toString();
  if (value instanceof Binary)
    return Buffer.from(value.buffer).toString("base64");
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, v]) => [
        key,
        toJsonSafe(v),
      ]),
    );
  }
  return value;
}

interface ParsedMongoUri {
  scheme: "mongodb" | "mongodb+srv";
  userinfo: string;
  hosts: string[];
  pathAndQuery: string;
}

function parseMongoUri(uri: string): ParsedMongoUri {
  const match = uri.match(/^(mongodb(?:\+srv)?):\/\/([^/?]*)(.*)$/s);
  if (!match) {
    throw new Error(
      'Stored MongoDB URI is not a valid connection string — expected it to start with "mongodb://" or "mongodb+srv://".',
    );
  }
  const [, scheme, authority, pathAndQuery] = match as [
    string,
    "mongodb" | "mongodb+srv",
    string,
    string,
  ];
  const atIndex = authority.lastIndexOf("@");
  const userinfo = atIndex >= 0 ? authority.slice(0, atIndex + 1) : "";
  const hostlist = atIndex >= 0 ? authority.slice(atIndex + 1) : authority;
  return { scheme, userinfo, hosts: hostlist.split(","), pathAndQuery };
}

/**
 * Resolves the single host:port a bastion tunnel connects to. SRV
 * ("mongodb+srv://") URIs resolve to a variable set of hosts via DNS —
 * exactly what Atlas gives you — which a single SSH tunnel can't stand in
 * for, so those are rejected with a clear error rather than silently
 * tunneling to the wrong thing. A standard URI naming more than one host
 * (a replica set list) is rejected the same way: pick the one node the
 * bastion can actually reach.
 */
function resolveSingleHostForTunnel(uri: string): {
  host: string;
  port: number;
} {
  const parsed = parseMongoUri(uri);
  if (parsed.scheme === "mongodb+srv") {
    throw new Error(
      'Cannot tunnel a "mongodb+srv://" connection string through a bastion — SRV URIs (the standard for Atlas) resolve to multiple hosts via DNS, which a single SSH tunnel can\'t represent. Store a standard "mongodb://host:port/..." URI naming exactly one reachable node for bastion use, or omit bastionName to connect directly.',
    );
  }
  if (parsed.hosts.length > 1) {
    throw new Error(
      `Bastion tunneling only supports a single-host "mongodb://" URI, but the stored URI names ${parsed.hosts.length} hosts (${parsed.hosts.join(", ")}) — store one naming exactly the node the bastion can reach.`,
    );
  }
  const [hostPort] = parsed.hosts;
  const [host, portStr] = hostPort!.split(":");
  if (!host) {
    throw new Error("Stored MongoDB URI has no host to tunnel to.");
  }
  return { host, port: portStr ? Number(portStr) : 27017 };
}

/**
 * Rewrites a single-host "mongodb://" URI to point at the tunnel's local
 * loopback port instead of the real host, forcing `directConnection=true`
 * (skip replica-set topology discovery — the tunnel only carries traffic to
 * this one node) and relaxing TLS hostname/cert checks the same way the RDS
 * and ElastiCache tunnels do: the hop is still encrypted, what's skipped is
 * confirming which host is on the other end, covered by the
 * already-authenticated SSH tunnel instead.
 */
function rewriteUriForTunnel(uri: string, localPort: number): string {
  const parsed = parseMongoUri(uri);
  const qIndex = parsed.pathAndQuery.indexOf("?");
  const path =
    qIndex >= 0 ? parsed.pathAndQuery.slice(0, qIndex) : parsed.pathAndQuery;
  const query = new URLSearchParams(
    qIndex >= 0 ? parsed.pathAndQuery.slice(qIndex + 1) : "",
  );
  query.set("directConnection", "true");
  query.set("tlsAllowInvalidHostnames", "true");
  query.set("tlsAllowInvalidCertificates", "true");
  return `mongodb://${parsed.userinfo}127.0.0.1:${localPort}${path || "/"}?${query.toString()}`;
}

/**
 * Runs one read (a `filter` for `find`, or a `pipeline` for `aggregate`)
 * against a MongoDB database/collection, given `uri` — the connection string
 * stored under a cluster nickname via `governor store mongodb-uri`. Reached
 * one of two ways:
 *
 * - `options.bastion` given — opens an SSH tunnel through that bastion host
 *   (stored via `governor store mongodb-bastion-key`) to the URI's single
 *   node.
 * - `options.bastion` omitted — connects directly using the stored URI
 *   as-is, letting it (and the driver) handle SRV resolution, TLS, and auth
 *   exactly as `mongosh` would — the common case for Atlas.
 */
export async function queryMongoDb(
  uri: string,
  options: {
    database: string;
    collection: string;
    filter?: Record<string, unknown>;
    projection?: Record<string, unknown>;
    sort?: Record<string, unknown>;
    pipeline?: Record<string, unknown>[];
    limit?: number;
    bastion?: {
      address: string;
      username: string;
      privateKey: string;
      passphrase?: string;
      port?: number;
    };
  },
): Promise<MongoQueryResult> {
  const limit = Math.min(options.limit ?? DEFAULT_MAX_DOCS, MAX_MAX_DOCS);

  let tunnel: SshTunnel | undefined;
  if (options.bastion) {
    const { host, port } = resolveSingleHostForTunnel(uri);
    tunnel = await openSshPortForwardTunnel({
      host: options.bastion.address,
      port: options.bastion.port,
      username: options.bastion.username,
      privateKey: options.bastion.privateKey,
      passphrase: options.bastion.passphrase,
      remoteHost: host,
      remotePort: port,
    });
  }

  const connectionUri = tunnel
    ? rewriteUriForTunnel(uri, tunnel.localPort)
    : uri;

  const client = new MongoClient(connectionUri, {
    connectTimeoutMS: CONNECT_TIMEOUT_MS,
    serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
  });

  try {
    await client.connect();
    const collection = client
      .db(options.database)
      .collection(options.collection);

    const documents = options.pipeline
      ? await collection
          .aggregate(options.pipeline)
          .limit(limit + 1)
          .toArray()
      : await collection
          .find(options.filter ?? {}, {
            projection: options.projection,
            sort: options.sort as Sort | undefined,
          })
          .limit(limit + 1)
          .toArray();

    return {
      documents: documents
        .slice(0, limit)
        .map((doc) => toJsonSafe(doc) as Record<string, unknown>),
      truncated: documents.length > limit,
    };
  } finally {
    await client.close();
    await tunnel?.close();
  }
}
