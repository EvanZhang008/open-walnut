/**
 * Plugin sources ("plugin store") — install plugins from git repos.
 *
 * A plugin source is any git repo whose root OR top-level subdirectories
 * contain a plugin manifest.json. Sources are configured in config.yaml
 * (`plugin_sources: [{url, ref?, enabled?}]`), cloned under
 * ~/.open-walnut/plugin-stores/<slug>/, and their plugin dirs are scanned by
 * the integration loader alongside ~/.open-walnut/plugins/.
 *
 * Runtime state (last synced SHA, errors) lives in
 * ~/.open-walnut/plugin-stores/sources.json — NOT in config.yaml, which stays
 * hand-editable. config.yaml is the source of truth for which sources exist.
 *
 * Trust model: adding a source is the consent step — plugins run in-process
 * with full privileges. No auto-pull: updates are explicit user actions so
 * remote code changes are always visible and attributable (SHA shown in UI).
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PLUGIN_STORES_DIR } from '../constants.js';
import { readJsonFile, writeJsonFile } from '../utils/fs.js';
import { getConfig, updateConfig } from './config-manager.js';
import { gitAsync, gitSafeAsync, hardenGitConfigPerms, isGitAvailable } from '../integrations/git-sync.js';
import { createSubsystemLogger } from '../logging/index.js';

const log = createSubsystemLogger('plugin-sources');

const SOURCES_STATE_FILE = path.join(PLUGIN_STORES_DIR, 'sources.json');
const CLONE_TIMEOUT = 120_000;

export interface PluginSourceConfig {
  url: string;
  ref?: string;
  enabled?: boolean;
}

export interface PluginSourceState {
  url: string;
  ref?: string;
  lastSha?: string;
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
  /** URL with any embedded credentials masked. */
  url: string;
  ref?: string;
  enabled: boolean;
  cloned: boolean;
  lastSha?: string;
  lastSyncedAt?: string;
  lastError?: string;
  plugins: DiscoveredStorePlugin[];
  /** Paste-able snippet for teammates ("Copy share snippet" button).
   *  Absent when the URL embeds credentials — never share those. */
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
  const slug = base.replace(/\.git$/i, '').toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  return slug || 'source';
}

const SLUG_RE = /^[a-z0-9._-]+$/;

/** Guard against path traversal — slugs come from API path params. */
export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && !slug.includes('..');
}

function cloneDirFor(slug: string): string {
  return path.join(PLUGIN_STORES_DIR, slug);
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
    if (!fs.existsSync(path.join(walnutHome, '.git'))) return; // not a git repo — nothing to protect
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

async function writeState(state: Record<string, PluginSourceState>): Promise<void> {
  await fsp.mkdir(PLUGIN_STORES_DIR, { recursive: true });
  await writeJsonFile(SOURCES_STATE_FILE, state);
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
    if (!entry.isDirectory() || entry.name === '.git') continue;
    const plugin = await readManifest(path.join(storeDir, entry.name));
    if (plugin) found.push(plugin);
  }
  return found;
}

/**
 * Plugin directories from all enabled, cloned sources — consumed by
 * discoverPluginDirs() in the integration loader.
 */
export async function getStorePluginDirs(): Promise<string[]> {
  const config = await getConfig();
  const sources = config.plugin_sources ?? [];
  const dirs: string[] = [];
  for (const source of sources) {
    if (source.enabled === false) continue;
    const dir = cloneDirFor(slugForUrl(source.url));
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue; // not cloned (yet)
    }
    const plugins = await scanStorePlugins(dir);
    dirs.push(...plugins.map(p => p.dir));
  }
  return dirs;
}

// ── Git helpers ──

/** Credential-helper guard for a URL we haven't cloned yet (credentialGuardArgs
 *  in git-sync.ts reads remotes of an EXISTING repo, so it can't cover clone). */
function cloneGuard(url: string): string {
  return /https?:\/\/[^/\s]+@/.test(url) ? '-c credential.helper= ' : '';
}

async function currentSha(dir: string): Promise<string | undefined> {
  return (await gitSafeAsync('rev-parse HEAD', { cwd: dir })) ?? undefined;
}

// ── Source lifecycle ──

