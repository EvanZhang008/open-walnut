/**
 * Plugin sources ("plugin store") — install plugins from git repos or npm.
 *
 * Two kinds of source, one registry:
 * - **git**: any repo whose root OR top-level subdirectories contain a plugin
 *   manifest.json. Configured as `{url, ref?, enabled?}`, cloned under
 *   ~/.open-walnut/plugin-stores/<slug>/.
 * - **npm**: a published registry package whose root holds a manifest.json.
 *   Configured as `{type: 'npm', spec, enabled?}`, installed under the same
 *   directory with an `npm-` prefixed slug. Registration rejects collisions
 *   across both source kinds. Fetch and verification live in plugin-npm-install.ts.
 *
 * Either way the installed plugin dirs are scanned by the integration loader
 * alongside ~/.open-walnut/plugins/.
 *
 * Runtime state (last synced SHA for git; resolved version + integrity for npm,
 * plus errors) lives in ~/.open-walnut/plugin-stores/sources.json — NOT in
 * config.yaml, which stays hand-editable and records only the spec/url the user
 * asked for (never a token). config.yaml is the source of truth for which
 * sources exist.
 *
 * Trust model: adding a source is the consent step — plugins run in-process
 * with full privileges. No auto-pull and no auto-resolve: updates are explicit
 * user actions so remote code changes are always visible and attributable (git
 * SHA / resolved name@version + integrity shown in the UI).
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { PLUGIN_STORES_DIR } from '../constants.js';
import { readJsonFile, updateJsonFile } from '../utils/fs.js';
import { getConfig, updateConfig } from './config-manager.js';
import { execGitArgsGroup, hardenGitConfigPerms, isGitAvailable } from '../integrations/git-sync.js';
import { createSubsystemLogger } from '../logging/index.js';
import {
  parseNpmSpec, slugForNpmPackage, invalidSpecMessage,
  resolveNpmSpecIsolated, installNpmPlugin, replaceNpmPlugin,
} from './plugin-npm-install.js';

const log = createSubsystemLogger('plugin-sources');

const SOURCES_STATE_FILE = path.join(PLUGIN_STORES_DIR, 'sources.json');
const CLONE_TIMEOUT = 120_000;

export interface GitPluginSourceConfig {
  url: string;
  ref?: string;
  enabled?: boolean;
}

export interface NpmPluginSourceConfig {
  type: 'npm';
  /** Registry package spec exactly as the user typed it (`name`, `name@1.2.3`, …). */
  spec: string;
  enabled?: boolean;
}

/** A configured source. Legacy git entries have no discriminator, so `type` is
 *  what distinguishes an npm entry — an old config keeps working untouched. */
export type PluginSourceConfig = GitPluginSourceConfig | NpmPluginSourceConfig;

export function isNpmSourceConfig(source: PluginSourceConfig): source is NpmPluginSourceConfig {
  return (source as NpmPluginSourceConfig).type === 'npm'
    || (typeof (source as NpmPluginSourceConfig).spec === 'string'
      && typeof (source as GitPluginSourceConfig).url !== 'string');
}

export interface PluginSourceState {
  /** git sources only. */
  url?: string;
  ref?: string;
  lastSha?: string;
  /** npm sources only. */
  type?: 'npm';
  spec?: string;
  /** Exact `name@version` installed on disk. */
  resolved?: string;
  packageName?: string;
  version?: string;
  integrity?: string;
  lastSyncedAt?: string;
  lastError?: string;
}

export interface DiscoveredStorePlugin {
  /** Absolute path of the plugin directory (contains manifest.json). */
  dir: string;
  /** Plugin id from manifest, or null if manifest is unreadable/invalid. */
  id: string | null;
  name: string | null;
  version: string | null;
  error?: string;
}

export interface PluginSourceView {
  slug: string;
  /** Which installer owns this source. Always present; `type` mirrors the
   *  config discriminator and is set only for npm, so old clients that
   *  branch on nothing still render git sources exactly as before. */
  kind: 'git' | 'npm';
  type?: 'npm';
  /** git: URL with any embedded credentials masked. Absent for npm sources. */
  url?: string;
  ref?: string;
  /** npm: the registry spec the user asked for. */
  spec?: string;
  /** npm: exact `name@version` currently on disk. */
  resolved?: string;
  packageName?: string;
  version?: string;
  integrity?: string;
  enabled: boolean;
  /** Installed on disk (git: cloned; npm: package directory present). */
  cloned: boolean;
  lastSha?: string;
  lastSyncedAt?: string;
  lastError?: string;
  plugins: DiscoveredStorePlugin[];
  /** Paste-able snippet for teammates ("Copy share snippet" button). git only —
   *  absent when the URL embeds credentials, since those must never be shared. */
  shareSnippet?: string;
}

