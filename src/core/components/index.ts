/**
 * Components for this process: what each one's status is, installing one when a
 * feature asks for it (once, however many ask), and where a feature loads its
 * package from.
 *
 * Where a package comes from, in order:
 *   1. bundled: Walnut's own node_modules has it (running from source, an npm
 *      install). Nothing is downloaded; developers never see a component.
 *   2. installed: the pinned archive is unpacked under componentsRoot(), or,
 *      until it is, an older install this data home already has.
 *   3. neither: the feature says so in its own place, and installs it when the
 *      feature is on and needs it (ensureComponent). Nothing installs at startup,
 *      except that the server (startComponentUpgrades) brings a component the
 *      person already had up to the pinned version.
 *
 * Never on the event loop's critical path: status reads are in memory, every
 * disk and network step is async, and a feature waits for an install only up
 * to that install's own deadline (whenComponentReady): the first caller gets
 * FEATURE_WAIT_MS, every later one what is left of it.
 *
 * Automatic triggers back off after a failure (doubling from a minute to six
 * hours) and never retry a failure no retry can fix (isPermanentFailure); a
 * person's click always tries again.
 */

import { randomBytes } from 'node:crypto';
import { rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSubsystemLogger } from '../../logging/index.js';
import { singleFile } from '../../lib/single-file.js';
import { COMPONENTS } from './catalog.js';
import { findUsable, installComponent, otherVersions, type InstalledComponent, type InstallOptions } from './install.js';
import { acquireLock } from './lock.js';
import { getManifest, loadManifestOverride, manifestComponent, manifestEntry } from './manifest.js';
import { componentsRoot, lockFile } from './paths.js';
import { currentPlatform, currentPlatformSync } from './platform.js';
import { COMPONENT_NAMES, componentErrorCode, isPermanentFailure, type ComponentName, type ComponentStatus } from './types.js';

export * from './types.js';
export { COMPONENTS } from './catalog.js';

const log = createSubsystemLogger('components');

/** How long a feature waits for an install it needs, counted from the install's start. */
const FEATURE_WAIT_MS = 20_000;
/** An automatic retry after the n-th failure in a row waits base * 2^(n-1), at most the cap. */
const AUTO_RETRY_BASE_MS = 60_000;
const AUTO_RETRY_MAX_MS = 6 * 3600_000;

/**
 * Who asks: a person's click, the server bringing an older install up to the
 * pinned version, a feature that needs the package, or the repair of an install
 * that stopped loading. A feature that an older install already serves never
 * starts the upgrade: only the server does (startComponentUpgrades).
 */
export type ComponentTrigger = 'user' | 'upgrade' | 'feature' | 'repair';

interface Slot {
  status: ComponentStatus;
  /** What the feature loads: the pinned install, or an older one (fallback) until it is there. */
  installed: InstalledComponent | null;
  inflight: Promise<ComponentStatus> | null;
  /** Until when a feature waits for the install in flight. */
  waitUntil: number;
  failedAt: number;
  /** Failures in a row (the backoff), and whether the last one can be fixed by retrying. */
  failures: number;
  permanent: boolean;
  /** A broken install was already replaced once in this process. */
  reinstalled: boolean;
}

export interface ComponentTuning extends Partial<InstallOptions> {
  featureWaitMs?: number;
  retryBaseMs?: number;
}

const slots = new Map<ComponentName, Slot>();
const listeners = new Set<(s: ComponentStatus) => void>();
let initPromise: Promise<void> | null = null;
let initDone = false;
/** Install options and clocks a test (or a host) sets for this process. */
let tuning: ComponentTuning = {};
/** This process installs nothing (`walnut __selftest`): it reports what is on disk. */
let installsHeld = false;

const inBunfs = (p: string | undefined) => !!p && (p.includes('/$bunfs/') || p.includes('~BUN'));

/**
 * True inside the compiled Walnut file (src/lib/single-file.ts; its entry in
 * bun's virtual filesystem when another build compiles this code). Its
 * import.meta.url points at the unpacked runtime tree on disk, so it does not
 * tell. Nothing is taken from node_modules there: the file carries none of these
 * packages, and a resolver walking up from the runtime tree or the current
 * directory would find someone else's copy.
 */
export function isCompiledBinary(): boolean {
  if (singleFile()) return true;
  const main = (globalThis as { Bun?: { main?: string } }).Bun?.main;
  return inBunfs(main) || inBunfs(process.argv[1]);
}

