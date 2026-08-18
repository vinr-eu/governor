import { listEntryKeys, type Vault } from "../../cli/lib/vault";

// Unlike AWS, MongoDB has no account-wide credential — each cluster is
// reached with its own connection string (stored via `governor store
// mongodb-uri`), and there's no `governor setup mongodb` step at all. So
// "profiles" for this provider aren't recorded by `setup` the way
// `profileKey(providerId, profile)` does for access-key providers; they're
// derived instead from whichever `mongodb-uri`/`mongodb-bastion` entries
// actually exist in the vault.

const MONGODB_URI_PREFIX = "mongodb-uri";
const MONGODB_BASTION_PREFIX = "mongodb-bastion";

/** Vault key for a stored MongoDB connection URI, keyed by a cluster nickname the caller chooses. */
export function mongodbUriKey(profile: string, clusterName: string): string {
  return `${MONGODB_URI_PREFIX}::${profile}::${clusterName}`;
}

export interface MongoBastionCredential {
  host: string;
  port?: number;
  username: string;
  privateKey: string;
  passphrase?: string;
}

/** Vault key for a stored SSH bastion used to tunnel to a MongoDB host. */
export function mongodbBastionKey(
  profile: string,
  bastionName: string,
): string {
  return `${MONGODB_BASTION_PREFIX}::${profile}::${bastionName}`;
}

/**
 * Every profile name with at least one stored MongoDB URI or bastion —
 * discovered by scanning entry keys rather than a fixed `setup`-created
 * marker, since this provider has no such marker.
 */
export async function listMongoDbProfiles(): Promise<string[]> {
  const profiles = new Set<string>();
  for (const key of await listEntryKeys()) {
    for (const prefix of [MONGODB_URI_PREFIX, MONGODB_BASTION_PREFIX]) {
      const marker = `${prefix}::`;
      if (!key.startsWith(marker)) continue;
      const profile = key.slice(marker.length).split("::")[0];
      if (profile) profiles.add(profile);
    }
  }
  return [...profiles];
}

/**
 * Every stored MongoDB URI for one profile, keyed by the cluster nickname it
 * was stored under so a tool call can look one up by the same `name` the
 * caller already passes.
 */
export async function loadMongoDbUris(
  vault: Vault,
  profile: string,
): Promise<Map<string, string>> {
  const prefix = `${MONGODB_URI_PREFIX}::${profile}::`;
  const uris = new Map<string, string>();
  for (const key of await listEntryKeys()) {
    if (!key.startsWith(prefix)) continue;
    const entry = vault.get<{ uri: string }>(key);
    if (entry) uris.set(key.slice(prefix.length), entry.uri);
  }
  return uris;
}

/**
 * Every stored MongoDB bastion for one profile, keyed by bastion name so a
 * tool call can look one up by the same `bastionName` the caller already
 * passes.
 */
export async function loadMongoDbBastions(
  vault: Vault,
  profile: string,
): Promise<Map<string, MongoBastionCredential>> {
  const prefix = `${MONGODB_BASTION_PREFIX}::${profile}::`;
  const bastions = new Map<string, MongoBastionCredential>();
  for (const key of await listEntryKeys()) {
    if (!key.startsWith(prefix)) continue;
    const entry = vault.get<MongoBastionCredential>(key);
    if (entry) bastions.set(key.slice(prefix.length), entry);
  }
  return bastions;
}
