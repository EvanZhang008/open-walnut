/**
 * A message parked because the coding agent cannot run on its host goes out by itself
 * once the host can run it (src/core/sessions/agent-wait-resend.ts). Review round 2,
 * D08: a first message typed before Claude Code was installed said "this message waits
 * here", and after the install and the sign-in nothing sent it.
 *
 * The guard: every readiness kind that means the agent cannot run (host-problem.ts
 * AGENT_CANNOT_RUN_KINDS) and every kind the spawn gate refuses with
 * (ClaudeRuntimeMissingError, read from its source) has a resend rule; the verdict
 * carries the kind onto the parked row; and no park site drops it by passing only the
 * verdict's words. A new kind, or a park site that keeps only `.reason`, fails here.
 * The rest pins the queue rules: once, in order, never past a Stop, never another park.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-agent-wait-resend'));

import { WALNUT_HOME } from '../../../src/constants.js';
import { AGENT_CANNOT_RUN_KINDS } from '../../../src/core/hosts/host-problem.js';
import { AGENT_WAIT_RESEND, agentRunnable } from '../../../src/core/sessions/agent-wait-resend.js';
import { ClaudeRuntimeMissingError, classifyDeliveryFailure } from '../../../src/providers/delivery-failure.js';
import {
  enqueueMessage, getQueue, markProcessing, parkMessages, resetCache, sessionsWithAgentWaitRows, unparkAgentWaitRows, unparkMessage,
} from '../../../src/core/session-message-queue.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Every .ts file under src/, recursively. */
function sourceFiles(dir = path.join(ROOT, 'src')): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sourceFiles(p) : e.name.endsWith('.ts') ? [p] : [];
  });
}

/**
 * Kinds whose waiting words name Retry instead of "goes out by itself", with why. Their row
 * still has a resend rule (AGENT_WAIT_RESEND), but the words promise only what is sure.
 */
const RETRY_WORDED_KINDS: Readonly<Record<string, string>> = {
  claude_error: 'Claude Code is installed and stopped at once: a readiness check may still read it runnable, so no turn to runnable may come to send the row; Retry is the sure way (delivery-failure.ts waitingReason)',
};

