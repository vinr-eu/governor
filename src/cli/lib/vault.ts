import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { chmod } from "node:fs/promises";
import { join } from "node:path";

const VAULT_PATH = join(process.cwd(), ".governor", "vault.enc");

interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

// N=2^17, r=8, p=1: OWASP's strongest listed scrypt config (128 MiB), per
// https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt.
// Cheap to afford since this only runs once per `governor` invocation, not
// per-request. Stored in the vault file itself (see `kdf` below) so bumping
// this later can't break vaults created under the old params.
const CURRENT_SCRYPT_PARAMS: ScryptParams = { N: 131072, r: 8, p: 1 };
// What vaults created before `kdf` was persisted actually used — kept only
// as a fallback for files missing the field, never for new vaults.
const LEGACY_SCRYPT_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 32;
const VERIFIER_PLAINTEXT = "governor-vault";

interface EncryptedBlob {
  iv: string;
  authTag: string;
  ciphertext: string;
}

interface VaultFile {
  version: 1;
  salt: string;
  /** scrypt params this vault's key was derived with; absent means `LEGACY_SCRYPT_PARAMS`. */
  kdf?: ScryptParams;
  verifier: EncryptedBlob;
  entries: Record<string, EncryptedBlob>;
}

function deriveKey(
  password: string,
  salt: Buffer,
  params: ScryptParams,
): Buffer {
  // scrypt needs ~128*N*r bytes of working memory; Node's scryptSync defaults
  // to a 32 MiB ceiling, so any params above that need an explicit override.
  const maxmem = Math.ceil(128 * params.N * params.r * 1.5);
  return scryptSync(password, salt, KEY_LENGTH, { ...params, maxmem });
}

function encrypt(key: Buffer, plaintext: string): EncryptedBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return {
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decrypt(key: Buffer, blob: EncryptedBlob): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(blob.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(blob.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(blob.ciphertext, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

export class Vault {
  private constructor(
    private key: Buffer,
    private readonly file: VaultFile,
  ) {}

  static async create(password: string): Promise<Vault> {
    const salt = randomBytes(16);
    const key = deriveKey(password, salt, CURRENT_SCRYPT_PARAMS);
    const file: VaultFile = {
      version: 1,
      salt: salt.toString("base64"),
      kdf: CURRENT_SCRYPT_PARAMS,
      verifier: encrypt(key, VERIFIER_PLAINTEXT),
      entries: {},
    };
    const vault = new Vault(key, file);
    await vault.save();
    return vault;
  }

  static async open(password: string): Promise<Vault> {
    const raw = await Bun.file(VAULT_PATH).json();
    const file = raw as VaultFile;
    const key = deriveKey(
      password,
      Buffer.from(file.salt, "base64"),
      file.kdf ?? LEGACY_SCRYPT_PARAMS,
    );

    let verified: string;
    try {
      verified = decrypt(key, file.verifier);
    } catch {
      throw new Error("Incorrect master password.");
    }
    if (verified !== VERIFIER_PLAINTEXT) {
      throw new Error("Incorrect master password.");
    }

    return new Vault(key, file);
  }

  get<T>(providerId: string): T | null {
    const blob = this.file.entries[providerId];
    if (!blob) return null;
    return JSON.parse(decrypt(this.key, blob)) as T;
  }

  set(providerId: string, value: unknown): void {
    this.file.entries[providerId] = encrypt(this.key, JSON.stringify(value));
  }

  /**
   * Re-encrypts every entry under a freshly derived key from `newPassword`
   * (new salt, current scrypt params) — the standard remediation for a
   * suspected master-password compromise, per
   * https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html#key-rotation.
   * Also upgrades a legacy vault's KDF params to `CURRENT_SCRYPT_PARAMS` as
   * a side effect, since it's already deriving a fresh key either way.
   */
  async rotatePassword(newPassword: string): Promise<void> {
    const decrypted = new Map<string, unknown>();
    for (const providerId of Object.keys(this.file.entries)) {
      decrypted.set(providerId, this.get(providerId));
    }

    const salt = randomBytes(16);
    const newKey = deriveKey(newPassword, salt, CURRENT_SCRYPT_PARAMS);

    const entries: Record<string, EncryptedBlob> = {};
    for (const [providerId, value] of decrypted) {
      entries[providerId] = encrypt(newKey, JSON.stringify(value));
    }

    this.file.salt = salt.toString("base64");
    this.file.kdf = CURRENT_SCRYPT_PARAMS;
    this.file.verifier = encrypt(newKey, VERIFIER_PLAINTEXT);
    this.file.entries = entries;
    this.key = newKey;

    await this.save();
  }

  async save(): Promise<void> {
    await Bun.write(VAULT_PATH, JSON.stringify(this.file, null, 2));
    // Bun.write doesn't take a mode option, and the file would otherwise
    // inherit the process umask (typically world-readable) — restrict it
    // to the owner since it holds encrypted credential material.
    await chmod(VAULT_PATH, 0o600);
  }
}

export async function vaultExists(): Promise<boolean> {
  return Bun.file(VAULT_PATH).exists();
}

export function vaultPath(): string {
  return VAULT_PATH;
}

const PROFILE_SEPARATOR = "::";

/** Composite vault key for a named profile of a provider, e.g. "aws::staging". */
export function profileKey(providerId: string, profile: string): string {
  return `${providerId}${PROFILE_SEPARATOR}${profile}`;
}

/**
 * Entry keys (e.g. provider ids, "aws::staging") are stored in plaintext in the
 * vault file — only the values are encrypted, matching the existing single-profile
 * design. That lets profile names be listed without unlocking the vault.
 */
export async function listEntryKeys(): Promise<string[]> {
  const raw = (await Bun.file(VAULT_PATH).json()) as VaultFile;
  return Object.keys(raw.entries);
}

/** Profile names stored for a given provider, derived from plaintext entry keys. */
export async function listProfiles(providerId: string): Promise<string[]> {
  const prefix = `${providerId}${PROFILE_SEPARATOR}`;
  const keys = await listEntryKeys();
  return keys
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length));
}
