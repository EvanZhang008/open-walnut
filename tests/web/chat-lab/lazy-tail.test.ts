/**
 * Chat-lab: lazy history tail load (?tail=N) — end-to-end through the REAL
 * production modules (history-merge, history-anchor, render-filter,
 * optimistic-dedup, history-delta server core).
 *
 * The 2026-08-11 incident: whale sessions (3000+ msgs) shipped in full on
 * every panel open, pinning a browser connection for 35-150s. Clients now
 * mount with only the last N; the cursor space still counts the hidden
 * prefix (baseOffset). These scenarios prove the lazy client behaves
 * IDENTICALLY to a full client for everything that matters:
 *   · streaming a new turn, delta folding, bubble absorption
 *   · refresh equivalence + never-vanish oracles
 *   · "Load N earlier" backfill mid-conversation (watermark integrity)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ScriptedServer, userRow, assistantRow, resetRowSeq } from './scripted-server';
import { HeadlessChatClient } from './headless-client';
import { expectNothingVanishedSince, expectRefreshEquivalentLazy } from './oracles';
import { planDeltaMerge } from '../../../web/src/hooks/history-merge';

const TAIL = 10;

let server: ScriptedServer;
let client: HeadlessChatClient;

/** Whale prefix: `count` completed turns already in the archive. */
function seedWhale(count: number): void {
  for (let i = 0; i < count; i++) {
    server.append(userRow(`old question ${i}`));
    server.append(assistantRow(`old answer ${i} with distinctive words`));
  }
}

/** One live turn end-to-end: send → stream → archive → result. */
function liveTurn(n: number): void {
  const q = `fresh question ${n}`;
  const a = `fresh answer ${n} with plenty of distinctive words`;
  client.send(q);
  server.append(userRow(q));
  const msgId = `m_live_${n}`;
  client.textDelta(a.slice(0, 12), { msgId });
  client.textDelta(a.slice(12), { msgId });
  server.append(assistantRow(a, { msgId }));
  client.result();
}

beforeEach(() => {
  resetRowSeq();
  server = new ScriptedServer();
  client = new HeadlessChatClient(server, { tailLimit: TAIL });
});

describe('chat-lab: lazy tail mount', () => {
  it('mounts with only the tail; cursor/baseOffset span the full archive', () => {
    seedWhale(50); // 100 rows
    client.reload();

    expect(client.messages).toHaveLength(TAIL);
    expect(client.cursor).toBe(100);
    expect(client.baseOffset).toBe(90);
    // The newest row is present — the tail is the RIGHT end.
    expect(client.messages[client.messages.length - 1].text).toContain('old answer 49');
  });

  it('a live turn on a tail-mounted client folds via delta and absorbs the bubble', () => {
    seedWhale(50);
    client.reload();
    liveTurn(1);

    // Delta appended 2 rows onto the 10-row tail; cursor tracks the full space.
    expect(client.cursor).toBe(102);
    expect(client.messages).toHaveLength(TAIL + 2);
    const projected = client.project();
    // Bubble absorbed (its persisted twin arrived within the watermark window).
    expect(projected.filter(i => i.kind === 'bubble')).toEqual([]);
    // Streamed text absorbed into its history twin (no duplicate block).
    expect(projected.filter(i => i.kind === 'block')).toEqual([]);
    expectNothingVanishedSince(client, server, 100);
  });

  it('multiple consecutive live turns keep folding without rebuilds', () => {
    seedWhale(50);
    client.reload();
    for (let n = 1; n <= 5; n++) liveTurn(n);

    expect(client.cursor).toBe(110);
    expect(client.messages).toHaveLength(TAIL + 10);
    // No serve() call after mount should have been a full rebuild.
    const fullServes = server.requests.slice(1).filter(r => r.since === undefined);
    expect(fullServes).toEqual([]);
    expectRefreshEquivalentLazy(client, server, TAIL);
  });

  it('refresh equivalence: a fresh lazy mount shows the same non-history view', () => {
    seedWhale(50);
    client.reload();
    liveTurn(1);
    expectRefreshEquivalentLazy(client, server, TAIL);
  });
});

