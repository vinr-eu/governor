import { DEFAULT_PROFILE, redisAuthTokenKey } from "../providers/credentials";
import { logger } from "../cli/lib/logger";
import { promptPassword } from "../cli/lib/prompt";
import { Vault, vaultExists } from "../cli/lib/vault";
import type { SecretPlugin } from "./plugin";

export const redisAuthTokenSecret: SecretPlugin = {
  id: "redis-auth-token",
  usage: "<name> [--profile name] [--token value]",

  async store(args, flags) {
    const [name] = args;

    if (!name) {
      logger.error(
        `Usage: governor store redis-auth-token ${redisAuthTokenSecret.usage}`,
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

    const tokenFlag = flags.token;
    if (tokenFlag !== undefined && typeof tokenFlag !== "string") {
      logger.error("--token requires a value.");
      process.exitCode = 1;
      return;
    }

    if (!(await vaultExists())) {
      logger.error("No vault found. Run `governor init` first.");
      process.exitCode = 1;
      return;
    }

    try {
      const authToken = tokenFlag ?? (await promptPassword("Redis AUTH token:"));
      const masterPassword = await promptPassword("Master password:");
      const vault = await Vault.open(masterPassword);

      vault.set(redisAuthTokenKey(profile, name), { token: authToken });
      await vault.save();
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }

    logger.success(
      `Stored a Redis AUTH token for "${name}" (profile "${profile}").`,
    );
    logger.info(
      "aws_elasticache_redis_command will use it whenever this replication group/cluster has AuthTokenEnabled.",
    );
  },
};
