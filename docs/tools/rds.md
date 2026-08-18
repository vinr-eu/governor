# RDS / Aurora

## `aws_rds_instance_query`

Runs one SQL statement against an RDS instance or Aurora cluster, named the way a human would — by the identifier shown
in the RDS console (e.g. `"prod-orders-db"`), never by ARN. Reaches it one of two ways:

- **`bastionName` given** — opens an SSH tunnel through a bastion EC2 instance already inside that VPC, implemented
  natively against the `ssh2` library (no `ssh` CLI binary required on the machine running `governor serve`).
- **`bastionName` omitted** — connects directly to the instance/cluster's own network endpoint. Only works when it's
  publicly accessible (the `PubliclyAccessible` flag on the instance/cluster); fails with a clear error otherwise
  rather than hanging.

| Param         | Type   | Required | Description                                                                                                 |
|---------------|--------|----------|---------------------------------------------------------------------------------------------------------------|
| `name`        | string | yes      | RDS instance or Aurora cluster identifier, e.g. `"prod-orders-db"`.                                        |
| `bastionName` | string | no       | `Name` tag of the EC2 bastion to tunnel through. Omit to connect directly to a publicly accessible instance/cluster. |
| `dbUser`      | string | yes      | Database username.                                                                                          |
| `database`    | string | yes      | Name of the database to query.                                                                              |
| `sql`         | string | yes      | SQL statement to execute.                                                                                   |
| `maxRows`     | number | no       | Max rows to return. Default 200, max 1000.                                                                  |
| `profile`     | string | no       | Profile name. Defaults to `"default"`.                                                                      |
| `region`      | string | no       | AWS region. Defaults to `AWS_REGION` env, else `us-east-1`.                                                 |

**Example call (via bastion):**

```json
{
  "name": "governor-db",
  "bastionName": "governor-bastion",
  "dbUser": "governor_admin",
  "database": "postgres",
  "sql": "select 1 as ok",
  "region": "eu-central-1"
}
```

**Example call (direct, publicly accessible instance):**

```json
{
  "name": "governor-db",
  "dbUser": "governor_admin",
  "database": "postgres",
  "sql": "select 1 as ok",
  "region": "eu-central-1"
}
```

**Example response:**

```json
{
  "columns": [
    "ok"
  ],
  "rows": [
    {
      "ok": 1
    }
  ],
  "truncated": false
}
```

`truncated: true` means more rows matched than `maxRows` returned — narrow the query (add a `LIMIT`/`WHERE`) rather than
raising `maxRows` past what you actually need to look at.

### Supported engines

Only Postgres- and MySQL-compatible engines — RDS for PostgreSQL/MySQL/MariaDB, and Aurora PostgreSQL/MySQL (both
provisioned and Serverless v2; it always goes through the normal network endpoint, never Aurora's HTTPS-only Data API).
RDS for SQL Server, Oracle, or Db2 fail with an explicit error rather than a confusing one, because Bun's native `SQL`
client only speaks the Postgres and MySQL wire protocols to begin with.

`name` is tried first as an RDS instance identifier, then as an Aurora cluster identifier (using the cluster's stable
writer endpoint, which — unlike a specific member instance's endpoint — doesn't change across failover).

### Authentication: two paths

By default, authenticates with a short-lived **IAM database-auth token** instead of a stored password — nothing
persisted in the vault. This requires:

1. `iam_database_authentication_enabled` turned on on the instance/cluster.
2. `dbUser` granted the `rds_iam` role (Postgres) / AWS auth plugin (MySQL) — done by connecting as a privileged user
   and running `GRANT rds_iam TO <dbUser>;` (Postgres) once.
3. The IAM identity behind governor's AWS credentials granted `rds-db:connect` on
   `arn:aws:rds-db:<region>:<account>:dbuser:<db-resource-id>/<dbUser>`.

If none of that is set up, store a password instead — an explicit opt-in, for databases without IAM DB auth turned on:

```sh
governor store rds-password <name> <dbUser>
# prompts for the DB password, then the vault's master password
```

Once stored, `aws_rds_instance_query` automatically prefers it over the IAM path for that exact `name`+`dbUser`
pair — no flag needed on the tool call itself. **Restart `governor serve` after storing it** — credentials are loaded
from the vault once at `serve` startup, so a password stored while `serve` is already running isn't picked up until the
next restart.

### Reaching the database: bastion tunnel or direct

**Via a bastion** (`bastionName` given) — resolved by `EC2:DescribeInstances` filtered to `tag:Name = bastionName` and
`instance-state-name = running`. The bastion must:

- Have a public IP (governor doesn't assume any other network path — VPN, Direct Connect — is available).
- Have a unique `Name` tag among running instances — more than one match is a hard error rather than picking one
  arbitrarily.
- Have network reachability (security group + routing) to the RDS instance/cluster on its database port.
- Have an SSH key stored for it:

```sh
governor store ssh-key <bastionName> --user <ssh-username> --key-file <path-to-private-key> [--port N] [--passphrase value]
```

The public half of that key must already be in the bastion's `~/.ssh/authorized_keys` (e.g. via an
`aws_key_pair`/`key_name` at instance launch). An empty passphrase is fine — either omit `--passphrase` entirely, or
pass it as a bare flag (`--passphrase` with no following value); both are treated as "no passphrase," not an error.

Because the SQL client connects to the tunnel's loopback port rather than the RDS endpoint's real hostname, TLS
hostname/CA verification is skipped for this path — the hop is still encrypted, but what's skipped is confirming which
host is on the other end, which the already-authenticated SSH tunnel covers instead.

**Direct** (`bastionName` omitted) — governor calls `DescribeDBInstances`/`DescribeDBClusters` to check the
`PubliclyAccessible` flag before attempting anything. If it's `false`, the call fails immediately with an explicit
error telling you to pass `bastionName` instead — no connection attempt, no hang. If it's `true`, governor connects
straight to the instance/cluster's real endpoint hostname, so full TLS verification applies (RDS server certificates
chain to a publicly trusted root, so this works without extra configuration). This path still requires normal network
reachability — the RDS instance's security group must allow inbound traffic on the database port from wherever
`governor serve` runs.

### Error shapes worth knowing

| Symptom                                                               | Meaning                                                                                             |
|-------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------|
| `No SSH key stored for bastion "..."`                                 | Run `governor store ssh-key` for that bastion name first.                                           |
| `No running EC2 instance named "..."`                                 | `bastionName` doesn't match any running instance's `Name` tag in that region.                       |
| `N running EC2 instances are named "..."`                             | `Name` tag isn't unique among running instances — fix the tag, don't just pick one.                 |
| `Bastion instance "..." has no public IP address`                     | Instance needs a public IP or an Elastic IP attached.                                                |
| `"..." isn't publicly accessible, so it can't be reached directly`    | `bastionName` was omitted but the instance/cluster's `PubliclyAccessible` flag is `false` — pass `bastionName` instead. |
| `No RDS instance or Aurora cluster named "..." was found in region X` | Wrong `name`, or wrong `region` — the default is `AWS_REGION` env or `us-east-1`, easy to miss.     |
| `... uses engine "...", which isn't supported`                        | Engine isn't Postgres- or MySQL-compatible (see above).                                              |
| A Postgres/MySQL error (e.g. `password authentication failed`)        | Tunnel/network path (or direct connection) is fine — this is a real DB-side rejection (wrong password/user/db name). |
