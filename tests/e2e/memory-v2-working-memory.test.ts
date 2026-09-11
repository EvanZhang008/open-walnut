/**
 * Category 2: Working Memory E2E
 *
 * Tests working memory file operations, template initialization, read/write,
 * empty detection, section sizes, truncation, snapshot, trigger thresholds,
 * and prompt construction.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';
import { seedWorkingMemory } from '../helpers/memory-v2-seeders.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  WALNUT_HOME,
  WORKING_MEMORY_FILE,
  COMPACTION_DIR,
  MEMORY_DIR,
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
import {
  resetUpdaterState,
  shouldUpdateWorkingMemory,
  trackToolCall,
  setCompacting,
  executeWorkingMemoryUpdate,
  buildWorkingMemoryUpdatePrompt,
} from '../../src/core/memory/working-memory-updater.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
  await fsp.mkdir(MEMORY_DIR, { recursive: true });
  resetUpdaterState();
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ── 2.1 Working Memory Template Initialization ──

describe('Working Memory Template', () => {
  it('2.1: initializes template when file absent', () => {
    ensureWorkingMemory();

    expect(fs.existsSync(WORKING_MEMORY_FILE)).toBe(true);
    const content = fs.readFileSync(WORKING_MEMORY_FILE, 'utf-8');
    // Exact equality already covers that all 7 section headers are present
    expect(content).toBe(WORKING_MEMORY_TEMPLATE);
  });
});

// ── 2.2 Working Memory Read/Write Roundtrip ──

describe('Working Memory Read/Write', () => {
  it('2.2: read returns seeded content', () => {
    const customContent = `# Active Focus
Working on memory v2 test plan.

# User Requests
_What did the user ask for recently?_

# Decisions & Rationale
Chose QMD over custom FTS5 implementation.

# Struggles & Breakthroughs
_What blocked progress?_

# Session Status
_Running sessions_

# Open Threads
Need to verify BGE-M3 model download in CI.

# Learnings
_What worked well?_
`;
    seedWorkingMemory(WALNUT_HOME, customContent);

    const result = getWorkingMemory();
    expect(result).toBe(customContent);
    expect(isWorkingMemoryEmpty(result)).toBe(false);
  });
});

// ── 2.3 Working Memory Empty Detection ──

describe('Working Memory Empty Detection', () => {
  it('2.3: template-only content is detected as empty', () => {
    seedWorkingMemory(WALNUT_HOME, WORKING_MEMORY_TEMPLATE);

    const content = getWorkingMemory();
    expect(isWorkingMemoryEmpty(content)).toBe(true);
  });

  it('2.3b: null is detected as empty', () => {
    expect(isWorkingMemoryEmpty(null)).toBe(true);
  });

  it('2.3c: content with real text is not empty', () => {
    const content = WORKING_MEMORY_TEMPLATE.replace(
      '_What is the user currently working on? Active tasks, their IDs, and status._',
      'Building memory v2 E2E test suite, task ID #9.',
    );
    expect(isWorkingMemoryEmpty(content)).toBe(false);
  });
});

// ── 2.4 Section Size Tracking ──

describe('Section Size Tracking', () => {
  it('2.4: returns token counts per section', () => {
    // Build content with an oversized section
    const bigContent = 'The quick brown fox jumps over the lazy dog. '.repeat(500);
    const content = `# Active Focus\n${bigContent}\n# User Requests\nSmall note.\n# Decisions & Rationale\nAnother small note.\n# Struggles & Breakthroughs\nSmall.\n# Session Status\nSmall.\n# Open Threads\nSmall.\n# Learnings\nSmall.`;

    const sizes = getWorkingMemorySectionSizes(content);

    expect(sizes.size).toBe(7);
    expect(sizes.has('Active Focus')).toBe(true);
    expect(sizes.has('User Requests')).toBe(true);

    // Active Focus should be oversized (500 * ~10 words * ~1.3 tokens/word)
    expect(sizes.get('Active Focus')!).toBeGreaterThan(MAX_SECTION_TOKENS);
    // User Requests should be small
    expect(sizes.get('User Requests')!).toBeLessThan(MAX_SECTION_TOKENS);
  });
});

// ── 2.5 Truncation for Compaction ──

describe('Truncation for Compaction', () => {
  it('2.5: truncates oversized content and preserves headers', () => {
    const bigSection = 'The quick brown fox jumps over the lazy dog and runs around the park. '.repeat(500);
    const content = [
      `# Active Focus\n${bigSection}`,
      '# User Requests\nSmall note.',
      '# Decisions & Rationale\nSmall note.',
      '# Struggles & Breakthroughs\nSmall.',
      '# Session Status\nSmall.',
      '# Open Threads\nSmall.',
      '# Learnings\nSmall.',
    ].join('\n');

    const result = truncateWorkingMemoryForCompact(content, 8000);

    // All section headers must be preserved
    expect(result).toContain('# Active Focus');
    expect(result).toContain('# User Requests');
    expect(result).toContain('# Decisions & Rationale');
    expect(result).toContain('# Struggles & Breakthroughs');
    expect(result).toContain('# Session Status');
    expect(result).toContain('# Open Threads');
    expect(result).toContain('# Learnings');

    // Oversized section should have truncation marker
    expect(result).toContain('[...truncated]');
  });

  it('2.5b: short content passes through untouched', () => {
    const content = '# Active Focus\nShort note\n# User Requests\nSmall.';
    const result = truncateWorkingMemoryForCompact(content);
    expect(result).not.toContain('[...truncated]');
    expect(result).toContain('Short note');
  });
});

// ── 2.6 Working Memory Snapshot ──

describe('Snapshot', () => {
  it('2.6: creates snapshot file with YAML front matter', () => {
    seedWorkingMemory(WALNUT_HOME, '# Active Focus\nWorking on snapshot tests');
    fs.mkdirSync(COMPACTION_DIR, { recursive: true });

    const filepath = snapshotWorkingMemory();

    expect(filepath).not.toBeNull();
    expect(fs.existsSync(filepath!)).toBe(true);

    const content = fs.readFileSync(filepath!, 'utf-8');
    expect(content).toContain('source: working-memory-snapshot');
    expect(content).toContain('date:');
    expect(content).toContain('# Active Focus');
    expect(content).toContain('Working on snapshot tests');

    // Filepath under compaction dir
    expect(filepath!.startsWith(COMPACTION_DIR)).toBe(true);

    // Filename pattern YYYY-MM-DD-HHMM.md
    const filename = path.basename(filepath!);
    expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}\.md$/);
  });

  // ── 2.7 Snapshot - Empty Memory ──

  it('2.7: returns null for empty working memory', () => {
    seedWorkingMemory(WALNUT_HOME, WORKING_MEMORY_TEMPLATE);
    fs.mkdirSync(COMPACTION_DIR, { recursive: true });

    expect(snapshotWorkingMemory()).toBeNull();
  });
});

// ── 2.8 Update Trigger Thresholds ──

describe('Update Trigger Thresholds', () => {
  it('2.8: threshold logic follows initialization + growth + tool calls', () => {
    resetUpdaterState();

    // Step 2: below 10K initialization threshold — should be false
    expect(shouldUpdateWorkingMemory(5000)).toBe(false);

    // Step 3: accumulate 3 tool calls
    trackToolCall();
    trackToolCall();
    trackToolCall();

    // Step 4: enough tool calls but still below token threshold
    expect(shouldUpdateWorkingMemory(5000)).toBe(false);

    // Step 5: at initialization threshold with 3 tool calls — should be true
    expect(shouldUpdateWorkingMemory(10000)).toBe(true);
  });

  it('2.8b: subsequent update needs growth + tool calls', async () => {
    resetUpdaterState();

    // Reach initialization threshold
    trackToolCall();
    trackToolCall();
    trackToolCall();
    expect(shouldUpdateWorkingMemory(10000)).toBe(true);

    // Simulate extraction. The runner answers with a well-formed whole file —
    // a malformed answer is refused, and a refusal deliberately does NOT advance
    // the cadence, so the thresholds below would never move.
    const mockRunner = vi.fn(async () => WORKING_MEMORY_TEMPLATE);
    await executeWorkingMemoryUpdate(mockRunner, 10000);

    // Step 7: only 5K growth — need 5K more tokens
    expect(shouldUpdateWorkingMemory(15000)).toBe(false);

    // Step 8: accumulate 3 more tool calls
    trackToolCall();
    trackToolCall();
    trackToolCall();

    // Step 9: 6K growth (>5K threshold) + 3 tool calls (>=3 threshold) — should be true
    expect(shouldUpdateWorkingMemory(16000)).toBe(true);
  });
});

// ── 2.9 Compaction Skips Update ──

describe('Compaction Suppression', () => {
  it('2.9: compaction in progress suppresses updates', () => {
    resetUpdaterState();

    // Set up conditions that would normally trigger
    trackToolCall();
    trackToolCall();
    trackToolCall();
    expect(shouldUpdateWorkingMemory(10000)).toBe(true);

    // Now enable compaction mode
    resetUpdaterState();
    trackToolCall();
    trackToolCall();
    trackToolCall();
    setCompacting(true);

    expect(shouldUpdateWorkingMemory(20000)).toBe(false);

    // Clean up
    setCompacting(false);
  });
});

// ── 2.10 Working Memory Update Prompt Construction ──

describe('Update Prompt Construction', () => {
  it('2.10: prompt contains required elements', () => {
    // Create an oversized section to trigger WARNING
    const bigContent = 'The quick brown fox jumps over the lazy dog. '.repeat(500);
    const content = `# Active Focus\n${bigContent}\n# User Requests\nSmall.\n# Decisions & Rationale\nSmall.\n# Struggles & Breakthroughs\nSmall.\n# Session Status\nSmall.\n# Open Threads\nSmall.\n# Learnings\nSmall.`;
    seedWorkingMemory(WALNUT_HOME, content);

    const prompt = buildWorkingMemoryUpdatePrompt();

    // Contains XML tag with working memory content
    expect(prompt).toContain('<current_working_memory>');
    expect(prompt).toContain('</current_working_memory>');

    // Contains WARNING about oversized section
    expect(prompt).toContain('WARNING');
    expect(prompt).toContain('Active Focus');

    // References the working memory file path
    expect(prompt).toContain(WORKING_MEMORY_FILE);

    // Asks for the whole file back: the update is a one-shot with no tools.
    expect(prompt).toContain('COMPLETE updated file');
  });

  it('2.10b: prompt without oversized sections has no WARNING', () => {
    seedWorkingMemory(WALNUT_HOME, '# Active Focus\nSmall note.\n# User Requests\nSmall.\n# Decisions & Rationale\nSmall.\n# Struggles & Breakthroughs\nSmall.\n# Session Status\nSmall.\n# Open Threads\nSmall.\n# Learnings\nSmall.');

    const prompt = buildWorkingMemoryUpdatePrompt();

    expect(prompt).toContain('<current_working_memory>');
    expect(prompt).not.toContain('WARNING');
  });
});