describe('every kind the agent can wait on has a resend rule', () => {
  it('covers AGENT_CANNOT_RUN_KINDS', () => {
    expect(AGENT_CANNOT_RUN_KINDS.length).toBeGreaterThan(0);
    for (const kind of AGENT_CANNOT_RUN_KINDS) expect(AGENT_WAIT_RESEND[kind], kind).toBeDefined();
  });

  it('covers every kind the spawn gate refuses with, and the verdict carries it to the parked row', () => {
    const src = read('src/providers/delivery-failure.ts');
    const union = /class ClaudeRuntimeMissingError[\s\S]*?readonly errorKind: ([^)]+)\)/.exec(src)?.[1] ?? '';
    const kinds = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      expect(AGENT_WAIT_RESEND[kind], kind).toBeDefined();
      const verdict = classifyDeliveryFailure(new ClaudeRuntimeMissingError('Claude Code is not installed on this computer.', kind as 'claude_missing'));
      expect(verdict).toMatchObject({ kind: 'permanent', waitsFor: kind });
      // The words say it goes out by itself, never only "press Retry", except where the
      // readiness check may never see the kind (RETRY_WORDED_KINDS).
      expect(verdict.reason).toMatch(RETRY_WORDED_KINDS[kind] ? /press Retry/ : /goes out by itself/);
    }
  });

  it('no park site keeps only the words of a delivery verdict (its waitsFor would be lost)', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/parkMessages\(([^\n]*)/g)) {
        if (/(verdict|classifyDeliveryFailure\([^)]*\))\.reason/.test(m[1])) offenders.push(`${path.relative(ROOT, file)}: parkMessages(${m[1].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the refused first line is parked with its kind', () => {
    const src = read('src/providers/claude-code-session.ts');
    const fn = /async function parkUnstartedFirstLine[\s\S]*?\n}\n/.exec(src)?.[0] ?? '';
    expect(fn).toMatch(/heldReason: reason, waitsFor/);
    expect(src).toMatch(/parkUnstartedFirstLine\(parkSid, parkLine, reason, refused\.errorKind\)/);
  });
});

describe('agentRunnable', () => {
  it('reads runnable only on a settled answer with no kind that stops the agent', () => {
    expect(agentRunnable(undefined)).toBe(false);
    expect(agentRunnable({ claude: { found: false }, problems: [{ kind: 'claude_missing' }] })).toBe(false);
    expect(agentRunnable({ claude: { found: true }, problems: [{ kind: 'claude_not_logged_in' }] })).toBe(false);
    expect(agentRunnable({ claude: { found: true, unknown: 'timed out' }, problems: [] })).toBe(false);
    expect(agentRunnable({ claude: { found: true }, problems: [], checkError: 'no answer' })).toBe(false);
    // An outdated CLI still runs.
    expect(agentRunnable({ claude: { found: true }, problems: [{ kind: 'claude_outdated' }] })).toBe(true);
    expect(agentRunnable({ claude: { found: true }, problems: [] })).toBe(true);
  });
});

describe('the queue rules of a resend', () => {
  const SID = 'agent-wait-session';
  const verdict = classifyDeliveryFailure(new ClaudeRuntimeMissingError('Claude Code is not installed on this computer.', 'claude_missing'));

  beforeEach(async () => {
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
    await fsp.mkdir(WALNUT_HOME, { recursive: true });
    resetCache();
  });
  afterEach(async () => {
    resetCache();
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
  });

  it('a row parked on the verdict waits for the agent; a person\'s Retry clears the mark', async () => {
    const row = await enqueueMessage(SID, 'hello');
    await parkMessages(await markProcessing(SID), verdict);
    expect((await getQueue(SID))[0]).toMatchObject({ id: row.id, status: 'parked', waitsFor: 'claude_missing' });
    expect(await sessionsWithAgentWaitRows()).toEqual([SID]);
    expect(await unparkMessage(SID, row.id)).toBe(true);
    expect((await getQueue(SID))[0].waitsFor).toBeUndefined();
    expect(await sessionsWithAgentWaitRows()).toEqual([]);
  });

  it('sends a waiting row once, and never a row parked for anything else', async () => {
    const waiting = await enqueueMessage(SID, 'first', { heldReason: verdict.reason, waitsFor: 'claude_missing' });
    const other = await enqueueMessage(SID, 'too large', { heldReason: 'Not sent: too large.' });
    expect(await unparkAgentWaitRows(SID, null)).toEqual([waiting.id]);
    expect(await unparkAgentWaitRows(SID, null)).toEqual([]);
    const rows = await getQueue(SID);
    expect(rows.find((m) => m.id === waiting.id)).toMatchObject({ status: 'pending' });
    expect(rows.find((m) => m.id === waiting.id)?.waitsFor).toBeUndefined();
    expect(rows.find((m) => m.id === other.id)).toMatchObject({ status: 'parked', parkedReason: 'Not sent: too large.' });
  });

  it('a row a Stop came after stays parked for the person', async () => {
    await enqueueMessage(SID, 'before the stop', { heldReason: verdict.reason, waitsFor: 'claude_missing' });
    // The session's fence moved (a Stop): the row's own fence is no longer the current one.
    expect(await unparkAgentWaitRows(SID, 'stop-after-it')).toEqual([]);
    expect((await getQueue(SID))[0]).toMatchObject({ status: 'parked', waitsFor: 'claude_missing' });
  });

  it('rides ahead of a row going out, in its own order, only when one goes out', async () => {
    const waiting = await enqueueMessage(SID, 'first', { heldReason: verdict.reason, waitsFor: 'claude_missing' });
    expect(await unparkAgentWaitRows(SID, null, { onlyWithPending: true })).toEqual([]);
    const next = await enqueueMessage(SID, 'second');
    expect(await unparkAgentWaitRows(SID, null, { onlyWithPending: true })).toEqual([waiting.id]);
    const batch = await markProcessing(SID, null);
    expect(batch.map((m) => m.id)).toEqual([waiting.id]);
    expect((await getQueue(SID)).map((m) => m.id)).toEqual([waiting.id, next.id]);
  });
});
