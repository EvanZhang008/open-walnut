/** Release old credential holds; recovery is best effort and never blocks private sync. */
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { log } from '../logging/index.js';
import type { GitRunner } from './git-sync-secrets.js';

interface LegacyHold { asideOf?: string }
interface Recovery { source: string; target: string }
const chains = new Map<string, Promise<void>>();

export function releasePrivateDataHolds(git: GitRunner, root: string): Promise<void> {
  const previous = chains.get(root) ?? Promise.resolve();
  const next = previous.then(() => releaseNow(git, root)).catch(() => {
    log.git.info('git-sync: old private-data recovery deferred; ordinary files still sync');
  });
  chains.set(root, next);
  void next.then(() => { if (chains.get(root) === next) chains.delete(root); });
  return next;
}

async function recover(root: string, aside: string, original: string): Promise<string | null> {
  const source = path.resolve(root, aside);
  const target = path.resolve(root, original);
  const within = (p: string) => p.startsWith(path.resolve(root) + path.sep);
  if (!within(source) || !within(target)) throw new Error('Recovery path is outside the data folder');
  let stat;
  try { stat = await fsp.lstat(source); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!stat.isFile()) throw new Error('Recovery source is not a regular file');
  const [parent, rootReal] = await Promise.all([fsp.realpath(path.dirname(source)), fsp.realpath(root)]);
  if (parent !== rootReal && !parent.startsWith(rootReal + path.sep)) throw new Error('Recovery parent is outside the data folder');
  // Recover alongside the sidecar: its directory exists, even if the old original directory is gone.
  const base = path.join(parent, path.basename(target));
  const tmp = path.join(parent, `.open-walnut-${crypto.randomBytes(12).toString('hex')}.tmp`);
  try {
    await fsp.copyFile(source, tmp);
    const bytes = await fsp.readFile(tmp);
    const suffix = crypto.createHash('sha256').update(aside).update(bytes).digest('hex').slice(0, 16);
    let restored = `${base}.recovered-private-data-${suffix}`;
    try { await fsp.link(tmp, restored); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await fsp.lstat(restored);
      if (!existing.isFile() || !(await fsp.readFile(restored)).equals(bytes)) {
        // An edited or partial old recovery is evidence too; preserve it and publish a fresh copy.
        restored += `-${crypto.randomBytes(6).toString('hex')}`;
        await fsp.link(tmp, restored);
      }
    }
    // `restored` sits under the resolved folder, so it is relative to the resolved root (a data
    // folder under a symbolic link, as macOS /var is, would otherwise climb out with `../`).
    return path.relative(rootReal, restored).split(path.sep).join('/');
  } finally { await fsp.rm(tmp, { force: true }); }
}

async function releaseNow(git: GitRunner, root: string): Promise<void> {
  const dir = path.resolve(root, (await git(['rev-parse', '--git-dir'])).trim());
  const file = path.join(dir, 'walnut-secret-holds.json');
  let store: { privateDataReleased?: boolean; holds?: Record<string, LegacyHold>; recovered?: Recovery[] };
  try { store = JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; store = {}; }
  if (store.privateDataReleased) return;
  const entries = new Map(Object.entries(store.holds ?? {}).filter(([, hold]) => hold?.asideOf).map(([aside, hold]) => [aside, hold.asideOf!]));
  // Limit discovery to old sidecars, never enumerate caches or session runtime files.
  const ignored = await git(['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ':(glob)**/*.conflicted-secret-*']);
  for (const aside of ignored.split('\0')) {
    const match = /^(.*)\.conflicted-secret-[^/]+$/.exec(aside);
    if (match) entries.set(aside, entries.get(aside) ?? match[1]);
  }
  const recovered = store.recovered ?? [];
  const done = new Set(recovered.map((r) => r.source));
  const pending: Record<string, LegacyHold> = {};
  for (const [aside, original] of entries) {
    if (done.has(aside)) continue;
    try {
      const target = await recover(root, aside, original);
      if (target) recovered.push({ source: aside, target });
    } catch {
      pending[aside] = { asideOf: original };
      log.git.info('git-sync: old private-data sidecar recovery deferred; original copy retained');
    }
  }
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify({ version: 2, holds: pending, privateDataReleased: Object.keys(pending).length === 0, recovered }) + '\n', { mode: 0o600 });
  await fsp.rename(tmp, file);
}
