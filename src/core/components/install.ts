/**
 * Install one component: lock, download (or take an archive placed in
 * .downloads/ by hand), unpack into a staging dir while hashing the tar, and
 * rename it into place only when the hash and length are the pinned ones; then
 * remove the versions older than this one.
 *
 * Nothing unverified is published: the staging dir becomes the install only
 * after its tar matched, every file and the marker are fsynced first, and the
 * last step is one rename, so a crash leaves either the old state or the
 * finished one. Each holder of the lock downloads into its own file, and checks
 * that it still holds the lock before each step that publishes, so an installer
 * that was paused past the lock's stale limit (a sleeping Mac) never writes over
 * the one that took over.
 *
 * One data home may be shared by two Walnut builds (a rollback, an older Mac
 * app next to a newer server): each keeps its own pinned version, and an
 * install only removes versions older than the one it installed. A version the
 * installing process itself still loads from (`inUse`: an older install that
 * served until this one landed, whose files a running worker may still read)
 * stays until the next server start prunes it (index.ts).
 */

import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { extractTarGz } from '../../lib/tar.js';
import { downloadFile, type DownloadOptions } from './download.js';
import { acquireLock, type HeldLock, type LockOptions } from './lock.js';
import { assetUrl, getManifest, manifestComponent, manifestEntry } from './manifest.js';
import { downloadsDir, installDir, lockFile, MARKER, type InstallMarker } from './paths.js';
import { ComponentError, PLATFORMS, type ComponentName, type ComponentsManifest, type ManifestComponent, type ManifestPlatformEntry, type Platform } from './types.js';
import { compareVersions } from './version.js';

export interface InstalledComponent {
  name: ComponentName;
  version: string;
  platform: Platform;
  dir: string;
  /** Absolute path of the feature's entry module. */
  entryPath: string;
  /** An older install, used until the pinned version is installed. */
  fallback?: boolean;
}

export interface InstallOptions extends Pick<DownloadOptions, 'signal' | 'idleTimeoutMs' | 'deadlineMs' | 'retries' | 'backoffMs' | 'fetchImpl'> {
  root: string;
  platform: Platform;
  manifest?: ComponentsManifest;
  onPhase?: (phase: 'waiting' | 'downloading' | 'installing') => void;
  onProgress?: (done: number, total: number | null) => void;
  lock?: Omit<LockOptions, 'signal' | 'onWait'>;
  /** Versions this process still loads from: never removed by this install's prune. */
  inUse?: () => Iterable<string>;
}

/** Another installer's leftovers younger than this may still be in use (one that lost the lock). */
const LEFTOVER_MS = 10 * 60_000;

class LostLock extends ComponentError {
  constructor() { super('Another Walnut process took over this install', 'locked'); }
}

function pinned(name: ComponentName, platform: Platform, manifest: ComponentsManifest) {
  const comp = manifestComponent(name, manifest);
  const entry = manifestEntry(name, platform, manifest);
  if (!comp || !entry) throw new ComponentError(`No ${name} component is built for ${platform}`, 'unsupported');
  return { comp, entry };
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false);
}

async function readMarker(dir: string): Promise<InstallMarker | null> {
  try { return JSON.parse(await readFile(path.join(dir, MARKER), 'utf8')) as InstallMarker; } catch { return null; }
}

/** A finished install of `version`: its marker says so and its entry file is there. */
async function validInstall(name: ComponentName, root: string, version: string, platform: Platform, entry: string): Promise<{ dir: string; entryPath: string; marker: InstallMarker } | null> {
  const dir = installDir(root, name, version, platform);
  const marker = await readMarker(dir);
  if (!marker || marker.name !== name || marker.version !== version || marker.platform !== platform) return null;
  const entryPath = path.join(dir, marker.entry ?? entry);
  if (!(await exists(entryPath))) return null;
  return { dir, entryPath, marker };
}

/** The pinned version is installed and finished: its marker names the pinned hash. */
export async function findInstalled(name: ComponentName, opts: { root: string; platform: Platform; manifest?: ComponentsManifest }): Promise<InstalledComponent | null> {
  const manifest = opts.manifest ?? getManifest();
  const comp = manifestComponent(name, manifest);
  const entry = manifestEntry(name, opts.platform, manifest);
  if (!comp || !entry) return null;
  const found = await validInstall(name, opts.root, comp.version, opts.platform, comp.entry);
  if (!found || found.marker.tarSha256 !== entry.tarSha256) return null;
  return { name, version: comp.version, platform: opts.platform, dir: found.dir, entryPath: found.entryPath };
}

