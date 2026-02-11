import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

vi.mock('../../src/constants.js', () => createMockConstants());

import { slugify, saveMemory, getMemory, listMemories, getRecentMemories, deleteMemory, getMemoryPath } from '../../src/core/memory.js';
import { WALNUT_HOME } from '../../src/constants.js';

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('slugify', () => {
  it('converts to lowercase', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('replaces non-alphanumeric with dashes', () => {
    expect(slugify('My Task #1!')).toBe('my-task-1');
  });

  it('trims leading and trailing dashes', () => {
    expect(slugify('---test---')).toBe('test');
  });

  it('truncates to 80 characters', () => {
    const long = 'a'.repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(80);
  });

  it('handles empty string', () => {
    expect(slugify('')).toBe('');
  });
});

describe('getMemoryPath', () => {
  it('returns path for knowledge category', () => {
    const p = getMemoryPath('knowledge', 'my-note');
    expect(p).toContain('knowledge');
    expect(p).toContain('my-note.md');
  });

  it('returns path for session category', () => {
    const p = getMemoryPath('session', 'my-session');
    expect(p).toContain('sessions');
    expect(p).toContain('my-session.md');
  });

  it('returns path for project category', () => {
    const p = getMemoryPath('project', 'my-project');
    expect(p).toContain('projects');
    expect(p).toContain('my-project.md');
  });
});

describe('saveMemory', () => {
  it('creates file in correct directory', () => {
    const filePath = saveMemory('knowledge', 'test-note', '# Test Note\n\nContent here.');
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('# Test Note');
  });

  it('creates directories if needed', () => {
    const filePath = saveMemory('knowledge', 'deep-note', 'Content');
    expect(fs.existsSync(filePath)).toBe(true);
  });
});

describe('getMemory', () => {
  it('reads back a saved memory', () => {
    saveMemory('knowledge', 'recall-test', '# Recall Test\n\nBody text.');
    const mem = getMemory('knowledge/recall-test.md');
    expect(mem).not.toBeNull();
    expect(mem!.title).toBe('Recall Test');
    expect(mem!.content).toContain('Body text.');
    expect(mem!.category).toBe('knowledge');
  });

  it('returns null for non-existent file', () => {
    expect(getMemory('knowledge/nonexistent.md')).toBeNull();
  });

  it('extracts title from heading', () => {
    saveMemory('knowledge', 'titled', '# My Title\n\nStuff');
    const mem = getMemory('knowledge/titled.md');
    expect(mem!.title).toBe('My Title');
  });

  it('uses filename as title when no heading', () => {
    saveMemory('knowledge', 'no-heading', 'Just plain content without heading.');
    const mem = getMemory('knowledge/no-heading.md');
    expect(mem!.title).toBe('no-heading');
  });
});

describe('listMemories', () => {
  it('lists all memories across categories', () => {
    saveMemory('knowledge', 'note1', '# Note 1');
    saveMemory('session', 'sess1', '# Session 1');
    saveMemory('project', 'proj1', '# Project 1');

    const all = listMemories();
    expect(all.length).toBe(3);
  });

  it('filters by category', () => {
    saveMemory('knowledge', 'note1', '# Note 1');
    saveMemory('session', 'sess1', '# Session 1');

    const knowledge = listMemories('knowledge');
    expect(knowledge.length).toBe(1);
    expect(knowledge[0].category).toBe('knowledge');
  });

  it('returns empty array for empty directories', () => {
    const result = listMemories();
    expect(result).toEqual([]);
  });

  it('returns empty for unknown category', () => {
    const result = listMemories('nonexistent_category');
    expect(result).toEqual([]);
  });
});

describe('getRecentMemories', () => {
  it('returns memories sorted by updatedAt descending', () => {
    saveMemory('knowledge', 'older', '# Older');
    saveMemory('knowledge', 'newer', '# Newer');

    const recent = getRecentMemories(10);
    expect(recent.length).toBe(2);
    // Most recently modified should be first
    expect(recent[0].title).toBe('Newer');
  });

  it('respects limit', () => {
    saveMemory('knowledge', 'a', '# A');
    saveMemory('knowledge', 'b', '# B');
    saveMemory('knowledge', 'c', '# C');

    const recent = getRecentMemories(2);
    expect(recent.length).toBe(2);
  });
});

describe('deleteMemory', () => {
  it('deletes existing memory', () => {
    saveMemory('knowledge', 'to-delete', '# Delete me');
    const result = deleteMemory('knowledge/to-delete.md');
    expect(result).toBe(true);
    expect(getMemory('knowledge/to-delete.md')).toBeNull();
  });

  it('returns false for non-existent file', () => {
    const result = deleteMemory('knowledge/nonexistent.md');
    expect(result).toBe(false);
  });
});