describe('chat-lab: Load-earlier backfill', () => {
  it('backfill restores the full archive and keeps the cursor space intact', () => {
    seedWhale(50);
    client.reload();
    liveTurn(1);
    client.loadFullHistory();

    expect(client.messages).toHaveLength(102);
    expect(client.baseOffset).toBe(0);
    expect(client.cursor).toBe(102);
    expectNothingVanishedSince(client, server, 0); // now EVERYTHING must be visible
  });

  it('a live turn AFTER backfill still folds as a delta', () => {
    seedWhale(50);
    client.reload();
    client.loadFullHistory();
    liveTurn(1);

    expect(client.cursor).toBe(102);
    expect(client.messages).toHaveLength(102);
    expect(client.project().filter(i => i.kind === 'bubble')).toEqual([]);
  });

  it('backfill mid-STREAM does not let old twins steal the live bubble (watermark shift)', () => {
    // The front-insertion hazard: user sends "hello" (also present in the OLD
    // archive), then backfills while the turn is still streaming. The watermark
    // must shift by the inserted growth, or the ancient "hello" twin falls
    // inside the content window and absorbs the pending bubble.
    seedWhale(20);
    server.append(userRow('hello'));                       // ancient duplicate text
    server.append(assistantRow('ancient reply to hello'));
    seedWhale(5); // a few more turns after it
    client.reload();

    client.send('hello');                                  // optimistic bubble
    client.textDelta('working on it', { msgId: 'm_wip' }); // turn is LIVE (watermark set)
    client.loadFullHistory();                              // front-insert 42 old rows

    // The bubble must still be visible — its persisted twin has NOT arrived yet.
    const bubbles = client.project().filter(i => i.kind === 'bubble');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].label).toContain('hello');

    // Finish the turn normally: echo lands, bubble absorbs.
    server.append(userRow('hello'));
    server.append(assistantRow('fresh reply to hello', { msgId: 'm_wip' }));
    client.result();
    expect(client.project().filter(i => i.kind === 'bubble')).toEqual([]);
  });
});

describe('chat-lab: lazy client edge cases', () => {
  it('archive smaller than the tail behaves exactly like a full client', () => {
    seedWhale(3); // 6 rows < TAIL
    client.reload();
    expect(client.baseOffset).toBe(0);
    liveTurn(1);
    expect(client.cursor).toBe(8);
    expectRefreshEquivalentLazy(client, server, TAIL);
  });

  it('declined delta (anchor evicted) rebuilds TAIL-BOUNDED and recovers', () => {
    seedWhale(50);
    client.reload();
    // Sabotage the anchor: rewrite history so the client's newest msgId is gone
    // (the /compact-rewrite shape). The next delta must decline → full payload.
    for (const m of server.canonical) { m.msgId = `rewritten_${m.msgId}`; }
    server.append(userRow('after rewrite'));
    server.append(assistantRow('answer after rewrite'));
    client.batchCompleted();

    // The client re-adopted a bounded payload, not the whole 102-row archive.
    expect(client.messages.length).toBeLessThanOrEqual(TAIL);
    expect(client.cursor).toBe(server.canonical.length);
    expect(client.baseOffset).toBe(server.canonical.length - client.messages.length);
    // And the newest content is present.
    expect(client.messages[client.messages.length - 1].text).toContain('answer after rewrite');
  });

  it('planDeltaMerge never yields a cursor the next delta cannot use (offset chain)', () => {
    // Property-ish loop: repeated folds with a base offset must keep
    // cursor === baseOffset + messages.length at every step.
    seedWhale(50);
    client.reload();
    for (let n = 1; n <= 8; n++) {
      liveTurn(n);
      expect(client.cursor).toBe(client.baseOffset + client.messages.length);
    }
  });

  it('regression: the offset math itself (unit-level cross-check)', () => {
    // A 400-tail client at cursor 3219 receives a 3-row delta at cursor 3222.
    const base = Array.from({ length: 400 }, (_, i) => ({
      role: 'assistant' as const, text: `t${i}`, timestamp: '', msgId: `w${2819 + i}`,
    }));
    const delta = Array.from({ length: 3 }, (_, i) => ({
      role: 'assistant' as const, text: `new${i}`, timestamp: '', msgId: `w${3219 + i}`,
    }));
    const plan = planDeltaMerge(base, { messages: delta, cursor: 3222 }, 3219, { baseOffset: 2819 });
    expect(plan.kind).toBe('merged');
    if (plan.kind === 'merged') {
      expect(plan.cursor).toBe(3222);
      expect(plan.messages).toHaveLength(403);
    }
  });
});
