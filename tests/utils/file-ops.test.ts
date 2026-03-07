import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  computeContentHash,
  readFileWithMeta,
  editFileContent,
  writeFileChecked,
  StaleHashError,
  ContentNotFoundError,
  AmbiguousMatchError,
} from '../../src/utils/file-ops.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `file-ops-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fsp.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('computeContentHash', () => {
  it('returns deterministic 12-char hex', () => {
    const hash1 = computeContentHash('hello world');
    const hash2 = computeContentHash('hello world');
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(12);
    expect(hash1).toMatch(/^[0-9a-f]{12}$/);
  });

  it('different content produces different hash', () => {
    expect(computeContentHash('aaa')).not.toBe(computeContentHash('bbb'));
  });

  it('handles empty string', () => {
    const hash = computeContentHash('');
    expect(hash).toHaveLength(12);
  });
});

describe('readFileWithMeta', () => {
  it('reads file with line numbers and hash', async () => {
    const filePath = path.join(tmpDir, 'test.md');
    await fsp.writeFile(filePath, 'line1\nline2\nline3\n', 'utf-8');

    const result = await readFileWithMeta(filePath);

    expect(result.totalLines).toBe(4); // trailing newline = empty last line
    expect(result.contentHash).toHaveLength(12);
    expect(result.content).toContain('     1\tline1');
    expect(result.content).toContain('     2\tline2');
    expect(result.content).toContain('     3\tline3');
    expect(result.showing).toBe('1-4 of 4');
  });

  it('hash is computed on full content, not slice', async () => {
    const filePath = path.join(tmpDir, 'test.md');
    const fullContent = 'line1\nline2\nline3\nline4\nline5\n';
    await fsp.writeFile(filePath, fullContent, 'utf-8');

    const fullRead = await readFileWithMeta(filePath);
    const sliced = await readFileWithMeta(filePath, { offset: 2, limit: 2 });

    // Hash should be the same regardless of slice
    expect(sliced.contentHash).toBe(fullRead.contentHash);
    expect(sliced.contentHash).toBe(computeContentHash(fullContent));
  });

  it('respects offset and limit', async () => {
    const filePath = path.join(tmpDir, 'test.md');
    await fsp.writeFile(filePath, 'a\nb\nc\nd\ne\n', 'utf-8');

    const result = await readFileWithMeta(filePath, { offset: 2, limit: 2 });

    expect(result.content).toContain('     2\tb');
    expect(result.content).toContain('     3\tc');
    expect(result.content).not.toContain('     1\ta');
    expect(result.content).not.toContain('     4\td');
    expect(result.showing).toBe('2-3 of 6');
  });

  it('offset defaults to 1 when not specified', async () => {
    const filePath = path.join(tmpDir, 'test.md');
    await fsp.writeFile(filePath, 'first\nsecond\n', 'utf-8');

    const result = await readFileWithMeta(filePath);
    expect(result.content).toContain('     1\tfirst');
  });

  it('throws on missing file', async () => {
    await expect(readFileWithMeta(path.join(tmpDir, 'nope.txt'))).rejects.toThrow();
  });
});

