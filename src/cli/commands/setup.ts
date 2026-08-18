import {
  DEFAULT_PROFILE,
  type AccessKeyCredential,
} from "../../providers/credentials";
import { findProviderPlugin, PROVIDER_PLUGINS } from "../../providers";
import type { ProviderPlugin } from "../../providers/plugin";
import { parseFlags, type ParsedArgs } from "../lib/flags";
import { logger } from "../lib/logger";
import { promptPassword, promptText } from "../lib/prompt";
import { listProfiles, profileKey, Vault, vaultExists } from "../lib/vault";

export async function runSetup(argv: string[]) {
  const { args, flags } = parseFlags(argv);
  const target = args[0];
  const knownProviders = PROVIDER_PLUGINS.map((p) => p.id).join(", ");

  if (!target) {
    logger.error("Usage: governor setup <provider> [options]");
    logger.error(`Known providers: ${knownProviders}`);
    process.exitCode = 1;
    return;
  }

  const provider = findProviderPlugin(target);
  if (!provider) {
    logger.error(`Unknown provider "${target}".`);
    logger.error(`Known providers: ${knownProviders}`);
    process.exitCode = 1;
    return;
  }

  if (flags.list) {
    return listConfiguredProfiles(provider);
  }

  if (provider.authMethod === "access-key") {
    return setupWithAccessKey(provider, flags);
  }

  logger.error(
    provider.setupHint ??
      `"${provider.authMethod}" authentication is not implemented yet for ${provider.label}.`,
  );
  process.exitCode = 1;
}

async function listConfiguredProfiles(provider: ProviderPlugin) {
  if (!(await vaultExists())) {
    logger.error("No vault found. Run `governor init` first.");
    process.exitCode = 1;
    return;
  }

  const profiles = await listProfiles(provider.id);
  if (profiles.length === 0) {
    logger.info(`No ${provider.label} profiles set up yet.`);
    return;
  }

  logger.info(`${provider.label} profiles: ${profiles.join(", ")}`);
}

async function setupWithAccessKey(
  provider: ProviderPlugin,
  flags: ParsedArgs["flags"],
) {
  if (!(await vaultExists())) {
    logger.error("No vault found. Run `governor init` first.");
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

  let accessKeyId = flags["access-key-id"];
  let secretAccessKey = flags["secret-access-key"];

  if (accessKeyId !== undefined && typeof accessKeyId !== "string") {
    logger.error("--access-key-id requires a value.");
    process.exitCode = 1;
    return;
  }
  if (secretAccessKey !== undefined && typeof secretAccessKey !== "string") {
    logger.error("--secret-access-key requires a value.");
    process.exitCode = 1;
    return;
  }

  try {
    if (accessKeyId === undefined) {
      accessKeyId = await promptText("AWS Access Key ID:");
    }
    if (secretAccessKey === undefined) {
      secretAccessKey = await promptPassword("AWS Secret Access Key:");
    }
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const password = await promptPassword("Master password:");
  let vault: Vault;
  try {
    vault = await Vault.open(password);
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const credential: AccessKeyCredential = { accessKeyId, secretAccessKey };
  vault.set(profileKey(provider.id, profile), credential);
  await vault.save();

  logger.success(
    `Set up ${provider.label} using access keys (profile "${profile}").`,
  );
  logger.info(
    "Credentials stored in the encrypted vault (never written in plaintext).",
  );
}