const selfRequire = createRequire(import.meta.url);
const bundledCache = new Map<ComponentName, boolean>();
/** Packages that resolved but failed to load (a native binary that does not run here). */
const brokenBundled = new Set<ComponentName>();

function bundled(name: ComponentName): boolean {
  if (brokenBundled.has(name)) return false;
  let found = bundledCache.get(name);
  if (found === undefined) {
    found = false;
    if (!isCompiledBinary() && process.env.WALNUT_COMPONENTS_FROM !== 'download') {
      try { selfRequire.resolve(COMPONENTS[name].pkg); found = true; } catch { /* not installed */ }
    }
    bundledCache.set(name, found);
  }
  return found;
}

function now(): string {
  return new Date().toISOString();
}

function baseStatus(name: ComponentName): ComponentStatus {
  const def = COMPONENTS[name];
  const platform = currentPlatformSync();
  if (bundled(name)) {
    return { name, label: def.label, state: 'ready', source: 'bundled', platform, version: null, updatedAt: now() };
  }
  if (def.os && !def.os.includes(process.platform)) {
    return { name, label: def.label, state: 'unsupported', platform, version: null, error: `${def.label} is not available on this system`, code: 'unsupported', updatedAt: now() };
  }
  const comp = manifestComponent(name, getManifest());
  const entry = manifestEntry(name, platform);
  if (!entry || !comp) {
    return { name, label: def.label, state: 'unsupported', platform, version: comp?.version ?? null, error: `${def.label} is not built for ${platform ?? 'this system'}`, code: 'unsupported', updatedAt: now() };
  }
  return { name, label: def.label, state: 'missing', platform, version: comp.version, size: entry.size, updatedAt: now() };
}

function slot(name: ComponentName): Slot {
  let s = slots.get(name);
  if (!s) {
    s = { status: baseStatus(name), installed: null, inflight: null, waitUntil: 0, failedAt: 0, failures: 0, permanent: false, reinstalled: false };
    slots.set(name, s);
  }
  return s;
}

/** `into`: the slot an install started with; a run outliving a test reset only writes its own. */
function publish(name: ComponentName, next: ComponentStatus, into: Slot = slot(name)): ComponentStatus {
  into.status = next;
  if (slots.get(name) !== into) return next;
  for (const l of listeners) {
    try { l(next); } catch { /* a listener's failure is its own */ }
  }
  return next;
}

function update(name: ComponentName, patch: Partial<ComponentStatus>, into: Slot = slot(name)): ComponentStatus {
  const next: ComponentStatus = { ...into.status, ...patch, updatedAt: now() };
  if (patch.state && patch.state !== 'downloading' && patch.state !== 'installing') delete next.progress;
  if (patch.state && patch.state !== 'failed' && patch.state !== 'unsupported') { delete next.error; delete next.code; }
  return publish(name, next, into);
}

const pinnedReady = (s: Slot) => s.status.source === 'bundled' || (!!s.installed && !s.installed.fallback);
/** An older install serves the feature; bringing it up to date is the server's call, or a person's. */
const servedByOlder = (s: Slot, trigger: ComponentTrigger) => trigger === 'feature' && !!s.installed?.fallback;

