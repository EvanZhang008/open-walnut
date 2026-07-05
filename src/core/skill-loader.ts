/**
 * Skill loader: discovers SKILL.md files, parses frontmatter, filters by eligibility,
 * and formats the prompt section for injection into the agent system prompt.
 *
 * Load sources (highest priority first):
 *   ./skills/              — workspace-local
 *   ~/.open-walnut/skills/       — walnut global
 *   ~/.claude/skills/      — claude skills (shared across tools)
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { log } from '../logging/index.js';
import { GLOBAL_SKILLS_DIR, CLAUDE_SKILLS_DIR, BUILTIN_SKILLS_DIR, SKILL_SETTINGS_FILE } from '../constants.js';

export type SkillType = 'action' | 'knowledge';

export interface SkillMeta {
  name: string;
  description: string;
  location: string;
  /** Grouping category (subdirectory under the skills root). 'general' for flat skills. */
  category: string;
  /** action = reusable procedure/how-to; knowledge = curated domain facts. Default: action. */
  type: SkillType;
  metadata?: Record<string, unknown>;
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  category?: string;
  type?: string;
  metadata?: {
    openclaw?: {
      emoji?: string;
      requires?: {
        bins?: string[];
        env?: string[];
        platform?: string[];
        os?: string[];
      };
    };
    [key: string]: unknown;
  };
}

// ─── discovery ──────────────────────────────────────────────────────

function getSearchDirs(): string[] {
  return [
    path.resolve('skills'),       // workspace-local (highest priority)
    GLOBAL_SKILLS_DIR,            // ~/.open-walnut/skills/
    BUILTIN_SKILLS_DIR,           // dist/data/skills/ (shipped with walnut)
    CLAUDE_SKILLS_DIR,            // ~/.claude/skills/
  ];
}

export interface DiscoveredSkill {
  dir: string;
  file: string;
  /** Category from the directory layout: skills/<category>/<name>/SKILL.md. 'general' for flat skills. */
  category: string;
}

async function discoverSkills(dirs: string[]): Promise<Map<string, DiscoveredSkill>> {
  const found = new Map<string, DiscoveredSkill>();
  for (const base of dirs) {
    let entries: string[];
    try {
      entries = await fsp.readdir(base);
    } catch (err) {
      log.task.debug('skill-loader: skills directory not found', {
        dir: base,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    for (const entry of entries) {
      const entryDir = path.join(base, entry);
      const skillFile = path.join(entryDir, 'SKILL.md');
      let isFlatSkill = false;
      try {
        isFlatSkill = (await fsp.stat(skillFile)).isFile();
      } catch {
        // no SKILL.md directly — may be a category directory (checked below)
      }

      if (isFlatSkill) {
        // Flat layout: skills/<name>/SKILL.md (back-compat)
        if (!found.has(entry)) {
          found.set(entry, { dir: entryDir, file: skillFile, category: 'general' });
        }
        continue;
      }

      // Category layout: skills/<category>/<name>/SKILL.md
      let subEntries: string[];
      try {
        subEntries = await fsp.readdir(entryDir);
      } catch {
        continue; // not a directory — skip
      }
      for (const sub of subEntries) {
        if (found.has(sub)) continue; // higher-priority source already registered
        const subFile = path.join(entryDir, sub, 'SKILL.md');
        try {
          if ((await fsp.stat(subFile)).isFile()) {
            found.set(sub, { dir: path.join(entryDir, sub), file: subFile, category: entry });
          }
        } catch {
          // no SKILL.md in this subdir — expected
        }
      }
    }
  }
  return found;
}

// ─── parsing ────────────────────────────────────────────────────────

function parseFrontmatter(raw: string): { frontmatter: SkillFrontmatter; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { frontmatter: {}, body: raw };
  const fmText = match[1];
  const body = raw.slice(match[0].length).trim();
  let frontmatter: SkillFrontmatter;
  try {
    frontmatter = (yaml.load(fmText) as SkillFrontmatter) ?? {};
  } catch (err) {
    log.task.warn('skill-loader: failed to parse YAML frontmatter', {
      error: err instanceof Error ? err.message : String(err),
    });
    frontmatter = {};
  }
  return { frontmatter, body };
}

// ─── eligibility ────────────────────────────────────────────────────

function hasBin(name: string): boolean {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;  // binary not found — expected for eligibility filtering
  }
}

function isEligible(fm: SkillFrontmatter): boolean {
  const req = fm.metadata?.openclaw?.requires;
  if (!req) return true;

  if (req.bins) {
    for (const bin of req.bins) {
      if (!hasBin(bin)) return false;
    }
  }

  if (req.env) {
    for (const envVar of req.env) {
      if (!process.env[envVar]) return false;
    }
  }

  const platform = process.platform;
  const allowed = req.platform ?? req.os;
  if (allowed && allowed.length > 0) {
    const normalised = allowed.map((p) => p.toLowerCase());
    if (!normalised.includes(platform)) return false;
  }

  return true;
}

/** Normalize the frontmatter `type` field. Anything but 'knowledge' → 'action'. */
export function normalizeSkillType(raw?: string): SkillType {
  return raw === 'knowledge' ? 'knowledge' : 'action';
}

// ─── prompt formatting ──────────────────────────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatSkillsPrompt(skills: SkillMeta[]): string {
  if (skills.length === 0) return '';

  const preamble = `## Skills (mandatory)
Before replying: scan ALL <available_skills> <description> entries — this scan is not optional.
- Skills come in two types: **action** (procedures/how-tos to follow) and **knowledge** (curated domain facts to consult).
- If any skill might apply, ERR ON THE SIDE OF LOADING IT: read its SKILL.md at <location> (skill_view or read). Loading an unneeded skill is cheap; missing a needed one causes wrong answers.
- Multiple relevant skills? Load each relevant one — knowledge skills especially are meant to be consulted together.
- Only skip loading when you are confident none apply.`;

  // Group by category so the index stays scannable as the skill count grows.
  const byCategory = new Map<string, SkillMeta[]>();
  for (const s of skills) {
    const cat = s.category || 'general';
    let bucket = byCategory.get(cat);
    if (!bucket) {
      bucket = [];
      byCategory.set(cat, bucket);
    }
    bucket.push(s);
  }

  const groups = [...byCategory.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, group]) => {
      const entries = group
        .map(
          (s) =>
            `    <skill>\n      <name>${escapeXml(s.name)}</name>\n      <type>${escapeXml(s.type)}</type>\n      <description>${escapeXml(s.description)}</description>\n      <location>${escapeXml(s.location)}</location>\n    </skill>`,
        )
        .join('\n');
      return `  <category name="${escapeXml(category)}">\n${entries}\n  </category>`;
    })
    .join('\n');

  return `${preamble}\n\n<available_skills>\n${groups}\n</available_skills>`;
}