// ── URL validation & masking ──

// https / ssh / scp-like (git@host:path) / file (tests + local repos)
const URL_RE = /^(https?:\/\/|ssh:\/\/|git@[\w.-]+:|file:\/\/)[^\s]+$/;
// Shell metacharacters — the URL is interpolated into a git command line
const UNSAFE_RE = /[;&|`$(){}<>"'\\\s]/;

export function isValidSourceUrl(url: string): boolean {
  return URL_RE.test(url) && !UNSAFE_RE.test(url);
}

/** Mask embedded credentials: https://user:token@host/... → https://***@host/... */
export function maskSourceUrl(url: string): string {
  return url.replace(/^(https?:\/\/)[^/@\s]+@/, '$1***@');
}

/** Derive a filesystem slug from a repo URL: basename minus .git, sanitized. */
export function slugForUrl(url: string): string {
  const base = url.replace(/\/+$/, '').split(/[/:]/).pop() ?? 'source';
  const slug = base
    .replace(/\.git$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/\.{2,}/g, '.');
  return slug || 'source';
}

const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;
const GIT_REF_RE = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/;

/** Guard against traversal and internal staging names in API path params. */
export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && !slug.includes('..');
}

/** Conservative branch/tag syntax accepted by `git clone --branch`. */
export function isValidSourceRef(ref: string): boolean {
  if (!GIT_REF_RE.test(ref) || ref.includes('..') || ref.includes('//')) return false;
  return !ref.split('/').some((segment) =>
    !segment || segment.startsWith('.') || segment.endsWith('.') || segment.endsWith('.lock'));
}

/** Store slug for either kind of source. npm slugs carry an `npm-` prefix. */
export function slugForSource(source: PluginSourceConfig): string {
  if (isNpmSourceConfig(source)) {
    const parsed = parseNpmSpec(source.spec);
    // A hand-edited config could hold garbage; keep it listable rather than
    // throwing out of listSources()/getStorePluginDirs().
    return parsed ? slugForNpmPackage(parsed.name) : slugForNpmPackage(source.spec);
  }
  return slugForUrl(source.url);
}

function cloneDirFor(slug: string): string {
  return path.join(PLUGIN_STORES_DIR, slug);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.lstat(target);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

const sourceLocks = new Map<string, Promise<void>>();

async function withSourceLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = sourceLocks.get(key) ?? Promise.resolve();
  const waitForPrevious = previous.catch(() => undefined);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const chain = waitForPrevious.then(() => hold);
  sourceLocks.set(key, chain);
  await waitForPrevious;
  try {
    return await fn();
  } finally {
    release();
    if (sourceLocks.get(key) === chain) sourceLocks.delete(key);
  }
}

async function mutateConfiguredSources(
  mutate: (sources: PluginSourceConfig[]) => PluginSourceConfig[] | Promise<PluginSourceConfig[]>,
): Promise<PluginSourceConfig[]> {
  return withSourceLock('__plugin-source-config__', async () => {
    const config = await getConfig();
    const current = [...(config.plugin_sources ?? [])] as PluginSourceConfig[];
    const next = await mutate(current);
    await updateConfig({ plugin_sources: next });
    return next;
  });
}

// ── Share snippets ──
// A paste-able JSON one-liner teammates share over chat. Pasting it into the
// Plugin Store input registers the source with zero judgement required —
// nobody needs to know or type a git URL by hand.

export interface ShareSnippet {
  url: string;
  ref?: string;
}

/** Parse a pasted share snippet: {"walnut_plugin_source": "<url>" | {url, ref?}}.
 *  Returns null if the input isn't a snippet (callers then treat it as a URL). */
export function parseShareSnippet(input: string): ShareSnippet | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const raw = obj.walnut_plugin_source;
    if (typeof raw === 'string') return { url: raw };
    if (raw && typeof raw === 'object') {
      const src = raw as Record<string, unknown>;
      if (typeof src.url === 'string') {
        return { url: src.url, ref: typeof src.ref === 'string' ? src.ref : undefined };
      }
    }
  } catch { /* not JSON — fall through */ }
  return null;
}

/** Build the snippet for a source (the "Copy share snippet" button). */
export function buildShareSnippet(url: string, ref?: string): string {
  return JSON.stringify({ walnut_plugin_source: ref ? { url, ref } : url });
}

// ── WALNUT_HOME .gitignore self-heal ──
// WALNUT_HOME is itself a git repo (git-sync auto-commits it every 30s).
// Plugin clones are nested git repos — if the data repo ever tracked them it
// would record dead gitlinks (same problem Claude Code solves by ignoring
// plugins/ in ~/.claude/.gitignore). Ensure the ignore rule exists before
// every clone so fresh machines are safe without manual setup.
async function ensureStoresIgnored(): Promise<void> {
  const walnutHome = path.dirname(PLUGIN_STORES_DIR);
  try {
    if (!(await pathExists(path.join(walnutHome, '.git')))) return; // not a git repo — nothing to protect
    const ignorePath = path.join(walnutHome, '.gitignore');
    let content = '';
    try {
      content = await fsp.readFile(ignorePath, 'utf-8');
    } catch { /* no .gitignore yet */ }
    if (content.split(/\r?\n/).some(line => line.trim() === 'plugin-stores/')) return;
    const addition = `${content.length && !content.endsWith('\n') ? '\n' : ''}\n# Plugin-store clones (regenerable cache; nested git repos must not be tracked)\nplugin-stores/\n`;
    await fsp.writeFile(ignorePath, content + addition, 'utf-8');
    log.info('added plugin-stores/ to data-repo .gitignore');
  } catch (err) {
    log.warn('could not ensure plugin-stores gitignore', { error: String(err) });
  }
}

