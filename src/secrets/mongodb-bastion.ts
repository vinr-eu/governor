import { DEFAULT_PROFILE } from "../providers/credentials";
import { mongodbBastionKey } from "../providers/mongodb/credentials";
import { logger } from "../cli/lib/logger";
import { promptPassword } from "../cli/lib/prompt";
import { Vault, vaultExists } from "../cli/lib/vault";
import type { SecretPlugin } from "./plugin";

export const mongodbBastionSecret: SecretPlugin = {
  id: "mongodb-bastion-key",
  usage:
    "<bastion-name> --host <address> --user <ssh-username> --key-file <path> [--profile name] [--port N] [--passphrase value]",

  async store(args, flags) {
    const [bastionName] = args;

    if (!bastionName) {
      logger.error(
        `Usage: governor store mongodb-bastion-key ${mongodbBastionSecret.usage}`,
      );
      process.exitCode = 1;
      return;
    }

    const hostFlag = flags.host;
    if (typeof hostFlag !== "string") {
      logger.error(
        "--host is required (the bastion's public IP or hostname — unlike AWS's ssh-key secret, MongoDB clusters aren't in governor's own AWS account, so there's no EC2 lookup to resolve it automatically).",
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

    // A bare `--passphrase` (e.g. from `--passphrase $VAR` with $VAR empty) parses as `true` — treat it as an empty passphrase, not an error.
    const passphraseFlag = flags.passphrase === true ? "" : flags.passphrase;
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

      vault.set(mongodbBastionKey(profile, bastionName), {
        host: hostFlag,
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
      `Stored a bastion "${bastionName}" at ${hostFlag} (user "${userFlag}", profile "${profile}").`,
    );
    logger.info(
      "mongodb_query will use it to open an SSH tunnel when bastionName is given — restart `governor serve` to pick it up.",
    );
  },
};
