import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

// Mock constants module to redirect file paths to temp directory
vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME, DAILY_DIR, MEMORY_FILE, NOTES_DIR } from '../../src/constants.js';
import { buildMemoryContext } from '../../src/agent/context.js';
import { formatDateKey, estimateTokens } from '../../src/core/daily-log.js';
import {
  beginMemoryPromptTurn,
  getBoundedMemory,
  invalidateMemoryPromptSnapshots,
} from '../../src/core/bounded-memory.js';

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  // Pins live on module-level singletons — thaw so each test starts unfrozen.
  invalidateMemoryPromptSnapshots();
});

afterEach(async () => {
  invalidateMemoryPromptSnapshots();
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// Global memory is the BOUNDED store (memory/MEMORY.md, "## Title" entries) —
// renderForPrompt() only emits "## " entry content, so seeds must use that shape.

describe('buildMemoryContext', () => {
  it('returns placeholder text when no memory exists', async () => {
    const result = await buildMemoryContext();
    expect(result).toContain('(No global memory yet.');
    expect(result).toContain('(No recent activity.)');
  });

  it('contains all section headers', async () => {
    const result = await buildMemoryContext();
    expect(result).toContain('## Projects');
    expect(result).toContain('## User profile');
    expect(result).toContain('## Your long-term memory');
    expect(result).toContain('## Recent activity');
  });

  it('includes global MEMORY.md content when file exists', async () => {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, '## My Preferences\nI prefer dark mode and TypeScript.', 'utf-8');

    const result = await buildMemoryContext();
    expect(result).toContain('## My Preferences');
    expect(result).toContain('I prefer dark mode and TypeScript.');
    expect(result).not.toContain('(No global memory yet.');
  });

  it('includes recent daily log content', async () => {
    fs.mkdirSync(DAILY_DIR, { recursive: true });
    const dateKey = formatDateKey();
    const logContent = `# Daily Log: ${dateKey}\n\n## 10:30 — agent\nWorked on API endpoints.\n\n`;
    fs.writeFileSync(path.join(DAILY_DIR, `${dateKey}.md`), logContent, 'utf-8');

    const result = await buildMemoryContext();
    expect(result).toContain('Worked on API endpoints.');
    expect(result).not.toContain('(No recent activity.)');
  });

  it('does not inject the notes vault guide into every prompt', async () => {
    fs.mkdirSync(NOTES_DIR, { recursive: true });
    fs.writeFileSync(path.join(NOTES_DIR, 'AGENTS.md'), '# Vault guide\nSTALE-PARA-MARKER', 'utf-8');

    const result = await buildMemoryContext();
    expect(result).not.toContain('## Notes vault guide');
    expect(result).not.toContain('STALE-PARA-MARKER');
  });

  it('respects token budget - large daily logs get truncated', async () => {
    fs.mkdirSync(DAILY_DIR, { recursive: true });

    // Create daily logs for several days with large content
    const now = new Date();
    for (let i = 0; i < 10; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateKey = formatDateKey(d);
      // Each log has ~500 words = ~650 tokens
      const bigContent = `# Daily Log: ${dateKey}\n\n## 10:00 — agent\n${'Lorem ipsum dolor sit amet. '.repeat(100)}\n\n`;
      fs.writeFileSync(path.join(DAILY_DIR, `${dateKey}.md`), bigContent, 'utf-8');
    }

    // With a small budget, only some logs should be included
    const smallBudget = await buildMemoryContext(2000);
    const largeBudget = await buildMemoryContext(50000);

    // Small budget should have fewer logs than large budget
    const smallLogCount = (smallBudget.match(/Daily Log:/g) || []).length;
    const largeLogCount = (largeBudget.match(/Daily Log:/g) || []).length;
    expect(largeLogCount).toBeGreaterThan(smallLogCount);
  });

  it('combines all sections correctly', async () => {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, '## Knowledge\nGlobal knowledge here.', 'utf-8');

    fs.mkdirSync(DAILY_DIR, { recursive: true });
    const dateKey = formatDateKey();
    fs.writeFileSync(
      path.join(DAILY_DIR, `${dateKey}.md`),
      `# Daily Log: ${dateKey}\n\n## 09:00 — agent\nDid some work.\n\n`,
      'utf-8',
    );

    const result = await buildMemoryContext();

    expect(result).toContain('Global knowledge here.');
    expect(result).toContain('Did some work.');

    // No placeholders should appear
    expect(result).not.toContain('(No global memory yet.');
    expect(result).not.toContain('(No recent activity.)');
  });
});

