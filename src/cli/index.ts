#!/usr/bin/env bun
import { runInit } from "./commands/init";
import { runServe } from "./commands/serve";
import { runSetup } from "./commands/setup";
import { printHelp, VERSION } from "./help";
import { logger } from "./lib/logger";

const [, , command, ...rest] = process.argv;

async function main() {
  switch (command) {
    case undefined:
    case "-h":
    case "--help":
      printHelp();
      return;
    case "-v":
    case "--version":
      logger.log(VERSION);
      return;
    case "init":
      return runInit();
    case "setup":
      return runSetup(rest);
    case "serve":
      return runServe(rest);
    default:
      logger.error(`Unknown command: ${command}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
