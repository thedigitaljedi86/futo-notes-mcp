/**
 * Client-side E2EE crypto for FUTO Notes, reimplemented independently from
 * the public FUTO Notes app source (crates/futo-notes-core/src/e2ee/) and
 * sync server DESIGN.md — not copied, not officially documented.
 *
 * Scheme:
 *  - A random 32-byte AES-256 "vault key" encrypts note content.
 *  - The vault key is wrapped ("encrypted_vault_key") with a password-derived
 *    key: PBKDF2-HMAC-SHA256(password, salt, iterations) -> 32 bytes.
 *  - Every AES-256-GCM operation packs as iv(12) || ciphertext || tag(16),
 *    no additional authenticated data.
 *  - Note plaintext is a small binary frame, not JSON:
 *      [0x02][u32 BE path length][path bytes][content bytes]
 *    "path" is the vault-relative file path *including* folder and .md
 *    extension — it doubles as the note's title. There is no separate
 *    title/folder/tag field; tags are inline #hashtags in the content.
 */
import { randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv } from 'node:crypto';

export const PBKDF2_ITERATIONS_DEFAULT = 100_000;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VAULT_KEY_BYTES = 32;

export interface KeyKdf {
  kdf: string;
  iterations: number;
  hash: string;
}

export interface KeyMaterial {
  key_salt: string; // hex
  key_kdf: KeyKdf;
  encrypted_vault_key: string; // hex, iv||ciphertext||tag
  key_updated_at?: string;
}

function pbkdf2(password: string, salt: Buffer, iterations: number): Buffer {
  return pbkdf2Sync(password, salt, iterations, VAULT_KEY_BYTES, 'sha256');
}

/** AES-256-GCM encrypt, packed as iv(12) || ciphertext || tag(16). No AAD. */
export function aesGcmEncrypt(key: Buffer, plaintext: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]);
}

/** Inverse of aesGcmEncrypt. Throws on auth failure (wrong key/corrupt data). */
export function aesGcmDecrypt(key: Buffer, packed: Buffer): Buffer {
  const iv = packed.subarray(0, IV_BYTES);
  const rest = packed.subarray(IV_BYTES);
  const tag = rest.subarray(rest.length - TAG_BYTES);
  const ct = rest.subarray(0, rest.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function wrapVaultKey(password: string, vaultKey: Buffer): KeyMaterial {
  const salt = randomBytes(16);
  const iterations = PBKDF2_ITERATIONS_DEFAULT;
  const passwordKey = pbkdf2(password, salt, iterations);
  const encrypted = aesGcmEncrypt(passwordKey, vaultKey);
  return {
    key_salt: salt.toString('hex'),
    key_kdf: { kdf: 'pbkdf2-sha256', iterations, hash: 'SHA-256' },
    encrypted_vault_key: encrypted.toString('hex'),
  };
}

export class BadPasswordError extends Error {
  constructor() {
    super('Wrong vault password: could not unwrap the vault key.');
    this.name = 'BadPasswordError';
  }
}

export function unwrapVaultKey(password: string, material: KeyMaterial): Buffer {
  const salt = Buffer.from(material.key_salt, 'hex');
  const iterations = material.key_kdf.iterations;
  const passwordKey = pbkdf2(password, salt, iterations);
  const packed = Buffer.from(material.encrypted_vault_key, 'hex');
  let vaultKey: Buffer;
  try {
    vaultKey = aesGcmDecrypt(passwordKey, packed);
  } catch {
    throw new BadPasswordError();
  }
  if (vaultKey.length !== VAULT_KEY_BYTES) {
    throw new BadPasswordError();
  }
  return vaultKey;
}

export function generateVaultKey(): Buffer {
  return randomBytes(VAULT_KEY_BYTES);
}

export function packNote(path: string, content: string): Buffer {
  const pathBytes = Buffer.from(path, 'utf8');
  const header = Buffer.alloc(5);
  header[0] = 0x02;
  header.writeUInt32BE(pathBytes.length, 1);
  return Buffer.concat([header, pathBytes, Buffer.from(content, 'utf8')]);
}

export function unpackNote(frame: Buffer): { path: string; content: string } {
  let pathLen: number;
  let path: Buffer;
  let content: Buffer;
  if (frame[0] === 0x02) {
    pathLen = frame.readUInt32BE(1);
    path = frame.subarray(5, 5 + pathLen);
    content = frame.subarray(5 + pathLen);
  } else {
    // Legacy v1 frame: no version byte, just [u32 BE path length][path][content].
    pathLen = frame.readUInt32BE(0);
    path = frame.subarray(4, 4 + pathLen);
    content = frame.subarray(4 + pathLen);
  }
  return { path: path.toString('utf8'), content: content.toString('utf8') };
}

export function encryptNote(vaultKey: Buffer, path: string, content: string): Buffer {
  return aesGcmEncrypt(vaultKey, packNote(path, content));
}

export function decryptNote(vaultKey: Buffer, blob: Buffer): { path: string; content: string } {
  return unpackNote(aesGcmDecrypt(vaultKey, blob));
}