// ── State file ──

async function readState(): Promise<Record<string, PluginSourceState>> {
  return readJsonFile<Record<string, PluginSourceState>>(SOURCES_STATE_FILE, {});
}

async function updateState(
  mutate: (state: Record<string, PluginSourceState>) => void | Promise<void>,
): Promise<Record<string, PluginSourceState>> {
  await fsp.mkdir(PLUGIN_STORES_DIR, { recursive: true });
  return updateJsonFile(SOURCES_STATE_FILE, {}, async (state) => {
    await mutate(state);
  });
}

// ── Scanning ──

/**
 * Scan a store clone for plugin directories: the repo root itself, or any
 * top-level subdirectory, that contains a manifest.json.
 */
export async function scanStorePlugins(storeDir: string): Promise<DiscoveredStorePlugin[]> {
  const found: DiscoveredStorePlugin[] = [];

  const readManifest = async (dir: string): Promise<DiscoveredStorePlugin | null> => {
    const manifestPath = path.join(dir, 'manifest.json');
    try {
      await fsp.access(manifestPath, fs.constants.R_OK);
    } catch {
      return null; // not a plugin dir
    }
    try {
      const raw = JSON.parse(await fsp.readFile(manifestPath, 'utf-8')) as Record<string, unknown>;
      return {
        dir,
        id: typeof raw.id === 'string' ? raw.id : null,
        name: typeof raw.name === 'string' ? raw.name : null,
        version: typeof raw.version === 'string' ? raw.version : null,
        ...(typeof raw.id !== 'string' ? { error: 'manifest.json missing "id"' } : {}),
      };
    } catch (err) {
      return { dir, id: null, name: null, version: null, error: `invalid manifest.json: ${err instanceof Error ? err.message : String(err)}` };
    }
  };

  // Root-level manifest = single-plugin repo
  const root = await readManifest(storeDir);
  if (root) {
    found.push(root);
    return found;
  }

  // One level deep: each subdir with a manifest is a plugin
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(storeDir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    // node_modules only appears in an npm install, whose root manifest already
    // short-circuited above — skip it anyway so a malformed package can never
    // make dependencies look like plugins.
    if (!entry.isDirectory() || entry.name === '.git' || entry.name === 'node_modules') continue;
    const plugin = await readManifest(path.join(storeDir, entry.name));
    if (plugin) found.push(plugin);
  }
  return found;
}

