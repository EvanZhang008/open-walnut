/**
 * Where this machine keeps the backup recovery key:
 * `<data home>/local/backup/recovery-key`, mode 0600.
 *
 * `local/` never rides git sync (machine-local by its .gitignore) and is not
 * part of the replicated config, so the key stays on this machine. It IS in the
 * encrypted backup itself (sealed by the very key, so it gives nothing away),
 * which means a home restored from a backup can keep backing up with it.
 *
 * On a new machine the user types the key they saved (Settings, Restore); it
 * is checked against the destination's repository before it is stored here.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { formatRecoveryKey, generateRecoveryKey, parseRecoveryKey } from './repo/crypto.js';

export function recoveryKeyPath(dataDir: string): string {
  return path.join(dataDir, 'local', 'backup', 'recovery-key');
}

export async function readRecoveryKey(dataDir: string): Promise<string | null> {
  try {
    const text = (await fs.readFile(recoveryKeyPath(dataDir), 'utf8')).trim();
    if (!text) return null;
    parseRecoveryKey(text);
    return text;
  } catch {
    return null;
  }
}

export async function writeRecoveryKey(dataDir: string, key: string): Promise<string> {
  const canonical = formatRecoveryKey(parseRecoveryKey(key));
  const file = recoveryKeyPath(dataDir);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, `${canonical}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
  return canonical;
}

/** The key, made on first use. Never replaces one that exists. */
export async function ensureRecoveryKey(dataDir: string): Promise<{ key: string; created: boolean }> {
  const existing = await readRecoveryKey(dataDir);
  if (existing) return { key: existing, created: false };
  // A file that exists but does not parse is somebody's key gone wrong: keep it aside.
  const file = recoveryKeyPath(dataDir);
  await fs.rename(file, `${file}.unreadable-${Date.now()}`).catch(() => {});
  return { key: await writeRecoveryKey(dataDir, generateRecoveryKey()), created: true };
}
