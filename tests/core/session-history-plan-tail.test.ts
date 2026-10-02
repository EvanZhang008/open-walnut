/**
 * extractPlanContent on a transcript too large to read whole.
 *
 * GET /api/sessions/:id/plan answered 500 for every session whose transcript
 * exceeded DaemonFileReader's byte ceiling (a 63 MB JSONL on 2026-10-01): the
 * plan extractor read the WHOLE file, the reader refused it, and the refusal
 * propagated out of the route. The plan a user opens is the newest one, near the
 * end of the file, so the extractor now degrades to a bounded backward scan of
 * the tail.
 *
 * These tests drive the real read pipeline (readSessionJsonlContent through the
 * local daemon reader double, which enforces the same ceiling) with the ceiling
 * lowered via WALNUT_MAX_FILE_READ_BYTES, so a small fixture takes the exact
 * degradation path production takes. Every test first proves its fixture is
 * over the ceiling, so none can pass on the whole-file path by accident.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js';

vi.mock('../../src/constants.js', () => createMockConstants());
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());

import { CLAUDE_HOME } from '../../src/constants.js';
import { encodeProjectPath, extractPlanContent } from '../../src/core/session-history.js';
import { readSessionJsonlContent } from '../../src/core/session-file-reader.js';

const tmpBase = CLAUDE_HOME as string;
const CWD = '/tmp/plan-tail-test-project';
/** Tiny ceiling: the scan window is clamped to it, so the scan covers 8 x 16 KiB. */
const CEILING = 16 * 1024;
const SCAN_CAP = CEILING * 8;
const prevLimit = process.env.WALNUT_MAX_FILE_READ_BYTES;

beforeEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true });
  await fsp.mkdir(tmpBase, { recursive: true });
  process.env.WALNUT_MAX_FILE_READ_BYTES = String(CEILING);
});

afterEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
  if (prevLimit === undefined) delete process.env.WALNUT_MAX_FILE_READ_BYTES;
  else process.env.WALNUT_MAX_FILE_READ_BYTES = prevLimit;
});

function jsonlPath(sessionId: string): string {
  return path.join(tmpBase, 'projects', encodeProjectPath(CWD), `${sessionId}.jsonl`);
}

/** Writes the transcript and returns its size in bytes. */
async function writeLines(sessionId: string, lines: unknown[]): Promise<number> {
  const p = jsonlPath(sessionId);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return (await fsp.stat(p)).size;
}

let seq = 0;
const userLine = (text: string) => ({
  type: 'user', uuid: `u-${++seq}`, message: { role: 'user', content: text },
});
const asstLine = (content: unknown[]) => ({
  type: 'assistant', uuid: `a-${++seq}`,
  message: { role: 'assistant', id: `msg_${seq}`, content },
});
const writePlan = (content: string) => asstLine([{
  type: 'tool_use', id: `tu_${seq}`, name: 'Write',
  input: { file_path: '/home/dev/.claude/plans/plan-tail.md', content },
}]);
const exitPlanMode = (plan?: string) => asstLine([{
  type: 'tool_use', id: `tu_${seq}`, name: 'ExitPlanMode', input: plan === undefined ? {} : { plan },
}]);

/** About `bytes` of ordinary conversation (~1 KiB per line). */
function padding(bytes: number): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i * 1024 < bytes; i++) {
    out.push(i % 2 === 0
      ? userLine(`question ${i} ${'x'.repeat(980)}`)
      : asstLine([{ type: 'text', text: `answer ${i} ${'y'.repeat(980)}` }]));
  }
  return out;
}

/** The whole-file read really refuses this transcript (the reported failure). */
async function expectOverCeiling(sessionId: string, size: number): Promise<void> {
  expect(size).toBeGreaterThan(CEILING);
  await expect(readSessionJsonlContent(sessionId, CWD)).rejects.toThrow(/byte ceiling/);
}

