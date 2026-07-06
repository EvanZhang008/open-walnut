/**
 * Black-box regression tests for session dedup across two layers:
 *
 *   Category A — History API Contract (readSessionHistory)
 *     Input: JSONL file → Output: SessionHistoryMessage[]
 *     Verifies that replayed/duplicate JSONL lines produce deduplicated output.
 *
 *   Category B — Stream Buffer Contract (sessionStreamBuffer)
 *     Input: text deltas / tool uses → Output: StreamSnapshot
 *     Verifies buffer accumulation, session isolation, and lifecycle.
 *
 * Design: pure black-box. Only tests public APIs. No internal mocking.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js';

vi.mock('../../src/constants.js', () => createMockConstants());
// Daemon-uniform: serve __local__ reads from real fs against the mocked CLAUDE_HOME.
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());

import { CLAUDE_HOME } from '../../src/constants.js';
import {
  encodeProjectPath,
  readSessionHistory,
} from '../../src/core/session-history.js';
import { sessionStreamBuffer } from '../../src/web/session-stream-buffer.js';

const tmpBase = CLAUDE_HOME;

beforeEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true });
  await fsp.mkdir(tmpBase, { recursive: true });
});

afterEach(async () => {
  sessionStreamBuffer.destroy();
  await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
});

/** Helper: write JSONL lines to the expected Claude Code path. */
async function writeJsonl(sessionId: string, cwd: string, lines: unknown[]) {
  const encoded = encodeProjectPath(cwd);
  const dir = path.join(tmpBase, 'projects', encoded);
  await fsp.mkdir(dir, { recursive: true });
  const content = lines.map(l => JSON.stringify(l)).join('\n');
  await fsp.writeFile(path.join(dir, `${sessionId}.jsonl`), content);
}

/** Helper: build a JSONL message line. */
function msg(id: string, role: 'user' | 'assistant', text: string, extras?: {
  tools?: unknown[];
  thinking?: string;
  model?: string;
}) {
  const content: unknown[] = [];
  if (extras?.thinking) content.push({ type: 'thinking', thinking: extras.thinking });
  content.push({ type: 'text', text });
  if (extras?.tools) content.push(...extras.tools);
  return {
    type: role,
    timestamp: `2025-01-01T00:00:${String(parseInt(id.replace(/\D/g, '') || '0')).padStart(2, '0')}Z`,
    message: { id, role, content, ...(extras?.model ? { model: extras.model } : {}) },
  };
}

// ═══════════════════════════════════════════════════════════════════
//  Category A — History API dedup regression
// ═══════════════════════════════════════════════════════════════════

