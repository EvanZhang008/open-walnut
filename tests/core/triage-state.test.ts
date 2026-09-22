/**
 * The Inbox Triage pending buffer: the caps, the dropped counters, two writers
 * racing on one file, and the at-least-once handover.
 *
 * The case that has to exist is the last one: a crash BETWEEN the delivery and
 * the clear must re-deliver the batch, not lose it. Slack items live nowhere else
 * (the plugin's cursor has already moved past them), so a lost item is silently
 * gone forever — which is why this buffer clears on an acknowledgement and never
 * on a hand-out.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  ackTriageClaim,
  appendCapped,
  claimTriageBatch,
  CLAIM_TTL_MS,
  loadTriageState,
  markTriageStateStale,
  PENDING_MAIL_CAP,
  PENDING_SLACK_CAP,
  recordTriageArrivals,
  recordTriageJournalLine,
  releaseTriageClaim,
  triageStatePath,
  updateTriageState,
  type TriagePendingMail,
  type TriagePendingSlack,
} from '../../src/core/triage/state.js';

function slackRows(n: number, from = 0): TriagePendingSlack[] {
  return Array.from({ length: n }, (_, i) => ({
    conversation: `#room-${(from + i) % 9}`,
    isDm: false,
    isMention: (from + i) % 5 === 0,
    alias: `person${(from + i) % 4}`,
    ts: String(1_700_000_000 + from + i),
    permalink: `https://example.test/archives/C1/p${from + i}`,
    text: `line ${from + i}`,
    atMs: 1_000 + from + i,
  }));
}

function mailRows(n: number, from = 0): TriagePendingMail[] {
  return Array.from({ length: n }, (_, i) => ({
    accountId: `acct-${from + i}`,
    count: 2,
    headlines: [{ from: 'sender@example.test', subject: `subject ${from + i}` }],
    atMs: 2_000 + from + i,
  }));
}

beforeEach(async () => {
  await fs.rm(triageStatePath(), { force: true });
  await fs.rm(`${triageStatePath()}.lock`, { recursive: true, force: true });
});

describe('appendCapped — the pure cap rule', () => {
  it('keeps everything under the cap and drops nothing', () => {
    expect(appendCapped([1, 2], [3], 5)).toEqual({ list: [1, 2, 3], dropped: 0 });
  });

  it('drops the OLDEST when over the cap', () => {
    // Oldest-first because the claim is the oldest PREFIX: a cap that bites mid-run
    // must eat rows that were already delivered before it eats new ones.
    expect(appendCapped([1, 2, 3], [4, 5], 3)).toEqual({ list: [3, 4, 5], dropped: 2 });
  });

  it('a single append larger than the cap keeps the newest cap rows', () => {
    const { list, dropped } = appendCapped<number>([], [1, 2, 3, 4, 5], 2);
    expect(list).toEqual([4, 5]);
    expect(dropped).toBe(3);
  });
});

describe('the buffer on disk', () => {
  it('a missing file reads as empty, and nothing is created by reading', async () => {
    const state = await loadTriageState();
    expect(state).toEqual({ version: 1, runs: 0, pending: { mail: [], slack: [], droppedMail: 0, droppedSlack: 0 } });
    await expect(fs.access(triageStatePath())).rejects.toThrow();
  });

  it('an unreadable file degrades to empty instead of failing a run', async () => {
    await fs.mkdir(triageStatePath().replace(/\/[^/]+$/, ''), { recursive: true });
    await fs.writeFile(triageStatePath(), '{ this is not json', 'utf-8');
    const state = await loadTriageState();
    expect(state.pending.slack).toEqual([]);
  });

  it('a hand-edited row with the wrong types is dropped, the rest survives', async () => {
    await fs.writeFile(triageStatePath(), JSON.stringify({
      version: 1,
      runs: 'not a number',
      pending: {
        mail: [{ accountId: 'a', count: '4', headlines: 'nope' }, { count: 1 }],
        slack: [{ conversation: '#x', ts: '1', text: 'hi' }, 42, null],
        droppedMail: -5,
        droppedSlack: 3,
      },
    }), 'utf-8');
    const state = await loadTriageState();
    expect(state.runs).toBe(0);
    expect(state.pending.mail).toEqual([
      { accountId: 'a', count: 4, headlines: [], atMs: 0 },
    ]);
    expect(state.pending.slack).toHaveLength(1);
    expect(state.pending.droppedMail).toBe(0);
    expect(state.pending.droppedSlack).toBe(3);
  });

  it('keeps 120 Slack rows out of 400 and says 280 were dropped', async () => {
    // 400 items is 20 real ticks of the plugin's own 20-item cap.
    for (let tick = 0; tick < 20; tick++) {
      await recordTriageArrivals({ slack: slackRows(20, tick * 20) });
    }
    const state = await loadTriageState();
    expect(state.pending.slack).toHaveLength(PENDING_SLACK_CAP);
    expect(state.pending.droppedSlack).toBe(400 - PENDING_SLACK_CAP);
    // The NEWEST survived: the last item of the last tick is still there.
    expect(state.pending.slack.at(-1)?.text).toBe('line 399');
  });

  it("counts the plugin's own dropped items as dropped here too", async () => {
    // Items the plugin could not fit on the event exist only in Slack now, so the
    // count would be a lie without them.
    await recordTriageArrivals({ slack: slackRows(3), droppedSlack: 11 });
    const state = await loadTriageState();
    expect(state.pending.slack).toHaveLength(3);
    expect(state.pending.droppedSlack).toBe(11);
  });

  it('caps mail account ticks at 40', async () => {
    await recordTriageArrivals({ mail: mailRows(50) });
    const state = await loadTriageState();
    expect(state.pending.mail).toHaveLength(PENDING_MAIL_CAP);
    expect(state.pending.droppedMail).toBe(50 - PENDING_MAIL_CAP);
  });

  it('concurrent appends all land: the lock serializes read-modify-write', async () => {
    // Without the file lock each writer would persist ITS snapshot and the last
    // one home would erase the other nine.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => recordTriageArrivals({ slack: slackRows(5, i * 5) })),
    );
    const state = await loadTriageState();
    expect(state.pending.slack).toHaveLength(50);
    const texts = new Set(state.pending.slack.map((r) => r.text));
    expect(texts.size).toBe(50);
  });

  it('a collector flush and a claim in the same moment do not erase each other', async () => {
    await recordTriageArrivals({ slack: slackRows(4) });
    const [claimed] = await Promise.all([
      claimTriageBatch(10_000),
      recordTriageArrivals({ slack: slackRows(4, 100) }),
    ]);
    const state = await loadTriageState();
    expect(state.claim).toBeDefined();
    // Every item is still there, whichever order the two writes landed in.
    expect(state.pending.slack).toHaveLength(8);
    expect(claimed.claim.slack).toBeGreaterThanOrEqual(4);
  });
});

describe('the claim / ack handover (at-least-once)', () => {
  it('a claim hands out the batch and deletes NOTHING', async () => {
    await recordTriageArrivals({ mail: mailRows(2), slack: slackRows(6) });
    const claimed = await claimTriageBatch(50_000);

    expect(claimed.mail).toHaveLength(2);
    expect(claimed.slack).toHaveLength(6);
    expect(claimed.redelivered).toBe(false);
    // Still on disk: nothing is dropped until somebody says a session got it.
    const state = await loadTriageState();
    expect(state.pending.slack).toHaveLength(6);
    expect(state.claim).toEqual({ atMs: 50_000, mail: 2, slack: 6, droppedMail: 0, droppedSlack: 0 });
  });

  it('the first claim ever sets `since` to now, so no run reads from epoch 0', async () => {
    const claimed = await claimTriageBatch(1_726_000_000_000);
    expect(claimed.sinceMs).toBe(1_726_000_000_000);
    expect((await loadTriageState()).sinceMs).toBe(1_726_000_000_000);
  });

  it('an acknowledgement drops exactly the claimed rows and advances `since`', async () => {
    await recordTriageArrivals({ slack: slackRows(5) });
    const claimed = await claimTriageBatch(60_000);
    // Two more arrive DURING the run; they belong to the next batch.
    await recordTriageArrivals({ slack: slackRows(2, 500) });

    const { acked } = await ackTriageClaim(claimed.claim.atMs);
    expect(acked).toBe(true);

    const state = await loadTriageState();
    expect(state.pending.slack.map((r) => r.text)).toEqual(['line 500', 'line 501']);
    expect(state.claim).toBeUndefined();
    expect(state.lastRunAtMs).toBe(60_000);
    expect(state.runs).toBe(1);

    // The NEXT run's `since` is the acknowledged run's start.
    const next = await claimTriageBatch(70_000);
    expect(next.sinceMs).toBe(60_000);
    expect(next.slack).toHaveLength(2);
  });

  it('a failed delivery keeps every item and does not move `since`', async () => {
    await recordTriageArrivals({ slack: slackRows(3) });
    const claimed = await claimTriageBatch(60_000);
    expect(await releaseTriageClaim(claimed.claim.atMs)).toBe(true);

    const state = await loadTriageState();
    expect(state.pending.slack).toHaveLength(3);
    expect(state.claim).toBeUndefined();
    expect(state.lastRunAtMs).toBeUndefined();

    // The next run offers exactly the same batch.
    const again = await claimTriageBatch(90_000);
    expect(again.slack.map((r) => r.text)).toEqual(['line 0', 'line 1', 'line 2']);
    expect(again.redelivered).toBe(false);
  });

  it('a crash between the delivery and the clear re-delivers the same batch', async () => {
    await recordTriageArrivals({ mail: mailRows(1), slack: slackRows(4) });
    const first = await claimTriageBatch(100_000);
    expect(first.slack).toHaveLength(4);

    // The process dies here: the session was started, nothing acknowledged it.
    // A fresh process reads the SAME file — the claim is still open.
    const reopened = await loadTriageState();
    expect(reopened.claim?.atMs).toBe(100_000);

    const second = await claimTriageBatch(100_000 + 1_000);
    expect(second.redelivered).toBe(true);
    expect(second.claim.atMs).toBe(100_000);
    expect(second.slack.map((r) => r.text)).toEqual(first.slack.map((r) => r.text));
    expect(second.mail).toHaveLength(1);

    // And the acknowledgement still refers to the ORIGINAL claim.
    expect((await ackTriageClaim(100_000)).acked).toBe(true);
    expect((await loadTriageState()).pending.slack).toEqual([]);
  });

  it('a claim nobody ever acknowledged is released after its TTL, keeping the items', async () => {
    await recordTriageArrivals({ slack: slackRows(3) });
    const stale = await claimTriageBatch(1_000);
    await recordTriageArrivals({ slack: slackRows(2, 900) });

    const fresh = await claimTriageBatch(1_000 + CLAIM_TTL_MS + 1);
    expect(fresh.redelivered).toBe(false);
    expect(fresh.claim.atMs).not.toBe(stale.claim.atMs);
    // Nothing was lost by the release: the fresh claim covers all five.
    expect(fresh.slack).toHaveLength(5);
  });

  it('acknowledging a claim that is not the open one changes nothing', async () => {
    await recordTriageArrivals({ slack: slackRows(3) });
    const claimed = await claimTriageBatch(200_000);
    // A replayed or duplicated acknowledgement must never eat the NEXT batch.
    expect((await ackTriageClaim(claimed.claim.atMs + 5)).acked).toBe(false);
    expect((await loadTriageState()).pending.slack).toHaveLength(3);
    expect((await ackTriageClaim(claimed.claim.atMs)).acked).toBe(true);
    expect((await ackTriageClaim(claimed.claim.atMs)).acked).toBe(false);
    expect((await loadTriageState()).runs).toBe(1);
  });

  it('a cap that bites mid-run shrinks the claim, so the ack cannot eat new rows', async () => {
    await recordTriageArrivals({ slack: slackRows(PENDING_SLACK_CAP) });
    const claimed = await claimTriageBatch(300_000);
    expect(claimed.claim.slack).toBe(PENDING_SLACK_CAP);

    // 10 more arrive: the 10 oldest (all claimed, all already delivered) go.
    await recordTriageArrivals({ slack: slackRows(10, 5_000) });
    await ackTriageClaim(300_000);

    const state = await loadTriageState();
    // Exactly the 10 that arrived after the claim are left.
    expect(state.pending.slack.map((r) => r.text))
      .toEqual(Array.from({ length: 10 }, (_, i) => `line ${5_000 + i}`));
  });
});

describe('what the next envelope inherits', () => {
  it('carries the previous run\'s journal line', async () => {
    await recordTriageJournalLine('- 2026-09-21 14:10 run · Triage · task ab12cd34 · ended ok');
    const claimed = await claimTriageBatch(400_000);
    expect(claimed.lastJournalLine).toContain('ended ok');
  });

  it('carries the State.md warning once, then the acknowledgement clears it', async () => {
    await markTriageStateStale();
    const claimed = await claimTriageBatch(500_000);
    expect(claimed.stateStale).toBe(true);
    await ackTriageClaim(claimed.claim.atMs);
    const next = await claimTriageBatch(600_000);
    expect(next.stateStale).toBe(false);
  });

  it('an arbitrary mutation round-trips through the locked writer', async () => {
    await updateTriageState((s) => { s.runs = 7; });
    expect((await loadTriageState()).runs).toBe(7);
  });
});
