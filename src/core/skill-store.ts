/**
 * Skill store — CRUD operations for skills + enable/disable persistence.
 *
 * Reuses skill-loader.ts for discovery, parsing, and eligibility checks.
 * Adds write operations and a settings file for tracking disabled skills.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { GLOBAL_SKILLS_DIR, CLAUDE_SKILLS_DIR, BUILTIN_SKILLS_DIR, SKILL_SETTINGS_FILE } from '../constants.js';
import { SHIPPED_SKILL_READ_ONLY_DELETE, SHIPPED_SKILL_READ_ONLY_EDIT } from './skill-errors.js';
import {
  discoverSkills,
  getSearchDirs,
  getPluginSkillDirs,
  parseFrontmatter,
  isEligible,
  clearSkillsCache,
  getSkillsCacheGeneration,
  normalizeSkillType,
  type DiscoveredSkill,
  type SkillType,
  resolveSkillDirName,
  expandDisabledSkillNames,
  LEGACY_SKILL_DIR_ALIASES,
} from './skill-loader.js';

/** Where a skill's directory lives. One union, so the field and the resolver can't drift. */
export type SkillSource = 'workspace' | 'walnut' | 'claude' | 'plugin';

export interface SkillInfo {
  dirName: string;
  name: string;
  description: string;
  source: SkillSource;
  location: string;
  content: string;
  /** Grouping category (directory under the skills root, or frontmatter override). */
  category: string;
  /** action = procedure/how-to; knowledge = curated domain facts. */
  type: SkillType;
  metadata?: Record<string, unknown>;
  eligible: boolean;
  enabled: boolean;
  hasReferences: boolean;
}

interface SkillSettings {
  disabled: string[];
}

// ─── settings persistence ──────────────────────────────────────────

async function readSettings(): Promise<SkillSettings> {
  try {
    const raw = await fsp.readFile(SKILL_SETTINGS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.disabled)) return parsed as SkillSettings;
  } catch {
    // file doesn't exist or invalid — defaults
  }
  return { disabled: [] };
}

