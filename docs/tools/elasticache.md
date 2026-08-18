# ElastiCache

## `aws_elasticache_redis_command`

Runs one Redis command against an ElastiCache replication group or cache cluster, named the way a human would — by the
identifier shown in the ElastiCache console (e.g. `"prod-sessions"`), never by ARN. Reaches it one of two ways:

- **`bastionName` given** — opens an SSH tunnel through a bastion EC2 instance already inside that VPC, implemented
  natively against the `ssh2` library (no `ssh` CLI binary required on the machine running `governor serve`). Same
  mechanism as `aws_rds_instance_query`.
- **`bastionName` omitted** — connects directly to the resource's own network endpoint. Unlike RDS, ElastiCache has no
  public-endpoint mode at all — there's no `PubliclyAccessible` flag to check up front — so this only works when
  `governor serve` itself already has network access to the VPC (or a peered one). An unreachable direct attempt just
  times out with a normal connection error rather than a pre-check like RDS's.

| Param         | Type     | Required | Description                                                                                                       |
|---------------|----------|----------|---------------------------------------------------------------------------------------------------------------------|
| `name`        | string   | yes      | Replication group or cache cluster identifier, e.g. `"prod-sessions"`.                                            |
| `bastionName` | string   | no       | `Name` tag of the EC2 bastion to tunnel through. Omit only if governor already has direct VPC access.             |
| `command`     | string   | yes      | Redis command name, e.g. `"GET"`, `"HGETALL"`, `"SCAN"`.                                                          |
| `args`        | string[] | no       | Positional arguments for the command, e.g. `["session:123"]`.                                                     |
| `profile`     | string   | no       | Profile name. Defaults to `"default"`.                                                                            |
| `region`      | string   | no       | AWS region. Defaults to `AWS_REGION` env, else `us-east-1`.                                                       |

**Example call (via bastion):**

```json
{
  "name": "prod-sessions",
  "bastionName": "governor-bastion",
  "command": "GET",
  "args": ["session:123"],
  "region": "eu-central-1"
}
```

**Example call (direct, governor already has VPC access):**

```json
{
  "name": "prod-sessions",
  "command": "HGETALL",
  "args": ["user:42"],
  "region": "eu-central-1"
}
```

**Example response:**

```json
{
  "result": "eyJ1c2VySWQiOiI0MiJ9"
}
```

`result` is whatever the command returns, translated through Bun's Redis client's normal type conversion (integers as
numbers, bulk/simple strings as strings, arrays as arrays, `null` for a missing key, etc — see
[Bun's Redis docs](https://bun.sh/docs/runtime/redis) for the full mapping).

### Supported engines

Only Valkey and Redis OSS — Bun's `RedisClient` only speaks the Redis wire protocol. A Memcached cluster fails with an
explicit error rather than a confusing connection failure.

`name` is tried first as a replication group identifier (the common case), then as a standalone cache cluster
identifier (Memcached, or a Redis cluster not part of a replication group). For a cluster-mode-enabled replication
group, this uses the configuration endpoint (client-side sharding); otherwise the primary node group's endpoint —
covering only the primary/writer, not a specific read replica.

### Authentication: AUTH token only

There's no IAM-auth-token equivalent for ElastiCache the way `@aws-sdk/rds-signer` provides for RDS — no AWS SDK
package for it exists. Authentication is purely the resource's own AUTH token, required whenever `AuthTokenEnabled` is
on:

```sh
governor store redis-auth-token <name>
# prompts for the AUTH token, then the vault's master password
```

Once stored, `aws_elasticache_redis_command` automatically sends it for that exact `name` — no flag needed on the tool
call itself. **Restart `governor serve` after storing it** — credentials are loaded from the vault once at `serve`
startup, so a token stored while `serve` is already running isn't picked up until the next restart. If the resource has
`AuthTokenEnabled` and no token is stored, the call fails immediately with a clear error instead of a confusing auth
failure from Redis itself.

### Reaching the cluster: bastion tunnel or direct

**Via a bastion** (`bastionName` given) — resolved the same way as `aws_rds_instance_query`: `EC2:DescribeInstances`
filtered to `tag:Name = bastionName` and `instance-state-name = running`. The bastion must:

- Have a public IP (governor doesn't assume any other network path — VPN, Direct Connect — is available).
- Have a unique `Name` tag among running instances — more than one match is a hard error rather than picking one
  arbitrarily.
- Have network reachability (security group + routing) to the ElastiCache resource on its port.
- Have an SSH key stored for it:

```sh
governor store ssh-key <bastionName> --user <ssh-username> --key-file <path-to-private-key> [--port N] [--passphrase value]
```

This is the same vault entry `aws_rds_instance_query` uses — a bastion stored once works for both tools, keyed only by
`bastionName` and profile, not by which tool tunnels through it.

Whether the connection uses TLS at all depends on the resource's own `TransitEncryptionEnabled` flag, not on whether a
bastion is in play:

- **In-transit encryption on** — connects with TLS (`rediss://`). Tunneled, the TLS handshake reaches the real endpoint
  through the tunnel, but since the client connects via the tunnel's loopback port rather than the endpoint's real
  hostname, hostname/CA verification is skipped — the hop is still encrypted, but confirming which host is on the
  other end is left to the already-authenticated SSH tunnel instead. Direct, full TLS verification applies against the
  real endpoint hostname.
- **In-transit encryption off** — plain `redis://`, either path. When tunneled, the SSH hop is the only encryption in
  play.

**Direct** (`bastionName` omitted) — governor doesn't check any flag before attempting the connection (ElastiCache
reports no `PubliclyAccessible`-equivalent), so this only succeeds if `governor serve` already has network access to
the resource's VPC. An unreachable resource just times out with a normal connection error.

### Error shapes worth knowing

| Symptom                                                                        | Meaning                                                                                             |
|---------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------|
| `No SSH key stored for bastion "..."`                                         | Run `governor store ssh-key` for that bastion name first.                                           |
| `No running EC2 instance named "..."`                                         | `bastionName` doesn't match any running instance's `Name` tag in that region.                       |
| `N running EC2 instances are named "..."`                                     | `Name` tag isn't unique among running instances — fix the tag, don't just pick one.                 |
| `Bastion instance "..." has no public IP address`                             | Instance needs a public IP or an Elastic IP attached.                                                |
| `"..." is a Memcached cluster`                                                | Only Valkey/Redis OSS clusters can be queried — see Supported engines above.                        |
| `"..." has AuthTokenEnabled`                                                  | Run `governor store redis-auth-token <name>` first, then restart `governor serve`.                  |
| `No ElastiCache replication group or cache cluster named "..." was found`     | Wrong `name`, or wrong `region` — the default is `AWS_REGION` env or `us-east-1`, easy to miss.     |
| A Redis error (e.g. `WRONGTYPE`, `NOAUTH Authentication required`)            | Tunnel/network path (or direct connection) is fine — this is a real cluster-side rejection.          |
