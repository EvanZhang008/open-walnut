/**
 * Memory telemetry, end to end through the surfaces that CHANGE A DECISION:
 *  1. memory_manage's over-budget consolidation error (where the model picks
 *     what to merge/drop),
 *  2. the background-review fork's prompt (the unattended upkeep pass).
 *
 * Telemetry nobody reads is dead weight, so these are the tests that matter as
 * much as the lifecycle ones. Separate file from memory-manage-tool.test.ts to
 * keep this feature's assertions independent of that file's other suites.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { memoryManageTool } from '../../src/agent/tools/memory-manage-tool.js';
import { getBoundedMemory, MEMORY_CHAR_BUDGET } from '../../src/core/bounded-memory.js';
import { loadMemoryTelemetry } from '../../src/core/memory-telemetry.js';
import { buildReviewPrompt, REVIEW_PROMPT } from '../../src/agent/background-review.js';
import { WALNUT_HOME, MEMORY_FILE } from '../../src/constants.js';

const exec = async (params: Record<string, unknown>, meta?: { source?: string }) =>
  JSON.parse((await memoryManageTool.execute(params, meta)) as string);

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(MEMORY_FILE), { recursive: true });
  getBoundedMemory().resetConsolidationFailures();
  getBoundedMemory(undefined, 'user').resetConsolidationFailures();
});

afterEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('memory_manage records write-path telemetry', () => {
  it('an add through the tool creates a record with live-turn provenance', async () => {
    const res = await exec({ action: 'add', content: '## Reply Concisely\n\nUser prefers short answers.' });
    expect(res.success).toBe(true);
    const rec = loadMemoryTelemetry()['memory:Reply Concisely'];
    expect(rec.origin).toBe('personal-ai-turn');
    expect(rec.interactive_writes).toBe(1);
  });

  it('attributes a write from the review fork to unattended provenance', async () => {
    await exec(
      { action: 'add', content: '## Prefer Batch Writes\n\nUser prefers one batched change.' },
      { source: 'background-review' },
    );
    expect(loadMemoryTelemetry()['memory:Prefer Batch Writes'].origin).toBe('background-review');
  });

  it('tracks the user target separately', async () => {
    await exec({ action: 'add', target: 'user', content: '## Time Zone\n\nUser works in the Pacific time zone.' });
    expect(loadMemoryTelemetry()['user:Time Zone']).toBeDefined();
    expect(loadMemoryTelemetry()['memory:Time Zone']).toBeUndefined();
  });

  it('a batch that removes and adds leaves no residue for the removed entry', async () => {
    await exec({ action: 'add', content: '## Old Rule\n\nStale guidance.' });
    expect(loadMemoryTelemetry()['memory:Old Rule']).toBeDefined();
    const res = await exec({
      action: 'batch',
      operations: [
        { action: 'remove', old_text: 'Stale guidance' },
        { action: 'add', content: '## New Rule\n\nCurrent guidance.' },
      ],
    });
    expect(res.success).toBe(true);
    const map = loadMemoryTelemetry();
    expect(map['memory:Old Rule']).toBeUndefined();
    expect(map['memory:New Rule']).toBeDefined();
  });

  it('a failed write records nothing', async () => {
    const res = await exec({ action: 'remove', old_text: 'does not exist anywhere' });
    expect(res.success).toBe(false);
    expect(loadMemoryTelemetry()).toEqual({});
  });
});

describe('SURFACE 1: the over-budget consolidation error carries the evidence', () => {
  it('attaches index-aligned entryEvidence plus the honesty note', async () => {
    await exec({ action: 'add', content: `## Big\n\n${'x'.repeat(MEMORY_CHAR_BUDGET - 200)}` });
    const res = await exec({ action: 'add', content: `## Overflow\n\n${'y'.repeat(500)}` });

    expect(res.success).toBe(false);
    expect(res.currentEntries).toHaveLength(1);
    expect(res.entryEvidence).toHaveLength(1);
    expect(res.entryEvidence[0]).toContain('Big');
    expect(res.entryEvidence[0]).toContain('live/');
    // The caveat must travel with the numbers so they are read as tie-breakers.
    expect(res.entryEvidence[0]).not.toContain('used 0 times');
    expect(res.entryEvidenceNote).toContain('injected every turn');
    expect(res.entryEvidenceLegend).toContain('live=written in a live Personal AI turn');
    expect(res.entryEvidenceNote).toContain('NO per-entry');
    expect(res.entryEvidenceNote).toContain('tie-breakers, not verdicts');
    // The pre-existing skill-routing hint is untouched.
    expect(res.hint).toContain('skill_manage');
  });

  it('flags a review-fork entry as UNATTENDED right where the model must choose', async () => {
    await exec(
      { action: 'add', content: `## Fork Rule\n\n${'z'.repeat(MEMORY_CHAR_BUDGET - 200)}` },
      { source: 'background-review' },
    );
    const res = await exec({ action: 'add', content: `## Overflow\n\n${'y'.repeat(500)}` });
    expect(res.success).toBe(false);
    expect(res.entryEvidence[0]).toContain('UNATTENDED');
  });

  it('adds no evidence keys on a success response (terminal, stays lean)', async () => {
    const res = await exec({ action: 'add', content: '## Reply Concisely\n\nShort answers.' });
    expect(res.success).toBe(true);
    expect(res.entryEvidence).toBeUndefined();
    expect(res.entryEvidenceNote).toBeUndefined();
  });
});

describe('SURFACE 2: the background-review prompt', () => {
  it('is byte-identical to REVIEW_PROMPT when nothing is flagged', async () => {
    await exec({ action: 'add', content: '## Reply Concisely\n\nShort answers.' });
    expect(buildReviewPrompt('general')).toBe(REVIEW_PROMPT);
  });

  it('is byte-identical when there is no telemetry at all', () => {
    expect(buildReviewPrompt('general')).toBe(REVIEW_PROMPT);
    expect(buildReviewPrompt()).toBe(REVIEW_PROMPT);
  });

  it('appends flagged candidates so the reviewer can act on them', async () => {
    await exec(
      { action: 'add', content: '## Fork Invented Rule\n\nSomething the fork decided alone.' },
      { source: 'background-review' },
    );
    const prompt = buildReviewPrompt('general');
    expect(prompt.startsWith(REVIEW_PROMPT)).toBe(true);
    expect(prompt.length).toBeGreaterThan(REVIEW_PROMPT.length);
    expect(prompt).toContain('Fork Invented Rule');
    expect(prompt).toContain('UNATTENDED');
    expect(prompt).toContain('memory_manage');
    // The compact codes are only usable if the legend rides along.
    expect(prompt).toContain('fork=written by the unattended review fork');
    expect(prompt).toContain('NO per-entry');
  });

  it('stays well under 1k tokens even with a full store of flagged entries', async () => {
    for (let i = 0; i < 20; i++) {
      await exec(
        { action: 'add', content: `## Fork Rule Number ${i}\n\nSomething the fork decided alone.` },
        { source: 'background-review' },
      );
    }
    const added = buildReviewPrompt('general').length - REVIEW_PROMPT.length;
    // Cheap enough to be worth it on an every-10-turn fork (~4 chars/token).
    expect(added).toBeGreaterThan(0);
    expect(added).toBeLessThan(4_000);
  });
});
