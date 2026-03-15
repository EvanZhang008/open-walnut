import fs from 'node:fs';
import path from 'node:path';
import { log } from '../logging/index.js';
import { MEMORY_FILE } from '../constants.js';
import { computeContentHash, editFileContent, writeFileChecked } from '../utils/file-ops.js';

const DEFAULT_TEMPLATE = `---
name: Global Memory
description: >
  Curated knowledge and preferences. Updated by the agent as it learns.
---
`;

export interface MemoryFileResult {
  content: string;
  contentHash: string;
}

/**
 * Read the global MEMORY.md file.
 * Returns content + contentHash for stale-check support.
 */
export function getMemoryFile(): MemoryFileResult | null {
  try {
    const content = fs.readFileSync(MEMORY_FILE, 'utf-8');
    return { content, contentHash: computeContentHash(content) };
  } catch (err) {
    log.memory.debug('memory-file: MEMORY.md not found or unreadable', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Full replacement write of the global MEMORY.md file.
 * @param expectedHash — if provided, validates against current content hash before writing.
 */
export async function updateMemoryFile(
  content: string,
  expectedHash?: string,
): Promise<{ contentHash: string }> {
  fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
  const result = await writeFileChecked(MEMORY_FILE, content, {
    expectedHash,
  });
  return { contentHash: result.contentHash };
}

/**
 * Edit the global MEMORY.md by exact string replacement.
 * @param expectedHash — validates against current content hash before editing.
 */
export async function editMemoryFile(
  oldContent: string,
  newContent: string,
  expectedHash: string,
  replaceAll?: boolean,
): Promise<{ replacements: number; contentHash: string }> {
  return editFileContent(MEMORY_FILE, oldContent, newContent, {
    expectedHash,
    replaceAll,
  });
}

/**
 * Create MEMORY.md with a default template if it doesn't exist.
 */
export function ensureMemoryFile(): void {
  if (fs.existsSync(MEMORY_FILE)) return;
  fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
  fs.writeFileSync(MEMORY_FILE, DEFAULT_TEMPLATE, 'utf-8');
}
