import fs from 'node:fs';
import path from 'node:path';
import { MEMORY_FILE } from '../constants.js';

const DEFAULT_TEMPLATE = `---
name: Global Memory
description: >
  Curated knowledge and preferences. Updated by the agent as it learns.
---
`;

/**
 * Read the global MEMORY.md file.
 */
export function getMemoryFile(): string | null {
  try {
    return fs.readFileSync(MEMORY_FILE, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Full replacement write of the global MEMORY.md file.
 */
export function updateMemoryFile(content: string): void {
  fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
  fs.writeFileSync(MEMORY_FILE, content, 'utf-8');
}

/**
 * Create MEMORY.md with a default template if it doesn't exist.
 */
export function ensureMemoryFile(): void {
  if (fs.existsSync(MEMORY_FILE)) return;
  fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
  fs.writeFileSync(MEMORY_FILE, DEFAULT_TEMPLATE, 'utf-8');
}
