# governor tool docs

Reference for every MCP tool governor exposes to a connected agent. Each tool below is documented with its exact
parameters, an example call/response, and the gotchas that aren't obvious from the schema alone.

These are MCP tools, called over `/mcp` (see the main [README](../README.md) for how to point an agent at governor and
authenticate). All of them are read-only except `aws_rds_instance_query`, which can run arbitrary SQL against a database
you've explicitly wired up, and `aws_elasticache_redis_command`, which can run arbitrary Redis commands against a
cluster you've explicitly wired up. Once Slack is configured, `aws_rds_instance_query`, `aws_elasticache_redis_command`,
and `aws_s3_list_buckets` all require a human Slack approval before they run, automatically — see
[Slack](#slack-slack--not-an-mcp-tool) below.

## AWS (`aws`)

Prerequisite for every tool below: `governor setup aws` (or `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` in the
environment if no vault exists). All tools accept an optional `profile` param (default `"default"`) and, where relevant,
an optional `region`.

| Service            | Docs                                                 |
| ------------------ | ---------------------------------------------------- |
| Identity           | [identity.md](tools/identity.md)                     |
| S3                 | [s3.md](tools/s3.md)                                 |
| RDS / Aurora       | [rds.md](tools/rds.md)                               |
| ElastiCache        | [elasticache.md](tools/elasticache.md)               |
| DynamoDB           | [dynamodb.md](tools/dynamodb.md)                     |
| CloudWatch Logs    | [cloudwatch-logs.md](tools/cloudwatch-logs.md)       |
| CloudWatch Metrics | [cloudwatch-metrics.md](tools/cloudwatch-metrics.md) |
| SQS                | [sqs.md](tools/sqs.md)                               |

## MongoDB (`mongodb`)

Prerequisite: a connection URI stored per cluster via `governor store mongodb-uri <cluster-name>` — no `governor
setup` step, since (unlike AWS) there's no account-wide credential underneath it. See [mongodb.md](tools/mongodb.md).

| Tool    | Docs                           |
| ------- | ------------------------------ |
| MongoDB | [mongodb.md](tools/mongodb.md) |

## Slack (`slack`) — not an MCP tool

Slack backs governor's own approval gate — not an agent-facing MCP tool, an agent never talks to Slack directly.
Once configured, `aws_rds_instance_query`, `aws_elasticache_redis_command`, and `aws_s3_list_buckets` require a human
Approve/Deny click automatically, no flag needed; `governor serve --require-approval <tool>,...` overrides that
default list with any tool from any provider. See [slack.md](tools/slack.md) for the full setup.
