/**
 * memory_edit tool — edit memory by exact string replacement with hash-based stale check.
 * Supports global, project, and daily targets.
 */
import type { ToolDefinition } from '../tools.js';
import { MEMORY_FILE } from '../../constants.js';
import {
  editFileContent,
  StaleHashError,
  ContentNotFoundError,
  AmbiguousMatchError,
} from '../../utils/file-ops.js';
import { resolveProjectMemoryPath } from '../../core/project-memory.js';
import { resolveDailyLogPath } from '../../core/daily-log.js';

export const memoryEditTool: ToolDefinition = {
  name: 'memory_edit',
  description:
    'Edit memory by exact string replacement. Requires content_hash from memory_read to prevent stale edits. The old_content must match exactly once (or set replace_all=true). Supports global, project, and daily targets.',
  input_schema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        enum: ['global', 'project', 'daily'],
        description: 'Which memory to edit.',
      },
      project_path: {
        type: 'string',
        description: 'Project path. Required when target=project.',
      },
      date: {
        type: 'string',
        description: 'YYYY-MM-DD. Defaults to today. For target=daily.',
      },
      content_hash: {
        type: 'string',
        description: 'Hash from memory_read. Required.',
      },
      old_content: {
        type: 'string',
        description: 'Exact text to find.',
      },
      new_content: {
        type: 'string',
        description: 'Replacement text. Omit or empty string to delete the matched text.',
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace all occurrences instead of requiring a unique match. Default: false.',
      },
    },
    required: ['target', 'content_hash', 'old_content'],
  },

  async execute(params) {
    const target = params.target as string;
    const projectPath = params.project_path as string | undefined;
    const date = params.date as string | undefined;
    const contentHash = params.content_hash as string;
    const oldContent = params.old_content as string;
    const newContent = (params.new_content as string) ?? '';
    const replaceAll = (params.replace_all as boolean) ?? false;

    if (!contentHash) return 'Error: content_hash is required. Read the memory first with memory_read.';
    if (!oldContent) return 'Error: old_content is required.';

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
      const result = await editFileContent(filePath, oldContent, newContent, {
        expectedHash: contentHash,
        replaceAll,
      });

      return JSON.stringify({
        status: newContent ? 'updated' : 'deleted',
        replacements: result.replacements,
        content_hash: result.contentHash,
      }, null, 2);
    } catch (err) {
      if (err instanceof StaleHashError) {
        return `Error: ${err.message}`;
      }
      if (err instanceof ContentNotFoundError) {
        return `Error: old_content not found in ${target} memory. Make sure the string matches exactly (including whitespace and indentation). Use memory_read first to see current content.`;
      }
      if (err instanceof AmbiguousMatchError) {
        return `Error: ${err.message}`;
      }
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return `Error: No ${target} memory file found. Nothing to edit.`;
      }
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