describe('Category A: History API dedup regression', () => {
  it('A1: deduplicates 2x text repeat', async () => {
    const line = {
      type: 'assistant',
      timestamp: '2025-01-01T00:00:00Z',
      message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] },
    };
    await writeJsonl('a1-2x', '/test', [line, line]);

    const messages = await readSessionHistory('a1-2x', '/test');
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe('Hello world');
  });

  it('A2: deduplicates 8x text repeat', async () => {
    const line = {
      type: 'assistant',
      timestamp: '2025-01-01T00:00:00Z',
      message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'Repeated 8 times' }] },
    };
    await writeJsonl('a2-8x', '/test', Array(8).fill(line));

    const messages = await readSessionHistory('a2-8x', '/test');
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe('Repeated 8 times');
  });

  it('A3: deduplicates 4x mixed (thinking + text + tool_use)', async () => {
    const line = {
      type: 'assistant',
      timestamp: '2025-01-01T00:00:00Z',
      message: {
        id: 'a1',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me think...' },
          { type: 'text', text: 'Here is my answer.' },
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file: 'test.ts' } },
        ],
      },
    };
    await writeJsonl('a3-mixed', '/test', [line, line, line, line]);

    const messages = await readSessionHistory('a3-mixed', '/test');
    expect(messages).toHaveLength(1);
    expect(messages[0].thinking).toBe('Let me think...');
    expect(messages[0].text).toBe('Here is my answer.');
    expect(messages[0].tools).toHaveLength(1);
    expect(messages[0].tools![0].name).toBe('Read');
  });

  it('A4: deduplicates multi-turn 4x replay', async () => {
    const turn1User = msg('u1', 'user', 'Question 1');
    const turn1Asst = msg('a1', 'assistant', 'Answer 1');
    const turn2User = msg('u2', 'user', 'Question 2');
    const turn2Asst = msg('a2', 'assistant', 'Answer 2');

    // Simulate 4x replay of entire conversation
    const oneTurn = [turn1User, turn1Asst, turn2User, turn2Asst];
    const lines = [...oneTurn, ...oneTurn, ...oneTurn, ...oneTurn];
    await writeJsonl('a4-turns', '/test', lines);

    const messages = await readSessionHistory('a4-turns', '/test');
    expect(messages).toHaveLength(4);
    expect(messages[0].text).toBe('Question 1');
    expect(messages[1].text).toBe('Answer 1');
    expect(messages[2].text).toBe('Question 2');
    expect(messages[3].text).toBe('Answer 2');
  });

  it('A5: different texts + replay keeps distinct content merged', async () => {
    const line1 = {
      type: 'assistant',
      timestamp: '2025-01-01T00:00:00Z',
      message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'Step 1' }] },
    };
    const line2 = {
      type: 'assistant',
      timestamp: '2025-01-01T00:00:01Z',
      message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'Step 2' }] },
    };
    // Original + replay
    await writeJsonl('a5-replay', '/test', [line1, line2, line1, line2]);

    const messages = await readSessionHistory('a5-replay', '/test');
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe('Step 1\nStep 2');
  });

  it('A6: 8x replay with 2 different tool_use blocks', async () => {
    const line = {
      type: 'assistant',
      timestamp: '2025-01-01T00:00:00Z',
      message: {
        id: 'a1',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file: 'a.ts' } },
          { type: 'tool_use', id: 'tu_2', name: 'Edit', input: { file: 'b.ts' } },
        ],
      },
    };
    await writeJsonl('a6-tools', '/test', Array(8).fill(line));

    const messages = await readSessionHistory('a6-tools', '/test');
    expect(messages).toHaveLength(1);
    expect(messages[0].tools).toHaveLength(2);
    expect(messages[0].tools![0].name).toBe('Read');
    expect(messages[0].tools![1].name).toBe('Edit');
  });
});

// ═══════════════════════════════════════════════════════════════════
//  Category B — Stream Buffer contract
// ═══════════════════════════════════════════════════════════════════

