/**
 * Encryption for the backup repository: everything is sealed on this machine
 * before it leaves it.
 *
 * The user holds one recovery key: 32 random bytes, shown as Crockford base32
 * in groups (`WB1-XXXXX-...`). Two subkeys are derived from it with HKDF:
 *   - `enc`: AES-256-GCM for every object (blobs, pack headers, snapshots, indexes);
 *   - `mac`: HMAC-SHA256 for content ids, so a blob's id says nothing about its
 *     plaintext to anyone without the key (a bare SHA-256 would let the storage
 *     provider confirm a guessed file).
 * The key is high entropy, so no password stretching is needed.
 *
 * Sealed layout: [12-byte nonce][ciphertext][16-byte tag]. Every seal binds an
 * AAD naming what the bytes are (a blob's id, "snapshot:<name>"), so an object
 * moved to another name fails to open instead of being read as something else.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
export const SEAL_OVERHEAD = NONCE_BYTES + TAG_BYTES;

/** Crockford base32: no I, L, O, U, so a key read aloud or copied by hand survives. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const KEY_PREFIX = 'WB1';

export interface RepoKeys {
  enc: Buffer;
  mac: Buffer;
}

export function generateRecoveryKey(): string {
  return formatRecoveryKey(randomBytes(KEY_BYTES));
}

export function formatRecoveryKey(raw: Buffer): string {
  if (raw.length !== KEY_BYTES) throw new Error('recovery key must be 32 bytes');
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of raw) {
    value = ((value << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  // 52 characters + a 1-character checksum, in groups of 5.
  out += ALPHABET[checksum(out)];
  const groups = out.match(/.{1,5}/g) ?? [];
  return `${KEY_PREFIX}-${groups.join('-')}`;
}

function checksum(chars: string): number {
  let sum = 0;
  for (let i = 0; i < chars.length; i++) sum = (sum * 31 + ALPHABET.indexOf(chars[i]) + i) % 32;
  return sum;
}

/**
 * Parse a key the user typed or pasted: case, spaces, dashes and the prefix
 * are forgiven, and the Crockford look-alikes (O→0, I/L→1) are mapped.
 * Throws a plain sentence on anything else.
 */
export function parseRecoveryKey(input: string): Buffer {
  let s = input.trim().toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.startsWith(KEY_PREFIX)) s = s.slice(KEY_PREFIX.length);
  if (s.length !== 53 || /[^0-9A-Z]/.test(s) || /U/.test(s)) {
    throw new Error('That is not a Walnut recovery key (it starts with WB1- and has 53 letters and digits after it).');
  }
  const body = s.slice(0, 52);
  if (ALPHABET[checksum(body)] !== s[52]) {
    throw new Error('That recovery key has a typo: its last character does not match the rest.');
  }
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of body) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    value &= 0xffff;
  }
  return Buffer.from(out.slice(0, KEY_BYTES));
}

export function deriveKeys(raw: Buffer): RepoKeys {
  const derive = (info: string): Buffer =>
    Buffer.from(hkdfSync('sha256', raw, Buffer.from('walnut-backup-v1'), Buffer.from(info), KEY_BYTES));
  return { enc: derive('enc'), mac: derive('mac') };
}

/** Content id of a plaintext chunk: keyed, so it reveals nothing without the key. */
export function blobId(keys: RepoKeys, plaintext: Buffer): string {
  return createHmac('sha256', keys.mac).update(plaintext).digest('hex');
}

/** Proves a key belongs to a repository without revealing the key. */
export function keyCheck(keys: RepoKeys, repoId: string): string {
  return createHmac('sha256', keys.mac).update(`key-check:${repoId}`).digest('hex');
}

export function seal(keys: RepoKeys, plaintext: Buffer, aad: string): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keys.enc, nonce);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]);
}

/** Throws when the bytes were changed, the key is wrong or the AAD differs. */
export function open(keys: RepoKeys, sealed: Buffer, aad: string): Buffer {
  if (sealed.length < SEAL_OVERHEAD) throw new Error('sealed object is truncated');
  const nonce = sealed.subarray(0, NONCE_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const ct = sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', keys.enc, nonce);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new Error(`could not decrypt ${aad}: wrong recovery key or damaged data`);
  }
}