describe('editFileContent', () => {
  it('replaces exact match and returns new hash', async () => {
    const filePath = path.join(tmpDir, 'edit.md');
    await fsp.writeFile(filePath, 'hello world', 'utf-8');
    const oldHash = computeContentHash('hello world');

    const result = await editFileContent(filePath, 'world', 'earth', {
      expectedHash: oldHash,
    });

    expect(result.replacements).toBe(1);
    expect(result.contentHash).toBe(computeContentHash('hello earth'));

    const content = await fsp.readFile(filePath, 'utf-8');
    expect(content).toBe('hello earth');
  });

  it('rejects stale hash', async () => {
    const filePath = path.join(tmpDir, 'edit.md');
    await fsp.writeFile(filePath, 'original', 'utf-8');

    try {
      await editFileContent(filePath, 'original', 'new', {
        expectedHash: 'wrong_hash_00',
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StaleHashError);
      expect((err as StaleHashError).currentHash).toBe(computeContentHash('original'));
    }
  });

  it('skips hash check when expectedHash is undefined', async () => {
    const filePath = path.join(tmpDir, 'edit.md');
    await fsp.writeFile(filePath, 'hello world', 'utf-8');

    const result = await editFileContent(filePath, 'world', 'earth');

    expect(result.replacements).toBe(1);
    expect(await fsp.readFile(filePath, 'utf-8')).toBe('hello earth');
  });

  it('throws ContentNotFoundError when old_content missing', async () => {
    const filePath = path.join(tmpDir, 'edit.md');
    await fsp.writeFile(filePath, 'hello world', 'utf-8');

    await expect(
      editFileContent(filePath, 'nonexistent', 'replacement'),
    ).rejects.toThrow(ContentNotFoundError);
  });

  it('throws AmbiguousMatchError on multiple matches without replace_all', async () => {
    const filePath = path.join(tmpDir, 'edit.md');
    await fsp.writeFile(filePath, 'foo bar foo baz foo', 'utf-8');

    try {
      await editFileContent(filePath, 'foo', 'qux');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AmbiguousMatchError);
      expect((err as AmbiguousMatchError).matchCount).toBe(3);
    }
  });

  it('replace_all replaces all occurrences', async () => {
    const filePath = path.join(tmpDir, 'edit.md');
    await fsp.writeFile(filePath, 'foo bar foo baz foo', 'utf-8');

    const result = await editFileContent(filePath, 'foo', 'qux', { replaceAll: true });

    expect(result.replacements).toBe(3);
    expect(await fsp.readFile(filePath, 'utf-8')).toBe('qux bar qux baz qux');
  });

  it('empty replacement deletes content and collapses blank lines', async () => {
    const filePath = path.join(tmpDir, 'edit.md');
    await fsp.writeFile(filePath, 'keep\n\nremove me\n\nkeep too', 'utf-8');
    const hash = computeContentHash('keep\n\nremove me\n\nkeep too');

    await editFileContent(filePath, 'remove me', '', { expectedHash: hash });

    const content = await fsp.readFile(filePath, 'utf-8');
    expect(content).not.toContain('remove me');
    // Should not have 3+ consecutive newlines
    expect(content).not.toMatch(/\n{3,}/);
  });

  it('supports chained edits with hash from previous result', async () => {
    const filePath = path.join(tmpDir, 'chain.md');
    await fsp.writeFile(filePath, 'aaa bbb ccc', 'utf-8');
    const hash0 = computeContentHash('aaa bbb ccc');

    const r1 = await editFileContent(filePath, 'aaa', 'AAA', { expectedHash: hash0 });
    const r2 = await editFileContent(filePath, 'bbb', 'BBB', { expectedHash: r1.contentHash });
    const r3 = await editFileContent(filePath, 'ccc', 'CCC', { expectedHash: r2.contentHash });

    expect(await fsp.readFile(filePath, 'utf-8')).toBe('AAA BBB CCC');
    expect(r3.contentHash).toBe(computeContentHash('AAA BBB CCC'));
  });
});

describe('writeFileChecked', () => {
  it('writes content and returns hash', async () => {
    const filePath = path.join(tmpDir, 'write.md');
    await fsp.writeFile(filePath, 'old', 'utf-8');
    const oldHash = computeContentHash('old');

    const result = await writeFileChecked(filePath, 'new content', {
      expectedHash: oldHash,
    });

    expect(result.contentHash).toBe(computeContentHash('new content'));
    expect(await fsp.readFile(filePath, 'utf-8')).toBe('new content');
  });

  it('rejects stale hash', async () => {
    const filePath = path.join(tmpDir, 'write.md');
    await fsp.writeFile(filePath, 'original', 'utf-8');

    try {
      await writeFileChecked(filePath, 'new', { expectedHash: 'wrong_hash_00' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StaleHashError);
    }

    // File should be unchanged
    expect(await fsp.readFile(filePath, 'utf-8')).toBe('original');
  });

  it('creates file when no hash required', async () => {
    const filePath = path.join(tmpDir, 'subdir', 'new.md');

    const result = await writeFileChecked(filePath, 'brand new');

    expect(result.contentHash).toBe(computeContentHash('brand new'));
    expect(await fsp.readFile(filePath, 'utf-8')).toBe('brand new');
  });

  it('throws when hash provided but file does not exist', async () => {
    const filePath = path.join(tmpDir, 'ghost.md');

    await expect(
      writeFileChecked(filePath, 'content', { expectedHash: 'abc123def456' }),
    ).rejects.toThrow(StaleHashError);
  });

  it('skips hash check when expectedHash is undefined', async () => {
    const filePath = path.join(tmpDir, 'write.md');
    await fsp.writeFile(filePath, 'old', 'utf-8');

    const result = await writeFileChecked(filePath, 'overwritten');
    expect(result.contentHash).toBe(computeContentHash('overwritten'));
    expect(await fsp.readFile(filePath, 'utf-8')).toBe('overwritten');
  });
});
