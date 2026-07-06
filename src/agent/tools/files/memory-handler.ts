/**
 * MemoryHandler — handles memory/global, memory/project/*, memory/daily/*, memory/repo/* sources.
 * Reuses existing core modules: memory-file, project-memory, repo-memory, daily-log.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DAILY_DIR, agentDailyDir } from '../../../constants.js';
import { readFileWithMeta, writeFileChecked, editFileContent } from '../../../utils/file-ops.js';
import { ensureProjectDir, getAllProjectSummaries } from '../../../core/project-memory.js';
import { appendSkillHistoryForProject } from '../../../core/overview-log.js';
import { appendRepoMemory, ensureRepoMemoryDir, getAllRepoMemorySummaries } from '../../../core/repo-memory.js';
import { appendDailyLog, formatDateKey } from '../../../core/daily-log.js';
import { ensureMemoryFile } from '../../../core/memory-file.js';
import { parseMemoryContent, MEMORY_CHAR_BUDGET } from '../../../core/bounded-memory.js';
import type { FileHandler, ResolvedSource, FilesReadResult, FilesWriteResult, FilesEditResult, FilesListItem } from './types.js';

/**
 * Enforce the bounded-memory budget on direct memory/global writes.
 * memory_manage is the preferred write path (consolidation guidance, batch,
 * circuit breaker); this guard just keeps file_write/file_edit from silently
 * bypassing the budget and re-rotting MEMORY.md.
 */
/** Preamble (frontmatter + title, before the first `## `) is not entry content — cap it so it can't become a budget bypass. */
const MEMORY_PREAMBLE_CAP = 1_000;

function assertGlobalMemoryBudget(content: string): void {
  const { preamble, entries } = parseMemoryContent(content);
  const used = entries.length === 0 ? 0 : entries.join('\n\n').length;
  if (used > MEMORY_CHAR_BUDGET) {
    throw new Error(
      `Global memory would be at ${used.toLocaleString('en-US')}/${MEMORY_CHAR_BUDGET.toLocaleString('en-US')} chars — over the hard budget. ` +
      `Use memory_manage (action: batch) to consolidate: merge/shorten/remove entries. ` +
      `Domain knowledge belongs in a knowledge skill (skill_manage), not in global memory.`,
    );
  }
  if (preamble.length > MEMORY_PREAMBLE_CAP) {
    throw new Error(
      `Global memory preamble (content before the first "## " heading) would be ${preamble.length.toLocaleString('en-US')} chars — ` +
      `max ${MEMORY_PREAMBLE_CAP.toLocaleString('en-US')}. Keep the preamble to frontmatter + title; all content belongs in "## Title" entries.`,
    );
  }
}

