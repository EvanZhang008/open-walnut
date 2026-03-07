/**
 * memory_write tool — write to memory files.
 * Two modes:
 *   - "overwrite": replaces content (requires content_hash)
 *   - "append": adds a timestamped log entry (no hash needed)
 */
import type { ToolDefinition } from '../tools.js';
import { MEMORY_FILE } from '../../constants.js';
import {
  computeContentHash,
  writeFileChecked,
  StaleHashError,
} from '../../utils/file-ops.js';
import { withFileLock } from '../../utils/file-lock.js';
import {
  appendProjectMemory,
  resolveProjectMemoryPath,
  parseProjectMemory,
  ensureProjectDir,
} from '../../core/project-memory.js';
import { appendDailyLog, resolveDailyLogPath, formatDateKey } from '../../core/daily-log.js';
import yaml from 'js-yaml';
import fs from 'node:fs';

export const memoryWriteTool: ToolDefinition = {
  name: 'memory_write',
  description:
    'Write to memory. Two modes: "overwrite" replaces content (requires content_hash from memory_read), "append" adds a timestamped log entry (no hash needed). Targets: global, project, daily. For project/daily overwrite, use section to update only summary (YAML frontmatter) or body.',
  input_schema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        enum: ['global', 'project', 'daily'],
        description: 'Which memory to write to.',
      },
      project_path: {
        type: 'string',
        description: 'Project path. Required for project target and optional for append to also log to project memory.',
      },
      date: {
        type: 'string',
        description: 'YYYY-MM-DD. Defaults to today. For target=daily.',
      },
      mode: {
        type: 'string',
        enum: ['overwrite', 'append'],
        description: 'Write mode. Default: overwrite.',
      },
      content_hash: {
        type: 'string',
        description: 'Hash from memory_read. Required for overwrite mode.',
      },
      content: {
        type: 'string',
        description: 'The content to write (overwrite mode) or append (append mode).',
      },
      section: {
        type: 'string',
        enum: ['summary', 'body', 'all'],
        description: 'For project/daily overwrite: which part to update. "summary" = YAML frontmatter only, "body" = everything after frontmatter, "all" = full file. Default: all.',
      },
      name: {
        type: 'string',
        description: 'For section=summary: the project/daily name in YAML frontmatter.',
      },
      description: {
        type: 'string',
        description: 'For section=summary: the description in YAML frontmatter.',
      },
    },
    required: ['target'],
  },

  async execute(params) {
    const target = params.target as string;
    const projectPath = params.project_path as string | undefined;
    const date = params.date as string | undefined;
    const mode = (params.mode as string) || 'overwrite';
    const contentHash = params.content_hash as string | undefined;
    const content = params.content as string | undefined;
    const section = (params.section as string) || 'all';
    const name = params.name as string | undefined;
    const description = params.description as string | undefined;

    // ── Append mode ──
    if (mode === 'append') {
      return handleAppend(target, content, projectPath, date);
    }

    // ── Overwrite mode ──
    if (!contentHash) {
      return 'Error: content_hash is required for overwrite mode. Read the memory first with memory_read.';
    }

    return handleOverwrite(target, section, contentHash, content, projectPath, date, name, description);
  },
};

async function handleAppend(
  target: string,
  content: string | undefined,
  projectPath: string | undefined,
  date: string | undefined,
): Promise<string> {
  if (!content) return 'Error: content is required for append mode.';

  if (target === 'global') {
    return 'Error: Global memory does not support append. Use overwrite mode to update global memory.';
  }

  const writtenTo: string[] = [];

  if (target === 'daily') {
    appendDailyLog(content, 'agent', projectPath);
    writtenTo.push('daily');

    // If project_path also provided, write to project memory too
    if (projectPath) {
      const result = appendProjectMemory(projectPath, content, 'agent');
      writtenTo.push('project');
      return JSON.stringify({
        status: 'saved',
        written_to: writtenTo,
        summary: result.summary,
        recent_entries: result.tail,
      }, null, 2);
    }

    return JSON.stringify({ status: 'saved', written_to: writtenTo }, null, 2);
  }

  if (target === 'project') {
    if (!projectPath) return 'Error: project_path is required when target=project.';

    // Write to project memory + daily log (mimics old "both" behavior)
    appendDailyLog(content, 'agent', projectPath);
    writtenTo.push('daily');

    const result = appendProjectMemory(projectPath, content, 'agent');
    writtenTo.push('project');

    return JSON.stringify({
      status: 'saved',
      written_to: writtenTo,
      summary: result.summary,
      recent_entries: result.tail,
    }, null, 2);
  }

  return `Error: Unknown target "${target}". Use global, project, or daily.`;
}