/**
 * Plugin directories from all enabled, installed sources (git clones and npm
 * packages alike) — consumed by discoverPluginDirs() in the integration loader.
 */
export async function getStorePluginDirs(): Promise<string[]> {
  const config = await getConfig();
  const sources = config.plugin_sources ?? [];
  const dirs: string[] = [];
  for (const source of sources) {
    if (source.enabled === false) continue;
    const dir = cloneDirFor(slugForSource(source));
    try {
      if (!(await fsp.stat(dir)).isDirectory()) continue;
    } catch {
      continue; // not installed (yet)
    }
    const plugins = await scanStorePlugins(dir);
    dirs.push(...plugins.map(p => p.dir));
  }
  return dirs;
}

// ── Git helpers ──

function gitCredentialArgs(url?: string): string[] {
  return url && /https?:\/\/[^/\s]+@/.test(url) ? ['-c', 'credential.helper='] : [];
}

async function runSourceGit(args: string[], cwd: string, url?: string): Promise<string> {
  try {
    return await execGitArgsGroup([...gitCredentialArgs(url), ...args], {
      cwd,
      timeout: CLONE_TIMEOUT,
    });
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const masked = url ? raw.replaceAll(url, maskSourceUrl(url)) : raw;
    throw new Error(masked.replace(/(https?:\/\/)[^/\s@]+@/gi, '$1***@'));
  }
}

async function assertGitCheckout(dir: string): Promise<void> {
  let marker: fs.Stats;
  try {
    marker = await fsp.lstat(path.join(dir, '.git'));
  } catch {
    throw new Error('Source directory is not a git checkout.');
  }
  if (marker.isSymbolicLink() || (!marker.isDirectory() && !marker.isFile())) {
    throw new Error('Source directory has an invalid .git marker.');
  }
  const top = await runSourceGit(['rev-parse', '--show-toplevel'], dir);
  const [realTop, realDir] = await Promise.all([fsp.realpath(top), fsp.realpath(dir)]);
  if (realTop !== realDir) throw new Error('Source directory resolves to a different git checkout.');
}

async function currentSha(dir: string): Promise<string> {
  await assertGitCheckout(dir);
  return runSourceGit(['rev-parse', 'HEAD'], dir);
}