// The frozen-snapshot layer as buildMemoryContext sees it (see
// src/core/memory-prompt-snapshot.ts for the refresh policy).
describe('buildMemoryContext — frozen memory snapshot', () => {
  it('reads live from disk when no scope is passed', async () => {
    await getBoundedMemory().add('## Live Rule\n\nread from disk');
    const result = await buildMemoryContext();
    expect(result).toContain('read from disk');
  });

  it('serves the pinned block for a frozen scope while disk has newer content', async () => {
    const store = getBoundedMemory();
    await store.add('## Rule A\n\npinned at the boundary');
    const { scope } = beginMemoryPromptTurn('general', 'conv-ctx');

    // Mid-turn write — durable on disk...
    await store.add('## Rule B\n\nwritten mid-turn');
    expect((await store.read()).entries).toHaveLength(2);

    // ...but the frozen prompt for this turn still shows only the pinned state.
    const frozen = await buildMemoryContext(8000, scope);
    expect(frozen).toContain('pinned at the boundary');
    expect(frozen).not.toContain('written mid-turn');

    // A live build (no scope) does see it — proving the write really landed.
    expect(await buildMemoryContext()).toContain('written mid-turn');
  });

  it('the next turn boundary adopts the mid-turn write', async () => {
    const store = getBoundedMemory();
    await store.add('## Rule A\n\nfirst');
    const { scope } = beginMemoryPromptTurn('general', 'conv-ctx');
    await store.add('## Rule B\n\nsecond');
    expect(await buildMemoryContext(8000, scope)).not.toContain('second');

    beginMemoryPromptTurn('general', 'conv-ctx');
    expect(await buildMemoryContext(8000, scope)).toContain('second');
  });

  it('freezes the user profile section too, not just global memory', async () => {
    const user = getBoundedMemory(undefined, 'user');
    await user.add('## Who They Are\n\nprefers concise answers');
    const { scope } = beginMemoryPromptTurn('general', 'conv-ctx');
    await user.add('## New Fact\n\nlearned mid-turn');

    const frozen = await buildMemoryContext(8000, scope);
    expect(frozen).toContain('prefers concise answers');
    expect(frozen).not.toContain('learned mid-turn');
  });
  // ─── Budget enforcement (the dynamic segment is billed UNCACHED every round-trip) ───

  it('enforces the token budget as a real ceiling, not a suggestion', async () => {
    // Regression: `budget` used to be advisory — only the daily-logs half honored
    // it, so every other section (bounded stores, ledger, repo/notes guides) was
    // bounded at WRITE time but never as a SUM. Measured on a real vault: asking
    // for 8000 returned 9761 tokens and asking for 2000 returned 7069 (3.5x over).
    // This block is the `dynamic` segment, injected AFTER the prompt-cache
    // breakpoint, so every excess token is re-billed on EVERY round-trip of EVERY
    // turn — a tool-using turn is 2+ round-trips.
    const store = getBoundedMemory();
    for (let i = 0; i < 12; i++) {
      await store.add(`## Rule ${i}\n\n${'padding text '.repeat(60)}`);
    }
    // Daily logs are the biggest real-world contributor — seed a fat one.
    await fsp.mkdir(DAILY_DIR, { recursive: true });
    await fsp.writeFile(
      path.join(DAILY_DIR, `${formatDateKey(new Date())}.md`),
      `## Work log\n\n${'a long line of daily activity detail. '.repeat(400)}`,
      'utf-8',
    );

    // Compare ENFORCED vs UNENFORCED on identical inputs: a huge budget leaves
    // everything in, a tight one must be materially smaller. This is the real
    // contract (the non-droppable identity/rules core is a hard floor, so we
    // cannot assert an absolute number here).
    const unenforced = await buildMemoryContext(1_000_000, undefined);
    const enforced = await buildMemoryContext(1500, undefined);
    expect(estimateTokens(enforced)).toBeLessThan(estimateTokens(unenforced) / 2);
    // Recent activity is dropped FIRST (most re-readable via file_read).
    expect(unenforced).toContain('a long line of daily activity detail');
    expect(enforced).not.toContain('a long line of daily activity detail');
  });

  it('tells the model what it omitted instead of dropping silently', async () => {
    // A silent drop reads as "none exist" — the model must know to go fetch it.
    await fsp.mkdir(DAILY_DIR, { recursive: true });
    await fsp.writeFile(
      path.join(DAILY_DIR, `${formatDateKey(new Date())}.md`),
      `## Work log\n\n${'verbose daily detail. '.repeat(500)}`,
      'utf-8',
    );
    const out = await buildMemoryContext(500, undefined);
    expect(out).toMatch(/Context budget: omitted/);
    expect(out).toContain('Recent activity');
  });

  it('never drops identity or behavior rules, however tight the budget', async () => {
    const user = getBoundedMemory(undefined, 'user');
    await user.add('## Identity\n\nEvan, software engineer');
    const store = getBoundedMemory();
    await store.add('## Never Force Push\n\na behavior rule that must survive');

    const out = await buildMemoryContext(1, undefined); // absurdly tight
    expect(out).toContain('Evan, software engineer');
    expect(out).toContain('a behavior rule that must survive');
  });
});
