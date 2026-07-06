/**
 * Source URI resolver — routes source strings to the correct handler.
 *
 * Routing rules:
 *   /absolute/path   → FileHandler
 *   memory/*         → MemoryHandler
 *   notes/*          → NotesHandler
 *   repos/*          → ReposHandler
 */
import path from 'node:path';
import {
  MEMORY_FILE,
  PROJECTS_MEMORY_DIR,
  REPOS_MEMORY_DIR,
  DAILY_DIR,
  GLOBAL_NOTES_FILE,
  NOTES_DIR,
  NOTES_AGENTS_FILE,
  REPOSITORIES_DIR,
  agentMemoryDir,
  agentDailyDir,
} from '../../../constants.js';
import { formatDateKey } from '../../../core/daily-log.js';
import type { ResolvedSource } from './types.js';

/**
 * Resolve a source URI to an absolute file path + handler type.
 * When agentId is set and not 'general', memory/global and memory/daily
 * resolve to the agent's own directories instead of the General agent's.
 * Throws on invalid source patterns.
 */
export function resolveSource(source: string, agentId?: string): ResolvedSource {
  // Normalise: treat undefined/'general' identically (General agent path)
  const effectiveAgentId = agentId && agentId !== 'general' ? agentId : undefined;

  // ── Absolute path → FileHandler ──
  if (source.startsWith('/')) {
    return { type: 'file', filePath: source, source };
  }

  // ── memory/* → MemoryHandler ──
  if (source === 'memory/global') {
    const filePath = effectiveAgentId
      ? path.join(agentMemoryDir(effectiveAgentId), 'MEMORY.md')
      : MEMORY_FILE;
    return {
      type: 'memory',
      filePath,
      source,
      variant: 'global',
      agentId: effectiveAgentId,
    };
  }

  if (source.startsWith('memory/project/')) {
    const projectPath = source.slice('memory/project/'.length);
    if (!projectPath) {
      throw new Error('Invalid source: memory/project/ requires a project path (e.g. memory/project/work/api).');
    }
    if (projectPath.includes('..') || projectPath.startsWith('/')) {
      throw new Error(`Invalid project path in source "${source}": path traversal not allowed.`);
    }
    return {
      type: 'memory',
      filePath: path.join(PROJECTS_MEMORY_DIR, projectPath, 'MEMORY.md'),
      source,
      variant: 'project',
      meta: { projectPath },
    };
  }

  if (source === 'memory/project') {
    // List mode — resolved to directory
    return {
      type: 'memory',
      filePath: PROJECTS_MEMORY_DIR,
      source,
      variant: 'project-list',
    };
  }

  if (source === 'memory/daily') {
    // Default to today
    const dateKey = formatDateKey();
    const dailyDir = effectiveAgentId ? agentDailyDir(effectiveAgentId) : DAILY_DIR;
    return {
      type: 'memory',
      filePath: path.join(dailyDir, `${dateKey}.md`),
      source,
      variant: 'daily',
      meta: { date: dateKey },
      agentId: effectiveAgentId,
    };
  }

  if (source.startsWith('memory/daily/')) {
    const date = source.slice('memory/daily/'.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`Invalid date format in source "${source}". Expected YYYY-MM-DD.`);
    }
    const parsed = new Date(date + 'T00:00:00Z');
    if (isNaN(parsed.getTime())) {
      throw new Error(`Invalid date in source "${source}": "${date}" is not a valid date.`);
    }
    const dailyDir = effectiveAgentId ? agentDailyDir(effectiveAgentId) : DAILY_DIR;
    return {
      type: 'memory',
      filePath: path.join(dailyDir, `${date}.md`),
      source,
      variant: 'daily',
      meta: { date },
      agentId: effectiveAgentId,
    };
  }

  // ── memory/main/* → Main (General) agent memory/daily, always read-only ──
  if (source === 'memory/main/global') {
    return {
      type: 'memory',
      filePath: MEMORY_FILE,
      source,
      variant: 'main-global',
    };
  }

  if (source === 'memory/main/daily') {
    const dateKey = formatDateKey();
    return {
      type: 'memory',
      filePath: path.join(DAILY_DIR, `${dateKey}.md`),
      source,
      variant: 'main-daily',
      meta: { date: dateKey },
    };
  }

  if (source.startsWith('memory/main/daily/')) {
    const date = source.slice('memory/main/daily/'.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`Invalid date format in source "${source}". Expected YYYY-MM-DD.`);
    }
    const parsed = new Date(date + 'T00:00:00Z');
    if (isNaN(parsed.getTime())) {
      throw new Error(`Invalid date in source "${source}": "${date}" is not a valid date.`);
    }
    return {
      type: 'memory',
      filePath: path.join(DAILY_DIR, `${date}.md`),
      source,
      variant: 'main-daily',
      meta: { date },
    };
  }

  // ── memory/repo → repo environment memory ──
  if (source === 'memory/repo') {
    return {
      type: 'memory',
      filePath: REPOS_MEMORY_DIR,
      source,
      variant: 'repo-list',
    };
  }

  if (source.startsWith('memory/repo/')) {
    const slug = source.slice('memory/repo/'.length);
    if (!slug || slug.includes('..') || slug.includes('/')) {
      throw new Error(`Invalid repo slug in source "${source}": must be a simple name.`);
    }
    return {
      type: 'memory',
      filePath: path.join(REPOS_MEMORY_DIR, slug, 'SKILL.md'),
      source,
      variant: 'repo',
      meta: { slug },
    };
  }

  // ── notes/* → NotesHandler ──
  // Exact match must precede startsWith('notes/') to avoid resolving to notes/global.md
  if (source === 'notes/global') {
    return {
      type: 'notes',
      filePath: GLOBAL_NOTES_FILE,
      source,
      variant: 'global',
    };
  }

  // notes/instructions → AGENTS.md (primary). Writes/edits also mirror to CLAUDE.md — see NotesHandler.
  if (source === 'notes/instructions') {
    return {
      type: 'notes',
      filePath: NOTES_AGENTS_FILE,
      source,
      variant: 'instructions',
    };
  }

  if (source === 'notes') {
    // List mode
    return {
      type: 'notes',
      filePath: NOTES_DIR,
      source,
      variant: 'notes-list',
    };
  }

  if (source.startsWith('notes/')) {
    const name = source.slice('notes/'.length);
    if (!name || name.includes('..')) {
      throw new Error(`Invalid note name in source "${source}".`);
    }
    return {
      type: 'notes',
      filePath: path.join(NOTES_DIR, `${name}.md`),
      source,
      variant: 'named',
      meta: { name },
    };
  }

  // ── repos/* → ReposHandler ──
  if (source === 'repos' || source === 'repos/') {
    return {
      type: 'repos',
      filePath: REPOSITORIES_DIR,
      source,
      variant: 'repos-list',
    };
  }

  if (source.startsWith('repos/')) {
    const name = source.slice('repos/'.length);
    if (!name || name.includes('..') || name.includes('/')) {
      throw new Error(`Invalid repo name in source "${source}".`);
    }
    return {
      type: 'repos',
      filePath: path.join(REPOSITORIES_DIR, `${name}.yaml`),
      source,
      variant: 'named',
      meta: { name },
    };
  }

  throw new Error(
    `Invalid source "${source}". Expected: /absolute/path, memory/global, memory/project/{path}, memory/daily[/YYYY-MM-DD], memory/main/global, memory/main/daily[/YYYY-MM-DD], memory/repo[/{slug}], notes/global, notes/instructions, notes/{name}, repos/, or repos/{name}.`,
  );
}
