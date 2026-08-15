import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

let tmpDir: string;

vi.mock('../../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME, MEMORY_FILE, PROJECTS_MEMORY_DIR, DAILY_DIR, GLOBAL_NOTES_FILE } from '../../../src/constants.js';
import { executeTool } from '../../../src/agent/tools.js';
import { getReadFileState } from '../../../src/agent/tools/files-tools.js';

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });
  // MEMORY_FILE moved into memory/ (bounded-memory redesign) — direct
  // fs.writeFile fixtures need the parent dir.
  await fs.mkdir(path.dirname(MEMORY_FILE), { recursive: true });
  getReadFileState().clear();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('file_read', () => {
  it('reads memory/global', async () => {
    await fs.writeFile(MEMORY_FILE, '# Global Memory\nSome content\n', 'utf-8');

    const result = await executeTool('file_read', { source: 'memory/global' });
    const parsed = JSON.parse(result as string);
    expect(parsed.content).toContain('Global Memory');
    expect(parsed.content_hash).toBeTruthy();
    expect(parsed.total_lines).toBeGreaterThan(0);
  });

  it('reads memory/project/{path}', async () => {
    const projDir = path.join(PROJECTS_MEMORY_DIR, 'work/api');
    await fs.mkdir(projDir, { recursive: true });
    await fs.writeFile(path.join(projDir, 'MEMORY.md'), '---\nname: Work API\ndescription: API project\n---\n# Logs\n', 'utf-8');

    const result = await executeTool('file_read', { source: 'memory/project/work/api' });
    const parsed = JSON.parse(result as string);
    expect(parsed.content).toContain('Work API');
  });

  it('reads memory/daily (creates if needed)', async () => {
    // Daily log doesn't exist yet
    const result = await executeTool('file_read', { source: 'memory/daily' });
    expect(result).toContain('not found');
  });

  it('reads notes/global', async () => {
    await fs.mkdir(path.dirname(GLOBAL_NOTES_FILE), { recursive: true });
    await fs.writeFile(GLOBAL_NOTES_FILE, '# My Notes\n- [ ] Buy groceries\n', 'utf-8');

    const result = await executeTool('file_read', { source: 'notes/global' });
    const parsed = JSON.parse(result as string);
    expect(parsed.content).toContain('My Notes');
    expect(parsed.content_hash).toBeTruthy();
  });

  it('reads absolute file path', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    await fs.writeFile(filePath, 'Hello world\nLine 2\n', 'utf-8');

    const result = await executeTool('file_read', { source: filePath });
    const parsed = JSON.parse(result as string);
    expect(parsed.content).toContain('Hello world');
    expect(parsed.content).toContain('Line 2');
  });

  it('supports offset and limit', async () => {
    const filePath = path.join(tmpDir, 'big.txt');
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`);
    await fs.writeFile(filePath, lines.join('\n'), 'utf-8');

    const result = await executeTool('file_read', { source: filePath, offset: 10, limit: 5 });
    const parsed = JSON.parse(result as string);
    expect(parsed.content).toContain('Line 10');
    expect(parsed.content).toContain('Line 14');
    expect(parsed.showing).toContain('10-14');
  });

  it('supports parse=true for structured extraction', async () => {
    const filePath = path.join(tmpDir, 'doc.md');
    await fs.writeFile(filePath, `---
name: Test
---
# Title
## Section
- [ ] Todo 1
- [x] Done 1
[Link](https://example.com)
<task-ref id="t123" label="My Task"/>
`, 'utf-8');

    const result = await executeTool('file_read', { source: filePath, parse: true });
    const parsed = JSON.parse(result as string);
    expect(parsed.parsed).toBeDefined();
    expect(parsed.parsed.frontmatter).toEqual({ name: 'Test' });
    expect(parsed.parsed.headers).toHaveLength(2);
    expect(parsed.parsed.todos).toHaveLength(2);
    expect(parsed.parsed.links).toHaveLength(1);
    expect(parsed.parsed.task_refs).toHaveLength(1);
    expect(parsed.parsed.task_refs[0].id).toBe('t123');
  });

  it('returns error for nonexistent source', async () => {
    const result = await executeTool('file_read', { source: '/nonexistent/file.txt' });
    expect(result).toContain('Error:');
  });

  it('returns error for invalid source pattern', async () => {
    const result = await executeTool('file_read', { source: 'invalid/pattern' });
    expect(result).toContain('Error:');
  });
});

describe('file_write', () => {
  it('writes (overwrite) to memory/global with hash', async () => {
    await fs.writeFile(MEMORY_FILE, 'old content', 'utf-8');

    // Read to get hash
    const readResult = await executeTool('file_read', { source: 'memory/global' });
    const { content_hash } = JSON.parse(readResult as string);

    // Write with hash
    const writeResult = await executeTool('file_write', {
      source: 'memory/global',
      content: 'new content',
      content_hash,
    });
    const parsed = JSON.parse(writeResult as string);
    expect(parsed.status).toBe('updated');
    expect(parsed.content_hash).toBeTruthy();

    // Verify
    const actual = await fs.readFile(MEMORY_FILE, 'utf-8');
    expect(actual).toBe('new content');
  });

  it('rejects overwrite without hash on memory sources', async () => {
    await fs.writeFile(MEMORY_FILE, 'content', 'utf-8');

    const result = await executeTool('file_write', {
      source: 'memory/global',
      content: 'new',
    });
    expect(result).toContain('Error:');
    expect(result).toContain('content_hash');
  });

  it('appends to memory/daily', async () => {
    await fs.mkdir(DAILY_DIR, { recursive: true });

    const result = await executeTool('file_write', {
      source: 'memory/daily',
      content: 'Test entry',
      mode: 'append',
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.status).toBe('saved');
  });

  it('writes to notes/global', async () => {
    // Create new note (no hash needed for new files)
    const result = await executeTool('file_write', {
      source: 'notes/global',
      content: '# My Notes\n',
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.status).toBe('created');

    const actual = await fs.readFile(GLOBAL_NOTES_FILE, 'utf-8');
    expect(actual).toBe('# My Notes\n');
  });

  it('writes to absolute file path', async () => {
    const filePath = path.join(tmpDir, 'output.txt');

    const result = await executeTool('file_write', {
      source: filePath,
      content: 'file content',
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.status).toBe('updated');

    const actual = await fs.readFile(filePath, 'utf-8');
    expect(actual).toBe('file content');
  });

  it('appends to absolute file path', async () => {
    const filePath = path.join(tmpDir, 'append.txt');
    await fs.writeFile(filePath, 'first\n', 'utf-8');
    await executeTool('file_read', { source: filePath });

    const result = await executeTool('file_write', {
      source: filePath,
      content: 'second\n',
      mode: 'append',
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.status).toBe('appended');

    const actual = await fs.readFile(filePath, 'utf-8');
    expect(actual).toBe('first\nsecond\n');
  });
});

describe('file_edit', () => {
  it('edits memory/global with hash', async () => {
    await fs.writeFile(MEMORY_FILE, 'Hello world\n', 'utf-8');

    const readResult = await executeTool('file_read', { source: 'memory/global' });
    const { content_hash } = JSON.parse(readResult as string);

    const editResult = await executeTool('file_edit', {
      source: 'memory/global',
      old_content: 'Hello',
      new_content: 'Goodbye',
      content_hash,
    });
    const parsed = JSON.parse(editResult as string);
    expect(parsed.status).toBe('updated');
    expect(parsed.replacements).toBe(1);

    const actual = await fs.readFile(MEMORY_FILE, 'utf-8');
    expect(actual).toBe('Goodbye world\n');
  });

  it('rejects edit without hash on memory sources', async () => {
    await fs.writeFile(MEMORY_FILE, 'content', 'utf-8');

    const result = await executeTool('file_edit', {
      source: 'memory/global',
      old_content: 'content',
      new_content: 'new',
    });
    expect(result).toContain('Error:');
    expect(result).toContain('content_hash');
  });

  it('edits absolute file path (hash optional)', async () => {
    const filePath = path.join(tmpDir, 'edit.txt');
    await fs.writeFile(filePath, 'foo bar baz\n', 'utf-8');
    await executeTool('file_read', { source: filePath });

    const result = await executeTool('file_edit', {
      source: filePath,
      old_content: 'bar',
      new_content: 'qux',
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.status).toBe('updated');

    const actual = await fs.readFile(filePath, 'utf-8');
    expect(actual).toBe('foo qux baz\n');
  });

  it('supports replace_all', async () => {
    const filePath = path.join(tmpDir, 'multi.txt');
    await fs.writeFile(filePath, 'aaa bbb aaa ccc aaa\n', 'utf-8');
    await executeTool('file_read', { source: filePath });

    const result = await executeTool('file_edit', {
      source: filePath,
      old_content: 'aaa',
      new_content: 'xxx',
      replace_all: true,
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.replacements).toBe(3);

    const actual = await fs.readFile(filePath, 'utf-8');
    expect(actual).toBe('xxx bbb xxx ccc xxx\n');
  });

  it('returns error for content not found', async () => {
    const filePath = path.join(tmpDir, 'nope.txt');
    await fs.writeFile(filePath, 'hello\n', 'utf-8');
    await executeTool('file_read', { source: filePath });

    const result = await executeTool('file_edit', {
      source: filePath,
      old_content: 'nonexistent',
      new_content: 'x',
    });
    expect(result).toContain('Error:');
    expect(result).toContain('not found');
  });
});

describe('file_list', () => {
  it('lists memory/project summaries', async () => {
    // Create a project memory
    const projDir = path.join(PROJECTS_MEMORY_DIR, 'passion/walnut');
    await fs.mkdir(projDir, { recursive: true });
    await fs.writeFile(
      path.join(projDir, 'MEMORY.md'),
      '---\nname: Walnut\ndescription: Personal Personal AI\n---\n',
      'utf-8',
    );

    const result = await executeTool('file_list', { prefix: 'memory/project' });
    const parsed = JSON.parse(result as string);
    expect(parsed).toBeInstanceOf(Array);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0].source).toContain('memory/project/');
    expect(parsed[0].name).toBe('Walnut');
  });

  it('lists memory/daily logs', async () => {
    await fs.mkdir(DAILY_DIR, { recursive: true });
    await fs.writeFile(path.join(DAILY_DIR, '2026-03-25.md'), 'log content', 'utf-8');
    await fs.writeFile(path.join(DAILY_DIR, '2026-03-24.md'), 'older log', 'utf-8');

    const result = await executeTool('file_list', { prefix: 'memory/daily' });
    const parsed = JSON.parse(result as string);
    expect(parsed).toBeInstanceOf(Array);
    expect(parsed.length).toBe(2);
    // Most recent first
    expect(parsed[0].source).toContain('2026-03-25');
  });

  it('lists notes', async () => {
    // Create global notes (GLOBAL_NOTES_FILE is inside notes/ dir)
    const notesDir = path.join(tmpDir, 'notes');
    await fs.mkdir(notesDir, { recursive: true });
    await fs.writeFile(GLOBAL_NOTES_FILE, '# Notes\n', 'utf-8');
    await fs.writeFile(path.join(notesDir, 'recipes.md'), '# Recipes\n', 'utf-8');

    const result = await executeTool('file_list', { prefix: 'notes' });
    const parsed = JSON.parse(result as string);
    expect(parsed).toBeInstanceOf(Array);
    expect(parsed.length).toBe(2); // global + recipes
    expect(parsed.some((i: { source: string }) => i.source === 'notes/global')).toBe(true);
    expect(parsed.some((i: { source: string }) => i.source === 'notes/recipes')).toBe(true);
  });

  it('lists directory for absolute path', async () => {
    const dir = path.join(tmpDir, 'mydir');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'a.txt'), 'aaa', 'utf-8');
    await fs.mkdir(path.join(dir, 'subdir'));

    const result = await executeTool('file_list', { prefix: dir });
    const parsed = JSON.parse(result as string);
    expect(parsed).toBeInstanceOf(Array);
    expect(parsed.length).toBe(2);
    const names = parsed.map((i: { name: string }) => i.name);
    expect(names).toContain('a.txt');
    expect(names).toContain('subdir');
  });

  it('returns message for empty prefix', async () => {
    const result = await executeTool('file_list', { prefix: 'memory/daily' });
    // DAILY_DIR doesn't exist yet → "No items found"
    expect(result).toContain('No items');
  });
});
