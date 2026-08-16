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
    ssh-key <bastion>              SSH private key for aws_rds_instance_query's tunnel
                                      through the named bastion EC2 instance
      --user <name>                   SSH username configured on the bastion (required)
      --key-file <path>               Path to the private key file (required)
      --profile <name>                Profile the key is scoped under (default: "default")
      --port <n>                      SSH port on the bastion (default: 22)
      --passphrase <value>            Passphrase for an encrypted private key
  rotate-password             Re-encrypt the vault under a new master password
  serve                       Start the MCP endpoint
    --host <addr>                Bind address (default: 127.0.0.1, loopback only)
    --port <port>                Port to listen on (default: 8787)
    --profile is available per-request via /providers/aws/:profile/identity
    Requires "Authorization: Bearer <token>" on /mcp and /providers/*.
    Token comes from GOVERNOR_MCP_TOKEN, or is generated fresh each run
    and printed once at startup.

Options:
  -h, --help                  Show this help message
  -v, --version                Show the version number
`);
}
