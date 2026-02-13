/**
 * write_file tool — writes content to a file, creating parent dirs as needed.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolDefinition } from '../tools.js';

export const writeTool: ToolDefinition = {
  name: 'write_file',
  description:
    'Write content to a file. Creates parent directories if they do not exist. Overwrites the file if it already exists.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path to the file to write',
      },
      content: {
        type: 'string',
        description: 'Content to write to the file',
      },
    },
    required: ['path', 'content'],
  },
  async execute(params) {
    const filePath = params.path as string;
    const content = params.content as string;
    if (!filePath) return 'Error: path is required.';
    if (content == null) return 'Error: content is required.';

    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, 'utf-8');
      return `File written: ${filePath}`;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES') return `Error: Permission denied: ${filePath}`;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