async function cloneGitSource(url: string, ref: string | undefined, slug: string, finalDir: string): Promise<void> {
  const stagingDir = path.join(
    PLUGIN_STORES_DIR,
    `.staging-git-${slug}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
  );
  const args = [
    'clone',
    '--depth',
    '1',
    ...(ref ? ['--branch', ref] : []),
    '--',
    url,
    stagingDir,
  ];
  try {
    await runSourceGit(args, PLUGIN_STORES_DIR, url);
    await assertGitCheckout(stagingDir);
    await fsp.rename(stagingDir, finalDir);
  } catch (error) {
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(`git clone failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ── Source lifecycle ──

export async function addSource(url: string, ref?: string): Promise<PluginSourceView> {
  if (!isValidSourceUrl(url)) {
    throw new Error('Invalid git URL. Expected https://, ssh://, git@host:path, or file:// with no spaces or shell characters.');
  }
  if (ref !== undefined && !isValidSourceRef(ref)) {
    throw new Error('Invalid git ref. Use a branch or tag containing only letters, numbers, dot, underscore, slash, and hyphen.');
  }
  if (!isGitAvailable()) throw new Error('git is not available on this machine.');

  const slug = slugForUrl(url);
  const dir = cloneDirFor(slug);
  const source: GitPluginSourceConfig = { url, ...(ref ? { ref } : {}), enabled: true };
  return withSourceLock(slug, async () => {
    const existing = (await getConfig()).plugin_sources ?? [];
    if (existing.some((item) => !isNpmSourceConfig(item) && item.url === url)) {
      throw new Error('This source is already added.');
    }
    if (existing.some((item) => slugForSource(item) === slug) || await pathExists(dir)) {
      throw new Error(`A source with slug "${slug}" already exists. Remove it first or use a differently named source.`);
    }

    await fsp.mkdir(PLUGIN_STORES_DIR, { recursive: true });
    await ensureStoresIgnored();
    let installed = false;
    let state: Record<string, PluginSourceState> | undefined;
    try {
      await cloneGitSource(url, ref, slug, dir);
      installed = true;
      hardenGitConfigPerms(url, dir);
      const sha = await currentSha(dir);
      state = await updateState((current) => {
        current[slug] = { url, ref, lastSha: sha, lastSyncedAt: new Date().toISOString() };
      });
      await mutateConfiguredSources((current) => {
        if (current.some((item) => !isNpmSourceConfig(item) && item.url === url)) {
          throw new Error('This source is already added.');
        }
        if (current.some((item) => slugForSource(item) === slug)) {
          throw new Error(`A source with slug "${slug}" is already configured.`);
        }
        return [...current, source];
      });
      log.info('plugin source added', { slug, url: maskSourceUrl(url), sha });
    } catch (error) {
      if (installed) await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      await updateState((current) => { delete current[slug]; }).catch(() => undefined);
      throw error;
    }
    return buildView(slug, source, state![slug]);
  });
}

// ── npm source lifecycle ──

/**
 * Install a plugin from an npm registry package. Mirrors addSource: validate,
 * refuse duplicates, install, record state, then register in config.yaml — the
 * config keeps ONLY the spec the user typed (never a token, and never the
 * resolved version, which is runtime state).
 */
export async function addNpmSource(rawSpec: string): Promise<PluginSourceView> {
  const parsed = parseNpmSpec(rawSpec);
  if (!parsed) throw new Error(invalidSpecMessage());

  const slug = slugForNpmPackage(parsed.name);
  const dir = cloneDirFor(slug);
  const source: NpmPluginSourceConfig = { type: 'npm', spec: parsed.spec, enabled: true };
  return withSourceLock(slug, async () => {
    const existing = (await getConfig()).plugin_sources ?? [];
    if (existing.some((item) => isNpmSourceConfig(item) && parseNpmSpec(item.spec)?.name === parsed.name)) {
      throw new Error('This package is already added.');
    }
    if (existing.some((item) => slugForSource(item) === slug) || await pathExists(dir)) {
      throw new Error(`A source with slug "${slug}" already exists. Remove it first.`);
    }

    await fsp.mkdir(PLUGIN_STORES_DIR, { recursive: true });
    await ensureStoresIgnored();
    let installedOnDisk = false;
    let state: Record<string, PluginSourceState> | undefined;
    try {
      const installed = await installNpmPlugin({
        spec: parsed.spec,
        finalDir: dir,
        stagingRoot: PLUGIN_STORES_DIR,
      });
      installedOnDisk = true;
      state = await updateState((current) => {
        current[slug] = {
          type: 'npm',
          spec: parsed.spec,
          packageName: installed.name,
          version: installed.version,
          resolved: installed.resolved,
          ...(installed.integrity ? { integrity: installed.integrity } : {}),
          lastSyncedAt: new Date().toISOString(),
        };
      });
      await mutateConfiguredSources((current) => {
        if (current.some((item) => isNpmSourceConfig(item) && parseNpmSpec(item.spec)?.name === parsed.name)) {
          throw new Error('This package is already added.');
        }
        if (current.some((item) => slugForSource(item) === slug)) {
          throw new Error(`A source with slug "${slug}" is already configured.`);
        }
        return [...current, source];
      });
      log.info('npm plugin source added', { slug, resolved: installed.resolved });
    } catch (error) {
      if (installedOnDisk) await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      await updateState((current) => { delete current[slug]; }).catch(() => undefined);
      throw error;
    }
    return buildView(slug, source, state![slug]);
  });
}

export interface UpdateResult {
  updated: boolean;
  /** git */
  fromSha?: string;
  toSha?: string;
  /** npm */
  fromResolved?: string;
  resolved?: string;
  integrity?: string;
  error?: string;
}

/**
 * Re-resolve and reinstall an npm source. Nothing else re-resolves — a tag only
 * moves when the user asks. When the registry still points at the same
 * version AND the same integrity, this is a no-op (no download, no swap).
 */
async function updateNpmSource(slug: string, spec: string): Promise<UpdateResult> {
  const dir = cloneDirFor(slug);
  const previous = (await readState())[slug];
  const fromResolved = previous?.resolved;
  try {
    const resolved = await resolveNpmSpecIsolated(spec, PLUGIN_STORES_DIR);
    const sameVersion = fromResolved === resolved.resolved;
    const sameIntegrity = previous?.integrity === resolved.integrity;
    if (sameVersion && sameIntegrity && await pathExists(dir)) {
      await updateState((state) => {
        const row = (state[slug] ??= {
          type: 'npm',
          spec,
          packageName: resolved.name,
          version: resolved.version,
          resolved: resolved.resolved,
        });
        row.lastSyncedAt = new Date().toISOString();
        delete row.lastError;
      });
      return { updated: false, fromResolved, resolved: resolved.resolved, integrity: resolved.integrity };
    }

    const installed = await replaceNpmPlugin({
      spec,
      finalDir: dir,
      stagingRoot: PLUGIN_STORES_DIR,
      resolved,
      commit: async (next) => {
        await updateState((state) => {
          state[slug] = {
            ...(state[slug] ?? previous ?? {}),
            type: 'npm',
            spec,
            packageName: next.name,
            version: next.version,
            resolved: next.resolved,
            integrity: next.integrity,
            lastSyncedAt: new Date().toISOString(),
          };
          delete state[slug].lastError;
        });
      },
    });
    log.info('npm plugin source updated', { slug, fromResolved, resolved: installed.resolved });
    return { updated: true, fromResolved, resolved: installed.resolved, integrity: installed.integrity };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateState((state) => {
      const row = (state[slug] ??= { type: 'npm', spec });
      row.lastError = message;
    }).catch((stateError) => {
      log.error('could not record npm Plugin source update error', { slug, error: String(stateError) });
    });
    log.warn('npm plugin source update failed', { slug, error: message });
    return { updated: false, fromResolved, resolved: fromResolved, error: message };
  }
}

/** Which config entry owns a slug (both kinds). Ambiguity is never guessed. */
async function findSourceBySlug(slug: string): Promise<PluginSourceConfig | undefined> {
  if (!isValidSlug(slug)) throw new Error('Invalid source slug.');
  const config = await getConfig();
  const matches = (config.plugin_sources ?? []).filter((source) => slugForSource(source) === slug);
  if (matches.length > 1) throw new Error(`Multiple Plugin sources use slug "${slug}". Fix config.yaml before continuing.`);
  return matches[0];
}

export async function updateSource(slug: string): Promise<UpdateResult> {
  if (!isValidSlug(slug)) throw new Error('Invalid source slug.');
  return withSourceLock(slug, async () => {
    const source = await findSourceBySlug(slug);
    if (!source) throw new Error(`Plugin source "${slug}" was not found.`);
    if (isNpmSourceConfig(source)) return updateNpmSource(slug, source.spec);

    const dir = cloneDirFor(slug);
    let fromSha: string | undefined;
    try {
      if (!(await pathExists(dir))) {
        await fsp.mkdir(PLUGIN_STORES_DIR, { recursive: true });
        await ensureStoresIgnored();
        await cloneGitSource(source.url, source.ref, slug, dir);
        hardenGitConfigPerms(source.url, dir);
        const toSha = await currentSha(dir);
        await updateState((state) => {
          state[slug] = {
            url: source.url,
            ref: source.ref,
            lastSha: toSha,
            lastSyncedAt: new Date().toISOString(),
          };
        });
        log.info('plugin source restored', { slug, url: maskSourceUrl(source.url), toSha });
        return { updated: true, toSha };
      }

      fromSha = await currentSha(dir);
      await runSourceGit(['pull', '--ff-only'], dir, source.url);
      const toSha = await currentSha(dir);
      await updateState((state) => {
        const row = (state[slug] ??= { url: source.url, ref: source.ref });
        row.url = source.url;
        row.ref = source.ref;
        row.lastSha = toSha;
        row.lastSyncedAt = new Date().toISOString();
        delete row.lastError;
      });
      log.info('plugin source updated', { slug, fromSha, toSha });
      return { updated: fromSha !== toSha, fromSha, toSha };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updateState((state) => {
        const row = (state[slug] ??= { url: source.url, ref: source.ref });
        row.lastError = message;
      }).catch((stateError) => {
        log.error('could not record Plugin source update error', { slug, error: String(stateError) });
      });
      log.warn('plugin source update failed', { slug, error: message });
      return { updated: false, fromSha, toSha: fromSha, error: message };
    }
  });
}

export interface CheckResult {
  /** git: commits behind upstream. npm: 0 or 1 — a registry has no commit count,
   *  so "a newer version exists" is expressed as 1 and the detail rides
   *  updateAvailable/resolved. Keeping the field means old clients still work. */
  behind: number;
  updateAvailable?: boolean;
  /** npm: the version the registry would install right now. */
  resolved?: string;
  error?: string;
}

/**
 * "Is there something newer?" without touching the installed tree.
 * git: fetch + count commits behind. npm: re-resolve the spec and compare.
 */
export async function checkSource(slug: string): Promise<CheckResult> {
  if (!isValidSlug(slug)) throw new Error('Invalid source slug.');
  return withSourceLock(slug, async () => {
    const source = await findSourceBySlug(slug);
    if (!source) throw new Error(`Plugin source "${slug}" was not found.`);
    if (isNpmSourceConfig(source)) {
      const state = await readState();
      try {
        const resolved = await resolveNpmSpecIsolated(source.spec, PLUGIN_STORES_DIR);
        const current = state[slug];
        const changed = !current?.resolved
          || current.resolved !== resolved.resolved
          || current.integrity !== resolved.integrity;
        return { behind: changed ? 1 : 0, updateAvailable: changed, resolved: resolved.resolved };
      } catch (error) {
        return { behind: 0, updateAvailable: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    const dir = cloneDirFor(slug);
    try {
      await assertGitCheckout(dir);
      await runSourceGit(['fetch'], dir, source.url);
      const behind = await runSourceGit(['rev-list', '--count', 'HEAD..@{upstream}'], dir);
      const count = parseInt(behind, 10) || 0;
      return { behind: count, updateAvailable: count > 0 };
    } catch (error) {
      return { behind: 0, updateAvailable: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

export async function removeSource(slug: string): Promise<void> {
  if (!isValidSlug(slug)) throw new Error('Invalid source slug.');
  return withSourceLock(slug, async () => {
    const source = await findSourceBySlug(slug);
    if (!source) throw new Error(`Plugin source "${slug}" was not found.`);

    const dir = cloneDirFor(slug);
    await fsp.rm(dir, { recursive: true, force: true });
    await mutateConfiguredSources((current) => current.filter((item) => slugForSource(item) !== slug));
    await updateState((state) => { delete state[slug]; }).catch((error) => {
      log.warn('could not remove stale Plugin source state', { slug, error: String(error) });
    });
    log.info('plugin source removed', { slug });
  });
}

async function buildView(
  slug: string,
  source: PluginSourceConfig,
  state: PluginSourceState | undefined,
): Promise<PluginSourceView> {
  const dir = cloneDirFor(slug);
  let cloned = false;
  try {
    cloned = (await fsp.stat(dir)).isDirectory();
  } catch { /* not installed */ }
  const plugins = cloned ? await scanStorePlugins(dir) : [];

  if (isNpmSourceConfig(source)) {
    // No share snippet for npm: the spec IS the shareable thing, and it is
    // already shown verbatim on the card.
    return {
      slug,
      kind: 'npm',
      type: 'npm',
      spec: source.spec,
      packageName: state?.packageName ?? parseNpmSpec(source.spec)?.name,
      version: state?.version,
      resolved: state?.resolved,
      integrity: state?.integrity,
      enabled: source.enabled !== false,
      cloned,
      lastSyncedAt: state?.lastSyncedAt,
      lastError: state?.lastError,
      plugins,
    };
  }

  const hasCredentials = /https?:\/\/[^/\s]+@/.test(source.url);
  return {
    slug,
    kind: 'git',
    url: maskSourceUrl(source.url),
    ref: source.ref,
    enabled: source.enabled !== false,
    cloned,
    lastSha: state?.lastSha,
    lastSyncedAt: state?.lastSyncedAt,
    lastError: state?.lastError,
    plugins,
    ...(hasCredentials ? {} : { shareSnippet: buildShareSnippet(source.url, source.ref) }),
  };
}

export async function listSources(): Promise<PluginSourceView[]> {
  const config = await getConfig();
  const state = await readState();
  const sources = config.plugin_sources ?? [];
  return Promise.all(sources.map(s => {
    const slug = slugForSource(s);
    return buildView(slug, s, state[slug]);
  }));
}
