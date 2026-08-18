import { DEFAULT_PROFILE, rdsPasswordKey } from "../../providers/credentials";
import { parseFlags } from "../lib/flags";
import { logger } from "../lib/logger";
import { promptPassword } from "../lib/prompt";
import { Vault, vaultExists } from "../lib/vault";

export async function runRdsPassword(argv: string[]) {
  const { args, flags } = parseFlags(argv);
  const [dbIdentifier, dbUser] = args;

  if (!dbIdentifier || !dbUser) {
    logger.error(
      "Usage: governor rds-password <db-identifier> <db-user> [--profile name] [--password value]",
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

  const passwordFlag = flags.password;
  if (passwordFlag !== undefined && typeof passwordFlag !== "string") {
    logger.error("--password requires a value.");
    process.exitCode = 1;
    return;
  }

  if (!(await vaultExists())) {
    logger.error("No vault found. Run `governor init` first.");
    process.exitCode = 1;
    return;
  }

  try {
    const dbPassword = passwordFlag ?? (await promptPassword("Database password:"));
    const masterPassword = await promptPassword("Master password:");
    const vault = await Vault.open(masterPassword);

    vault.set(rdsPasswordKey(profile, dbIdentifier, dbUser), {
      password: dbPassword,
    });
    await vault.save();
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  logger.success(
    `Stored a DB password for "${dbIdentifier}" / user "${dbUser}" (profile "${profile}").`,
  );
  logger.info(
    "aws_rds_instance_query will use it instead of an IAM auth token for this exact name+dbUser pair.",
  );
}
