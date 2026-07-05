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
import {
  discoverSkills,
  getSearchDirs,
  parseFrontmatter,
  isEligible,
  clearSkillsCache,
  normalizeSkillType,
  type SkillType,
} from './skill-loader.js';

export interface SkillInfo {
  dirName: string;
  name: string;
  description: string;
  source: 'workspace' | 'walnut' | 'claude';
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

function resolveSource(skillDir: string): 'workspace' | 'walnut' | 'claude' {
  const dir = canonical(skillDir);
  // Specific roots first — path.resolve('skills') is cwd-relative and can
  // coincide with the walnut global dir, so the workspace check goes LAST.
  if (dir.startsWith(canonical(GLOBAL_SKILLS_DIR) + path.sep)) return 'walnut';
  if (dir.startsWith(canonical(BUILTIN_SKILLS_DIR) + path.sep)) return 'walnut';
  if (dir.startsWith(canonical(CLAUDE_SKILLS_DIR) + path.sep)) return 'claude';
  if (dir.startsWith(canonical(path.resolve('skills')) + path.sep)) return 'workspace';
  return 'claude';
}

// ─── read operations ────────────────────────────────────────────────

export async function listAllSkills(): Promise<SkillInfo[]> {
  const dirs = getSearchDirs();
  const discovered = await discoverSkills(dirs);
  const settings = await readSettings();
  const disabledSet = new Set(settings.disabled);
  const skills: SkillInfo[] = [];

  for (const [dirName, { dir, file, category }] of discovered) {
    let raw: string;
    try {
      raw = await fsp.readFile(file, 'utf-8');
    } catch {
      continue;
    }
    const { frontmatter } = parseFrontmatter(raw);
    const source = resolveSource(dir);
    const eligible = isEligible(frontmatter);
    const hasReferences = fs.existsSync(path.join(dir, 'references'));

    skills.push({
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
    });
  }

  return skills;
}

export async function getSkill(dirName: string): Promise<SkillInfo | null> {
  const dirs = getSearchDirs();
  const discovered = await discoverSkills(dirs);
  const entry = discovered.get(dirName);
  if (!entry) return null;

  let raw: string;
  try {
    raw = await fsp.readFile(entry.file, 'utf-8');
  } catch {
    return null;
  }

  const { frontmatter } = parseFrontmatter(raw);
  const source = resolveSource(entry.dir);
  const settings = await readSettings();

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
    eligible: isEligible(frontmatter),
    enabled: !settings.disabled.includes(dirName),
    hasReferences: fs.existsSync(path.join(entry.dir, 'references')),
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

  // Check for conflicts across all directories
  const dirs = getSearchDirs();
  const discovered = await discoverSkills(dirs);
  if (discovered.has(dirName)) {
    throw new Error(`Skill already exists: ${dirName}`);
  }

  const baseDir = target === 'walnut' ? GLOBAL_SKILLS_DIR : CLAUDE_SKILLS_DIR;
  // Categorized layout: skills/<category>/<name>/SKILL.md; flat when no category.
  const skillDir = category
    ? path.join(baseDir, category, dirName)
    : path.join(baseDir, dirName);
  await fsp.mkdir(skillDir, { recursive: true });
  await fsp.writeFile(path.join(skillDir, 'SKILL.md'), content);

  clearSkillsCache();
  const skill = await getSkill(dirName);
  if (!skill) throw new Error('Failed to read created skill');
  return skill;
}

export async function updateSkill(dirName: string, content: string): Promise<SkillInfo> {
  const dirs = getSearchDirs();
  const discovered = await discoverSkills(dirs);
  const entry = discovered.get(dirName);
  if (!entry) throw new Error(`Skill not found: ${dirName}`);

  const source = resolveSource(entry.dir);
  if (source === 'workspace') {
    throw new Error('Cannot modify workspace skills');
  }

  await fsp.writeFile(entry.file, content);
  clearSkillsCache();

  const skill = await getSkill(dirName);
  if (!skill) throw new Error('Failed to read updated skill');
  return skill;
}

export async function deleteSkill(dirName: string): Promise<void> {
  const dirs = getSearchDirs();
  const discovered = await discoverSkills(dirs);
  const entry = discovered.get(dirName);
  if (!entry) throw new Error(`Skill not found: ${dirName}`);

  const source = resolveSource(entry.dir);
  if (source === 'workspace') {
    throw new Error('Cannot delete workspace skills');
  }

  await fsp.rm(entry.dir, { recursive: true, force: true });
  clearSkillsCache();
}

export async function setSkillEnabled(dirName: string, enabled: boolean): Promise<SkillInfo> {
  // Validate skill exists BEFORE modifying settings
  const dirs = getSearchDirs();
  const discovered = await discoverSkills(dirs);
  if (!discovered.has(dirName)) {
    throw new Error(`Skill not found: ${dirName}`);
  }

  const settings = await readSettings();
  const disabledSet = new Set(settings.disabled);

  if (enabled) {
    disabledSet.delete(dirName);
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

export async function listReferences(dirName: string): Promise<{ name: string; size: number }[]> {
  const dirs = getSearchDirs();
  const discovered = await discoverSkills(dirs);
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

export async function getReference(dirName: string, filename: string): Promise<string> {
  // Path traversal guard
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    throw new Error('Invalid filename');
  }

  const dirs = getSearchDirs();
  const discovered = await discoverSkills(dirs);
  const entry = discovered.get(dirName);
  if (!entry) throw new Error(`Skill not found: ${dirName}`);

  const filePath = path.join(entry.dir, 'references', filename);
  return fsp.readFile(filePath, 'utf-8');
}

