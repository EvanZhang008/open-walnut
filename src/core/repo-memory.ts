/**
 * Repo memory — per-repository environment knowledge accumulation.
 *
 * Pairs with repos/{slug}.yaml (static profile) to store dynamic learnings:
 * monorepo structure, SSH host details, build command quirks, environment issues, conventions.
 *
 * Storage: skills/repos/{slug}/SKILL.md — repo knowledge IS a knowledge skill
 * (repos category) since the 2026-07 memory/skill/history unification. This
 * module keeps the append/edit ergonomics; the skill system provides
 * discovery, indexing, and search for free.
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { REPOS_MEMORY_DIR } from '../constants.js';
import { formatDateKey } from './daily-log.js';
import {
  computeContentHash,
  editFileContent,
  writeFileChecked,
} from '../utils/file-ops.js';

/** Max lines for repo memory before tail-truncation on read. */
export const REPO_MEMORY_MAX_LINES = 200;

export interface RepoMemoryResult {
  content: string;
  contentHash: string;
}

export interface RepoMemorySummary {
  slug: string;
  name: string;
  description: string;
}

/**
 * Validate a repo slug: no path traversal, no slashes.
 */
function validateSlug(slug: string): void {
  if (!slug || slug.includes('..') || slug.includes('/') || slug.includes('\\')) {
    throw new Error(`Invalid repo slug "${slug}": must be a simple name without path separators.`);
  }
}

/**
 * Ensure the repo skill directory and SKILL.md template exist.
 */
export function ensureRepoMemoryDir(slug: string): string {
  validateSlug(slug);
  const dirPath = path.join(REPOS_MEMORY_DIR, slug);
  fs.mkdirSync(dirPath, { recursive: true });

  const memFile = path.join(dirPath, 'SKILL.md');
  if (!fs.existsSync(memFile)) {
    const template = `---\nname: ${slug}\ndescription: 'Environment knowledge for ${slug} repo'\ntype: knowledge\n---\n`;
    fs.writeFileSync(memFile, template, 'utf-8');
  }
  return memFile;
}

/**
 * Read a repo's MEMORY.md content with hash.
 * Returns null if the repo memory doesn't exist.
 */
export function getRepoMemory(slug: string): RepoMemoryResult | null {
  validateSlug(slug);
  const memFile = path.join(REPOS_MEMORY_DIR, slug, 'SKILL.md');
  try {
    const content = fs.readFileSync(memFile, 'utf-8');
    return { content, contentHash: computeContentHash(content) };
  } catch {
    return null;
  }
}

/**
 * Append a timestamped entry to a repo's MEMORY.md.
 * Does NOT cross-write to daily log (repo memory is a knowledge base, not an activity log).
 */
export function appendRepoMemory(slug: string, content: string, source?: string): void {
  const memFile = ensureRepoMemoryDir(slug);

  const now = new Date();
  const dateKey = formatDateKey(now);
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const sourceLabel = source ?? 'agent';

  const entry = `## ${dateKey} ${hours}:${minutes} — ${sourceLabel}\n${content}\n\n`;
  fs.appendFileSync(memFile, entry, 'utf-8');
}

/**
 * Edit repo memory by content matching.
 */
export async function editRepoMemory(
  slug: string,
  oldContent: string,
  newContent: string,
  expectedHash?: string,
  replaceAll?: boolean,
): Promise<{ replacements: number; contentHash: string }> {
  validateSlug(slug);
  const memFile = path.join(REPOS_MEMORY_DIR, slug, 'SKILL.md');
  if (!oldContent) throw new Error('old_content cannot be empty.');
  return editFileContent(memFile, oldContent, newContent, { expectedHash, replaceAll });
}

/**
 * Overwrite a repo's MEMORY.md with hash-based stale check.
 */
export async function writeRepoMemory(
  slug: string,
  content: string,
  expectedHash: string,
): Promise<{ contentHash: string }> {
  ensureRepoMemoryDir(slug);
  const memFile = path.join(REPOS_MEMORY_DIR, slug, 'SKILL.md');
  return writeFileChecked(memFile, content, { expectedHash });
}

/**
 * List all repo memories with name/description from YAML frontmatter.
 */
export function getAllRepoMemorySummaries(): RepoMemorySummary[] {
  const summaries: RepoMemorySummary[] = [];
  try {
    const entries = fs.readdirSync(REPOS_MEMORY_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const memFile = path.join(REPOS_MEMORY_DIR, entry.name, 'SKILL.md');
      try {
        const content = fs.readFileSync(memFile, 'utf-8');
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        let name = entry.name;
        let description = '';
        if (fmMatch) {
          try {
            const parsed = yaml.load(fmMatch[1]) as Record<string, unknown> | null;
            if (parsed && typeof parsed === 'object') {
              if (typeof parsed.name === 'string') name = parsed.name;
              if (typeof parsed.description === 'string') description = parsed.description;
            }
          } catch { /* invalid YAML */ }
        }
        summaries.push({ slug: entry.name, name, description });
      } catch { /* no MEMORY.md */ }
    }
  } catch { /* REPOS_MEMORY_DIR doesn't exist */ }
  return summaries;
}

/**
 * Resolve a slug to the absolute MEMORY.md path.
 */
export function resolveRepoMemoryPath(slug: string): string {
  validateSlug(slug);
  return path.join(REPOS_MEMORY_DIR, slug, 'SKILL.md');
}