describe('extractPlanContent over the byte ceiling', () => {
  it('returns the newest plan near the end instead of throwing', async () => {
    const sid = 'plan-tail-newest';
    const size = await writeLines(sid, [
      exitPlanMode('Old plan from the first hour'),
      ...padding(80 * 1024),
      writePlan('# Newest plan\n\n1. Do the thing'),
      exitPlanMode(),
      ...padding(2 * 1024),
    ]);
    await expectOverCeiling(sid, size);

    await expect(extractPlanContent(sid, CWD)).resolves.toBe('# Newest plan\n\n1. Do the thing');
  });

  it('steps back past the last window to find a plan written earlier', async () => {
    const sid = 'plan-tail-step-back';
    const size = await writeLines(sid, [
      ...padding(10 * 1024),
      exitPlanMode('Plan three windows from the end'),
      ...padding(3 * CEILING),
    ]);
    await expectOverCeiling(sid, size);

    await expect(extractPlanContent(sid, CWD)).resolves.toBe('Plan three windows from the end');
  });

  it('reassembles a plan line longer than one window, multi-byte text intact', async () => {
    const sid = 'plan-tail-straddle';
    // Test data only: CJK and an emoji make every window edge likely to fall
    // inside a multi-byte character. The plan alone spans ~3 windows.
    const unit = 'Step 一二三 \u{1F4DD} details. ';
    const bigPlan = '# Big plan\n' + unit.repeat(Math.ceil((CEILING * 3) / unit.length));
    const size = await writeLines(sid, [
      ...padding(4 * 1024),
      writePlan(bigPlan),
      ...padding(CEILING + 3000),
    ]);
    await expectOverCeiling(sid, size);

    const plan = await extractPlanContent(sid, CWD);
    expect(plan).toBe(bigPlan);
  });

  it('keeps stepping back for a Write when the newest ExitPlanMode carries no plan', async () => {
    // Same answer as the whole-file read: the last Write wins, and the newest
    // ExitPlanMode (no plan) overrides the older one's text, so stopping at the
    // older ExitPlanMode plan two windows back would be wrong.
    const sid = 'plan-tail-exit-without-plan';
    const size = await writeLines(sid, [
      ...padding(4 * 1024),
      writePlan('Plan file the newest ExitPlanMode refers to'),
      ...padding(2 * CEILING),
      exitPlanMode('Older text an earlier ExitPlanMode carried'),
      ...padding(2 * CEILING),
      exitPlanMode(),
      ...padding(1024),
    ]);
    await expectOverCeiling(sid, size);

    await expect(extractPlanContent(sid, CWD)).resolves.toBe('Plan file the newest ExitPlanMode refers to');
  });

  it('answers null, not an error, when no plan sits inside the scan cap', async () => {
    const sid = 'plan-tail-beyond-cap';
    const size = await writeLines(sid, [
      exitPlanMode('Plan older than the scan reaches'),
      ...padding(SCAN_CAP + 8 * 1024),
    ]);
    await expectOverCeiling(sid, size);

    await expect(extractPlanContent(sid, CWD)).resolves.toBeNull();
  });

  it('finds the transcript without a cwd (hashed or unknown project dir)', async () => {
    const sid = 'plan-tail-no-cwd';
    const size = await writeLines(sid, [
      ...padding(40 * 1024),
      exitPlanMode('Plan found through fs.find'),
    ]);
    await expectOverCeiling(sid, size);

    await expect(extractPlanContent(sid)).resolves.toBe('Plan found through fs.find');
  });
});

describe('extractPlanContent under the byte ceiling (whole-file path unchanged)', () => {
  it('still prefers the last Write anywhere in the file over a later ExitPlanMode plan', async () => {
    const sid = 'plan-small-file';
    const size = await writeLines(sid, [
      writePlan('Written plan'),
      ...padding(2 * 1024),
      exitPlanMode('Later ExitPlanMode plan'),
    ]);
    expect(size).toBeLessThan(CEILING);

    await expect(extractPlanContent(sid, CWD)).resolves.toBe('Written plan');
  });
});
