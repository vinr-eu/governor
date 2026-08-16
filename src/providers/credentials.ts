import { listProfiles, profileKey, type Vault } from "../cli/lib/vault";

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
