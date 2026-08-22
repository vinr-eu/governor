import { logger } from "./lib/logger";

export const VERSION = "0.1.0";

export function printHelp() {
  logger.log(`governor ${VERSION}

Usage: governor <command> [options]

Commands:
  init                        Create the encrypted credential vault
  setup <provider>             Set up a provider (e.g. aws, datadog)
    --profile <name>              Store under a named profile (default: "default")
    --list                        List profiles already set up for the provider
  store <secret>               Store a secret (write-only — no way to read it back out)
    rds-password <db> <user>      DB password for aws_rds_instance_query, used
                                     instead of an IAM auth token (opt-in, per name+dbUser)
      --profile <name>               Profile the password is scoped under (default: "default")
      --password <value>             Skip the prompt and pass the password directly
    redis-auth-token <name>        AUTH token for aws_elasticache_redis_command, required
                                      whenever the replication group/cluster has AuthTokenEnabled
      --profile <name>               Profile the token is scoped under (default: "default")
      --token <value>                Skip the prompt and pass the token directly
    ssh-key <bastion>              SSH private key for aws_rds_instance_query's and
                                      aws_elasticache_redis_command's tunnel through the named
                                      bastion EC2 instance
      --user <name>                   SSH username configured on the bastion (required)
      --key-file <path>               Path to the private key file (required)
      --profile <name>                Profile the key is scoped under (default: "default")
      --port <n>                      SSH port on the bastion (default: 22)
      --passphrase <value>            Passphrase for an encrypted private key
    mongodb-uri <cluster-name>     Connection URI (credentials embedded) for mongodb_query,
                                      stored under a cluster nickname you choose
      --profile <name>                Profile the URI is scoped under (default: "default")
      --uri <value>                   Skip the prompt and pass the URI directly
    mongodb-bastion-key <bastion>  SSH bastion for mongodb_query's tunnel to a single-host
                                      "mongodb://" URI (not "mongodb+srv://")
      --host <address>                Bastion's public IP or hostname (required)
      --user <name>                   SSH username configured on the bastion (required)
      --key-file <path>               Path to the private key file (required)
      --profile <name>                Profile the key is scoped under (default: "default")
      --port <n>                      SSH port on the bastion (default: 22)
      --passphrase <value>            Passphrase for an encrypted private key
    slack-credential                Bot token + app-level token + approval channel for
                                       governor's own Slack approval gate (see serve below)
      --channel <id>                   Channel to post approval requests to (required)
      --profile <name>                Profile the credential is scoped under (default: "default")
      --bot-token <value>              Skip the prompt and pass the bot token directly (xoxb-...)
      --app-token <value>              Skip the prompt and pass the app-level token directly (xapp-...)
  rotate-password             Re-encrypt the vault under a new master password
  serve                       Start the MCP endpoint
    --host <addr>                Bind address (default: 127.0.0.1, loopback only)
    --port <port>                Port to listen on (default: 8787)
    Once governor store slack-credential has been run, aws_rds_instance_query,
    aws_elasticache_redis_command, and aws_s3_list_buckets require a human to
    click Approve/Deny in Slack before they run — on by default, no flag
    needed. Governor itself enforces this; the agent can't see or skip it.
    --require-approval <tool>,...  Override the default gated-tool list outright
                                      (not additively) with this comma-separated list.
                                      Pass "" to disable gating even if Slack is configured.
    --approval-timeout-seconds <n>  How long to wait for a decision before treating a gated
                                       call as denied (default: 300)
    --profile is available per-request via /providers/aws/:profile/identity
    Requires "Authorization: Bearer <token>" on /mcp and /providers/*.
    Token comes from GOVERNOR_MCP_TOKEN, or is generated fresh each run
    and printed once at startup. No exceptions — Slack approval clicks
    arrive over an outbound Socket Mode connection governor opens itself,
    not an inbound webhook, so nothing needs to be exposed publicly.

Options:
  -h, --help                  Show this help message
  -v, --version                Show the version number
`);
}
