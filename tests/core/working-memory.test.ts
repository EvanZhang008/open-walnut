import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  WALNUT_HOME,
  WORKING_MEMORY_FILE,
  COMPACTION_DIR,
} from '../../src/constants.js';
import {
  ensureWorkingMemory,
  getWorkingMemory,
  isWorkingMemoryEmpty,
  getWorkingMemorySectionSizes,
  truncateWorkingMemoryForCompact,
  snapshotWorkingMemory,
  WORKING_MEMORY_TEMPLATE,
  MAX_SECTION_TOKENS,
} from '../../src/core/working-memory.js';

/**
 * Suite 2: Working Memory (Unit with Filesystem)
 */

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('ensureWorkingMemory', () => {
  it('2.1: creates template file when absent', () => {
    ensureWorkingMemory();
    expect(fs.existsSync(WORKING_MEMORY_FILE)).toBe(true);
    const content = fs.readFileSync(WORKING_MEMORY_FILE, 'utf-8');
    expect(content).toBe(WORKING_MEMORY_TEMPLATE);
    // Verify all 7 section headers
    expect(content).toContain('# Active Focus');
    expect(content).toContain('# User Requests');
    expect(content).toContain('# Decisions & Rationale');
    expect(content).toContain('# Struggles & Breakthroughs');
    expect(content).toContain('# Session Status');
    expect(content).toContain('# Open Threads');
    expect(content).toContain('# Learnings');
  });

  it('2.2: is idempotent (does not overwrite existing)', () => {
    const customContent = '# Active Focus\nWorking on Memory v2 tests';
    fs.mkdirSync(path.dirname(WORKING_MEMORY_FILE), { recursive: true });
    fs.writeFileSync(WORKING_MEMORY_FILE, customContent, 'utf-8');

    ensureWorkingMemory();

    const content = fs.readFileSync(WORKING_MEMORY_FILE, 'utf-8');
    expect(content).toBe(customContent);
  });
});

describe('getWorkingMemory', () => {
  it('2.3: returns file content', () => {
    const knownContent = '# Active Focus\nTesting working memory';
    fs.mkdirSync(path.dirname(WORKING_MEMORY_FILE), { recursive: true });
    fs.writeFileSync(WORKING_MEMORY_FILE, knownContent, 'utf-8');

    expect(getWorkingMemory()).toBe(knownContent);
  });

  it('2.4: returns null when file absent', () => {
    expect(getWorkingMemory()).toBeNull();
  });
});

describe('isWorkingMemoryEmpty', () => {
  it('2.5: detects empty template', () => {
    expect(isWorkingMemoryEmpty(WORKING_MEMORY_TEMPLATE)).toBe(true);
  });

  it('2.6: detects real content', () => {
    const content = WORKING_MEMORY_TEMPLATE.replace(
      '_What is the user currently working on? Active tasks, their IDs, and status._',
      'Working on Memory v2',
    );
    expect(isWorkingMemoryEmpty(content)).toBe(false);
  });

  it('2.7: returns true for null', () => {
    expect(isWorkingMemoryEmpty(null)).toBe(true);
  });
});

describe('getWorkingMemorySectionSizes', () => {
  it('2.8: returns correct token counts per section', () => {
    const content = `# Active Focus\n${'word '.repeat(100)}\n# User Requests\n${'word '.repeat(50)}\n`;
    const sizes = getWorkingMemorySectionSizes(content);
    expect(sizes.has('Active Focus')).toBe(true);
    expect(sizes.has('User Requests')).toBe(true);
    expect(sizes.get('Active Focus')!).toBeGreaterThan(sizes.get('User Requests')!);
    expect(sizes.get('Active Focus')!).toBeGreaterThan(0);
    expect(sizes.get('User Requests')!).toBeGreaterThan(0);
  });

  it('2.8b: counts every one of the seven sections and measures an oversized one past the cap', () => {
    const big = 'The quick brown fox jumps over the lazy dog. '.repeat(500);
    const content = `# Active Focus\n${big}\n# User Requests\nSmall note.\n# Decisions & Rationale\nAnother small note.\n# Struggles & Breakthroughs\nSmall.\n# Session Status\nSmall.\n# Open Threads\nSmall.\n# Learnings\nSmall.`;
    const sizes = getWorkingMemorySectionSizes(content);
    expect(sizes.size).toBe(7);
    expect(sizes.get('Active Focus')!).toBeGreaterThan(MAX_SECTION_TOKENS);
    expect(sizes.get('User Requests')!).toBeLessThan(MAX_SECTION_TOKENS);
  });
});