export const memoryHandler: FileHandler = {
  async read(resolved, opts) {
    // Ensure file exists for global memory
    if (resolved.variant === 'global') {
      ensureMemoryFile(resolved.agentId);
    }

    const meta = await readFileWithMeta(resolved.filePath, opts);
    return {
      content: meta.content,
      content_hash: meta.contentHash,
      total_lines: meta.totalLines,
      showing: meta.showing,
    };
  },

  async write(resolved, content, opts) {
    // main-* variants are read-only
    if (resolved.variant === 'main-global' || resolved.variant === 'main-daily') {
      throw new Error('Main agent memory/daily is read-only. Write to memory/global or memory/daily instead (your own agent storage).');
    }

    const mode = opts?.mode ?? 'overwrite';

    if (mode === 'append') {
      return handleMemoryAppend(resolved, content);
    }

    // Overwrite — require hash for memory sources
    if (!opts?.contentHash) {
      throw new Error('content_hash is required for overwrite on memory sources. Read first with file_read.');
    }

    // Ensure directories exist
    if (resolved.variant === 'project' && resolved.meta?.projectPath) {
      ensureProjectDir(resolved.meta.projectPath);
    }
    if (resolved.variant === 'repo' && resolved.meta?.slug) {
      ensureRepoMemoryDir(resolved.meta.slug);
    }
    if (resolved.variant === 'global') {
      ensureMemoryFile(resolved.agentId);
      assertGlobalMemoryBudget(content);
    }

    const result = await writeFileChecked(resolved.filePath, content, {
      expectedHash: opts.contentHash,
    });
    return { status: 'updated', content_hash: result.contentHash };
  },

  async edit(resolved, oldContent, newContent, opts) {
    // main-* variants are read-only
    if (resolved.variant === 'main-global' || resolved.variant === 'main-daily') {
      throw new Error('Main agent memory/daily is read-only. Edit memory/global or memory/daily instead (your own agent storage).');
    }
    if (!opts?.contentHash) {
      throw new Error('content_hash is required for editing memory sources. Read first with file_read.');
    }
    if (!oldContent) {
      throw new Error('old_content cannot be empty.');
    }

    // Pre-validate the post-edit budget for global memory (best-effort preview;
    // the authoritative hash check still happens inside editFileContent).
    if (resolved.variant === 'global') {
      try {
        const raw = fs.readFileSync(resolved.filePath, 'utf-8');
        if (raw.includes(oldContent)) {
          const preview = opts?.replaceAll
            ? raw.split(oldContent).join(newContent)
            : raw.replace(oldContent, newContent);
          assertGlobalMemoryBudget(preview);
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes('hard budget')) throw err;
        // file missing/unreadable — let editFileContent produce the real error
      }
    }

    const result = await editFileContent(resolved.filePath, oldContent, newContent, {
      expectedHash: opts.contentHash,
      replaceAll: opts?.replaceAll,
    });
    return {
      status: newContent ? 'updated' : 'deleted',
      replacements: result.replacements,
      content_hash: result.contentHash,
    };
  },

  async list(resolved) {
    // memory/project → list all project summaries
    if (resolved.variant === 'project-list') {
      const summaries = getAllProjectSummaries();
      return summaries.map((s) => ({
        source: `memory/project/${s.path}`,
        name: s.name,
        description: s.description,
      }));
    }

    // memory/repo → list all repo memories
    if (resolved.variant === 'repo-list') {
      const summaries = getAllRepoMemorySummaries();
      return summaries.map((s) => ({
        source: `memory/repo/${s.slug}`,
        name: s.name,
        description: s.description,
      }));
    }

    // memory/daily (used from file_list prefix="memory/daily")
    // List all daily log files, most recent first
    const dailyDir = resolved.agentId ? agentDailyDir(resolved.agentId) : DAILY_DIR;
    const items: FilesListItem[] = [];
    try {
      const files = fs.readdirSync(dailyDir)
        .filter((f) => f.endsWith('.md') && !f.endsWith('.bak.md'))
        .sort()
        .reverse();
      for (const f of files) {
        const date = f.replace('.md', '');
        const stat = fs.statSync(path.join(dailyDir, f));
        items.push({
          source: `memory/daily/${date}`,
          name: date,
          size: stat.size,
          modified: stat.mtime.toISOString(),
        });
      }
    } catch {
      // dailyDir doesn't exist yet
    }
    return items;
  },
};

/** Route "category/project[/…]" to the skill-history system. Returns the
 *  written_to label, or null when no skill/overview target exists. */
function routeProjectEntryToSkillHistory(projectPath: string, content: string): string | null {
  const [category, ...rest] = projectPath.split('/').filter(Boolean);
  const project = rest.join('-') || category;
  const result = appendSkillHistoryForProject(category ?? '', project, content, 'agent');
  return result ? 'skill-history' : null;
}

function handleMemoryAppend(resolved: ResolvedSource, content: string): FilesWriteResult {
  if (resolved.variant === 'global') {
    throw new Error('Global memory does not support append. Use overwrite mode.');
  }

  const writtenTo: string[] = [];

  if (resolved.variant === 'daily') {
    const projectPath = resolved.meta?.projectPath;
    appendDailyLog(content, 'agent', projectPath, resolved.agentId);
    writtenTo.push('daily');

    if (projectPath) {
      // Project-scoped entries land in the SKILL system's history (three-word
      // model: episodic → history), not the retired memory/projects/ tree.
      const routed = routeProjectEntryToSkillHistory(projectPath, content);
      if (routed) writtenTo.push(routed);
    }
    return { status: 'saved', content_hash: '', written_to: writtenTo };
  }

  if (resolved.variant === 'project') {
    const projectPath = resolved.meta?.projectPath;
    if (!projectPath) {
      throw new Error('project_path is required for project memory append.');
    }

    // Write to both the skill-history log and the daily log. memory/projects/
    // is retired as a write target (2026-07 unification) — entries route to
    // skills/<category>/<project>/history/ (or the category overview log).
    appendDailyLog(content, 'agent', projectPath, resolved.agentId);
    writtenTo.push('daily');

    const routed = routeProjectEntryToSkillHistory(projectPath, content);
    if (routed) {
      writtenTo.push(routed);
    } else {
      const [cat] = projectPath.split('/');
      throw new Error(
        `No skill history target for project "${projectPath}". Create the skill first ` +
        `(skill_manage action=create, category "${cat}") or use skill_manage log_append ` +
        `against an existing category overview. (Entry was still saved to the daily log.)`,
      );
    }

    return { status: 'saved', content_hash: '', written_to: writtenTo };
  }

  if (resolved.variant === 'repo') {
    const slug = resolved.meta?.slug;
    if (!slug) {
      throw new Error('slug is required for repo memory append.');
    }
    appendRepoMemory(slug, content, 'agent');
    return { status: 'saved', content_hash: '', written_to: ['repo'] };
  }

  throw new Error(`Append not supported for memory variant "${resolved.variant}".`);
}
