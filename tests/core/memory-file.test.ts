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
  it('reads content of existing file', () => {
    fs.writeFileSync(MEMORY_FILE, 'Test memory content', 'utf-8');
    const content = getMemoryFile();
    expect(content).toBe('Test memory content');
  });

  it('returns null when file does not exist', () => {
    const content = getMemoryFile();
    expect(content).toBeNull();
  });
});

describe('updateMemoryFile', () => {
  it('replaces content of existing file', () => {
    fs.writeFileSync(MEMORY_FILE, 'Old content', 'utf-8');
    updateMemoryFile('New content');
    const content = fs.readFileSync(MEMORY_FILE, 'utf-8');
    expect(content).toBe('New content');
  });

  it('creates file if it does not exist', () => {
    updateMemoryFile('Brand new content');
    expect(fs.existsSync(MEMORY_FILE)).toBe(true);
    const content = fs.readFileSync(MEMORY_FILE, 'utf-8');
    expect(content).toBe('Brand new content');
  });
});
