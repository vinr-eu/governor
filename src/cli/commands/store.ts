import { findSecretPlugin, SECRET_PLUGINS } from "../../secrets";
import { parseFlags } from "../lib/flags";
import { logger } from "../lib/logger";

export async function runStore(argv: string[]) {
  const { args, flags } = parseFlags(argv);
  const target = args[0];
  const knownSecrets = SECRET_PLUGINS.map((s) => s.id).join(", ");

  if (!target) {
    logger.error("Usage: governor store <secret> [options]");
    logger.error(`Known secrets: ${knownSecrets}`);
    process.exitCode = 1;
    return;
  }

  const secret = findSecretPlugin(target);
  if (!secret) {
    logger.error(`Unknown secret "${target}".`);
    logger.error(`Known secrets: ${knownSecrets}`);
    process.exitCode = 1;
    return;
  }

  return secret.store(args.slice(1), flags);
}
