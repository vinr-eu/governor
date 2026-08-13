import { logger } from "./lib/logger";

export const VERSION = "0.1.0";

export function printHelp() {
  logger.log(`governor ${VERSION}

Usage: governor <command> [options]

Commands:
  init                        Create the encrypted credential vault
  connect <provider>          Connect a provider (e.g. aws, datadog)
    --profile <name>            Store under a named profile (default: "default")
    --list                      List profiles already connected for the provider
  serve                       Start the MCP endpoint
    --profile is available per-request via /providers/aws/:profile/identity

Options:
  -h, --help                  Show this help message
  -v, --version                Show the version number
`);
}