async function writeSettings(settings: SkillSettings): Promise<void> {
  await fsp.mkdir(path.dirname(SKILL_SETTINGS_FILE), { recursive: true });
  await fsp.writeFile(SKILL_SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
}

// ─── source resolution ─────────────────────────────────────────────

/** Canonicalize a path for comparison (resolves symlinks, e.g. /var → /private/var on macOS). */
function canonical(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

async function canonicalAsync(p: string): Promise<string> {
  try {
    return await fsp.realpath(p);
  } catch {
    return p;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Canonical skill roots in match order. Resolved once per call, never once per skill. */
interface SourceRoots {
  walnut: string;
  builtin: string;
  claude: string;
  workspace: string;
  plugin: string[];
}

async function loadSourceRoots(): Promise<SourceRoots> {
  const [walnut, builtin, claude, workspace, plugin] = await Promise.all([
    canonicalAsync(GLOBAL_SKILLS_DIR),
    canonicalAsync(BUILTIN_SKILLS_DIR),
    canonicalAsync(CLAUDE_SKILLS_DIR),
    canonicalAsync(path.resolve('skills')),
    Promise.all(getPluginSkillDirs().map(canonicalAsync)),
  ]);
  return { walnut, builtin, claude, workspace, plugin };
}

async function resolveSource(skillDir: string, roots?: SourceRoots): Promise<SkillSource> {
  const [dir, r] = await Promise.all([canonicalAsync(skillDir), roots ?? loadSourceRoots()]);
  const under = (root: string) => dir.startsWith(root + path.sep);
  // Specific roots first — path.resolve('skills') is cwd-relative and can
  // coincide with the walnut global dir, so the workspace check goes LAST.
  if (under(r.walnut)) return 'walnut';
  if (under(r.builtin)) return 'walnut';
  if (under(r.claude)) return 'claude';
  if (under(r.workspace)) return 'workspace';
  // Plugin-contributed roots (manifest `<pluginDir>/skills` + every directory a
  // plugin registered through `registry.skill`) BEFORE the fallback: without this
  // a plugin's skill is reported as living in the user's own Claude store, and the
  // Settings page offers to edit a file the plugin overwrites on its next update.
  // Empty list on a plugin-free install, so this costs nothing there.
  if (r.plugin.some(under)) return 'plugin';
  return 'claude';
}

// ─── shipped skills on a read-only install ─────────────────────────

/**
 * Shipped skills live in the running package (dist/data/skills). Where that is
 * read-only to the server (the cloud companion: root owns the code tree), an
 * edit or delete is refused with a readable 409 rather than failing on EACCES.
 * Deliberately no override copy in the walnut skills dir: that dir git-syncs to
 * the primary, where the copy would outrank the shipped skill and hide every
 * later release of it. A writable install edits the shipped file in place.
 */
function isShipped(skillDir: string): boolean {
  return canonical(skillDir).startsWith(canonical(BUILTIN_SKILLS_DIR) + path.sep);
}

function canWrite(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// ─── read operations ────────────────────────────────────────────────

/**
 * GET /api/skills runs on every page load and socket reconnect and answers with every
 * SKILL.md body. Discovery (readdir + one stat per skill) still runs per call, and its
 * SKILL.md mtimes and sizes key the built list, so an edit shows on the next call while
 * an unchanged tree is never re-read or re-parsed. The age cap covers inputs the key
 * cannot see: a binary appearing on PATH, a new references/ directory.
 */
const SKILL_LIST_MAX_AGE_MS = 60_000;

let skillListCache: { key: string; builtAt: number; skills: SkillInfo[] } | null = null;
let skillListBuild: { key: string; promise: Promise<SkillInfo[]> } | null = null;

/** Test hook: drop the built list. */
export function _resetSkillListCacheForTest(): void {
  skillListCache = null;
  skillListBuild = null;
}

function skillListKey(generation: number, dirs: string[], discovered: Map<string, DiscoveredSkill>): string {
  const parts: string[] = [String(generation), ...dirs];
  for (const [dirName, { file, mtimeMs, size }] of discovered) {
    parts.push(`${dirName}\0${file}\0${mtimeMs}\0${size}`);
  }
  return parts.join('\n');
}

async function buildSkillList(
  discovered: Map<string, DiscoveredSkill>,
  disabledSet: Set<string>,
): Promise<SkillInfo[]> {
  const roots = await loadSourceRoots();
  const built = await Promise.all([...discovered].map(async ([dirName, { dir, file, category }]): Promise<SkillInfo | null> => {
    let raw: string;
    try {
      raw = await fsp.readFile(file, 'utf-8');
    } catch {
      return null;
    }
    const { frontmatter } = parseFrontmatter(raw);
    const [source, eligible, hasReferences] = await Promise.all([
      resolveSource(dir, roots),
      isEligible(frontmatter),
      pathExists(path.join(dir, 'references')),
    ]);

    return {
      dirName,
      name: frontmatter.name ?? dirName,
      description: frontmatter.description ?? '',
      source,
      location: file,
      content: raw,
      category: frontmatter.category ?? category,
      type: normalizeSkillType(frontmatter.type),
      metadata: frontmatter.metadata,
      eligible,
      enabled: !disabledSet.has(dirName),
      hasReferences,
    };
  }));
  return built.filter((s): s is SkillInfo => s !== null);
}

export async function listAllSkills(): Promise<SkillInfo[]> {
  const generation = getSkillsCacheGeneration();
  const dirs = getSearchDirs();
  const [discovered, settings] = await Promise.all([discoverSkills(dirs), readSettings()]);
  const disabledSet = expandDisabledSkillNames(settings.disabled);
  const key = skillListKey(generation, dirs, discovered);
  const startedAt = Date.now();

  let skills: SkillInfo[];
  if (skillListCache && skillListCache.key === key && startedAt - skillListCache.builtAt < SKILL_LIST_MAX_AGE_MS) {
    skills = skillListCache.skills;
  } else {
    // Concurrent callers with the same key share one build.
    if (!skillListBuild || skillListBuild.key !== key) {
      const promise: Promise<SkillInfo[]> = buildSkillList(discovered, disabledSet)
        .then((built) => {
          skillListCache = { key, builtAt: startedAt, skills: built };
          return built;
        })
        .finally(() => {
          if (skillListBuild?.promise === promise) skillListBuild = null;
        });
      skillListBuild = { key, promise };
    }
    skills = await skillListBuild.promise;
  }

  // Fresh objects per call, and `enabled` from this call's settings read: the settings
  // file is not part of the key, and callers must not be able to edit the cache.
  return skills.map((s) => ({ ...s, enabled: !disabledSet.has(s.dirName) }));
}

export async function getSkill(requested: string): Promise<SkillInfo | null> {
  const dirs = getSearchDirs();
  const discovered = await discoverSkills(dirs);
  const dirName = resolveSkillDirName(requested, discovered);
  const entry = discovered.get(dirName);
  if (!entry) return null;

  let raw: string;
  try {
    raw = await fsp.readFile(entry.file, 'utf-8');
  } catch {
    return null;
  }

  const { frontmatter } = parseFrontmatter(raw);
  const [source, settings, eligible, hasReferences] = await Promise.all([
    resolveSource(entry.dir),
    readSettings(),
    isEligible(frontmatter),
    pathExists(path.join(entry.dir, 'references')),
  ]);

  return {
    dirName,
    name: frontmatter.name ?? dirName,
    description: frontmatter.description ?? '',
    source,
    location: entry.file,
    content: raw,
    category: frontmatter.category ?? entry.category,
    type: normalizeSkillType(frontmatter.type),
    metadata: frontmatter.metadata,
    eligible,
    enabled: !expandDisabledSkillNames(settings.disabled).has(dirName),
    hasReferences,
  };
}

// ─── write operations ───────────────────────────────────────────────

export async function createSkill(
  dirName: string,
  content: string,
  target: 'claude' | 'walnut' = 'claude',
  category?: string,
): Promise<SkillInfo> {
  // Validate dirName
  if (!dirName || !/^[a-zA-Z0-9_-]+$/.test(dirName)) {
    throw new Error('Invalid skill name: must be alphanumeric, hyphens, or underscores');
  }
  if (category && !/^[a-zA-Z0-9_-]+$/.test(category)) {
    throw new Error('Invalid category: must be alphanumeric, hyphens, or underscores');
  }

  // Check for conflicts across all directories (overview skills are keyed
  // <category>/overview in discovery — check under the same key).
  const conflictKey = dirName === 'overview' && category ? `${category}/overview` : dirName;
  const dirs = getSearchDirs();
  const discovered = await discoverSkills(dirs);
  if (discovered.has(conflictKey)) {
    throw new Error(`Skill already exists: ${conflictKey}`);
  }

  const baseDir = target === 'walnut' ? GLOBAL_SKILLS_DIR : CLAUDE_SKILLS_DIR;
  // Categorized layout: skills/<category>/<name>/SKILL.md; flat when no category.
  const skillDir = category
    ? path.join(baseDir, category, dirName)
    : path.join(baseDir, dirName);
  await fsp.mkdir(skillDir, { recursive: true });
  await fsp.writeFile(path.join(skillDir, 'SKILL.md'), content);

  clearSkillsCache();
  // Overview skills are keyed <category>/overview in discovery (the bare name
  // would collide across categories) — read back under the same key.
  const lookupKey = dirName === 'overview' && category ? `${category}/overview` : dirName;
  const skill = await getSkill(lookupKey);
  if (!skill) throw new Error('Failed to read created skill');
  return skill;
}

export async function updateSkill(requested: string, content: string): Promise<SkillInfo> {
  const dirs = getSearchDirs();
  const discovered = await discoverSkills(dirs);
  const dirName = resolveSkillDirName(requested, discovered);
  const entry = discovered.get(dirName);
  if (!entry) throw new Error(`Skill not found: ${dirName}`);

  const source = await resolveSource(entry.dir);
  if (source === 'workspace') {
    throw new Error('Cannot modify workspace skills');
  }
  // The owning plugin ships that directory and replaces it on its next update, so an
  // edit here is silently temporary. Both routers map "Cannot modify" to 403.
  if (source === 'plugin') {
    throw new Error('Cannot modify plugin skills');
  }

  if (isShipped(entry.dir) && !canWrite(entry.file)) {
    throw new Error(SHIPPED_SKILL_READ_ONLY_EDIT);
  }
  await fsp.writeFile(entry.file, content);
  clearSkillsCache();

  const skill = await getSkill(dirName);
  if (!skill) throw new Error('Failed to read updated skill');
  return skill;
}

export async function deleteSkill(requested: string): Promise<void> {
  const dirs = getSearchDirs();
  const discovered = await discoverSkills(dirs);
  const dirName = resolveSkillDirName(requested, discovered);
  const entry = discovered.get(dirName);
  if (!entry) throw new Error(`Skill not found: ${dirName}`);

  const source = await resolveSource(entry.dir);
  if (source === 'workspace') {
    throw new Error('Cannot delete workspace skills');
  }
  // This would rm -rf inside an installed plugin's own directory.
  if (source === 'plugin') {
    throw new Error('Cannot delete plugin skills');
  }

  if (isShipped(entry.dir) && !(canWrite(entry.dir) && canWrite(path.dirname(entry.dir)))) {
    throw new Error(SHIPPED_SKILL_READ_ONLY_DELETE);
  }

  await fsp.rm(entry.dir, { recursive: true, force: true });
  clearSkillsCache();
}

export async function setSkillEnabled(requested: string, enabled: boolean): Promise<SkillInfo> {
  // Validate skill exists BEFORE modifying settings
  const dirs = getSearchDirs();
  const discovered = await discoverSkills(dirs);
  const dirName = resolveSkillDirName(requested, discovered);
  if (!discovered.has(dirName)) {
    throw new Error(`Skill not found: ${dirName}`);
  }

  const settings = await readSettings();
  const disabledSet = new Set(settings.disabled);
  // Re-enabling a renamed skill must also drop the entry saved under its old name.
  const legacyNames = Object.entries(LEGACY_SKILL_DIR_ALIASES)
    .filter(([, renamed]) => renamed === dirName)
    .map(([legacy]) => legacy);

  if (enabled) {
    disabledSet.delete(dirName);
    for (const legacy of legacyNames) disabledSet.delete(legacy);
  } else {
    disabledSet.add(dirName);
  }

  settings.disabled = [...disabledSet].sort();
  await writeSettings(settings);
  clearSkillsCache();

  const skill = await getSkill(dirName);
  if (!skill) throw new Error(`Skill not found: ${dirName}`);
  return skill;
}

// ─── references ─────────────────────────────────────────────────────

export async function listReferences(requested: string): Promise<{ name: string; size: number }[]> {
  const dirs = getSearchDirs();
  const discovered = await discoverSkills(dirs);
  const dirName = resolveSkillDirName(requested, discovered);
  const entry = discovered.get(dirName);
  if (!entry) throw new Error(`Skill not found: ${dirName}`);

  const refsDir = path.join(entry.dir, 'references');
  let entries: string[];
  try {
    entries = await fsp.readdir(refsDir);
  } catch {
    return [];
  }

  const files: { name: string; size: number }[] = [];
  for (const name of entries) {
    try {
      const stat = await fsp.stat(path.join(refsDir, name));
      if (stat.isFile()) {
        files.push({ name, size: stat.size });
      }
    } catch {
      // skip unreadable entries
    }
  }
  return files;
}

export async function getReference(requested: string, filename: string): Promise<string> {
  // Path traversal guard
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    throw new Error('Invalid filename');
  }

  const dirs = getSearchDirs();
  const discovered = await discoverSkills(dirs);
  const dirName = resolveSkillDirName(requested, discovered);
  const entry = discovered.get(dirName);
  if (!entry) throw new Error(`Skill not found: ${dirName}`);

  const filePath = path.join(entry.dir, 'references', filename);
  return fsp.readFile(filePath, 'utf-8');
}

