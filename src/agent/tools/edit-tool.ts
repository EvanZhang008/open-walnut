/**
 * edit_file tool — performs string replacement in a file.
 * Ensures unique match unless replace_all is set.
 * Uses shared file-ops infrastructure (no hash check for generic files).
 */
import {
  editFileContent,
  ContentNotFoundError,
  AmbiguousMatchError,
} from '../../utils/file-ops.js';
import type { ToolDefinition } from '../tools.js';

export const editTool: ToolDefinition = {
  name: 'edit_file',
  description:
    'Edit a file by replacing an exact string. By default the old_string must appear exactly once in the file (to avoid ambiguous edits). Set replace_all to true to replace every occurrence.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path to the file to edit',
      },
      old_string: {
        type: 'string',
        description: 'The exact text to find and replace',
      },
      new_string: {
        type: 'string',
        description: 'The replacement text',
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace all occurrences instead of requiring a unique match (default: false)',
      },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute(params) {
    const filePath = params.path as string;
    const oldString = params.old_string as string;
    const newString = params.new_string as string;
    const replaceAll = (params.replace_all as boolean) ?? false;

    if (!filePath) return 'Error: path is required.';
    if (oldString == null) return 'Error: old_string is required.';
    if (newString == null) return 'Error: new_string is required.';

    try {
      // No expectedHash for generic file editing (hash check is memory-tool-only)
      const result = await editFileContent(filePath, oldString, newString, {
        replaceAll,
      });

      return `File edited: ${filePath} (${result.replacements} replacement${result.replacements > 1 ? 's' : ''})`;
    } catch (err: unknown) {
      if (err instanceof ContentNotFoundError) {
        return `Error: old_string not found in ${filePath}. Make sure the string matches exactly (including whitespace and indentation).`;
      }
      if (err instanceof AmbiguousMatchError) {
        return `Error: old_string appears ${err.matchCount} times in ${filePath}. Provide more surrounding context to make the match unique, or set replace_all to true.`;
      }
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return `Error: File not found: ${filePath}`;
      if (code === 'EACCES') return `Error: Permission denied: ${filePath}`;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