// ─── cache + public API ─────────────────────────────────────────────

let cachedPrompt: string | undefined;
let cachedSkills: (SkillMeta & { dirName: string })[] | undefined;

export function clearSkillsCache(): void {
  cachedPrompt = undefined;
  cachedSkills = undefined;
}

/** Read the set of disabled skill dirNames from skill-settings.json. */
async function getDisabledSkillSet(): Promise<Set<string>> {
  try {
    const raw = await fsp.readFile(SKILL_SETTINGS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.disabled)) return new Set(parsed.disabled);
  } catch {
    // file doesn't exist or invalid — all skills enabled
  }
  return new Set();
}

/** Discover and cache all eligible skills with their directory names. */
async function getEligibleSkills(): Promise<(SkillMeta & { dirName: string })[]> {
  if (cachedSkills !== undefined) return cachedSkills;

  const dirs = getSearchDirs();
  const discovered = await discoverSkills(dirs);
  const disabledSet = await getDisabledSkillSet();
  const skills: (SkillMeta & { dirName: string })[] = [];

  for (const [dirName, { file, category }] of discovered) {
    let raw: string;
    try {
      raw = await fsp.readFile(file, 'utf-8');
    } catch (err) {
      log.task.debug('skill-loader: failed to read skill file', {
        file,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const { frontmatter } = parseFrontmatter(raw);
    if (!isEligible(frontmatter)) continue;
    if (disabledSet.has(dirName)) continue;

    skills.push({
      dirName,
      name: frontmatter.name ?? dirName,
      description: frontmatter.description ?? '',
      location: file,
      category: frontmatter.category ?? category,
      type: normalizeSkillType(frontmatter.type),
      metadata: frontmatter.metadata,
    });
  }

  cachedSkills = skills;
  return skills;
}

export async function buildSkillsPrompt(): Promise<string> {
  if (cachedPrompt !== undefined) return cachedPrompt;
  const skills = await getEligibleSkills();
  cachedPrompt = formatSkillsPrompt(skills);
  return cachedPrompt;
}

/** List all eligible skills with dirName, name, and description (for UI/API). */
export async function listAvailableSkills(): Promise<(SkillMeta & { dirName: string })[]> {
  return getEligibleSkills();
}

/** Build skills prompt filtered to only the specified skill directory names. */
export async function buildFilteredSkillsPrompt(skillDirNames: string[]): Promise<string> {
  const all = await getEligibleSkills();
  const nameSet = new Set(skillDirNames);
  const filtered = all.filter((s) => nameSet.has(s.dirName));
  return formatSkillsPrompt(filtered);
}

// Exported for testing
export { parseFrontmatter, isEligible, escapeXml, formatSkillsPrompt, discoverSkills, getSearchDirs };
