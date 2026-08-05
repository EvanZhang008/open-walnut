import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  BoundedMemoryStore,
  MEMORY_CHAR_BUDGET,
  parseMemoryContent,
  renderMemoryContent,
  decodeHtmlArtifacts,
  getBoundedMemory,
} from '../../src/core/bounded-memory.js';
import {
  MEMORY_BACKUP_GENERATIONS,
  atomicWriteSameDir,
  listMemoryBackups,
  memoryBackupPath,
} from '../../src/core/bounded-memory-backup.js';
import { WALNUT_HOME, MEMORY_FILE, USER_FILE, agentMemoryDir } from '../../src/constants.js';

let store: BoundedMemoryStore;

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  // MEMORY_FILE lives at memory/MEMORY.md — create its parent dir
  await fsp.mkdir(path.dirname(MEMORY_FILE), { recursive: true });
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

  it('keeps a "## " line INSIDE the frontmatter fence as preamble', () => {
    const content = `---\nname: Sample Store\nnote: "## not an entry"\n---\n\n## Real Entry\n\nBody\n`;
    const { preamble, entries } = parseMemoryContent(content);
    expect(preamble).toContain('## not an entry');
    expect(entries).toEqual(['## Real Entry\n\nBody']);
  });
});

/**
 * A markdown WYSIWYG round-trip (markdown-it → HTML → serializer) turns a YAML
 * frontmatter block into `<hr>` + a setext h2, which serializes back as ONE
 * `## name: … description: &gt; …` line. That line must never be mistaken for a
 * memory entry: it would eat budget, be a replace/remove target, and get
 * injected into the system prompt as if it were a user rule.
 */