/** Look at disk for one component: the pinned version, else an older install to use meanwhile. */
async function refresh(name: ComponentName): Promise<void> {
  const s = slot(name);
  const base = baseStatus(name);
  if (base.state !== 'missing') { s.installed = null; publish(name, base); return; }
  const platform = await currentPlatform();
  const usable = platform ? await findUsable(name, { root: componentsRoot(), platform }) : null;
  s.installed = usable;
  if (usable) publish(name, { ...base, state: 'ready', source: 'installed', version: usable.version });
  else if (s.status.state !== 'failed' && !s.inflight) publish(name, base);
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Read the manifest override, detect the platform, look at what is installed.
 * Downloads nothing. Never rejects: a part that fails is logged, and the
 * status reads what could be found.
 */
export function initComponents(): Promise<void> {
  initPromise ??= (async () => {
    await loadManifestOverride().catch((err) => {
      log.warn('components manifest override unreadable; using the compiled one', { error: errText(err) });
    });
    await currentPlatform().catch(() => null);
    for (const name of COMPONENT_NAMES) {
      await refresh(name).catch((err) => log.warn('component status could not be read', { name, error: errText(err) }));
    }
    initDone = true;
  })();
  return initPromise;
}

/** initComponents() has finished: a status read now reflects the disk. */
export function componentsInitialized(): boolean {
  return initDone;
}

/** From now on this process downloads, replaces and removes nothing (a selftest). */
export function holdComponentInstalls(): void {
  installsHeld = true;
}

/**
 * The server only (never a CLI command or `walnut __selftest`): a component the
 * person already had (an older install in use, or another build's version on
 * disk) is brought to the pinned version in the background.
 */
export async function startComponentUpgrades(): Promise<void> {
  await initComponents();
  for (const name of COMPONENT_NAMES) {
    const s = slot(name);
    const version = manifestComponent(name, getManifest())?.version;
    if (!version || s.status.state === 'unsupported' || pinnedReady(s)) continue;
    const others = await otherVersions(name, componentsRoot(), version).catch(() => [] as string[]);
    if (!s.installed?.fallback && others.length === 0) continue;
    log.info('component upgrade: another version is on disk', { name, others, version, using: s.installed?.version ?? null });
    void ensureComponent(name, 'upgrade');
  }
}

export function componentStatus(name: ComponentName): ComponentStatus {
  return slot(name).status;
}

export function listComponentStatuses(): ComponentStatus[] {
  return COMPONENT_NAMES.map((n) => componentStatus(n));
}

export function onComponentStatus(listener: (s: ComponentStatus) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function retryDelay(failures: number): number {
  const base = tuning.retryBaseMs ?? AUTO_RETRY_BASE_MS;
  return Math.min(base * 2 ** Math.max(0, failures - 1), AUTO_RETRY_MAX_MS);
}

/**
 * Install `name` if the pinned version is not there; resolves with the final
 * status and never rejects (a failure is the status). One install per
 * component at a time in this process; across processes the lock (lock.ts)
 * does the same. While an older install serves the feature, the row stays
 * ready and the upgrade runs quietly.
 */
export function ensureComponent(name: ComponentName, trigger: ComponentTrigger): Promise<ComponentStatus> {
  const s = slot(name);
  if (s.inflight) return s.inflight;
  if (installsHeld || s.status.state === 'unsupported' || pinnedReady(s) || servedByOlder(s, trigger)) return Promise.resolve(s.status);
  if (trigger !== 'user' && s.failures > 0 && (s.permanent || Date.now() - s.failedAt < retryDelay(s.failures))) {
    return Promise.resolve(s.status);
  }
  s.waitUntil = Date.now() + (tuning.featureWaitMs ?? FEATURE_WAIT_MS);
  const quiet = () => !!s.installed?.fallback;
  const say = (patch: Partial<ComponentStatus>) => (quiet() ? s.status : update(name, patch, s));
  const starting = { state: 'downloading' as const, progress: { done: 0, total: s.status.size ?? null } };
  // A click is answered at once; an automatic trigger speaks once the disk was read.
  if (initDone || trigger === 'user') say(starting);
  const run = (async (): Promise<ComponentStatus> => {
    await initComponents();
    if (s.status.state === 'unsupported' || pinnedReady(s) || servedByOlder(s, trigger)) return s.status;
    const platform = await currentPlatform();
    if (!platform) return update(name, { state: 'unsupported', error: 'No components are built for this system', code: 'unsupported' }, s);
    if (s.status.state !== 'downloading') say(starting);
    const startedAt = Date.now();
    const { featureWaitMs: _wait, retryBaseMs: _retry, ...installTuning } = tuning;
    try {
      const installed = await installComponent(name, {
        root: componentsRoot(),
        platform,
        ...installTuning,
        onPhase: (phase) => { say({ state: phase }); },
        onProgress: (done, total) => { say({ state: 'downloading', progress: { done, total } }); },
      });
      s.installed = installed;
      s.failures = 0;
      s.permanent = false;
      log.info('component installed', { name, version: installed.version, platform, trigger, ms: Date.now() - startedAt });
      return update(name, { state: 'ready', source: 'installed', version: installed.version }, s);
    } catch (err) {
      s.failedAt = Date.now();
      s.failures++;
      const code = componentErrorCode(err);
      s.permanent = isPermanentFailure(code, (err as { status?: number }).status);
      log.warn('component install failed', {
        name, platform, trigger, code, error: errText(err), ms: Date.now() - startedAt,
        permanent: s.permanent, nextAutoRetryMs: s.permanent ? null : retryDelay(s.failures),
      });
      if (quiet()) return s.status;
      return update(name, { state: code === 'unsupported' ? 'unsupported' : 'failed', error: errText(err), code }, s);
    }
  })();
  s.inflight = run.finally(() => { s.inflight = null; });
  return s.inflight;
}

/**
 * Ready now, or once the install in flight lands, waiting at most what is left
 * of that install's deadline (and `timeoutMs`). False when nothing is
 * installing, the install failed, or the deadline passed.
 */
export async function whenComponentReady(name: ComponentName, timeoutMs = Number.POSITIVE_INFINITY): Promise<boolean> {
  const s = slot(name);
  if (s.status.state === 'ready') return true;
  if (!s.inflight) return false;
  const left = Math.min(timeoutMs, s.waitUntil - Date.now());
  if (!(left > 0)) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((r) => { timer = setTimeout(() => r(null), left); timer.unref?.(); });
  try {
    const result = await Promise.race([s.inflight, timeout]);
    return result?.state === 'ready';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type LoadedComponent =
  | { source: 'bundled' }
  | { source: 'installed'; version: string; dir: string; entryPath: string; entryUrl: string; require: NodeJS.Require };

function loaded(name: ComponentName): LoadedComponent | null {
  const s = slot(name);
  if (s.status.state !== 'ready') return null;
  if (s.status.source === 'bundled') return { source: 'bundled' };
  const inst = s.installed;
  if (!inst) return null;
  return {
    source: 'installed',
    version: inst.version,
    dir: inst.dir,
    entryPath: inst.entryPath,
    entryUrl: pathToFileURL(inst.entryPath).href,
    // Resolves the component's own node_modules tree, wherever this code runs from.
    require: createRequire(path.join(inst.dir, 'index.js')),
  };
}

/** Where to load `name` from right now (sync: in memory only), or null when it is not ready. */
export function resolveComponent(name: ComponentName): LoadedComponent | null {
  return loaded(name);
}

/** The same, after the first look at disk. */
export async function loadComponent(name: ComponentName): Promise<LoadedComponent | null> {
  await initComponents();
  return loaded(name);
}

/**
 * The bundled package resolved but does not load here (a native binary built for
 * a newer C library than this machine has): fall back to the component, whose
 * archive is built for the oldest supported systems.
 */
export function markBundledBroken(name: ComponentName, err: unknown): void {
  if (brokenBundled.has(name) || !bundledCache.get(name)) return;
  brokenBundled.add(name);
  log.warn('bundled package does not load; using the downloaded component instead', { name, error: errText(err) });
  publish(name, baseStatus(name));
  void refresh(name);
}

/**
 * An installed component does not load (a file lost or damaged after its
 * marker was written): its dir is moved aside and the component is installed
 * again, once per process; an older install serves meanwhile when there is one.
 */
export function markInstalledBroken(name: ComponentName, err: unknown): void {
  const s = slot(name);
  const inst = s.installed;
  if (!inst) return;
  if (installsHeld) {
    log.warn('installed component does not load', { name, dir: inst.dir, error: errText(err) });
    return;
  }
  log.warn('installed component does not load; installing it again', { name, dir: inst.dir, error: errText(err) });
  s.installed = null;
  publish(name, baseStatus(name));
  void (async () => {
    try {
      const lock = await acquireLock(lockFile(componentsRoot(), name), { waitMs: 60_000 });
      try {
        const trash = path.join(path.dirname(inst.dir), `.trash-${randomBytes(4).toString('hex')}`);
        if (await rename(inst.dir, trash).then(() => true, () => false)) await rm(trash, { recursive: true, force: true });
      } finally {
        await lock.release();
      }
    } catch (e) {
      log.warn('broken component could not be moved aside', { name, error: errText(e) });
    }
    await refresh(name).catch(() => {});
    if (s.reinstalled) return;
    s.reinstalled = true;
    await ensureComponent(name, 'repair');
  })();
}

/** Test seam: forget every status, and set the install options and clocks (the platform cache is platform.ts's). */
export function resetComponentsForTests(defaults: ComponentTuning = {}): void {
  slots.clear();
  bundledCache.clear();
  brokenBundled.clear();
  initPromise = null;
  initDone = false;
  installsHeld = false;
  tuning = defaults;
}
