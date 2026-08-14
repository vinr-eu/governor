import { logger } from "../lib/logger";
import { promptPassword } from "../lib/prompt";
import { Vault, vaultExists, vaultPath } from "../lib/vault";

export async function runInit() {
  if (await vaultExists()) {
    logger.error(`Governor is already initialized (${vaultPath()} exists).`);
    process.exitCode = 1;
    return;
  }

  const password = await promptPassword(
    "Set a master password for your vault:",
  );
  const confirmation = await promptPassword("Confirm master password:");
  if (password !== confirmation) {
    logger.error("Passwords did not match.");
    process.exitCode = 1;
    return;
  }

  await Vault.create(password);
  logger.success(`Vault created at ${vaultPath()}.`);
  logger.info(
    "Run `governor setup <provider>` to add credentials, or `governor serve` to start the MCP server.",
  );
}
