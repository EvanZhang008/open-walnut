import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

// Mock constants module to redirect file paths to temp directory
vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME, DAILY_DIR, MEMORY_FILE } from '../../src/constants.js';
import { buildMemoryContext } from '../../src/agent/context.js';
import { formatDateKey } from '../../src/core/daily-log.js';
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
});
