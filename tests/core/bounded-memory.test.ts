import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  BoundedMemoryStore,
  MEMORY_CHAR_BUDGET,
  parseMemoryContent,
  getBoundedMemory,
} from '../../src/core/bounded-memory.js';
import { WALNUT_HOME, MEMORY_FILE } from '../../src/constants.js';

let store: BoundedMemoryStore;

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  store = new BoundedMemoryStore();
});

afterEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

const entry = (title: string, body = 'Some rule body.') => `## ${title}\n\n${body}`;

describe('parseMemoryContent', () => {
  it('splits preamble and ## sections', () => {
    const content = `---\nname: Global Memory\n---\n\n# MEMORY.md — Global\n\n## Rule A\n\nBody A\n\n## Rule B\n\nBody B\n`;
    const { preamble, entries } = parseMemoryContent(content);
    expect(preamble).toContain('name: Global Memory');
    expect(preamble).toContain('# MEMORY.md — Global');
    expect(entries).toEqual(['## Rule A\n\nBody A', '## Rule B\n\nBody B']);
  });

  it('handles empty content and content with no entries', () => {
    expect(parseMemoryContent('').entries).toEqual([]);
    const { preamble, entries } = parseMemoryContent('# Just a title\nprose\n');
    expect(entries).toEqual([]);
    expect(preamble).toContain('# Just a title');
  });

  it('does not treat ### deeper headings as entry boundaries', () => {
    const { entries } = parseMemoryContent('## Top\n\n### Sub\ndetail\n');
    expect(entries).toEqual(['## Top\n\n### Sub\ndetail']);
  });
});

describe('add', () => {
  it('adds an entry and persists to disk', async () => {
    const res = await store.add(entry('Rule A'));
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.done).toBe(true);
      expect(res.entryCount).toBe(1);
      expect(res.note).toContain('do not repeat');
      // Terminal success must NOT echo entries
      expect(JSON.stringify(res)).not.toContain('Some rule body');
    }
    const raw = fs.readFileSync(MEMORY_FILE, 'utf-8');
    expect(raw).toContain('## Rule A');
  });

  it('rejects entries without a ## heading', async () => {
    const res = await store.add('just some prose without heading');
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toContain('## Title');
  });

  it('rejects empty content', async () => {
    const res = await store.add('   ');
    expect(res.success).toBe(false);
  });

  it('treats exact duplicates as idempotent success', async () => {
    await store.add(entry('Rule A'));
    const res = await store.add(entry('Rule A'));
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.message).toContain('already exists');
      expect(res.entryCount).toBe(1);
    }
  });

  it('rejects over-budget add with full current entries + consolidate-now guidance', async () => {
    const big = entry('Big', 'x'.repeat(MEMORY_CHAR_BUDGET - 200));
    expect((await store.add(big)).success).toBe(true);
    const res = await store.add(entry('Overflow', 'y'.repeat(500)));
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain('Consolidate now');
      expect(res.error).toContain('this turn');
      expect(res.currentEntries).toHaveLength(1);
      expect(res.currentEntries![0]).toContain('## Big');
      expect(res.usage).toBeDefined();
    }
    // Nothing was written
    const snap = await store.read();
    expect(snap.entries).toHaveLength(1);
  });

  it('preserves existing preamble on write', async () => {
    fs.writeFileSync(MEMORY_FILE, '---\nname: Custom\n---\n\n# My Memory\n', 'utf-8');
    await store.add(entry('Rule A'));
    const raw = fs.readFileSync(MEMORY_FILE, 'utf-8');
    expect(raw).toContain('name: Custom');
    expect(raw).toContain('# My Memory');
    expect(raw).toContain('## Rule A');
  });
});

