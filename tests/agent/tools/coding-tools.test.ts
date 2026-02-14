import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

let tmpDir: string;

vi.mock('../../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../../src/constants.js';
import { executeTool } from '../../../src/agent/tools.js';

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('read_file tool', () => {
  it('reads an existing text file with line numbers', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(filePath, 'line one\nline two\nline three\n', 'utf-8');

    const result = await executeTool('read_file', { path: filePath });
    expect(result).toContain('line one');
    expect(result).toContain('line two');
    expect(result).toContain('line three');
    // Should have line numbers
    expect(result).toMatch(/1\t/);
    expect(result).toMatch(/2\t/);
  });

  it('returns error for file not found', async () => {
    const result = await executeTool('read_file', { path: '/nonexistent/file.txt' });
    expect(result).toContain('Error:');
    expect(result).toContain('not found');
  });

  it('supports offset and limit for large files', async () => {
    const filePath = path.join(tmpDir, 'big.txt');
    await fs.mkdir(tmpDir, { recursive: true });
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
    await fs.writeFile(filePath, lines.join('\n'), 'utf-8');

    const result = await executeTool('read_file', { path: filePath, offset: 10, limit: 5 });
    expect(result).toContain('Line 10');
    expect(result).toContain('Line 14');
    expect(result).not.toContain('Line 9\n');
    expect(result).not.toContain('Line 15');
    expect(result).toContain('Showing lines 10');
  });

  it('returns inline image content for vision-supported image files', async () => {
    const filePath = path.join(tmpDir, 'photo.png');
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(filePath, Buffer.from('fake png data'));

    const result = await executeTool('read_file', { path: filePath });
    // Now returns array with image block + text block
    expect(Array.isArray(result)).toBe(true);
    const blocks = result as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('image');
    const source = blocks[0].source as Record<string, unknown>;
    expect(source.type).toBe('base64');
    expect(source.media_type).toBe('image/png');
    expect(typeof source.data).toBe('string');
    expect(blocks[1].type).toBe('text');
    expect(blocks[1].text).toContain('image/png');
    expect(blocks[1].text).toContain('bytes');
  });

  it('returns inline image content for jpg files', async () => {
    const filePath = path.join(tmpDir, 'photo.jpg');
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(filePath, Buffer.from('fake jpg data'));

    const result = await executeTool('read_file', { path: filePath });
    expect(Array.isArray(result)).toBe(true);
    const blocks = result as Array<Record<string, unknown>>;
    expect(blocks[0].type).toBe('image');
    const source = blocks[0].source as Record<string, unknown>;
    expect(source.media_type).toBe('image/jpeg');
  });

  it('returns metadata only for non-vision image types (svg)', async () => {
    const filePath = path.join(tmpDir, 'icon.svg');
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(filePath, '<svg></svg>');

    const result = await executeTool('read_file', { path: filePath });
    expect(typeof result).toBe('string');
    expect(result).toContain('[Image file:');
    expect(result).toContain('not a vision-supported format');
  });

  it('reads empty file without error', async () => {
    const filePath = path.join(tmpDir, 'empty.txt');
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(filePath, '', 'utf-8');

    const result = await executeTool('read_file', { path: filePath });
    // Should contain at least line 1 (empty)
    expect(result).toMatch(/1\t/);
  });

  it('returns error for directory path', async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    const result = await executeTool('read_file', { path: tmpDir });
    expect(result).toContain('Error:');
  });
});

describe('write_file tool', () => {
  it('creates a new file', async () => {
    const filePath = path.join(tmpDir, 'new-file.txt');

    const result = await executeTool('write_file', { path: filePath, content: 'hello world' });
    expect(result).toContain('File written:');
    expect(result).toContain(filePath);

    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('hello world');
  });

  it('creates nested directories automatically', async () => {
    const filePath = path.join(tmpDir, 'a', 'b', 'c', 'deep.txt');

    const result = await executeTool('write_file', { path: filePath, content: 'deep content' });
    expect(result).toContain('File written:');

    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('deep content');
  });

  it('overwrites an existing file', async () => {
    const filePath = path.join(tmpDir, 'overwrite.txt');
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(filePath, 'original', 'utf-8');

    const result = await executeTool('write_file', { path: filePath, content: 'replaced' });
    expect(result).toContain('File written:');

    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('replaced');
  });

  it('returns error for missing path', async () => {
    const result = await executeTool('write_file', { content: 'hello' } as any);
    expect(result).toContain('Error:');
  });
});

describe('edit_file tool', () => {
  const setupFile = async (content: string) => {
    const filePath = path.join(tmpDir, 'edit-target.txt');
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
    return filePath;
  };

  it('replaces a unique string', async () => {
    const filePath = await setupFile('Hello World\nGoodbye World\n');

    const result = await executeTool('edit_file', {
      path: filePath,
      old_string: 'Hello World',
      new_string: 'Hi World',
    });
    expect(result).toContain('File edited:');
    expect(result).toContain('1 replacement');

    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('Hi World\nGoodbye World\n');
  });

  it('returns error when old_string is not found', async () => {
    const filePath = await setupFile('Hello World\n');

    const result = await executeTool('edit_file', {
      path: filePath,
      old_string: 'NONEXISTENT',
      new_string: 'replacement',
    });
    expect(result).toContain('Error:');
    expect(result).toContain('not found');
  });

  it('returns error when old_string matches multiple times without replace_all', async () => {
    const filePath = await setupFile('foo bar foo baz foo\n');

    const result = await executeTool('edit_file', {
      path: filePath,
      old_string: 'foo',
      new_string: 'qux',
    });
    expect(result).toContain('Error:');
    expect(result).toContain('3 times');
    expect(result).toContain('replace_all');

    // File should be unchanged
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('foo bar foo baz foo\n');
  });

  it('replaces all occurrences with replace_all', async () => {
    const filePath = await setupFile('foo bar foo baz foo\n');

    const result = await executeTool('edit_file', {
      path: filePath,
      old_string: 'foo',
      new_string: 'qux',
      replace_all: true,
    });
    expect(result).toContain('File edited:');
    expect(result).toContain('3 replacement');

    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('qux bar qux baz qux\n');
  });

  it('returns error for nonexistent file', async () => {
    const result = await executeTool('edit_file', {
      path: '/nonexistent/file.txt',
      old_string: 'a',
      new_string: 'b',
    });
    expect(result).toContain('Error:');
    expect(result).toContain('not found');
  });

  it('handles multiline replacements', async () => {
    const filePath = await setupFile('function hello() {\n  return "hi";\n}\n');

    const result = await executeTool('edit_file', {
      path: filePath,
      old_string: 'function hello() {\n  return "hi";\n}',
      new_string: 'function hello() {\n  return "hello world";\n}',
    });
    expect(result).toContain('File edited:');

    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toContain('hello world');
  });

  it('can replace with empty string (deletion)', async () => {
    const filePath = await setupFile('keep this\nremove this\nkeep this too\n');

    const result = await executeTool('edit_file', {
      path: filePath,
      old_string: 'remove this\n',
      new_string: '',
    });
    expect(result).toContain('File edited:');

    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('keep this\nkeep this too\n');
  });
});
