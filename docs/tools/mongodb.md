# MongoDB

## `mongodb_query`

Runs one read (a `find` filter, or an `aggregate` pipeline) against a MongoDB database/collection on a cluster, named
by whatever nickname it was stored under via `governor store mongodb-uri` — never the connection string itself.
Reaches it one of two ways:

- **`bastionName` given** — opens an SSH tunnel through a bastion host (stored via `governor store
mongodb-bastion-key`) to the URI's single node. Only supported for a standard single-host `"mongodb://"` URI —
  `"mongodb+srv://"` (the standard Atlas format) fails with a clear error, since SRV resolves to multiple hosts via
  DNS that a single tunnel can't represent.
- **`bastionName` omitted** — connects directly using the stored URI as-is, letting the driver handle SRV resolution,
  TLS, and auth exactly as `mongosh` would. The common case for Atlas.

| Param         | Type   | Required | Description                                                                                      |
| ------------- | ------ | -------- | ------------------------------------------------------------------------------------------------ |
| `name`        | string | yes      | Cluster nickname the URI was stored under, e.g. `"prod-atlas"`.                                  |
| `bastionName` | string | no       | Bastion stored via `governor store mongodb-bastion-key`. Omit to connect directly.               |
| `database`    | string | yes      | Name of the database to query.                                                                   |
| `collection`  | string | yes      | Name of the collection to query.                                                                 |
| `filter`      | object | no       | MongoDB query filter, e.g. `{"status": "active"}`. Ignored if `pipeline` is given. Default `{}`. |
| `projection`  | object | no       | Fields to include/exclude, e.g. `{"name": 1, "_id": 0}`. Ignored if `pipeline` is given.         |
| `sort`        | object | no       | Sort order, e.g. `{"createdAt": -1}`. Ignored if `pipeline` is given.                            |
| `pipeline`    | array  | no       | Aggregation pipeline stages. When given, runs `aggregate` instead of `find`.                     |
| `limit`       | number | no       | Max documents to return. Default 200, max 1000.                                                  |
| `profile`     | string | no       | Profile name. Defaults to `"default"`.                                                           |

**Example call (find, direct — the common Atlas case):**

```json
{
  "name": "prod-atlas",
  "database": "app",
  "collection": "orders",
  "filter": { "status": "pending" },
  "sort": { "createdAt": -1 },
  "limit": 20
}
```

**Example call (aggregate, via bastion):**

```json
{
  "name": "self-hosted",
  "bastionName": "governor-bastion",
  "database": "app",
  "collection": "orders",
  "pipeline": [
    { "$match": { "status": "pending" } },
    { "$group": { "_id": "$region", "count": { "$sum": 1 } } }
  ]
}
```

**Example response:**

```json
{
  "documents": [
    {
      "_id": "65f1a2b3c4d5e6f7a8b9c0d1",
      "status": "pending",
      "region": "eu-west-1"
    }
  ],
  "truncated": false
}
```

`truncated: true` means more documents matched than `limit` returned — narrow the `filter`/`pipeline` rather than
raising `limit` past what you actually need to look at. `ObjectId`, `Date`, `Decimal128`, `Long`, `Timestamp`, and
BSON `Binary` values come back as plain JSON (hex string, ISO 8601, decimal string, decimal string, string, and
base64 respectively) since none of those are natively JSON-serializable.

### Read-only by design

There's no write escape hatch (`insertOne`, `updateMany`, `deleteOne`, …) — unlike `aws_rds_instance_query`'s
arbitrary SQL, a single MongoDB write has no equivalent blast-radius guard the way a bounded `find`/`aggregate` does,
the same reasoning behind the DynamoDB tools being read-only. `pipeline` is the escape hatch for anything a `filter`
alone can't express (`$lookup` joins, `$group` aggregation, `$unwind`, …).

### Connecting: one URI per cluster, no `governor setup` step

Unlike AWS, there's no account-wide credential to set up — each cluster is reached with its own connection string,
credentials included, stored under a nickname you choose:

```sh
governor store mongodb-uri <cluster-name> [--uri value]
# prompts for the URI (e.g. mongodb+srv://user:pass@cluster0.abcde.mongodb.net/), then the vault's master password
```

`governor setup mongodb` isn't a thing — running it just points you back at `governor store mongodb-uri`.
**Restart `governor serve` after storing a URI** — credentials are loaded from the vault once at `serve` startup, so
a URI stored while `serve` is already running isn't picked up until the next restart.

If no vault exists at all (env-var fallback, e.g. CI), `MONGODB_URI` is used for a single cluster named `"default"`.

### Reaching the cluster: bastion tunnel or direct

**Via a bastion** (`bastionName` given) — unlike AWS's `ssh-key` secret, a MongoDB bastion isn't looked up by an EC2
`Name` tag (Atlas clusters aren't in governor's own AWS account), so the bastion's address is stored directly:

```sh
governor store mongodb-bastion-key <bastionName> --host <address> --user <ssh-username> --key-file <path> [--port N] [--passphrase value]
```

The public half of that key must already be in the bastion's `~/.ssh/authorized_keys`. An empty passphrase is fine —
either omit `--passphrase` entirely, or pass it as a bare flag (`--passphrase` with no following value); both are
treated as "no passphrase," not an error.

This path requires the _stored URI_ to name exactly one host in standard `"mongodb://host:port/..."` form —
`"mongodb+srv://"` URIs and multi-host replica-set lists are rejected with a clear error, since a single SSH tunnel
can't stand in for DNS-based topology discovery across several nodes. The tunneled connection forces
`directConnection=true` (skip replica-set discovery entirely — the tunnel only carries traffic to this one node).
Because the driver connects to the tunnel's loopback port rather than the real hostname, TLS hostname/CA verification
is skipped for this path — the hop is still encrypted, but what's skipped is confirming which host is on the other
end, which the already-authenticated SSH tunnel covers instead.

**Direct** (`bastionName` omitted) — the stored URI is passed to the driver as-is, so its own TLS/auth/SRV settings
apply unmodified, same as connecting with `mongosh`. This is the normal path for Atlas, which expects direct
(allow-listed) network access rather than a bastion.

### Error shapes worth knowing

| Symptom                                                                | Meaning                                                                                                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `No MongoDB URI stored for cluster "..."`                              | Run `governor store mongodb-uri <name>` first, then restart `governor serve`.                                                              |
| `No bastion stored for "..."`                                          | Run `governor store mongodb-bastion-key <bastionName>` first, then restart `governor serve`.                                               |
| `Cannot tunnel a "mongodb+srv://" connection string through a bastion` | Store a standard single-host `"mongodb://"` URI for bastion use, or omit `bastionName`.                                                    |
| `Bastion tunneling only supports a single-host "mongodb://" URI`       | The stored URI lists more than one host — store one naming the single node the bastion reaches.                                            |
| `Timed out connecting over SSH to "..."`                               | Bastion host unreachable, wrong port, or security group/firewall blocking the SSH port.                                                    |
| A driver connection error (e.g. `MongoServerSelectionError`)           | Tunnel/network path (or direct connection) is fine — this is a real Mongo-side rejection (wrong host, auth, IP not allow-listed on Atlas). |