describe('parseMemoryContent — collapsed frontmatter (WYSIWYG round-trip rot)', () => {
  /** The mangled shape, with invented neutral YAML values. */
  const MANGLED = [
    '---',
    '',
    '## name: Sample Store description: &gt; Placeholder description for the fixture.',
    '',
    '# SAMPLE.md — Sample',
    '',
    '## Alpha Rule',
    '',
    'Body alpha.',
    '',
    '## Beta Rule',
    '',
    'Body beta.',
    '',
  ].join('\n');

  it('treats the collapsed frontmatter heading as preamble, not an entry', () => {
    const { preamble, entries } = parseMemoryContent(MANGLED);
    expect(entries).toEqual(['## Alpha Rule\n\nBody alpha.', '## Beta Rule\n\nBody beta.']);
    expect(entries.some((e) => e.startsWith('## name:'))).toBe(false);
    expect(preamble).toContain('## name: Sample Store');
    expect(preamble).toContain('# SAMPLE.md — Sample');
  });

  it('charges the budget only for real entries (frontmatter excluded)', () => {
    const { entries } = parseMemoryContent(MANGLED);
    const used = entries.join('\n\n').length;
    // '## Alpha Rule\n\nBody alpha.' = 26, '## Beta Rule\n\nBody beta.' = 24, join = 2
    expect(used).toBe(26 + 2 + 24);
  });

  it('parses a mangled and a healthy file to the SAME entries and budget', () => {
    const healthy = [
      '---',
      'name: Sample Store',
      'description: >',
      '  Placeholder description for the fixture.',
      '---',
      '',
      '# SAMPLE.md — Sample',
      '',
      '## Alpha Rule',
      '',
      'Body alpha.',
      '',
      '## Beta Rule',
      '',
      'Body beta.',
      '',
    ].join('\n');
    expect(parseMemoryContent(MANGLED).entries).toEqual(parseMemoryContent(healthy).entries);
  });

  it('render heals the collapsed header and un-escapes HTML artifacts', () => {
    const { preamble, entries } = parseMemoryContent(MANGLED);
    const rendered = renderMemoryContent(preamble, entries);
    expect(rendered).not.toContain('&gt;');
    expect(rendered).not.toMatch(/^## name:/m);
    expect(rendered).toMatch(/^---\nname: /);
    // The real preamble content survives; entries are untouched.
    expect(rendered).toContain('# SAMPLE.md — Sample');
    expect(rendered).toContain('## Alpha Rule\n\nBody alpha.');
  });

  it('round-trips stably: parse → render → parse yields the same entries', () => {
    const first = parseMemoryContent(MANGLED);
    const rendered = renderMemoryContent(first.preamble, first.entries);
    const second = parseMemoryContent(rendered);
    expect(second.entries).toEqual(first.entries);
    // And render is idempotent from the healed state (no further drift).
    expect(renderMemoryContent(second.preamble, second.entries)).toBe(rendered);
  });

  it('leaves a healthy preamble byte-identical through render (no needless rewrite)', () => {
    const healthy = `---\nname: Sample Store\n---\n\n# SAMPLE.md\n\n## Alpha Rule\n\nBody alpha.\n`;
    const { preamble, entries } = parseMemoryContent(healthy);
    expect(renderMemoryContent(preamble, entries)).toBe(healthy);
  });

  it('does NOT misclassify a legitimate one-colon entry title as frontmatter', () => {
    // Real entries whose titles contain a colon must survive — a false positive
    // here would silently DELETE a user memory on the next write.
    const content = [
      '---',
      'name: Sample Store',
      '---',
      '',
      '# SAMPLE.md',
      '',
      '## Language: Neutral',
      '',
      'Body one.',
      '',
      '## Routing: Somewhere',
      '',
      'Body two.',
      '',
    ].join('\n');
    const { entries } = parseMemoryContent(content);
    expect(entries).toEqual(['## Language: Neutral\n\nBody one.', '## Routing: Somewhere\n\nBody two.']);
    // Survives a render round-trip too.
    const { preamble } = parseMemoryContent(content);
    expect(parseMemoryContent(renderMemoryContent(preamble, entries)).entries).toEqual(entries);
  });

  it('does not swallow a body that merely starts with an hr', () => {
    const content = '---\n\n## Alpha Rule\n\nBody alpha.\n';
    const { entries } = parseMemoryContent(content);
    expect(entries).toEqual(['## Alpha Rule\n\nBody alpha.']);
  });

  it('decodeHtmlArtifacts peels exactly one entity layer', () => {
    expect(decodeHtmlArtifacts('a &gt; b &lt; c')).toBe('a > b < c');
    expect(decodeHtmlArtifacts('&amp;gt;')).toBe('&gt;');
    expect(decodeHtmlArtifacts('no entities')).toBe('no entities');
  });
});

describe('store reads with collapsed frontmatter on disk', () => {
  it('does not count the collapsed header toward usage and heals it on write', async () => {
    await fsp.writeFile(
      MEMORY_FILE,
      [
        '---',
        '',
        '## name: Sample Store description: &gt; Placeholder description for the fixture.',
        '',
        '# SAMPLE.md — Sample',
        '',
        '## Alpha Rule',
        '',
        'Body alpha.',
        '',
      ].join('\n'),
      'utf-8',
    );

    const snap = await store.read();
    expect(snap.entries).toEqual(['## Alpha Rule\n\nBody alpha.']);
    expect(snap.usedChars).toBe('## Alpha Rule\n\nBody alpha.'.length);

    // The prompt block must not carry the frontmatter line either.
    const prompt = store.renderForPrompt();
    expect(prompt).not.toContain('## name:');
    expect(prompt).not.toContain('&gt;');

    // A normal write heals the header without touching the existing entry.
    const res = await store.add(entry('Beta Rule'));
    expect(res.success).toBe(true);
    const onDisk = await fsp.readFile(MEMORY_FILE, 'utf-8');
    expect(onDisk).not.toContain('&gt;');
    expect(onDisk).not.toMatch(/^## name:/m);
    expect(onDisk).toContain('## Alpha Rule\n\nBody alpha.');
    expect(onDisk).toContain('# SAMPLE.md — Sample');
    expect(parseMemoryContent(onDisk).entries).toHaveLength(2);
  });

  it('cannot target the collapsed header with replace/remove', async () => {
    await fsp.writeFile(
      MEMORY_FILE,
      [
        '---',
        '',
        '## name: Sample Store description: &gt; Placeholder description for the fixture.',
        '',
        '# SAMPLE.md — Sample',
        '',
        '## Alpha Rule',
        '',
        'Body alpha.',
        '',
      ].join('\n'),
      'utf-8',
    );
    const res = await store.remove('name: Sample Store');
    expect(res.success).toBe(false);
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

// ── Pre-write backups (bounded-memory-backup.ts) ──

describe('pre-write backups', () => {
  const bak = (gen: number) => memoryBackupPath(MEMORY_FILE, gen);

  it('does not create a backup on the very first write (nothing to lose)', async () => {
    expect((await store.add(entry('First'))).success).toBe(true);
    expect(listMemoryBackups(MEMORY_FILE)).toEqual([]);
  });

  it('snapshots the PREVIOUS content, not the new content', async () => {
    await store.add(entry('Rule A', 'original body'));
    await store.add(entry('Rule B', 'second body'));

    const snapshot = fs.readFileSync(bak(1), 'utf-8');
    expect(snapshot).toContain('original body');
    // The snapshot is the pre-write state — it must NOT contain the new entry.
    expect(snapshot).not.toContain('second body');
    // ...while the live file has both.
    const live = fs.readFileSync(MEMORY_FILE, 'utf-8');
    expect(live).toContain('original body');
    expect(live).toContain('second body');
  });

  it('makes a destructive replace fully recoverable', async () => {
    await store.add(entry('Keep me', 'valuable knowledge worth keeping'));
    await store.add(entry('Anchor', 'anchor body'));

    // The accident: a replace that swallows the valuable entry.
    const res = await store.replace('valuable knowledge worth keeping', entry('Oops', 'tiny'));
    expect(res.success).toBe(true);
    expect((await store.read()).entries.some((e) => e.includes('valuable knowledge'))).toBe(false);

    // Rollback = copy the snapshot back over the file.
    fs.writeFileSync(MEMORY_FILE, fs.readFileSync(bak(1), 'utf-8'), 'utf-8');
    const restored = await store.read();
    expect(restored.entries).toHaveLength(2);
    expect(restored.entries.some((e) => e.includes('valuable knowledge worth keeping'))).toBe(true);
  });

  it('makes a destructive batch fully recoverable', async () => {
    await store.add(entry('One', 'body one'));
    await store.add(entry('Two', 'body two'));
    await store.add(entry('Three', 'body three'));

    // Wipe everything and leave a single entry behind.
    const res = await store.applyBatch([
      { action: 'remove', oldText: 'body one' },
      { action: 'remove', oldText: 'body two' },
      { action: 'remove', oldText: 'body three' },
      { action: 'add', content: entry('Replacement', 'all that survived') },
    ]);
    expect(res.success).toBe(true);
    expect((await store.read()).entries).toHaveLength(1);

    fs.writeFileSync(MEMORY_FILE, fs.readFileSync(bak(1), 'utf-8'), 'utf-8');
    const restored = await store.read();
    expect(restored.entries).toHaveLength(3);
    expect(restored.entries.map((e) => e.split('\n')[0])).toEqual(['## One', '## Two', '## Three']);
  });

  it('keeps MEMORY_BACKUP_GENERATIONS rolling generations, newest first', async () => {
    // N+2 writes: the first leaves no snapshot, so N+1 snapshots are offered
    // and the oldest must be evicted.
    for (let i = 0; i < MEMORY_BACKUP_GENERATIONS + 2; i++) {
      expect((await store.add(entry(`Rule ${i}`, `body ${i}`))).success).toBe(true);
    }

    expect(listMemoryBackups(MEMORY_FILE)).toHaveLength(MEMORY_BACKUP_GENERATIONS);
    expect(fs.existsSync(memoryBackupPath(MEMORY_FILE, MEMORY_BACKUP_GENERATIONS + 1))).toBe(false);

    // Generation 1 = state before the newest write (has all but the last entry).
    const newest = fs.readFileSync(bak(1), 'utf-8');
    expect(newest).toContain(`body ${MEMORY_BACKUP_GENERATIONS}`);
    expect(newest).not.toContain(`body ${MEMORY_BACKUP_GENERATIONS + 1}`);

    // Strictly older as the generation number grows, and the very first state
    // (only "Rule 0") has aged out of the ring.
    const oldest = fs.readFileSync(bak(MEMORY_BACKUP_GENERATIONS), 'utf-8');
    expect(oldest.length).toBeLessThan(newest.length);
    expect(oldest).toContain('body 1');
    expect(fs.readFileSync(bak(MEMORY_BACKUP_GENERATIONS), 'utf-8')).not.toBe(newest);
  });

  it('does not let no-op writes evict real history (identical snapshots dedup)', async () => {
    await store.add(entry('Real', 'real body'));
    await store.add(entry('Second', 'second body')); // creates generation 1

    // Idempotent duplicate adds still funnel through mutate() and "succeed",
    // rewriting identical bytes. They must not consume generations.
    for (let i = 0; i < MEMORY_BACKUP_GENERATIONS + 3; i++) {
      expect((await store.add(entry('Second', 'second body'))).success).toBe(true);
    }

    expect(listMemoryBackups(MEMORY_FILE)).toHaveLength(1);
    expect(fs.readFileSync(bak(1), 'utf-8')).toContain('real body');
    expect(fs.readFileSync(bak(1), 'utf-8')).not.toContain('second body');
  });

  it('a failed backup never blocks or corrupts the real write', async () => {
    await store.add(entry('Rule A', 'body A'));

    // Make the filesystem refuse the snapshot write only — the real memory
    // write must still go through untouched.
    const realWriteFile = fsp.writeFile.bind(fsp);
    const spy = vi.spyOn(fsp, 'writeFile').mockImplementation(async (target: never, ...rest: never[]) => {
      if (String(target).includes('.bak.')) throw new Error('EACCES simulated');
      return realWriteFile(target, ...(rest as [never]));
    });

    let res: Awaited<ReturnType<typeof store.add>>;
    try {
      res = await store.add(entry('Rule B', 'body B'));
    } finally {
      spy.mockRestore();
    }

    expect(res.success).toBe(true);
    if (res.success) expect(res.entryCount).toBe(2);

    // The write landed in full despite the backup failing, and the failed
    // snapshot left nothing behind to confuse a later reader.
    const live = fs.readFileSync(MEMORY_FILE, 'utf-8');
    expect(live).toContain('body A');
    expect(live).toContain('body B');
    expect(listMemoryBackups(MEMORY_FILE)).toEqual([]);
    expect(fs.readdirSync(path.dirname(MEMORY_FILE)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('writes backups for a per-agent store, next to that agent\'s memory file', async () => {
    const agentStore = new BoundedMemoryStore('marina');
    const agentFile = path.join(agentMemoryDir('marina'), 'MEMORY.md');

    await agentStore.add(entry('Agent rule', 'agent body one'));
    await agentStore.add(entry('Agent rule 2', 'agent body two'));

    const agentBaks = listMemoryBackups(agentFile);
    expect(agentBaks).toHaveLength(1);
    expect(path.dirname(agentBaks[0])).toBe(path.dirname(agentFile));
    expect(fs.readFileSync(agentBaks[0], 'utf-8')).toContain('agent body one');
    // The global store is untouched by a per-agent write.
    expect(listMemoryBackups(MEMORY_FILE)).toEqual([]);
  });

  it('backs up the user profile store independently of global memory', async () => {
    const userStore = new BoundedMemoryStore(undefined, 'user');
    await userStore.add(entry('Identity', 'profile body one'));
    await userStore.add(entry('Preference', 'profile body two'));

    expect(listMemoryBackups(USER_FILE)).toHaveLength(1);
    expect(fs.readFileSync(memoryBackupPath(USER_FILE, 1), 'utf-8')).toContain('profile body one');
    expect(listMemoryBackups(MEMORY_FILE)).toEqual([]);
  });

  it('snapshot names never end in .md, so markdown walkers cannot pick them up', async () => {
    await store.add(entry('A'));
    await store.add(entry('B'));
    const names = fs.readdirSync(path.dirname(MEMORY_FILE));
    expect(names.filter((n) => n.endsWith('.md'))).toEqual(['MEMORY.md']);
    expect(names.some((n) => /\.bak\.\d+$/.test(n))).toBe(true);
  });
});

describe('atomic writes stay on the same filesystem (EXDEV)', () => {
  it('renames only within the target directory, and leaves no temp files behind', async () => {
    const renames: Array<[string, string]> = [];
    const realRename = fsp.rename.bind(fsp);
    const spy = vi
      .spyOn(fsp, 'rename')
      .mockImplementation(async (from: never, to: never) => {
        renames.push([String(from), String(to)]);
        return realRename(from, to);
      });

    try {
      await store.add(entry('A', 'body A'));
      await store.add(entry('B', 'body B')); // second write also rotates a backup
    } finally {
      spy.mockRestore();
    }

    expect(renames.length).toBeGreaterThan(0);
    // Every rename source must sit in the same directory as its destination —
    // a cross-device rename fails with EXDEV (a temp under the OS tmpdir would).
    for (const [from, to] of renames) {
      expect(path.dirname(from)).toBe(path.dirname(to));
      expect(path.dirname(from)).toBe(path.dirname(MEMORY_FILE));
    }
    expect(fs.readdirSync(path.dirname(MEMORY_FILE)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('atomicWriteSameDir cleans up its temp file when the rename fails', async () => {
    const target = path.join(path.dirname(MEMORY_FILE), 'atomic-probe.txt');
    const spy = vi.spyOn(fsp, 'rename').mockRejectedValue(new Error('EXDEV simulated'));
    try {
      await expect(atomicWriteSameDir(target, 'content')).rejects.toThrow('EXDEV simulated');
    } finally {
      spy.mockRestore();
    }
    expect(fs.readdirSync(path.dirname(MEMORY_FILE)).filter((n) => n.includes('atomic-probe'))).toEqual([]);
  });

  it('the backup module never stages temp files outside the target directory', async () => {
    const source = await fsp.readFile(
      new URL('../../src/core/bounded-memory-backup.ts', import.meta.url),
      'utf-8',
    );
    // Regression guard: a "cleanup" that moves staging to os.tmpdir() would
    // reintroduce the EXDEV failure this repo has already been bitten by.
    expect(source).not.toMatch(/os\.tmpdir|mkdtemp|['"]\/tmp/);
  });
});
