/**
 * Plugin skill discovery: finds skills that ship inside Claude Code *plugins*,
 * which the flat skill-loader (~/.claude/skills/ etc.) never sees.
 *
 * Source of truth (NOT installed_plugins.json — its installPath/installLocation
 * point at /home/... cross-machine paths that don't exist on this box):
 *   1. ~/.claude/settings.json → enabledPlugins  ("<plugin>@<marketplace>": true)
 *   2. each marketplace's .claude-plugin/marketplace.json → plugin name → source dir
 *
 * Marketplace install locations:
 *   - directory marketplaces (e.g. aim): the directory path itself
 *   - github marketplaces:   ~/.claude/plugins/marketplaces/<marketplace>/
 *
 * A plugin's skills live at <plugin-dir>/skills/<skill>/SKILL.md.
 * Used only by the slash-command palette — NOT injected into the agent prompt.
 *
 * The discovery algorithm is reader-agnostic (see `discoverPluginSkills`): it runs
 * over a `SkillFs` abstraction so the SAME logic serves local disk (this file) and
 * a remote host over the daemon protocol (`remote-skill-loader.ts`).
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { log } from '../logging/index.js';
import { CLAUDE_SETTINGS_FILE, CLAUDE_PLUGINS_DIR } from '../constants.js';

export interface PluginSkillMeta {
  /** Skill directory name (e.g. "eks-investigate-ticket"). */
  dirName: string;
  name: string;
  description: string;
  location: string;
  /** "<plugin>@<marketplace>" — for debugging/attribution. */
  plugin: string;
}

interface MarketplacePlugin {
  name?: string;
  source?: string | { source?: string; path?: string };
}

interface MarketplaceManifest {
  plugins?: MarketplacePlugin[];
}

// ─── reader abstraction ─────────────────────────────────────────────

/**
 * Minimal filesystem surface the discovery algorithm needs. Implemented over
 * local `fs/promises` here, and over the daemon's fs.* protocol for remote hosts.
 * All methods are forgiving: read/list return null on any error (missing, perms).
 */
export interface SkillFs {
  /** Read a UTF-8 text file; null if missing/unreadable. */
  readText(p: string): Promise<string | null>;
  /** List directory entry names; null if not a directory / unreadable. */
  list(p: string): Promise<string[] | null>;
  /** True if the path is a directory. */
  isDir(p: string): Promise<boolean>;
  /** Join path segments (native locally, posix for remote). */
  join(...parts: string[]): string;
  /** Expand a leading "~" (local: to homedir; remote: identity — daemon expands). */
  expandHome(p: string): string;
}

/** Base paths the discovery needs — differ between local (absolute) and remote (~/…). */
export interface PluginDiscoveryConfig {
  /** Path to Claude Code's settings.json (holds enabledPlugins). */
  settingsFile: string;
  /** Path to Claude Code's plugins dir (holds known_marketplaces.json + marketplaces/). */
  pluginsDir: string;
}

// ─── reader-agnostic discovery core ─────────────────────────────────

/**
 * Bounded-concurrency map that preserves input order in the result.
 * The discovery core runs over a SkillFs whose remote implementation pays a
 * full daemon round-trip per read — sequential awaits made a ~200-skill host
 * take 12-22s per /api/slash-commands call (long enough to saturate the
 * browser's 6-per-origin connection pool). Pipelining the RTTs is the fix;
 * the bound keeps us from flooding one WS with hundreds of in-flight reads.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** In-flight read bound per discovery pass (per-host WS stays responsive). */
const SKILL_READ_CONCURRENCY = 16;

/** Read enabled plugin ids ("<plugin>@<marketplace>": true) from settings.json. */
async function readEnabledPlugins(fs: SkillFs, settingsFile: string): Promise<string[]> {
  const raw = await fs.readText(settingsFile);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as { enabledPlugins?: Record<string, boolean> };
    if (!parsed.enabledPlugins) return [];
    return Object.entries(parsed.enabledPlugins)
      .filter(([, on]) => on === true)
      .map(([id]) => id);
  } catch {
    return [];
  }
}

/** Map marketplace name → on-disk root directory. */
async function readMarketplaceRoots(
  fs: SkillFs,
  pluginsDir: string,
): Promise<Map<string, string>> {
  const roots = new Map<string, string>();
  const raw = await fs.readText(fs.join(pluginsDir, 'known_marketplaces.json'));
  if (raw === null) return roots;
  let parsed: { [k: string]: { source?: { source?: string; path?: string } } };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return roots;
  }

  for (const [name, entry] of Object.entries(parsed)) {
    const src = entry?.source;
    // Directory marketplaces point at a real local path (e.g. aim → ~/.aim/cc-plugins).
    // installLocation in the file is unreliable (cross-machine /home/...), so for
    // directory sources prefer source.path, and for github sources use the canonical
    // marketplaces/<name>/ checkout dir.
    if (src?.source === 'directory' && src.path) {
      roots.set(name, fs.expandHome(src.path));
    } else {
      roots.set(name, fs.join(pluginsDir, 'marketplaces', name));
    }
  }
  return roots;
}

