import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

let tmpDir: string;

vi.mock('../../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME, WORKING_MEMORY_FILE } from '../../../src/constants.js';
import { WORKING_MEMORY_TEMPLATE, MAX_SECTION_TOKENS } from '../../../src/core/working-memory.js';
import {
  resetUpdaterState,
  setCompacting,
  trackToolCall,
  shouldUpdateWorkingMemory,
  executeWorkingMemoryUpdate,
  buildWorkingMemoryUpdatePrompt,
  validateWorkingMemoryAnswer,
} from '../../../src/core/memory/working-memory-updater.js';

/**
 * Suite 3: Working Memory Updater (Unit)
 *
 * The update is a one-shot: the runner hands back a whole file as TEXT and the
 * updater decides whether it may land on disk. So a stub that answers with a
 * well-formed file is the "success" case, and every malformed answer must leave
 * the previous file untouched.
 */

/** A well-formed answer: the template itself carries every header. */
function validAnswer(focus = 'Shipping the updater'): string {
  return WORKING_MEMORY_TEMPLATE.replace('# Active Focus\n', `# Active Focus\n${focus}\n`);
}

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
  resetUpdaterState();
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('shouldUpdateWorkingMemory', () => {
  it('3.1: returns false below initialization threshold', () => {
    for (let i = 0; i < 5; i++) trackToolCall();
    expect(shouldUpdateWorkingMemory(5000)).toBe(false);
  });

  it('3.2: returns false without enough tool calls', () => {
    trackToolCall();
    trackToolCall();
    // 2 tool calls, below threshold of 3
    expect(shouldUpdateWorkingMemory(15000)).toBe(false);
  });

  it('3.3: returns true at initialization threshold', () => {
    for (let i = 0; i < 3; i++) trackToolCall();
    expect(shouldUpdateWorkingMemory(10000)).toBe(true);
  });

  it('3.4: subsequent update needs 5K growth + 3 tool calls', async () => {
    // Simulate first extraction
    const runner = vi.fn().mockResolvedValue(validAnswer());
    for (let i = 0; i < 3; i++) trackToolCall();
    await executeWorkingMemoryUpdate(runner, 10000);

    // Track 3 tool calls for the next check
    for (let i = 0; i < 3; i++) trackToolCall();

    // Only 4K growth (< 5K threshold)
    expect(shouldUpdateWorkingMemory(14000)).toBe(false);

    // 5K growth + 3 tool calls
    expect(shouldUpdateWorkingMemory(15000)).toBe(true);
  });

  it('3.5: setCompacting(true) blocks updates', () => {
    for (let i = 0; i < 3; i++) trackToolCall();
    setCompacting(true);
    expect(shouldUpdateWorkingMemory(20000)).toBe(false);

    setCompacting(false);
    expect(shouldUpdateWorkingMemory(20000)).toBe(true);
  });

  it('3.6: trackToolCall() increments counter', () => {
    trackToolCall();
    trackToolCall();
    trackToolCall();
    expect(shouldUpdateWorkingMemory(10000)).toBe(true);
  });
});

describe('executeWorkingMemoryUpdate', () => {
  it('3.7: writes the answer as the whole file and resets state', async () => {
    const runner = vi.fn().mockResolvedValue(validAnswer('Reviewing the one-shot'));
    await executeWorkingMemoryUpdate(runner, 15000);

    expect(runner).toHaveBeenCalledOnce();
    // The prompt should reference WORKING_MEMORY_FILE
    const prompt = runner.mock.calls[0][0] as string;
    expect(prompt).toContain(WORKING_MEMORY_FILE);

    // The answer replaced the file, headers and all.
    const written = fs.readFileSync(WORKING_MEMORY_FILE, 'utf-8');
    expect(written).toContain('Reviewing the one-shot');
    for (const header of ['# Active Focus', '# User Requests', '# Learnings']) {
      expect(written).toContain(header);
    }

    // After execution, shouldUpdateWorkingMemory returns false (reset state)
    // Need 3 tool calls + 5K token growth from 15000
    expect(shouldUpdateWorkingMemory(15000)).toBe(false);
  });

  it('3.8: handles runner failure gracefully', async () => {
    const runner = vi.fn().mockRejectedValue(new Error('LLM timeout'));

    // Should not throw
    await executeWorkingMemoryUpdate(runner, 15000);

    // extractionStartedAt should be reset, so a subsequent check with fresh tool calls
    // should be able to trigger again
    for (let i = 0; i < 3; i++) trackToolCall();
    expect(shouldUpdateWorkingMemory(15000)).toBe(true);
  });

  it('3.8b: an answer missing a section header leaves the file alone', async () => {
    // The previous file is the ONLY copy: writing a reply that dropped a header
    // would delete that section for good, so a partial answer is refused whole.
    const before = '# Active Focus\nKeep me.\n# User Requests\nAnd me.\n';
    fs.mkdirSync(path.dirname(WORKING_MEMORY_FILE), { recursive: true });
    fs.writeFileSync(WORKING_MEMORY_FILE, before, 'utf-8');

    await executeWorkingMemoryUpdate(vi.fn().mockResolvedValue('# Active Focus\nOnly this one.\n'), 15000);

    expect(fs.readFileSync(WORKING_MEMORY_FILE, 'utf-8')).toBe(before);
    // State did not advance either, so the next threshold crossing retries.
    for (let i = 0; i < 3; i++) trackToolCall();
    expect(shouldUpdateWorkingMemory(15000)).toBe(true);
  });

  it('3.8c: an oversized answer leaves the file alone', async () => {
    const before = '# Active Focus\nKeep me.\n';
    fs.mkdirSync(path.dirname(WORKING_MEMORY_FILE), { recursive: true });
    fs.writeFileSync(WORKING_MEMORY_FILE, before, 'utf-8');

    const huge = validAnswer('word '.repeat(60_000));
    await executeWorkingMemoryUpdate(vi.fn().mockResolvedValue(huge), 15000);

    expect(fs.readFileSync(WORKING_MEMORY_FILE, 'utf-8')).toBe(before);
  });
});

describe('validateWorkingMemoryAnswer', () => {
  it('3.10: accepts a well-formed file and guarantees a trailing newline', () => {
    const verdict = validateWorkingMemoryAnswer(validAnswer().trimEnd());
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error('unreachable');
    expect(verdict.content.endsWith('\n')).toBe(true);
  });

  it('3.11: unwraps a fenced answer rather than throwing the update away', () => {
    // The prompt forbids fences; a fenced reply is still perfectly good content.
    const verdict = validateWorkingMemoryAnswer('```markdown\n' + validAnswer() + '\n```');
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error('unreachable');
    expect(verdict.content).not.toContain('```');
  });

  it('3.12: names what is wrong, so a stalled working memory is diagnosable', () => {
    const empty = validateWorkingMemoryAnswer('   ');
    expect(empty.ok).toBe(false);
    if (empty.ok) throw new Error('unreachable');
    expect(empty.reason).toContain('empty');

    const missing = validateWorkingMemoryAnswer('# Active Focus\nonly one section\n');
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error('unreachable');
    expect(missing.reason).toContain('# User Requests');

    const fatSection = validateWorkingMemoryAnswer(validAnswer('word '.repeat(2_000)));
    expect(fatSection.ok).toBe(false);
    if (fatSection.ok) throw new Error('unreachable');
    expect(fatSection.reason).toMatch(new RegExp(String(MAX_SECTION_TOKENS)));
  });
});

describe('buildWorkingMemoryUpdatePrompt', () => {
  it('3.9: includes current content and size warnings', () => {
    // Write oversized content to WORKING_MEMORY_FILE
    fs.mkdirSync(path.dirname(WORKING_MEMORY_FILE), { recursive: true });
    // Need content that exceeds MAX_SECTION_TOKENS (2000) when tokenized
    const bigContent = 'the quick brown fox jumps over the lazy dog and runs around the park. '.repeat(500);
    fs.writeFileSync(
      WORKING_MEMORY_FILE,
      `# Active Focus\n${bigContent}\n# User Requests\nSmall content\n`,
      'utf-8',
    );

    const prompt = buildWorkingMemoryUpdatePrompt();
    expect(prompt).toContain('<current_working_memory>');
    expect(prompt).toContain('WARNING:');
    expect(prompt).toContain('Active Focus');
    // It asks for the whole file back — no tools are available to this call.
    expect(prompt).toContain('COMPLETE updated file');
  });
});