describe('replace', () => {
  beforeEach(async () => {
    await store.add(entry('Rule A', 'old body A'));
    await store.add(entry('Rule B', 'body B'));
  });

  it('replaces by substring match', async () => {
    const res = await store.replace('old body A', entry('Rule A v2', 'new body'));
    expect(res.success).toBe(true);
    const snap = await store.read();
    expect(snap.entries.some((e) => e.includes('Rule A v2'))).toBe(true);
    expect(snap.entries.some((e) => e.includes('old body A'))).toBe(false);
    expect(snap.entries).toHaveLength(2);
  });

  it('errors with currentEntries when no match', async () => {
    const res = await store.replace('nonexistent text', entry('X'));
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain('No entry matched');
      expect(res.currentEntries).toHaveLength(2);
    }
  });

  it('asks to be more specific on multiple distinct matches', async () => {
    // Both entries contain "body"
    const res = await store.replace('body', entry('X'));
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain('Be more specific');
      expect(res.matches).toHaveLength(2);
      // Ambiguity does NOT dump full entries
      expect(res.currentEntries).toBeUndefined();
    }
  });

  it('operates on first when duplicates are identical', async () => {
    // Write two identical entries directly (add() dedupes)
    const dup = entry('Dup', 'same');
    fs.writeFileSync(MEMORY_FILE, `# M\n\n${dup}\n\n${dup}\n`, 'utf-8');
    const res = await store.replace('same', entry('Dup v2', 'changed'));
    expect(res.success).toBe(true);
    const snap = await store.read();
    expect(snap.entries.filter((e) => e.includes('same'))).toHaveLength(1);
    expect(snap.entries.filter((e) => e.includes('changed'))).toHaveLength(1);
  });

  it('rejects over-budget replacement without writing', async () => {
    const res = await store.replace('body B', entry('Huge', 'z'.repeat(MEMORY_CHAR_BUDGET)));
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toContain('over the limit');
    const snap = await store.read();
    expect(snap.entries.some((e) => e.includes('body B'))).toBe(true);
  });

  it('requires non-empty content', async () => {
    const res = await store.replace('body B', '');
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toContain("'remove'");
  });
});

describe('remove', () => {
  beforeEach(async () => {
    await store.add(entry('Rule A', 'unique alpha'));
    await store.add(entry('Rule B', 'unique beta'));
  });

  it('removes the matched entry', async () => {
    const res = await store.remove('unique alpha');
    expect(res.success).toBe(true);
    const snap = await store.read();
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0]).toContain('Rule B');
  });

  it('errors when no match', async () => {
    const res = await store.remove('nope');
    expect(res.success).toBe(false);
    if (!res.success) expect(res.currentEntries).toHaveLength(2);
  });

  it('asks to be more specific on multiple distinct matches', async () => {
    const res = await store.remove('unique');
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toContain('Be more specific');
  });
});

describe('applyBatch', () => {
  it('is atomic: validates against FINAL budget only', async () => {
    // Fill near the budget, then batch remove+add where the ADD alone would
    // overflow but the batch nets under budget.
    const big = entry('Big', 'x'.repeat(MEMORY_CHAR_BUDGET - 500));
    await store.add(big);
    const res = await store.applyBatch([
      { action: 'remove', oldText: '## Big' },
      { action: 'add', content: entry('New', 'y'.repeat(1000)) },
    ]);
    expect(res.success).toBe(true);
    const snap = await store.read();
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0]).toContain('## New');
  });

  it('is all-or-nothing: bad op mid-batch writes nothing', async () => {
    await store.add(entry('Keep', 'keep body'));
    const res = await store.applyBatch([
      { action: 'add', content: entry('First', 'ok') },
      { action: 'remove', oldText: 'does-not-exist' },
    ]);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain('all-or-nothing');
      expect(res.currentEntries).toHaveLength(1);
    }
    const snap = await store.read();
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0]).toContain('Keep');
  });

  it('rejects the whole batch when final state is over budget', async () => {
    const res = await store.applyBatch([
      { action: 'add', content: entry('A', 'x'.repeat(5000)) },
      { action: 'add', content: entry('B', 'y'.repeat(5000)) },
    ]);
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toContain('over the limit');
    const snap = await store.read();
    expect(snap.entries).toHaveLength(0);
  });

  it('skips duplicate adds idempotently instead of failing', async () => {
    await store.add(entry('Dup'));
    const res = await store.applyBatch([
      { action: 'add', content: entry('Dup') },
      { action: 'add', content: entry('Fresh') },
    ]);
    expect(res.success).toBe(true);
    const snap = await store.read();
    expect(snap.entries).toHaveLength(2);
  });

  it('rejects empty operations list and unknown actions', async () => {
    expect((await store.applyBatch([])).success).toBe(false);
    const res = await store.applyBatch([
      { action: 'frobnicate' } as never,
    ]);
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toContain('unknown action');
  });

  it('later ops see earlier ops in the same batch (replace what was just added)', async () => {
    const res = await store.applyBatch([
      { action: 'add', content: entry('Stage1', 'draft') },
      { action: 'replace', oldText: 'draft', content: entry('Stage1', 'final') },
    ]);
    expect(res.success).toBe(true);
    const snap = await store.read();
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0]).toContain('final');
  });
});