/**
 * The pinned install, else the newest finished install older than it (what this
 * data home had before Walnut was upgraded): the feature keeps working while the
 * pinned one downloads, or for good on a machine that cannot download.
 */
export async function findUsable(name: ComponentName, opts: { root: string; platform: Platform; manifest?: ComponentsManifest }): Promise<InstalledComponent | null> {
  const installed = await findInstalled(name, opts);
  if (installed) return installed;
  const comp = manifestComponent(name, opts.manifest ?? getManifest());
  if (!comp) return null;
  const older = (await otherVersions(name, opts.root, comp.version))
    .filter((v) => compareVersions(v, comp.version) < 0)
    .sort((a, b) => compareVersions(b, a));
  for (const version of older) {
    const found = await validInstall(name, opts.root, version, opts.platform, comp.entry);
    if (found) return { name, version, platform: opts.platform, dir: found.dir, entryPath: found.entryPath, fallback: true };
  }
  return null;
}

/** Versions of `name` on disk other than `keep` (another Walnut build installed them). */
export async function otherVersions(name: ComponentName, root: string, keep: string): Promise<string[]> {
  const entries = await readdir(path.join(root, name)).catch(() => [] as string[]);
  return entries.filter((v) => v !== keep && !v.startsWith('.'));
}

async function fsyncPath(p: string): Promise<void> {
  // A directory's fsync publishes the names in it; some file systems refuse it, which costs nothing here.
  const fh = await open(p, 'r').catch(() => null);
  if (!fh) return;
  try { await fh.sync(); } catch { /* not supported here */ } finally { await fh.close(); }
}

function isDiskError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^E(NOSPC|ACCES|PERM|ROFS|IO|MFILE|NFILE|DQUOT)$/.test(code);
}

export async function installComponent(name: ComponentName, opts: InstallOptions): Promise<InstalledComponent> {
  const manifest = opts.manifest ?? getManifest();
  const { comp, entry } = pinned(name, opts.platform, manifest);
  const ready = await findInstalled(name, { root: opts.root, platform: opts.platform, manifest });
  if (ready) return ready;

  for (let round = 0; ; round++) {
    const lock = await acquireLock(lockFile(opts.root, name), {
      ...opts.lock,
      signal: opts.signal,
      onWait: () => opts.onPhase?.('waiting'),
    });
    try {
      // Another process may have finished it while this one waited.
      const done = await findInstalled(name, { root: opts.root, platform: opts.platform, manifest });
      if (done) return done;
      return await installLocked(name, comp, entry, manifest, opts, lock);
    } catch (err) {
      // Taken over while paused: wait for the one that took it, then look again.
      if (err instanceof LostLock && round === 0) continue;
      throw err;
    } finally {
      await lock.release();
    }
  }
}

