import {
  listEntryKeys,
  listProfiles,
  profileKey,
  type Vault,
} from "../cli/lib/vault";

export const DEFAULT_PROFILE = "default";

export interface AccessKeyCredential {
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Shared credential-loading shape for any access-key provider: pull every
 * profile out of an already-unlocked vault, or fall back to a single
 * "default" profile from env vars when no vault exists at all. Never
 * unlocks the vault itself (that happens once, centrally, in `serve.ts`)
 * so multiple providers don't each prompt for the master password.
 */
export async function loadAccessKeyCredentials(
  providerId: string,
  vault: Vault | undefined,
  envVarNames: { accessKeyId: string; secretAccessKey: string },
): Promise<Map<string, AccessKeyCredential>> {
  const credentials = new Map<string, AccessKeyCredential>();

  if (vault) {
    for (const profile of await listProfiles(providerId)) {
      const credential = vault.get<AccessKeyCredential>(
        profileKey(providerId, profile),
      );
      if (credential) credentials.set(profile, credential);
    }
    return credentials;
  }

  const accessKeyId = process.env[envVarNames.accessKeyId];
  const secretAccessKey = process.env[envVarNames.secretAccessKey];
  if (accessKeyId && secretAccessKey) {
    credentials.set(DEFAULT_PROFILE, { accessKeyId, secretAccessKey });
  }
  return credentials;
}

const RDS_PASSWORD_PREFIX = "aws-rds-password";

/** Vault key for a stored RDS/Aurora DB password — opt-in alternative to IAM DB auth tokens. */
export function rdsPasswordKey(
  profile: string,
  dbIdentifier: string,
  dbUser: string,
): string {
  return `${RDS_PASSWORD_PREFIX}::${profile}::${dbIdentifier}::${dbUser}`;
}

/**
 * Every stored RDS password for one profile, keyed by `<dbIdentifier>::<dbUser>`
 * so a tool call can look one up by the same names the caller already passes.
 */
export async function loadRdsPasswords(
  vault: Vault,
  profile: string,
): Promise<Map<string, string>> {
  const prefix = `${RDS_PASSWORD_PREFIX}::${profile}::`;
  const passwords = new Map<string, string>();
  for (const key of await listEntryKeys()) {
    if (!key.startsWith(prefix)) continue;
    const entry = vault.get<{ password: string }>(key);
    if (entry) passwords.set(key.slice(prefix.length), entry.password);
  }
  return passwords;
}

const REDIS_AUTH_TOKEN_PREFIX = "aws-redis-auth-token";

/** Vault key for a stored ElastiCache AUTH token — required whenever the replication group/cluster has `AuthTokenEnabled`. */
export function redisAuthTokenKey(profile: string, name: string): string {
  return `${REDIS_AUTH_TOKEN_PREFIX}::${profile}::${name}`;
}

/**
 * Every stored Redis AUTH token for one profile, keyed by replication
 * group/cache cluster name so a tool call can look one up by the same name
 * the caller already passes. Unlike RDS's per-`dbUser` password, ElastiCache
 * AUTH is a single token for the whole resource, so there's no second key
 * component.
 */
export async function loadRedisAuthTokens(
  vault: Vault,
  profile: string,
): Promise<Map<string, string>> {
  const prefix = `${REDIS_AUTH_TOKEN_PREFIX}::${profile}::`;
  const tokens = new Map<string, string>();
  for (const key of await listEntryKeys()) {
    if (!key.startsWith(prefix)) continue;
    const entry = vault.get<{ token: string }>(key);
    if (entry) tokens.set(key.slice(prefix.length), entry.token);
  }
  return tokens;
}

export interface SshBastionKeyCredential {
  username: string;
  privateKey: string;
  passphrase?: string;
  port?: number;
}

const SSH_BASTION_KEY_PREFIX = "aws-ssh-bastion-key";

/** Vault key for a stored SSH private key used to tunnel through a bastion EC2 instance. */
export function sshBastionKeyKey(profile: string, bastionName: string): string {
  return `${SSH_BASTION_KEY_PREFIX}::${profile}::${bastionName}`;
}

/**
 * Every stored SSH bastion key for one profile, keyed by bastion name so a
 * tool call can look one up by the same name the caller already passes.
 */
export async function loadSshBastionKeys(
  vault: Vault,
  profile: string,
): Promise<Map<string, SshBastionKeyCredential>> {
  const prefix = `${SSH_BASTION_KEY_PREFIX}::${profile}::`;
  const keys = new Map<string, SshBastionKeyCredential>();
  for (const key of await listEntryKeys()) {
    if (!key.startsWith(prefix)) continue;
    const entry = vault.get<SshBastionKeyCredential>(key);
    if (entry) keys.set(key.slice(prefix.length), entry);
  }
  return keys;
}