describe('consolidation circuit breaker', () => {
  it('turns terminal after 3 consecutive failures, resets on success and on turn boundary', async () => {
    // 3 failures allowed with normal error responses
    for (let i = 0; i < 3; i++) {
      const res = await store.remove('never-matches');
      expect(res.success).toBe(false);
      if (!res.success) expect(res.terminal).toBeUndefined();
    }
    // 4th failure trips the breaker
    const tripped = await store.remove('never-matches');
    expect(tripped.success).toBe(false);
    if (!tripped.success) {
      expect(tripped.terminal).toBe(true);
      expect(tripped.error).toContain('STOP retrying');
      // Terminal response must not echo entries
      expect(tripped.currentEntries).toBeUndefined();
    }

    // Success resets the counter
    store.resetConsolidationFailures();
    expect((await store.add(entry('Fresh'))).success).toBe(true);
    for (let i = 0; i < 3; i++) {
      const res = await store.remove('never-matches');
      if (!res.success) expect(res.terminal).toBeUndefined();
    }
  });

  it('successful write mid-sequence resets the consecutive counter', async () => {
    await store.remove('never-matches');
    await store.remove('never-matches');
    await store.add(entry('Progress')); // success → reset
    // 3 more failures allowed before tripping again
    for (let i = 0; i < 3; i++) {
      const res = await store.remove('never-matches');
      if (!res.success) expect(res.terminal).toBeUndefined();
    }
    const tripped = await store.remove('never-matches');
    if (!tripped.success) expect(tripped.terminal).toBe(true);
  });

  it('ambiguous match does NOT count toward the breaker', async () => {
    fs.writeFileSync(
      MEMORY_FILE,
      `# M\n\n${entry('A', 'shared token')}\n\n${entry('B', 'shared token too')}\n`,
      'utf-8',
    );
    for (let i = 0; i < 10; i++) {
      const res = await store.remove('shared token');
      expect(res.success).toBe(false);
      if (!res.success) expect(res.terminal).toBeUndefined();
    }
  });
});

describe('renderForPrompt', () => {
  it('returns null when empty', () => {
    expect(store.renderForPrompt()).toBeNull();
  });

  it('includes usage header and all entries', async () => {
    await store.add(entry('Rule A'));
    await store.add(entry('Rule B'));
    const block = store.renderForPrompt()!;
    expect(block).toMatch(/\[Memory usage: \d+% — [\d,]+\/8,000 chars\]/);
    expect(block).toContain('## Rule A');
    expect(block).toContain('## Rule B');
    // Preamble/frontmatter is NOT injected
    expect(block).not.toContain('name: Global Memory');
  });
});

describe('getBoundedMemory', () => {
  it('returns the same instance per agent (breaker state is shared)', () => {
    expect(getBoundedMemory()).toBe(getBoundedMemory());
    expect(getBoundedMemory('general')).toBe(getBoundedMemory());
    expect(getBoundedMemory('other')).not.toBe(getBoundedMemory());
  });
});

describe('multi-process safety', () => {
  it('picks up external edits made between operations (re-read under lock)', async () => {
    await store.add(entry('Rule A'));
    // External writer appends an entry directly
    const raw = fs.readFileSync(MEMORY_FILE, 'utf-8');
    fs.writeFileSync(MEMORY_FILE, raw + '\n' + entry('External', 'from outside') + '\n', 'utf-8');
    const res = await store.add(entry('Rule B'));
    expect(res.success).toBe(true);
    const snap = await store.read();
    expect(snap.entries).toHaveLength(3);
    expect(snap.entries.some((e) => e.includes('External'))).toBe(true);
  });
});
