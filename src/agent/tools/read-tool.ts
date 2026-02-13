/**
 * read_file tool — reads file contents with optional offset/limit.
 * Returns line-numbered text for text files. For vision-supported image files
 * (PNG, JPEG, GIF, WebP), returns the image inline as a base64 content block
 * so the model can directly perceive it.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolDefinition } from '../tools.js';
import { compressForApi, MAX_BASE64_BYTES } from '../../utils/image-compress.js';

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp',
]);

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
};

/** Anthropic vision API supports only these mime types. */
const VISION_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Max file size for inline vision (20 MB). */
const MAX_INLINE_IMAGE_SIZE = 20 * 1024 * 1024;

export const readTool: ToolDefinition = {
  name: 'read_file',
  description:
    'Read the contents of a file. Returns line-numbered text for text files. For image files (PNG, JPEG, GIF, WebP), returns the image inline for vision analysis. Supports optional offset and limit for large files.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path to the file to read',
      },
      offset: {
        type: 'number',
        description: 'Line number to start reading from (1-based). Defaults to 1.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of lines to return. Defaults to all lines.',
      },
    },
    required: ['path'],
  },
  async execute(params) {
    const filePath = params.path as string;
    if (!filePath) return 'Error: path is required.';

    try {
      const stat = await fs.stat(filePath);
      const ext = path.extname(filePath).toLowerCase();

      // Image files: return inline base64 for vision-supported types
      if (IMAGE_EXTENSIONS.has(ext)) {
        const mime = MIME_MAP[ext] ?? 'application/octet-stream';

        // Non-vision types (svg, bmp): metadata only
        if (!VISION_MIME_TYPES.has(mime)) {
          return `[Image file: ${filePath}] (${stat.size} bytes, ${mime}) — not a vision-supported format`;
        }

        // Size guard: skip inline for files > 20MB (too large even for compression)
        if (stat.size > MAX_INLINE_IMAGE_SIZE) {
          return `[Image file: ${filePath}] (${stat.size} bytes, ${mime}) — too large for inline vision`;
        }

        const rawBuffer = await fs.readFile(filePath);
        const { buffer, mimeType } = await compressForApi(rawBuffer, mime);
        const base64 = buffer.toString('base64');

        if (base64.length > MAX_BASE64_BYTES) {
          // Log so server ops can see which files are hitting the limit
          console.warn(`[read_file] image too large after compression: ${filePath} (${(buffer.length / 1_048_576).toFixed(1)} MB)`);
          return `[Image file: ${filePath}] (${stat.size} bytes, ${mime}) — too large for inline vision even after compression`;
        }

        const sizeNote = buffer.length !== rawBuffer.length
          ? ` (compressed from ${(rawBuffer.length / 1_048_576).toFixed(1)} MB to ${(buffer.length / 1_048_576).toFixed(1)} MB)`
          : '';

        return [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
          { type: 'text', text: `[Read image: ${filePath}] (${stat.size} bytes, ${mime})${sizeNote}` },
        ];
      }

      // Text files: read and return with line numbers
      const raw = await fs.readFile(filePath, 'utf-8');
      const allLines = raw.split('\n');

      const offset = Math.max(1, (params.offset as number) || 1);
      const limit = params.limit as number | undefined;

      const start = offset - 1; // convert to 0-based
      const sliced = limit != null ? allLines.slice(start, start + limit) : allLines.slice(start);

      const numbered = sliced.map(
        (line, i) => `${String(start + i + 1).padStart(6)}\t${line}`,
      );

      let result = numbered.join('\n');
      if (start > 0 || (limit != null && start + limit < allLines.length)) {
        result += `\n\n(Showing lines ${start + 1}–${start + sliced.length} of ${allLines.length} total)`;
      }
      return result;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return `Error: File not found: ${filePath}`;
      if (code === 'EACCES') return `Error: Permission denied: ${filePath}`;
      if (code === 'EISDIR') return `Error: Path is a directory, not a file: ${filePath}`;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
