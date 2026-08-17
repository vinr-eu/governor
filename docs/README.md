# governor tool docs

Reference for every MCP tool governor exposes to a connected agent. Each tool below is documented with its exact
parameters, an example call/response, and the gotchas that aren't obvious from the schema alone.

These are MCP tools, called over `/mcp` (see the main [README](../README.md) for how to point an agent at governor and
authenticate). All of them are read-only except `aws_rds_instance_query`, which can run arbitrary SQL against a database
you've explicitly wired up.

## AWS (`aws`)

Prerequisite for every tool below: `governor setup aws` (or `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` in the
environment if no vault exists). All tools accept an optional `profile` param (default `"default"`) and, where relevant,
an optional `region`.

| Service            | Docs                                                 |
|--------------------|------------------------------------------------------|
| Identity           | [identity.md](tools/identity.md)                     |
| S3                 | [s3.md](tools/s3.md)                                 |
| RDS / Aurora       | [rds.md](tools/rds.md)                               |
| DynamoDB           | [dynamodb.md](tools/dynamodb.md)                     |
| CloudWatch Logs    | [cloudwatch-logs.md](tools/cloudwatch-logs.md)       |
| CloudWatch Metrics | [cloudwatch-metrics.md](tools/cloudwatch-metrics.md) |
| SQS                | [sqs.md](tools/sqs.md)                               |
