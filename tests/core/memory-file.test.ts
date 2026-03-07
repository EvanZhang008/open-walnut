import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  getMemoryFile,
  updateMemoryFile,
  ensureMemoryFile,
  editMemoryFile,
} from '../../src/core/memory-file.js';
import { WALNUT_HOME, MEMORY_FILE } from '../../src/constants.js';

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('ensureMemoryFile', () => {
  it('creates template file when not exists', () => {
    ensureMemoryFile();
    expect(fs.existsSync(MEMORY_FILE)).toBe(true);
    const content = fs.readFileSync(MEMORY_FILE, 'utf-8');
    expect(content).toContain('name: Global Memory');
    expect(content).toContain('---');
  });

  it('does not overwrite existing file', () => {
    fs.writeFileSync(MEMORY_FILE, 'Custom content', 'utf-8');
    ensureMemoryFile();
    const content = fs.readFileSync(MEMORY_FILE, 'utf-8');
    expect(content).toBe('Custom content');
  });
});

describe('getMemoryFile', () => {
  it('reads content and hash of existing file', () => {
    fs.writeFileSync(MEMORY_FILE, 'Test memory content', 'utf-8');
    const result = getMemoryFile();
    expect(result).not.toBeNull();
    expect(result!.content).toBe('Test memory content');
    expect(result!.contentHash).toHaveLength(12);
  });

  it('returns null when file does not exist', () => {
    const result = getMemoryFile();
    expect(result).toBeNull();
  });
});

describe('updateMemoryFile', () => {
  it('replaces content of existing file', async () => {
    fs.writeFileSync(MEMORY_FILE, 'Old content', 'utf-8');
    const result = await updateMemoryFile('New content');
    const content = fs.readFileSync(MEMORY_FILE, 'utf-8');
    expect(content).toBe('New content');
    expect(result.contentHash).toHaveLength(12);
  });

  it('creates file if it does not exist', async () => {
    const result = await updateMemoryFile('Brand new content');
    expect(fs.existsSync(MEMORY_FILE)).toBe(true);
    const content = fs.readFileSync(MEMORY_FILE, 'utf-8');
    expect(content).toBe('Brand new content');
    expect(result.contentHash).toHaveLength(12);
  });

  it('validates hash when provided', async () => {
    fs.writeFileSync(MEMORY_FILE, 'Old content', 'utf-8');
    const { contentHash } = getMemoryFile()!;

    await expect(
      updateMemoryFile('New content', 'wrong_hash_00'),
    ).rejects.toThrow('Stale content_hash');

    // Valid hash should work
    const result = await updateMemoryFile('New content', contentHash);
    expect(result.contentHash).toHaveLength(12);
  });
});

describe('editMemoryFile', () => {
  it('edits content by exact match', async () => {
    fs.writeFileSync(MEMORY_FILE, 'hello world', 'utf-8');
    const { contentHash } = getMemoryFile()!;

    const result = await editMemoryFile('world', 'earth', contentHash);
    expect(result.replacements).toBe(1);
    expect(fs.readFileSync(MEMORY_FILE, 'utf-8')).toBe('hello earth');
  });

  it('rejects stale hash', async () => {
    fs.writeFileSync(MEMORY_FILE, 'hello world', 'utf-8');

    await expect(
      editMemoryFile('world', 'earth', 'wrong_hash_00'),
    ).rejects.toThrow('Stale content_hash');
  });
});
