import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  chunkMarkdown,
  collectMemoryFiles,
  indexMemoryFiles,
  searchIndex,
  closeDb,
} from '../../src/core/memory-index.js';
import { WALNUT_HOME, MEMORY_DIR } from '../../src/constants.js';

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
  await fsp.mkdir(MEMORY_DIR, { recursive: true });
});

afterEach(async () => {
  closeDb();
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('chunkMarkdown', () => {
  it('splits content on ## headings', () => {
    const content = `# Title

Some intro text.

## Section One

Content of section one.

## Section Two

Content of section two.`;

    const chunks = chunkMarkdown(content);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // At least one chunk should contain "Section One"
    expect(chunks.some((c) => c.includes('Section One'))).toBe(true);
    expect(chunks.some((c) => c.includes('Section Two'))).toBe(true);
  });

  it('handles content shorter than target tokens', () => {
    const content = 'Short content here.';
    const chunks = chunkMarkdown(content);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('Short content');
  });

  it('splits long paragraphs', () => {
    // Create content that exceeds target tokens (~400 tokens ≈ ~307 words)
    const longParagraph = Array(400).fill('word').join(' ');
    const content = `## Big Section\n\n${longParagraph}`;
    const chunks = chunkMarkdown(content, 100);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('returns empty array for empty content', () => {
    expect(chunkMarkdown('')).toEqual([]);
    expect(chunkMarkdown('   ')).toEqual([]);
  });

  it('applies overlap between chunks', () => {
    // Create content with multiple sections that will produce multiple chunks
    const sections = Array(5)
      .fill(null)
      .map((_, i) => `## Section ${i}\n\n${'Word '.repeat(100)}`)
      .join('\n\n');
    const chunks = chunkMarkdown(sections, 80, 20);
    // With overlap, chunks after the first should share some words with the previous
    if (chunks.length > 1) {
      // The second chunk should start with overlap from the first
      const firstWords = chunks[0].split(/\s+/);
      const lastWordsOfFirst = firstWords.slice(-Math.floor(20 / 1.3));
      const secondChunkStart = chunks[1].split(/\s+/).slice(0, lastWordsOfFirst.length);
      // Some overlap words should appear at the start of the second chunk
      const overlap = lastWordsOfFirst.filter((w) => secondChunkStart.includes(w));
      expect(overlap.length).toBeGreaterThan(0);
    }
  });
});

describe('collectMemoryFiles', () => {
  it('collects .md files from memory directory', () => {
    fs.writeFileSync(path.join(MEMORY_DIR, 'test.md'), '# Test');
    const files = collectMemoryFiles();
    expect(files.some((f) => f.path.endsWith('test.md'))).toBe(true);
  });

  it('collects files from subdirectories', () => {
    const subdir = path.join(MEMORY_DIR, 'projects');
    fs.mkdirSync(subdir, { recursive: true });
    fs.writeFileSync(path.join(subdir, 'proj.md'), '# Project');
    const files = collectMemoryFiles();
    expect(files.some((f) => f.path.includes('proj.md'))).toBe(true);
  });

  it('collects global MEMORY.md', () => {
    fs.writeFileSync(path.join(WALNUT_HOME, 'MEMORY.md'), '# Global');
    const files = collectMemoryFiles();
    expect(files.some((f) => f.path === 'MEMORY.md')).toBe(true);
  });

  it('returns empty for nonexistent directories', async () => {
    await fsp.rm(MEMORY_DIR, { recursive: true, force: true });
    const files = collectMemoryFiles();
    expect(files).toEqual([]);
  });
});

describe('indexMemoryFiles', () => {
  it('creates DB and indexes files', () => {
    fs.writeFileSync(path.join(MEMORY_DIR, 'note.md'), '# Note\n\nSome content about testing.');
    indexMemoryFiles();

    const results = searchIndex('testing');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain('testing');
  });

  it('re-indexes changed files based on hash', () => {
    const filePath = path.join(MEMORY_DIR, 'changing.md');
    fs.writeFileSync(filePath, '# Original\n\nOriginal content about apples.');
    indexMemoryFiles();

    let results = searchIndex('apples');
    expect(results.length).toBeGreaterThan(0);

    // Modify the file
    fs.writeFileSync(filePath, '# Updated\n\nUpdated content about bananas.');
    indexMemoryFiles();

    results = searchIndex('bananas');
    expect(results.length).toBeGreaterThan(0);

    // Old content should no longer match
    results = searchIndex('apples');
    expect(results).toHaveLength(0);
  });

  it('removes deleted files from index', () => {
    const filePath = path.join(MEMORY_DIR, 'temporary.md');
    fs.writeFileSync(filePath, '# Temporary\n\nEphemeral content about rainbows.');
    indexMemoryFiles();

    let results = searchIndex('rainbows');
    expect(results.length).toBeGreaterThan(0);

    // Delete the file
    fs.unlinkSync(filePath);
    indexMemoryFiles();

    results = searchIndex('rainbows');
    expect(results).toHaveLength(0);
  });
});

describe('searchIndex', () => {
  it('returns ranked results', () => {
    fs.writeFileSync(path.join(MEMORY_DIR, 'a.md'), '# Alpha\n\nPython programming is great for data science.');
    fs.writeFileSync(path.join(MEMORY_DIR, 'b.md'), '# Beta\n\nJavaScript is used for web development.');
    indexMemoryFiles();

    const results = searchIndex('Python programming');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[0].text).toContain('Python');
  });

  it('returns empty for no matches', () => {
    fs.writeFileSync(path.join(MEMORY_DIR, 'x.md'), '# X\n\nContent about cats and dogs.');
    indexMemoryFiles();

    const results = searchIndex('xylophone');
    expect(results).toHaveLength(0);
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 15; i++) {
      fs.writeFileSync(path.join(MEMORY_DIR, `file${i}.md`), `# File ${i}\n\nDatabase indexing performance optimization.`);
    }
    indexMemoryFiles();

    const results = searchIndex('database', 5);
    expect(results.length).toBeLessThanOrEqual(5);
  });
});

describe('closeDb', () => {
  it('cleans up properly and allows re-opening', () => {
    fs.writeFileSync(path.join(MEMORY_DIR, 'close-test.md'), '# Close\n\nTesting database close.');
    indexMemoryFiles();
    closeDb();

    // After closing, we should be able to re-open and search
    indexMemoryFiles();
    const results = searchIndex('close');
    expect(results.length).toBeGreaterThan(0);
  });
});