/** Resolve a plugin's root directory via its marketplace manifest, else by convention. */
async function resolvePluginDir(
  fs: SkillFs,
  pluginName: string,
  marketplaceRoot: string,
): Promise<string | undefined> {
  // Try the marketplace manifest first — it maps plugin name → source subdir.
  const raw = await fs.readText(fs.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'));
  if (raw !== null) {
    try {
      const manifest = JSON.parse(raw) as MarketplaceManifest;
      const entry = manifest.plugins?.find((p) => p.name === pluginName);
      const src = entry?.source;
      const sub = typeof src === 'string' ? src : src?.path;
      if (sub) return fs.join(marketplaceRoot, sub);
    } catch {
      // unparsable manifest — fall through to convention
    }
  }

  // Fallbacks by convention: <root>/plugins/<plugin> (github) or <root>/<plugin> (directory).
  for (const candidate of [
    fs.join(marketplaceRoot, 'plugins', pluginName),
    fs.join(marketplaceRoot, pluginName),
  ]) {
    if (await fs.isDir(candidate)) return candidate;
  }
  return undefined;
}

/** Scan a single plugin's skills/ directory. */
async function scanPluginSkills(
  fs: SkillFs,
  pluginDir: string,
  pluginId: string,
): Promise<PluginSkillMeta[]> {
  const skillsDir = fs.join(pluginDir, 'skills');
  const entries = await fs.list(skillsDir);
  if (entries === null) return [];

  const metas = await mapLimit(entries, SKILL_READ_CONCURRENCY, async (entry) => {
    const file = fs.join(skillsDir, entry, 'SKILL.md');
    const raw = await fs.readText(file);
    if (raw === null) return null; // not a skill dir
    const meta = parseSkillMeta(raw);
    return {
      dirName: entry,
      name: meta.name ?? entry,
      description: meta.description ?? '',
      location: file,
      plugin: pluginId,
    };
  });
  return metas.filter((m): m is PluginSkillMeta => m !== null);
}

/**
 * Reader-agnostic plugin-skill discovery. Deduplicates by dirName
 * (first writer wins, matching enabledPlugins iteration order).
 */
export async function discoverPluginSkills(
  fs: SkillFs,
  cfg: PluginDiscoveryConfig,
): Promise<PluginSkillMeta[]> {
  const [enabled, roots] = await Promise.all([
    readEnabledPlugins(fs, cfg.settingsFile),
    readMarketplaceRoots(fs, cfg.pluginsDir),
  ]);

  // Scan plugins concurrently (mapLimit preserves order), then dedup
  // sequentially so "first writer wins" still follows enabledPlugins order.
  const perPlugin = await mapLimit(enabled, 4, async (pluginId): Promise<PluginSkillMeta[]> => {
    const at = pluginId.lastIndexOf('@');
    if (at < 0) return [];
    const pluginName = pluginId.slice(0, at);
    const marketplace = pluginId.slice(at + 1);
    const root = roots.get(marketplace);
    if (!root) return [];

    const pluginDir = await resolvePluginDir(fs, pluginName, root);
    if (!pluginDir) {
      log.task.debug('plugin-skill-loader: could not resolve plugin dir', {
        pluginId,
        marketplace,
        root,
      });
      return [];
    }
    return scanPluginSkills(fs, pluginDir, pluginId);
  });

  const seen = new Set<string>();
  const skills: PluginSkillMeta[] = [];
  for (const skill of perPlugin.flat()) {
    if (seen.has(skill.dirName)) continue;
    seen.add(skill.dirName);
    skills.push(skill);
  }

  return skills;
}

// ─── frontmatter parsing ────────────────────────────────────────────

/** Parse just the YAML frontmatter name/description from a SKILL.md (cheap, no yaml dep). */
function parseSkillMeta(raw: string): { name?: string; description?: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^(name|description):\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (m[1] === 'name') out.name = val;
    else out.description = val;
  }
  return out;
}

// ─── local filesystem reader ────────────────────────────────────────

function expandHomeLocal(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** SkillFs backed by local fs/promises. */
export const localSkillFs: SkillFs = {
  async readText(p) {
    try {
      return await fsp.readFile(p, 'utf-8');
    } catch {
      return null;
    }
  },
  async list(p) {
    try {
      return await fsp.readdir(p);
    } catch {
      return null;
    }
  },
  async isDir(p) {
    try {
      return (await fsp.stat(p)).isDirectory();
    } catch {
      return false;
    }
  },
  join: path.join,
  expandHome: expandHomeLocal,
};

// ─── local cache + public API ───────────────────────────────────────

let cached: PluginSkillMeta[] | undefined;

export function clearPluginSkillsCache(): void {
  cached = undefined;
}

/** Discover all skills from enabled Claude Code plugins on the LOCAL host. */
export async function listPluginSkills(): Promise<PluginSkillMeta[]> {
  if (cached !== undefined) return cached;
  cached = await discoverPluginSkills(localSkillFs, {
    settingsFile: CLAUDE_SETTINGS_FILE,
    pluginsDir: CLAUDE_PLUGINS_DIR,
  });
  return cached;
}

// Exported for testing
export { parseSkillMeta, expandHomeLocal };