describe('Category B: Stream Buffer contract', () => {
  it('B1: normal text accumulation (data events do NOT flip streaming)', () => {
    sessionStreamBuffer.appendTextDelta('b1', 'Hello ');
    sessionStreamBuffer.appendTextDelta('b1', 'world');

    const snap = sessionStreamBuffer.getSnapshot('b1');
    expect(snap.blocks).toHaveLength(1);
    expect(snap.blocks[0]).toMatchObject({ type: 'text', content: 'Hello world' });
    // Architectural invariant: data events (appendTextDelta/appendToolUse) must
    // NOT set isStreaming. Only markStreaming (driven by lifecycle events) does.
    // This prevents replay/late events from re-polluting state after markDone.
    expect(snap.isStreaming).toBe(false);
  });

  it('B1b: markStreaming flips isStreaming; markDone clears it; data events never re-pollute', () => {
    sessionStreamBuffer.markStreaming('b1b');
    expect(sessionStreamBuffer.getSnapshot('b1b').isStreaming).toBe(true);

    sessionStreamBuffer.markDone('b1b');
    expect(sessionStreamBuffer.getSnapshot('b1b').isStreaming).toBe(false);

    // Late text-delta after markDone must NOT re-set streaming (core Root Cause 5 invariant)
    sessionStreamBuffer.appendTextDelta('b1b', 'replay');
    expect(sessionStreamBuffer.getSnapshot('b1b').isStreaming).toBe(false);

    // Same invariant for tool-use events (second data-event path)
    sessionStreamBuffer.appendToolUse('b1b', 'tu_replay', 'Read', { file: 'x.ts' });
    expect(sessionStreamBuffer.getSnapshot('b1b').isStreaming).toBe(false);

    // After clear() + late data events, streaming must remain false
    sessionStreamBuffer.clear('b1b');
    sessionStreamBuffer.appendTextDelta('b1b', 'post-clear');
    sessionStreamBuffer.appendToolUse('b1b', 'tu_post', 'Edit', {});
    expect(sessionStreamBuffer.getSnapshot('b1b').isStreaming).toBe(false);
  });

  it('B2: tool_use interrupts text flow', () => {
    sessionStreamBuffer.appendTextDelta('b2', 'Part 1');
    sessionStreamBuffer.appendToolUse('b2', 'tu_1', 'Read', { file: 'x.ts' });
    sessionStreamBuffer.appendTextDelta('b2', 'Part 2');

    const snap = sessionStreamBuffer.getSnapshot('b2');
    expect(snap.blocks).toHaveLength(3);
    expect(snap.blocks[0]).toMatchObject({ type: 'text', content: 'Part 1' });
    expect(snap.blocks[1]).toMatchObject({ type: 'tool_call', name: 'Read' });
    expect(snap.blocks[2]).toMatchObject({ type: 'text', content: 'Part 2' });
    // Part 2 must NOT contain Part 1 — tool resets text accumulator
    expect((snap.blocks[2] as { content: string }).content).not.toContain('Part 1');
  });

  it('B3: repeated deltas accumulate (buffer does NOT dedup — Layer 2 responsibility)', () => {
    sessionStreamBuffer.appendTextDelta('b3', 'X');
    sessionStreamBuffer.appendTextDelta('b3', 'X');

    const snap = sessionStreamBuffer.getSnapshot('b3');
    expect(snap.blocks).toHaveLength(1);
    // Buffer simply accumulates — dedup is Layer 2's job
    expect(snap.blocks[0]).toMatchObject({ type: 'text', content: 'XX' });
  });

  it('B4: complete turn (text → tool → result → text)', () => {
    sessionStreamBuffer.appendTextDelta('b4', 'Analyzing...');
    sessionStreamBuffer.appendToolUse('b4', 'tu_1', 'Read', { file: 'a.ts' });
    sessionStreamBuffer.appendToolResult('b4', 'tu_1', 'file contents');
    sessionStreamBuffer.appendTextDelta('b4', 'Done.');

    const snap = sessionStreamBuffer.getSnapshot('b4');
    expect(snap.blocks).toHaveLength(3);
    expect(snap.blocks[0]).toMatchObject({ type: 'text', content: 'Analyzing...' });
    expect(snap.blocks[1]).toMatchObject({ type: 'tool_call', name: 'Read', status: 'done' });
    expect(snap.blocks[2]).toMatchObject({ type: 'text', content: 'Done.' });
  });

  it('B5: session isolation', () => {
    // s1 gets duplicate deltas (simulating what would happen without Layer 2 dedup)
    sessionStreamBuffer.appendTextDelta('s1', 'AAA');
    sessionStreamBuffer.appendTextDelta('s1', 'AAA');

    // s2 gets clean deltas
    sessionStreamBuffer.appendTextDelta('s2', 'BBB');

    const snap1 = sessionStreamBuffer.getSnapshot('s1');
    const snap2 = sessionStreamBuffer.getSnapshot('s2');

    expect(snap1.blocks[0]).toMatchObject({ type: 'text', content: 'AAAAAA' });
    expect(snap2.blocks[0]).toMatchObject({ type: 'text', content: 'BBB' });
    // s2 is not contaminated by s1
    expect(snap2.blocks).toHaveLength(1);
  });

  it('B6: markDone + clear lifecycle', () => {
    sessionStreamBuffer.appendTextDelta('b6', 'data');

    // markDone: isStreaming → false, blocks retained
    sessionStreamBuffer.markDone('b6');
    const afterDone = sessionStreamBuffer.getSnapshot('b6');
    expect(afterDone.isStreaming).toBe(false);
    expect(afterDone.blocks).toHaveLength(1);

    // clear: blocks removed
    sessionStreamBuffer.clear('b6');
    const afterClear = sessionStreamBuffer.getSnapshot('b6');
    expect(afterClear.blocks).toEqual([]);
    expect(afterClear.isStreaming).toBe(false);
  });
});
