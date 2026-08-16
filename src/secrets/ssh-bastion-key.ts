import { DEFAULT_PROFILE, sshBastionKeyKey } from "../providers/credentials";
import { logger } from "../cli/lib/logger";
import { promptPassword } from "../cli/lib/prompt";
import { Vault, vaultExists } from "../cli/lib/vault";
import type { SecretPlugin } from "./plugin";

export const sshBastionKeySecret: SecretPlugin = {
  id: "ssh-key",
  usage:
    "<bastion-name> --user <ssh-username> --key-file <path> [--profile name] [--port N] [--passphrase value]",

  async store(args, flags) {
    const [bastionName] = args;

    if (!bastionName) {
      logger.error(
        `Usage: governor store ssh-key ${sshBastionKeySecret.usage}`,
      );
      process.exitCode = 1;
      return;
    }

    const userFlag = flags.user;
    if (typeof userFlag !== "string") {
      logger.error(
        "--user is required (the SSH username configured on the bastion, e.g. ec2-user).",
      );
      process.exitCode = 1;
      return;
    }

    const keyFileFlag = flags["key-file"];
    if (typeof keyFileFlag !== "string") {
      logger.error(
        "--key-file is required (path to the private key file, e.g. ~/.ssh/bastion_key).",
      );
      process.exitCode = 1;
      return;
    }

    const profileFlag = flags.profile;
    if (profileFlag !== undefined && typeof profileFlag !== "string") {
      logger.error("--profile requires a value.");
      process.exitCode = 1;
      return;
    }
    const profile = profileFlag ?? DEFAULT_PROFILE;

    const portFlag = flags.port;
    if (portFlag !== undefined && typeof portFlag !== "string") {
      logger.error("--port requires a value.");
      process.exitCode = 1;
      return;
    }
    const port = portFlag !== undefined ? Number(portFlag) : undefined;
    if (port !== undefined && (!Number.isInteger(port) || port <= 0)) {
      logger.error("--port must be a positive integer.");
      process.exitCode = 1;
      return;
    }

    const passphraseFlag = flags.passphrase;
    if (passphraseFlag !== undefined && typeof passphraseFlag !== "string") {
      logger.error("--passphrase requires a value.");
      process.exitCode = 1;
      return;
    }

    if (!(await vaultExists())) {
      logger.error("No vault found. Run `governor init` first.");
      process.exitCode = 1;
      return;
    }

    let privateKey: string;
    try {
      privateKey = await Bun.file(keyFileFlag).text();
    } catch (err) {
      logger.error(
        `Could not read private key file "${keyFileFlag}": ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
      return;
    }

    try {
      const masterPassword = await promptPassword("Master password:");
      const vault = await Vault.open(masterPassword);

      vault.set(sshBastionKeyKey(profile, bastionName), {
        username: userFlag,
        privateKey,
        passphrase: passphraseFlag,
        port,
      });
      await vault.save();
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }

    logger.success(
      `Stored an SSH key for bastion "${bastionName}" (user "${userFlag}", profile "${profile}").`,
    );
    logger.info(
      "aws_rds_instance_query will use it to open an SSH tunnel through this bastion.",
    );
  },
};
