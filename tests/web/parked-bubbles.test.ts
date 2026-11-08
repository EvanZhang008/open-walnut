/**
 * A parked row is never hidden behind the launch prompt (parked-bubbles.ts).
 *
 * Review round 2, D08: a task started before Claude Code was installed had its first
 * line parked under the launch bubble's own id (`launch-<sid>`). The live panel had
 * seeded that bubble as delivered, so the queue answer's parked row was skipped as
 * "already shown", and the launch head drew it with no Retry; only a reload showed it.
 *
 * Guard: the rules (a parked row replaces the bubble shown under its id, a refused
 * launch bubble is no head), and every place in web/src that picks the launch head or
 * merges the queue goes through them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { headsAsLaunch, markBubblesFailed, type ParkableBubble } from '@/components/sessions/parked-bubbles';
import { launchBubbleOf, queueRowBubble, type QueueRowWire } from '@/hooks/useSessionSend';
import { rehydrateFromQueue } from '@/hooks/queue-reconcile';
import type { OptimisticMessage } from '@/components/sessions/SessionChatHistory';
import { dedupeOptimisticMessages } from '@/components/sessions/optimistic-dedup';

const SID = '91dcfb86-0000-4000-8000-000000000001';
const LAUNCH_ID = `launch-${SID}`;
const words = 'Make a plan for my week';
const waiting = 'Claude Code is not installed on this computer. Install Claude Code and this message goes out by itself.';

function seeded(): OptimisticMessage {
  const b = launchBubbleOf({ id: LAUNCH_ID, text: words, at: '2026-11-10T17:34:09.000Z' });
  if (!b) throw new Error('no launch bubble');
  return b;
}

/** The panel's first queue read (useSessionSend's rehydrate). */
const rehydrate = (prev: OptimisticMessage[], rows: QueueRowWire[], launch: OptimisticMessage | null) =>
  rehydrateFromQueue(prev, rows, launch, { retired: new Set(), now: 0, toBubble: (r) => queueRowBubble(r) });

describe('a refused launch prompt reads as the message that was not sent', () => {
  it('the queue answer\'s parked row replaces the seeded launch bubble, with its waiting words', () => {
    const row: QueueRowWire = { id: LAUNCH_ID, message: words, status: 'parked', parkedReason: waiting, waitsFor: 'claude_missing', enqueuedAt: '2026-11-10T17:34:10.000Z' };
    expect(queueRowBubble(row)).not.toBeNull();
    const out = rehydrate([seeded()], [row], null) as Array<OptimisticMessage & ParkableBubble>;
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ queueId: LAUNCH_ID, status: 'failed', parked: true, failedError: waiting, waitsFor: 'claude_missing' });
    expect(out[0].launch).toBeFalsy();
    expect(headsAsLaunch(out[0])).toBe(false);
  });

  it('a batch-failed for the launch id strips the launch mark and keeps what it waits on', () => {
    const out = markBubblesFailed([seeded()], [LAUNCH_ID], waiting, { parked: true, waitsFor: 'claude_missing' });
    expect(out[0]).toMatchObject({ status: 'failed', parked: true, waitsFor: 'claude_missing', failedError: waiting });
    expect(out[0].launch).toBeUndefined();
  });

  it('the launch prompt still leads when no row stands under its id, and is never shown twice', () => {
    const typed: QueueRowWire = { id: 'qm-1', message: 'second', status: 'pending' };
    const launch = seeded();
    expect(rehydrate([], [typed], launch).map((m) => m.queueId)).toEqual([LAUNCH_ID, 'qm-1']);
    const parkedRow: QueueRowWire = { id: LAUNCH_ID, message: words, status: 'parked', parkedReason: waiting };
    expect(rehydrate([], [parkedRow], launch).map((m) => m.queueId)).toEqual([LAUNCH_ID]);
    expect(rehydrate([], [parkedRow], launch)[0]).toMatchObject({ status: 'failed', parked: true });
  });

  it('with no history the refused bubble stays on screen (nothing absorbs it)', () => {
    const failed = markBubblesFailed([seeded()], [LAUNCH_ID], waiting, { parked: true, waitsFor: 'claude_missing' });
    expect(dedupeOptimisticMessages(failed, [], 0).map((m) => m.queueId)).toEqual([LAUNCH_ID]);
  });
});

describe('guard: every launch-head pick and queue merge goes through the rules', () => {
  const root = path.resolve(import.meta.dirname, '../../web/src');
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : /\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : [];
  });

  it('no surface heads the conversation with a launch bubble without asking headsAsLaunch', () => {
    const offenders = files(root).flatMap((f) => {
      const text = fs.readFileSync(f, 'utf8');
      return [...text.matchAll(/\.filter\(\(?\s*(\w+)\s*\)?\s*=>\s*!?\1\.launch\s*\)/g)].map((m) => `${path.relative(root, f)}: ${m[0]}`);
    });
    expect(offenders).toEqual([]);
  });

  it('the queue rehydrate merges with rehydrateFromQueue, never by skipping an id already shown', () => {
    const hook = fs.readFileSync(path.join(root, 'hooks/useSessionSend.ts'), 'utf8');
    expect(hook).toMatch(/rehydrateFromQueue\(prev, res\.messages \?\? \[\], launch,/);
    expect(hook).toMatch(/markBubblesFailed\(prev, messageIds, error, info\)/);
    const history = fs.readFileSync(path.join(root, 'components/sessions/SessionChatHistory.tsx'), 'utf8');
    expect(history).toMatch(/deduped\.filter\(headsAsLaunch\)/);
    // A row waiting for the agent draws its waiting words and the fix in place.
    expect(history).toMatch(/m\.waitsFor \? \(\s*\/\/[^\n]*\n\s*<AgentWaitNote/);
  });
});

describe('the waiting note reads the live state of this computer', () => {
  it('says sign in once Claude Code is installed but signed out, not "not installed"', async () => {
    const { agentWaitLine, AGENT_SIGN_IN_LINE, AGENT_READY_SENDING } = await import('@/components/sessions/AgentWaitNote');
    const missing = 'Claude Code is not installed on this computer. Install Claude Code and this message goes out by itself.';
    expect(agentWaitLine(false, 'install', missing)).toBe(missing);
    expect(agentWaitLine(false, 'sign-in', missing)).toBe(AGENT_SIGN_IN_LINE);
    expect(agentWaitLine(true, undefined, missing)).toBe(AGENT_READY_SENDING);
    expect(agentWaitLine(false, undefined, missing)).toBe(missing);
  });
});