describe('truncateWorkingMemoryForCompact', () => {
  it('2.9: passes through short content', () => {
    const content = `# Active Focus\nShort note\n# User Requests\nAnother short note\n`;
    const result = truncateWorkingMemoryForCompact(content);
    // The split/join may add whitespace but the content should remain intact
    expect(result).toContain('# Active Focus');
    expect(result).toContain('Short note');
    expect(result).toContain('# User Requests');
    expect(result).toContain('Another short note');
    expect(result).not.toContain('[...truncated]');
  });

  it('2.10: truncates oversized section', () => {
    // Use real words to generate enough tokens (need > MAX_SECTION_TOKENS = 2000)
    // Each 'the quick brown fox ' is ~5 tokens, so 500 repetitions = ~2500 tokens
    const bigContent = 'the quick brown fox jumps over the lazy dog and runs around the park again. '.repeat(500);
    const bigSection = `# Active Focus\n${bigContent}\n# User Requests\nSmall\n`;
    const result = truncateWorkingMemoryForCompact(bigSection);
    expect(result).toContain('[...truncated]');
    expect(result).toContain('# Active Focus');
    expect(result).toContain('# User Requests');
  });

  it('2.10b: keeps all seven headers when one section is cut under a total budget', () => {
    const big = 'The quick brown fox jumps over the lazy dog and runs around the park. '.repeat(500);
    const headers = ['# User Requests', '# Decisions & Rationale', '# Struggles & Breakthroughs', '# Session Status', '# Open Threads', '# Learnings'];
    const content = [`# Active Focus\n${big}`, ...headers.map((h) => `${h}\nSmall.`)].join('\n');
    const result = truncateWorkingMemoryForCompact(content, 8000);
    expect(result).toContain('[...truncated]');
    for (const h of ['# Active Focus', ...headers]) expect(result).toContain(h);
  });

  it('2.11: enforces total budget', () => {
    // Build content with 7 sections, each ~1500 tokens (total ~10500)
    const sections = [
      'Active Focus',
      'User Requests',
      'Decisions & Rationale',
      'Struggles & Breakthroughs',
      'Session Status',
      'Open Threads',
      'Learnings',
    ].map(h => `# ${h}\n${'word '.repeat(1200)}`).join('\n');

    const result = truncateWorkingMemoryForCompact(sections, 8000);
    expect(result).toContain('[...truncated for compaction]');
  });
});

describe('snapshotWorkingMemory', () => {
  it('2.12: creates archive file', () => {
    // Write real content
    fs.mkdirSync(path.dirname(WORKING_MEMORY_FILE), { recursive: true });
    fs.writeFileSync(WORKING_MEMORY_FILE, '# Active Focus\nWorking on tests', 'utf-8');
    fs.mkdirSync(COMPACTION_DIR, { recursive: true });

    const filepath = snapshotWorkingMemory();
    expect(filepath).not.toBeNull();
    expect(filepath!.startsWith(COMPACTION_DIR)).toBe(true);
    expect(fs.existsSync(filepath!)).toBe(true);

    const content = fs.readFileSync(filepath!, 'utf-8');
    expect(content).toContain('source: working-memory-snapshot');
    expect(content).toContain('date:');
    expect(content).toContain('# Active Focus');
    expect(content).toContain('Working on tests');

    // Filename pattern YYYY-MM-DD-HHMM.md
    const filename = path.basename(filepath!);
    expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}\.md$/);
  });

  it('2.13: returns null for empty template', () => {
    fs.mkdirSync(path.dirname(WORKING_MEMORY_FILE), { recursive: true });
    fs.writeFileSync(WORKING_MEMORY_FILE, WORKING_MEMORY_TEMPLATE, 'utf-8');
    fs.mkdirSync(COMPACTION_DIR, { recursive: true });

    expect(snapshotWorkingMemory()).toBeNull();
  });
});
