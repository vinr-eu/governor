import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { chmod } from "node:fs/promises";
import { join } from "node:path";

const VAULT_PATH = join(process.cwd(), ".governor", "vault.enc");
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
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
  verifier: EncryptedBlob;
  entries: Record<string, EncryptedBlob>;
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, KEY_LENGTH, SCRYPT_PARAMS);
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
    private readonly key: Buffer,
    private readonly file: VaultFile,
  ) {}

  static async create(password: string): Promise<Vault> {
    const salt = randomBytes(16);
    const key = deriveKey(password, salt);
    const file: VaultFile = {
      version: 1,
      salt: salt.toString("base64"),
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
    const key = deriveKey(password, Buffer.from(file.salt, "base64"));

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
