import { DEFAULT_PROFILE } from "../providers/credentials";
import { mongodbUriKey } from "../providers/mongodb/credentials";
import { logger } from "../cli/lib/logger";
import { promptPassword } from "../cli/lib/prompt";
import { Vault, vaultExists } from "../cli/lib/vault";
import type { SecretPlugin } from "./plugin";

const URI_PATTERN = /^mongodb(\+srv)?:\/\//;

export const mongodbUriSecret: SecretPlugin = {
  id: "mongodb-uri",
  usage: "<cluster-name> [--profile name] [--uri value]",

  async store(args, flags) {
    const [clusterName] = args;

    if (!clusterName) {
      logger.error(
        `Usage: governor store mongodb-uri ${mongodbUriSecret.usage}`,
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

    const uriFlag = flags.uri;
    if (uriFlag !== undefined && typeof uriFlag !== "string") {
      logger.error("--uri requires a value.");
      process.exitCode = 1;
      return;
    }

    if (!(await vaultExists())) {
      logger.error("No vault found. Run `governor init` first.");
      process.exitCode = 1;
      return;
    }

    try {
      const uri =
        uriFlag ??
        (await promptPassword(
          "MongoDB connection URI (credentials embedded, e.g. mongodb+srv://user:pass@cluster.mongodb.net/):",
        ));

      if (!URI_PATTERN.test(uri)) {
        logger.error(
          'Not a MongoDB connection string — expected it to start with "mongodb://" or "mongodb+srv://".',
        );
        process.exitCode = 1;
        return;
      }

      const masterPassword = await promptPassword("Master password:");
      const vault = await Vault.open(masterPassword);

      vault.set(mongodbUriKey(profile, clusterName), { uri });
      await vault.save();
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }

    logger.success(
      `Stored a MongoDB URI for cluster "${clusterName}" (profile "${profile}").`,
    );
    logger.info(
      "mongodb_query will use it to connect — restart `governor serve` to pick it up.",
    );
  },
};