async function installLocked(
  name: ComponentName, comp: ManifestComponent, entry: ManifestPlatformEntry, manifest: ComponentsManifest,
  opts: InstallOptions, lock: HeldLock,
): Promise<InstalledComponent> {
  const held = async () => { if (!(await lock.stillHeld())) throw new LostLock(); };
  const versionDir = path.join(opts.root, name, comp.version);
  const final = installDir(opts.root, name, comp.version, opts.platform);
  const downloads = downloadsDir(opts.root);
  await mkdir(downloads, { recursive: true });

  /** Unpack `archive` into a staging dir; null when it is not the pinned archive. */
  const unpack = async (archive: string): Promise<string | null> => {
    const staging = path.join(versionDir, `.staging-${opts.platform}-${lock.token}-${randomBytes(4).toString('hex')}`);
    await mkdir(versionDir, { recursive: true });
    try {
      const r = await extractTarGz(archive, staging, { maxBytes: entry.tarSize, maxTarBytes: entry.tarSize, fsync: true });
      if (r.tarSha256 !== entry.tarSha256 || r.tarBytes !== entry.tarSize) {
        await rm(staging, { recursive: true, force: true });
        return null;
      }
      return staging;
    } catch (err) {
      await rm(staging, { recursive: true, force: true });
      if (isDiskError(err)) throw err;
      // Not a gzip or a tar, cut short, longer than pinned: not the pinned archive.
      return null;
    }
  };

  const publish = async (staging: string): Promise<InstalledComponent> => {
    try {
      if (!(await exists(path.join(staging, comp.entry)))) {
        throw new ComponentError(`The ${name} archive has no ${comp.entry}`, 'checksum');
      }
      await held();
      const marker: InstallMarker = {
        name, version: comp.version, platform: opts.platform, tarSha256: entry.tarSha256, entry: comp.entry, installedAt: new Date().toISOString(),
      };
      const fh = await open(path.join(staging, MARKER), 'w');
      try {
        await fh.writeFile(JSON.stringify(marker, null, 2));
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fsyncPath(staging);
      await held();
      // An unfinished or broken dir in the way (no marker, another hash, no entry) goes first.
      if (await exists(final)) {
        const trash = path.join(versionDir, `.trash-${randomBytes(4).toString('hex')}`);
        await rename(final, trash);
        await rm(trash, { recursive: true, force: true });
      }
      await rename(staging, final);
      await fsyncPath(versionDir);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    await pruneOld(name, opts.root, comp.version, opts.inUse?.() ?? []);
    const installed = await findInstalled(name, { root: opts.root, platform: opts.platform, manifest });
    if (!installed) throw new ComponentError(`The ${name} component did not install`, 'disk');
    return installed;
  };

  // An archive placed here by hand (a host without internet): used when it is the pinned one.
  const handed = path.join(downloads, entry.asset);
  if (await exists(handed)) {
    opts.onPhase?.('installing');
    const staged = await unpack(handed);
    await rm(handed, { force: true });
    if (staged) return publish(staged);
  }

  // This holder's own files: one paused past the lock's stale limit never shares them.
  const mine = path.join(downloads, `${entry.asset}.${lock.token}`);
  try {
    // Twice: a download that completed but does not match (a proxy that cut it
    // short without saying so) is fetched again from scratch once.
    for (let attempt = 0; attempt < 2; attempt++) {
      opts.onPhase?.('downloading');
      await downloadFile(assetUrl(name, entry, manifest), mine, {
        partFile: `${mine}.part`,
        expectedBytes: entry.size,
        onProgress: opts.onProgress,
        signal: opts.signal,
        idleTimeoutMs: opts.idleTimeoutMs,
        deadlineMs: opts.deadlineMs,
        retries: opts.retries,
        backoffMs: opts.backoffMs,
        fetchImpl: opts.fetchImpl,
      });
      await held();
      opts.onPhase?.('installing');
      const staged = await unpack(mine);
      await rm(mine, { force: true });
      if (staged) return await publish(staged);
    }
    throw new ComponentError(`The ${name} download does not match its pinned checksum`, 'checksum');
  } finally {
    await rm(mine, { force: true });
    await rm(`${mine}.part`, { force: true });
  }
}

/**
 * With the lock held: remove the versions of `name` older than `keep` (never a
 * newer one: another Walnut build uses it, and never one in `inUse`: this
 * process still loads from it), crashed installs' leftovers, and archives and
 * partial downloads in .downloads/ that are not this version's or that no live
 * installer is writing.
 */
export async function pruneOld(name: ComponentName, root: string, keep: string, inUse: Iterable<string> = []): Promise<string[]> {
  const removed: string[] = [];
  const using = new Set(inUse);
  for (const v of await otherVersions(name, root, keep)) {
    if (compareVersions(v, keep) >= 0 || using.has(v)) continue;
    await rm(path.join(root, name, v), { recursive: true, force: true });
    removed.push(v);
  }
  const old = async (p: string) => stat(p).then((s) => Date.now() - s.mtimeMs > LEFTOVER_MS, () => false);
  const keepDir = path.join(root, name, keep);
  for (const e of await readdir(keepDir).catch(() => [] as string[])) {
    const p = path.join(keepDir, e);
    if (e.startsWith('.trash-') || (e.startsWith('.staging-') && await old(p))) await rm(p, { recursive: true, force: true });
  }
  const downloads = downloadsDir(root);
  for (const f of await readdir(downloads).catch(() => [] as string[])) {
    const version = assetVersion(f, name);
    if (version === null) continue;
    const p = path.join(downloads, f);
    const c = compareVersions(version, keep);
    // Older: no build will use it. This version: another holder's, gone quiet. Newer: another build's.
    if (c < 0 || (c === 0 && await old(p))) await rm(p, { force: true });
  }
  return removed;
}

/** The version in a file name under .downloads/ (`walnut-<name>-<version>-<platform>.tar.gz`, then any suffix). */
function assetVersion(file: string, name: ComponentName): string | null {
  const prefix = `walnut-${name}-`;
  if (!file.startsWith(prefix)) return null;
  for (const platform of PLATFORMS) {
    const at = file.indexOf(`-${platform}.tar.gz`, prefix.length);
    if (at > prefix.length) return file.slice(prefix.length, at);
  }
  return null;
}

/** Remove a component entirely (every version and platform). */
export async function removeComponent(name: ComponentName, root: string): Promise<void> {
  await rm(path.join(root, name), { recursive: true, force: true });
}
