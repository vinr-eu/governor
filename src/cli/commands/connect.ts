import type { AccessKeyCredential } from "../../providers/credentials";
import {
  findProvider,
  PROVIDERS,
  type ProviderDescriptor,
} from "../../providers/registry";
import { parseFlags, type ParsedArgs } from "../lib/flags";
import { logger } from "../lib/logger";
import { promptPassword, promptText } from "../lib/prompt";
import { listProfiles, profileKey, Vault, vaultExists } from "../lib/vault";

const DEFAULT_PROFILE = "default";

export async function runConnect(argv: string[]) {
  const { args, flags } = parseFlags(argv);
  const providerId = args[0];
  const knownProviders = PROVIDERS.map((p) => p.id).join(", ");

  if (!providerId) {
    logger.error("Usage: governor connect <provider> [options]");
    logger.error(`Known providers: ${knownProviders}`);
    process.exitCode = 1;
    return;
  }

  const provider = findProvider(providerId);
  if (!provider) {
    logger.error(`Unknown provider "${providerId}".`);
    logger.error(`Known providers: ${knownProviders}`);
    process.exitCode = 1;
    return;
  }

  if (flags.list) {
    return listConnectedProfiles(provider);
  }

  if (provider.authMethod === "access-key") {
    return connectWithAccessKey(provider, flags);
  }

  logger.error(
    `"${provider.authMethod}" authentication is not implemented yet for ${provider.label}.`,
  );
  process.exitCode = 1;
}

async function listConnectedProfiles(provider: ProviderDescriptor) {
  if (!(await vaultExists())) {
    logger.error("No vault found. Run `governor init` first.");
    process.exitCode = 1;
    return;
  }

  const profiles = await listProfiles(provider.id);
  if (profiles.length === 0) {
    logger.info(`No ${provider.label} profiles connected yet.`);
    return;
  }

  logger.info(`${provider.label} profiles: ${profiles.join(", ")}`);
}

async function connectWithAccessKey(
  provider: ProviderDescriptor,
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
    `Connected to ${provider.label} using access keys (profile "${profile}").`,
  );
  logger.info(
    "Credentials stored in the encrypted vault (never written in plaintext).",
  );
}
