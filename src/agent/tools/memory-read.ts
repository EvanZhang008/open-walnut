/**
 * memory_read tool — reads memory files with line numbers and content hash.
 * Supports global, project, and daily targets.
 */
import type { ToolDefinition } from '../tools.js';
import { MEMORY_FILE } from '../../constants.js';
import { readFileWithMeta } from '../../utils/file-ops.js';
import { resolveProjectMemoryPath, ensureProjectDir } from '../../core/project-memory.js';
import { resolveDailyLogPath, formatDateKey } from '../../core/daily-log.js';

export const memoryReadTool: ToolDefinition = {
  name: 'memory_read',
  description:
    'Read memory files. Returns content with line numbers and a content_hash for use with memory_edit/memory_write. Targets: "global" (user preferences/facts), "project" (category/project-scoped logs, requires project_path e.g. "work/event-service"), "daily" (time-indexed activity log, defaults to today).',
  input_schema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        enum: ['global', 'project', 'daily'],
        description: 'Which memory to read.',
      },
      project_path: {
        type: 'string',
        description: 'Project path (e.g. "work/event-service"). Required when target=project.',
      },
      date: {
        type: 'string',
        description: 'YYYY-MM-DD. Defaults to today. For target=daily.',
      },
      offset: {
        type: 'number',
        description: '1-based start line.',
      },
      limit: {
        type: 'number',
        description: 'Max lines to return.',
      },
    },
    required: ['target'],
  },

  async execute(params) {
    const target = params.target as string;
    const projectPath = params.project_path as string | undefined;
    const date = params.date as string | undefined;
    const offset = params.offset as number | undefined;
    const limit = params.limit as number | undefined;

    let filePath: string;

    switch (target) {
      case 'global':
        filePath = MEMORY_FILE;
        break;

      case 'project':
        if (!projectPath) return 'Error: project_path is required when target=project.';
        filePath = resolveProjectMemoryPath(projectPath);
        break;

      case 'daily':
        filePath = resolveDailyLogPath(date);
        break;

      default:
        return `Error: Unknown target "${target}". Use global, project, or daily.`;
    }

    try {
      const meta = await readFileWithMeta(filePath, { offset, limit });
      return JSON.stringify({
        content: meta.content,
        content_hash: meta.contentHash,
        total_lines: meta.totalLines,
        showing: meta.showing,
      }, null, 2);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        if (target === 'project' && projectPath) {
          return `No memory found for project "${projectPath}". Use memory_write with mode=append to create it.`;
        }
        if (target === 'daily') {
          return `No daily log found for ${date ?? formatDateKey()}.`;
        }
        return 'No global memory file found.';
      }
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