async function handleOverwrite(
  target: string,
  section: string,
  contentHash: string,
  content: string | undefined,
  projectPath: string | undefined,
  date: string | undefined,
  name: string | undefined,
  description: string | undefined,
): Promise<string> {
  try {
    switch (target) {
      case 'global': {
        if (!content) return 'Error: content is required for global overwrite.';
        const result = await writeFileChecked(MEMORY_FILE, content, {
          expectedHash: contentHash,
        });
        return JSON.stringify({
          status: 'updated',
          content_hash: result.contentHash,
        }, null, 2);
      }

      case 'project': {
        if (!projectPath) return 'Error: project_path is required when target=project.';
        const filePath = resolveProjectMemoryPath(projectPath);
        ensureProjectDir(projectPath);
        return await overwriteWithSection(filePath, section, contentHash, content, name, description);
      }

      case 'daily': {
        const filePath = resolveDailyLogPath(date);
        return await overwriteWithSection(filePath, section, contentHash, content, name, description);
      }

      default:
        return `Error: Unknown target "${target}". Use global, project, or daily.`;
    }
  } catch (err) {
    if (err instanceof StaleHashError) {
      return `Error: ${err.message}`;
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return `Error: No ${target} memory file found. Nothing to overwrite.`;
    }
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Handle section-aware overwrite for project and daily targets.
 */
async function overwriteWithSection(
  filePath: string,
  section: string,
  contentHash: string,
  content: string | undefined,
  name: string | undefined,
  description: string | undefined,
): Promise<string> {
  if (section === 'all') {
    if (!content) return 'Error: content is required for section=all overwrite.';
    const result = await writeFileChecked(filePath, content, {
      expectedHash: contentHash,
    });
    return JSON.stringify({
      status: 'updated',
      content_hash: result.contentHash,
    }, null, 2);
  }

  if (section === 'summary') {
    if (name == null && description == null) {
      return 'Error: name and/or description required for section=summary.';
    }

    return withFileLock(filePath, async () => {
      const existing = fs.readFileSync(filePath, 'utf-8');
      const currentHash = computeContentHash(existing);
      if (currentHash !== contentHash) {
        throw new StaleHashError(currentHash);
      }

      // Parse existing frontmatter
      const parsed = parseProjectMemory(existing);
      const newName = name ?? parsed.name;
      const newDesc = description ?? parsed.description;

      // Remove existing frontmatter
      const fmMatch = existing.match(/^---\n[\s\S]*?\n---\n?/);
      const body = fmMatch ? existing.slice(fmMatch[0].length) : existing;

      const newFrontmatter = `---\n${yaml.dump({ name: newName, description: newDesc }, { lineWidth: -1 })}---\n`;
      const newContent = newFrontmatter + body;
      fs.writeFileSync(filePath, newContent, 'utf-8');

      return JSON.stringify({
        status: 'updated',
        content_hash: computeContentHash(newContent),
      }, null, 2);
    });
  }

  if (section === 'body') {
    if (!content && content !== '') return 'Error: content is required for section=body overwrite.';

    return withFileLock(filePath, async () => {
      const existing = fs.readFileSync(filePath, 'utf-8');
      const currentHash = computeContentHash(existing);
      if (currentHash !== contentHash) {
        throw new StaleHashError(currentHash);
      }

      // Preserve frontmatter, replace body
      const fmMatch = existing.match(/^---\n[\s\S]*?\n---\n?/);
      const frontmatter = fmMatch ? fmMatch[0] : '';
      const newContent = frontmatter + content;
      fs.writeFileSync(filePath, newContent, 'utf-8');

      return JSON.stringify({
        status: 'updated',
        content_hash: computeContentHash(newContent),
      }, null, 2);
    });
  }

  return `Error: Unknown section "${section}". Use summary, body, or all.`;
}
