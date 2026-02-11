/**
 * Skill loader: discovers SKILL.md files, parses frontmatter, filters by eligibility,
 * and formats the prompt section for injection into the agent system prompt.
 *
 * Load sources (highest priority first):
 *   ./skills/              — workspace-local
 *   ~/.walnut/skills/       — walnut global
 *   ~/.claude/skills/      — claude skills (shared across tools)
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { GLOBAL_SKILLS_DIR, CLAUDE_SKILLS_DIR } from '../constants.js';

export interface SkillMeta {
  name: string;
  description: string;
  location: string;
  metadata?: Record<string, unknown>;
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
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
    GLOBAL_SKILLS_DIR,            // ~/.walnut/skills/
    CLAUDE_SKILLS_DIR,            // ~/.claude/skills/
  ];
}

async function discoverSkills(dirs: string[]): Promise<Map<string, { dir: string; file: string }>> {
  const found = new Map<string, { dir: string; file: string }>();
  for (const base of dirs) {
    let entries: string[];
    try {
      entries = await fsp.readdir(base);
    } catch {
      continue; // directory doesn't exist
    }
    for (const entry of entries) {
      if (found.has(entry)) continue; // higher-priority source already registered
      const skillFile = path.join(base, entry, 'SKILL.md');
      try {
        const stat = await fsp.stat(skillFile);
        if (stat.isFile()) {
          found.set(entry, { dir: path.join(base, entry), file: skillFile });
        }
      } catch {
        // no SKILL.md in this subdir
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
  } catch {
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
    return false;
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
Before replying: scan <available_skills> <description> entries.
- If exactly one skill clearly applies: read its SKILL.md at <location> with \`read\`, then follow it.
- If multiple could apply: choose the most specific one, then read/follow it.
- If none clearly apply: do not read any SKILL.md.
Constraints: never read more than one skill up front; only read after selecting.

The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.`;

  const entries = skills
    .map(
      (s) =>
        `  <skill>\n    <name>${escapeXml(s.name)}</name>\n    <description>${escapeXml(s.description)}</description>\n    <location>${escapeXml(s.location)}</location>\n  </skill>`,
    )
    .join('\n');

  return `${preamble}\n\n<available_skills>\n${entries}\n</available_skills>`;
}

// ─── cache + public API ─────────────────────────────────────────────

let cachedPrompt: string | undefined;
let cachedSkills: (SkillMeta & { dirName: string })[] | undefined;

export function clearSkillsCache(): void {
  cachedPrompt = undefined;
  cachedSkills = undefined;
}

/** Discover and cache all eligible skills with their directory names. */
async function getEligibleSkills(): Promise<(SkillMeta & { dirName: string })[]> {
  if (cachedSkills !== undefined) return cachedSkills;

  const dirs = getSearchDirs();
  const discovered = await discoverSkills(dirs);
  const skills: (SkillMeta & { dirName: string })[] = [];

  for (const [dirName, { file }] of discovered) {
    let raw: string;
    try {
      raw = await fsp.readFile(file, 'utf-8');
    } catch {
      continue;
    }
    const { frontmatter } = parseFrontmatter(raw);
    if (!isEligible(frontmatter)) continue;

    skills.push({
      dirName,
      name: frontmatter.name ?? dirName,
      description: frontmatter.description ?? '',
      location: file,
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