export async function addSource(url: string, ref?: string): Promise<PluginSourceView> {
  if (!isValidSourceUrl(url)) {
    throw new Error('Invalid git URL. Expected https://, ssh://, git@host:path, or file:// with no spaces or shell characters.');
  }
  if (!isGitAvailable()) {
    throw new Error('git is not available on this machine.');
  }

  const config = await getConfig();
  const existing = config.plugin_sources ?? [];
  if (existing.some(s => s.url === url)) {
    throw new Error('This source is already added.');
  }

  const slug = slugForUrl(url);
  const dir = cloneDirFor(slug);
  try {
    if (fs.statSync(dir).isDirectory()) {
      throw new Error(`A source with slug "${slug}" already exists. Remove it first or use a differently named repo.`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) throw err;
    // ENOENT — good, dir is free
  }

  await fsp.mkdir(PLUGIN_STORES_DIR, { recursive: true });
  await ensureStoresIgnored();
  const refArg = ref ? `--branch ${ref} ` : '';
  try {
    await gitAsync(`${cloneGuard(url)}clone --depth 1 ${refArg}${url} ${dir}`, {
      cwd: PLUGIN_STORES_DIR,
      timeout: CLONE_TIMEOUT,
    });
  } catch (err) {
    // Clean up partial clone so a retry isn't blocked by a half-written dir
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`git clone failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  hardenGitConfigPerms(url, dir);

  const sha = await currentSha(dir);
  const state = await readState();
  state[slug] = { url, ref, lastSha: sha, lastSyncedAt: new Date().toISOString() };
  await writeState(state);

  await updateConfig({
    plugin_sources: [...existing, { url, ...(ref ? { ref } : {}), enabled: true }],
  });

  log.info('plugin source added', { slug, url: maskSourceUrl(url), sha });
  return buildView(slug, { url, ref, enabled: true }, state[slug]);
}

export interface UpdateResult {
  updated: boolean;
  fromSha?: string;
  toSha?: string;
  error?: string;
}

export async function updateSource(slug: string): Promise<UpdateResult> {
  const dir = cloneDirFor(slug);
  const fromSha = await currentSha(dir);
  const state = await readState();
  try {
    await gitAsync('pull --ff-only', { cwd: dir, timeout: CLONE_TIMEOUT });
    const toSha = await currentSha(dir);
    if (state[slug]) {
      state[slug].lastSha = toSha;
      state[slug].lastSyncedAt = new Date().toISOString();
      delete state[slug].lastError;
      await writeState(state);
    }
    log.info('plugin source updated', { slug, fromSha, toSha });
    return { updated: fromSha !== toSha, fromSha, toSha };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (state[slug]) {
      state[slug].lastError = message;
      await writeState(state);
    }
    log.warn('plugin source update failed', { slug, error: message });
    return { updated: false, fromSha, toSha: fromSha, error: message };
  }
}

/** git fetch + count commits behind the remote — no working-tree change. */
export async function checkSource(slug: string): Promise<{ behind: number; error?: string }> {
  const dir = cloneDirFor(slug);
  try {
    await gitAsync('fetch', { cwd: dir, timeout: CLONE_TIMEOUT });
    const behind = await gitSafeAsync('rev-list --count HEAD..@{upstream}', { cwd: dir });
    return { behind: behind ? parseInt(behind, 10) || 0 : 0 };
  } catch (err) {
    return { behind: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function removeSource(slug: string): Promise<void> {
  const dir = cloneDirFor(slug);

  const config = await getConfig();
  const remaining = (config.plugin_sources ?? []).filter(s => slugForUrl(s.url) !== slug);
  await updateConfig({ plugin_sources: remaining });

  const state = await readState();
  if (state[slug]) {
    delete state[slug];
    await writeState(state);
  }

  await fsp.rm(dir, { recursive: true, force: true });
  log.info('plugin source removed', { slug });
}

async function buildView(
  slug: string,
  source: PluginSourceConfig,
  state: PluginSourceState | undefined,
): Promise<PluginSourceView> {
  const dir = cloneDirFor(slug);
  let cloned = false;
  try {
    cloned = fs.statSync(dir).isDirectory();
  } catch { /* not cloned */ }
  const hasCredentials = /https?:\/\/[^/\s]+@/.test(source.url);
  return {
    slug,
    url: maskSourceUrl(source.url),
    ref: source.ref,
    enabled: source.enabled !== false,
    cloned,
    lastSha: state?.lastSha,
    lastSyncedAt: state?.lastSyncedAt,
    lastError: state?.lastError,
    plugins: cloned ? await scanStorePlugins(dir) : [],
    ...(hasCredentials ? {} : { shareSnippet: buildShareSnippet(source.url, source.ref) }),
  };
}

export async function listSources(): Promise<PluginSourceView[]> {
  const config = await getConfig();
  const state = await readState();
  const sources = config.plugin_sources ?? [];
  return Promise.all(sources.map(s => buildView(slugForUrl(s.url), s, state[slugForUrl(s.url)])));
}
