/**
 * edit_file tool — performs string replacement in a file.
 * Ensures unique match unless replace_all is set.
 */
import fs from 'node:fs/promises';
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
      const content = await fs.readFile(filePath, 'utf-8');

      // Count occurrences
      let count = 0;
      let searchPos = 0;
      while (true) {
        const idx = content.indexOf(oldString, searchPos);
        if (idx === -1) break;
        count++;
        searchPos = idx + oldString.length;
      }

      if (count === 0) {
        return `Error: old_string not found in ${filePath}. Make sure the string matches exactly (including whitespace and indentation).`;
      }

      if (count > 1 && !replaceAll) {
        return `Error: old_string appears ${count} times in ${filePath}. Provide more surrounding context to make the match unique, or set replace_all to true.`;
      }

      let updated: string;
      if (replaceAll) {
        updated = content.split(oldString).join(newString);
      } else {
        // Replace first (and only) occurrence
        const idx = content.indexOf(oldString);
        updated = content.slice(0, idx) + newString + content.slice(idx + oldString.length);
      }

      await fs.writeFile(filePath, updated, 'utf-8');
      const replacements = replaceAll ? count : 1;
      return `File edited: ${filePath} (${replacements} replacement${replacements > 1 ? 's' : ''})`;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return `Error: File not found: ${filePath}`;
      if (code === 'EACCES') return `Error: Permission denied: ${filePath}`;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
