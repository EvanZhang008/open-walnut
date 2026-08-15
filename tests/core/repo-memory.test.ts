import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  ensureRepoMemoryDir,
  getRepoMemory,
  appendRepoMemory,
  editRepoMemory,
  writeRepoMemory,
  getAllRepoMemorySummaries,
  resolveRepoMemoryPath,
  REPO_MEMORY_MAX_LINES,
} from '../../src/core/repo-memory.js';
import { WALNUT_HOME, REPOS_MEMORY_DIR } from '../../src/constants.js';

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('ensureRepoMemoryDir', () => {
  it('creates directory and SKILL.md template', () => {
    ensureRepoMemoryDir('walnut');
    const dirPath = path.join(REPOS_MEMORY_DIR, 'walnut');
    expect(fs.existsSync(dirPath)).toBe(true);
    const memFile = path.join(dirPath, 'SKILL.md');
    expect(fs.existsSync(memFile)).toBe(true);
    const content = fs.readFileSync(memFile, 'utf-8');
    expect(content).toContain('name: walnut');
    expect(content).toContain('Environment knowledge for walnut');
  });

  it('does not overwrite existing SKILL.md', () => {
    ensureRepoMemoryDir('walnut');
    const memFile = path.join(REPOS_MEMORY_DIR, 'walnut', 'SKILL.md');
    fs.writeFileSync(memFile, 'Custom content', 'utf-8');
    ensureRepoMemoryDir('walnut');
    const content = fs.readFileSync(memFile, 'utf-8');
    expect(content).toBe('Custom content');
  });

  it('rejects slug with path traversal', () => {
    expect(() => ensureRepoMemoryDir('..')).toThrow('Invalid repo slug');
    expect(() => ensureRepoMemoryDir('../evil')).toThrow('Invalid repo slug');
  });

  it('rejects slug with slashes', () => {
    expect(() => ensureRepoMemoryDir('foo/bar')).toThrow('Invalid repo slug');
    expect(() => ensureRepoMemoryDir('foo\\bar')).toThrow('Invalid repo slug');
  });

  it('rejects empty slug', () => {
    expect(() => ensureRepoMemoryDir('')).toThrow('Invalid repo slug');
  });
});

describe('getRepoMemory', () => {
  it('returns content and hash', () => {
    ensureRepoMemoryDir('walnut');
    appendRepoMemory('walnut', 'Build with npm run build', 'agent');

    const result = getRepoMemory('walnut');
    expect(result).not.toBeNull();
    expect(result!.content).toContain('Build with npm run build');
    expect(result!.contentHash).toHaveLength(12);
  });

  it('returns null for non-existent repo', () => {
    const result = getRepoMemory('nonexistent');
    expect(result).toBeNull();
  });
});

describe('appendRepoMemory', () => {
  it('creates repo dir if needed and appends timestamped entry', () => {
    appendRepoMemory('my-monorepo', 'Monorepo uses custom build tool', 'agent');

    const result = getRepoMemory('my-monorepo');
    expect(result).not.toBeNull();
    expect(result!.content).toContain('Monorepo uses custom build tool');
    expect(result!.content).toMatch(/## \d{4}-\d{2}-\d{2} \d{2}:\d{2} — agent/);
  });

  it('appends multiple entries sequentially', () => {
    appendRepoMemory('walnut', 'Entry 1', 'agent');
    appendRepoMemory('walnut', 'Entry 2', 'session');
    appendRepoMemory('walnut', 'Entry 3', 'agent');

    const result = getRepoMemory('walnut');
    expect(result!.content).toContain('Entry 1');
    expect(result!.content).toContain('Entry 2');
    expect(result!.content).toContain('Entry 3');
    expect(result!.content).toContain('— session');
  });

  it('defaults source to agent', () => {
    appendRepoMemory('walnut', 'Test content');

    const result = getRepoMemory('walnut');
    expect(result!.content).toContain('— agent');
  });
});

describe('editRepoMemory', () => {
  it('replaces matched text', async () => {
    appendRepoMemory('walnut', 'Old build command: npm run build', 'agent');
    const result = await editRepoMemory(
      'walnut',
      'Old build command: npm run build',
      'New build command: npm run build:prod',
    );
    expect(result.replacements).toBe(1);

    const content = getRepoMemory('walnut')!;
    expect(content.content).toContain('New build command: npm run build:prod');
    expect(content.content).not.toContain('Old build command');
  });

  it('rejects empty old_content', async () => {
    appendRepoMemory('walnut', 'Some content', 'agent');
    await expect(editRepoMemory('walnut', '', 'new')).rejects.toThrow('cannot be empty');
  });
});

describe('writeRepoMemory', () => {
  it('overwrites with hash check', async () => {
    ensureRepoMemoryDir('walnut');
    const initial = getRepoMemory('walnut')!;

    const result = await writeRepoMemory('walnut', '---\nname: walnut\n---\nNew content\n', initial.contentHash);
    expect(result.contentHash).toHaveLength(12);

    const updated = getRepoMemory('walnut')!;
    expect(updated.content).toBe('---\nname: walnut\n---\nNew content\n');
  });

  it('rejects stale hash', async () => {
    ensureRepoMemoryDir('walnut');
    await expect(writeRepoMemory('walnut', 'new content', 'wrong-hash-12')).rejects.toThrow();
  });
});

describe('getAllRepoMemorySummaries', () => {
  it('lists all repo memories with metadata', () => {
    ensureRepoMemoryDir('walnut');
    ensureRepoMemoryDir('my-monorepo');

    const summaries = getAllRepoMemorySummaries();
    expect(summaries).toHaveLength(2);

    const slugs = summaries.map((s) => s.slug).sort();
    expect(slugs).toEqual(['my-monorepo', 'walnut']);

    const walnut = summaries.find((s) => s.slug === 'walnut')!;
    expect(walnut.name).toBe('walnut');
    expect(walnut.description).toContain('Environment knowledge');
  });

  it('returns empty when no repos exist', () => {
    const summaries = getAllRepoMemorySummaries();
    expect(summaries).toEqual([]);
  });

  it('reads custom YAML frontmatter', () => {
    ensureRepoMemoryDir('walnut');
    const memFile = path.join(REPOS_MEMORY_DIR, 'walnut', 'SKILL.md');
    fs.writeFileSync(memFile, `---\nname: Open Walnut\ndescription: Personal Personal AI codebase\n---\n`, 'utf-8');

    const summaries = getAllRepoMemorySummaries();
    const walnut = summaries.find((s) => s.slug === 'walnut')!;
    expect(walnut.name).toBe('Open Walnut');
    expect(walnut.description).toBe('Personal Personal AI codebase');
  });
});

describe('resolveRepoMemoryPath', () => {
  it('returns absolute path to SKILL.md', () => {
    const p = resolveRepoMemoryPath('walnut');
    expect(p).toBe(path.join(REPOS_MEMORY_DIR, 'walnut', 'SKILL.md'));
  });

  it('rejects invalid slugs', () => {
    expect(() => resolveRepoMemoryPath('../evil')).toThrow('Invalid repo slug');
    expect(() => resolveRepoMemoryPath('foo/bar')).toThrow('Invalid repo slug');
  });
});

describe('REPO_MEMORY_MAX_LINES', () => {
  it('is defined as a reasonable limit', () => {
    expect(REPO_MEMORY_MAX_LINES).toBe(200);
  });
});
