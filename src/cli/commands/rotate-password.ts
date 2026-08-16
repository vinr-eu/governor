import { logger } from "../lib/logger";
import { promptPassword } from "../lib/prompt";
import { Vault, vaultExists, vaultPath } from "../lib/vault";

export async function runRotatePassword() {
  if (!(await vaultExists())) {
    logger.error("No vault found. Run `governor init` first.");
    process.exitCode = 1;
    return;
  }

  const currentPassword = await promptPassword("Current master password:");
  let vault: Vault;
  try {
    vault = await Vault.open(currentPassword);
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const newPassword = await promptPassword("New master password:");
  const confirmation = await promptPassword("Confirm new master password:");
  if (newPassword !== confirmation) {
    logger.error("Passwords did not match.");
    process.exitCode = 1;
    return;
  }

  await vault.rotatePassword(newPassword);

  logger.success(
    `Vault re-encrypted under the new master password (${vaultPath()}).`,
  );
  logger.info(
    "All stored provider credentials remain intact — nothing else to redo.",
  );
}
