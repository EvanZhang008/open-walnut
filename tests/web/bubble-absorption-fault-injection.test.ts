/**
 * FAULT INJECTION — optimistic-bubble absorption must survive the loss of EVERY
 * server-side removal signal (inc-1785888617044 and its 8 predecessors).
 *
 * The bubble-absorption model has exactly one hard invariant, set by the product
 * owner: a delivered message may briefly render TWICE, but it must never vanish
 * and must never stay pinned below newer content. Every incident in this family
 * was the second failure — a bubble with no surviving evidence.
 *
 * The corpus measurements that motivate these cases (450 deliveries / 247 orphaned
 * qm-ids over the logged window):
 *   · 150 (60.7%) partial ids — `setActiveProcessing` OVERWRITES batchMessageIds,
 *     so a turn that re-enters after the 60s safety timeout under-reports.
 *   ·  85 (34.4%) no batch-completed at all (sid mismatch / `no activeProcessing
 *     match` / process death).
 *   ·  12  (4.9%) explicit ids=0.
 *   · the safety timeout co-signals 89.9% of them, and turn DURATION predicts the
 *     orphan rate monotonically (24% under 30s → 84% at ≥900s) while history size
 *     does NOT — long turns, not big chats, are the driver. Big chats merely make
 *     the damage visible as a wall of stale bubbles (56 observed at once).
 *
 * Conclusion pinned by these tests: the server signal is treated as a NICE-TO-HAVE
 * status hint, never as removal proof. Absorption is decided purely from persisted
 * history, so losing any or all of those signals changes nothing about correctness.
 * Each case below deletes a different signal and asserts the bubbles still clear.
 */
import { describe, it, expect } from 'vitest';
import { dedupeOptimisticMessages, dedupScanStart } from '@/components/sessions/optimistic-dedup';

/** A persisted history user line as the parser+echo-claims produce it. */
const hUser = (text: string, walnutMessageId?: string) =>
  walnutMessageId ? { role: 'user', text, walnutMessageId } : { role: 'user', text };
const hAsst = (text: string) => ({ role: 'assistant', text });
/** An optimistic bubble after its send RPC resolved (queueId rewritten to qm-…). */
const bubble = (text: string, queueId: string, status = 'delivered') => ({ text, status, queueId });

/**
 * The incident's five real sends, verbatim from session 9800cccf's canonical JSONL.
 * The first two were absorbed normally; the last three are the stuck bubbles in the
 * user's screenshot. The CLI drained #3-#5 into ONE prompt joined with a single '\n'.
 */
const S1 = 'lets talk about the pipeline first';
const S2 = 'ok now the delivery side';
const S3 = 'also for the filer Cache-level: mandatory TransformFunc projection\n\nin the EO we do filter base don allwolist right';
const S4 = 'we have another filter on delivery';
const S5 = 'discus with me first';
/** What the CLI actually logged for the merged batch — one line, '\n'-joined. */
const MERGED = [S3, S4, S5].join('\n');

describe('bubble absorption — no server signal is required for correctness', () => {
  it('THE INCIDENT: 3 orphaned ids + one merged history line ⇒ zero stuck bubbles', () => {
    // Server delivered 5, browser only ever saw batch-completed for the first two,
    // then ids=0. echo-claims bound qmIds[0] of the merged batch only (…xz9sm3).
    const bubbles = [
      bubble(S3, 'qm-xz9sm3'),
      bubble(S4, 'qm-mlrmcv'),
      bubble(S5, 'qm-jdqh2h'),
    ];
    const history = [
      hUser(S1, 'qm-08wfi5'), hAsst('…'),
      hUser(S2, 'qm-4tudbu'), hAsst('…'),
      hUser(MERGED, 'qm-xz9sm3'), hAsst('…'),
    ];
    // Pre-fix: all three survived and rendered below 20 minutes of newer content.
    expect(dedupeOptimisticMessages(bubbles, history, 0)).toEqual([]);
  });

  it('signal loss #1 — batch-completed never arrives (sid mismatch, 34.4% of orphans)', () => {
    // No removal event at all: history is the only evidence, and it suffices.
    const bubbles = [bubble(S4, 'qm-1'), bubble(S5, 'qm-2')];
    const history = [hUser(`${S4}\n${S5}`)]; // claim never bound either → no wmid
    expect(dedupeOptimisticMessages(bubbles, history, 0)).toEqual([]);
  });

  it('signal loss #2 — ids=0 (safety timeout retained the flagless entry)', () => {
    // Same as above from the client's perspective: an event with no ids is not proof
    // of anything, so absorption must not depend on it.
    const bubbles = [bubble(S3, 'qm-1'), bubble(S4, 'qm-2'), bubble(S5, 'qm-3')];
    expect(dedupeOptimisticMessages(bubbles, [hUser(MERGED)], 0)).toEqual([]);
  });

  it('signal loss #3 — partial ids after re-entry (60.7% of orphans): later batch still clears', () => {
    // Turn A's ids were overwritten by turn B's when processNext re-entered post
    // timeout. Both turns' bubbles are on screen; history holds both echoes.
    const bubbles = [bubble(S1, 'qm-a1'), bubble(S2, 'qm-a2'), bubble(S4, 'qm-b1'), bubble(S5, 'qm-b2')];
    const history = [hUser(S1), hUser(S2), hUser(`${S4}\n${S5}`, 'qm-b1')];
    expect(dedupeOptimisticMessages(bubbles, history, 0)).toEqual([]);
  });

  it('signal loss #4 — server restart wipes the in-memory echo-claim registry', () => {
    // No walnutMessageId anywhere (registry is not persisted). The text-only merged
    // run is the last line of defense and must carry the whole batch alone.
    const bubbles = [bubble(S3, 'qm-1'), bubble(S4, 'qm-2'), bubble(S5, 'qm-3')];
    const history = [hUser(MERGED)]; // no ids at all
    expect(dedupeOptimisticMessages(bubbles, history, 0)).toEqual([]);
  });

  it('signal loss #5 — only qmIds[0] bound (the real echo-claim limit) clears 2..N', () => {
    // bindEchoClaims stamps a single id per line by design; the id-anchored run
    // reconstructs the bound line from the following bubbles to prove the rest.
    const bubbles = [bubble(S3, 'qm-head'), bubble(S4, 'qm-tail1'), bubble(S5, 'qm-tail2')];
    const history = [hUser(MERGED, 'qm-head')];
    expect(dedupeOptimisticMessages(bubbles, history, 0)).toEqual([]);
  });

  it('compounded worst case: restart + merged batch + /compact rewrite (window collapse)', () => {
    // Every signal gone AND the scan window invalidated: /compact rewrote history
    // from 4792 messages to 6, so the stale prevMsgLen points past the end.
    const bubbles = [bubble(S4, 'qm-1'), bubble(S5, 'qm-2')];
    const history = [
      hUser('This session is being continued from a previous conversation…'),
      hAsst('…'), hUser(`${S4}\n${S5}`),
    ];
    expect(dedupScanStart(4792, history.length)).toBe(0); // shrink ⇒ scan all
    expect(dedupeOptimisticMessages(bubbles, history, 4792)).toEqual([]);
  });

  it("mid-turn injection: walnut's own '\\n\\n' delivery join is also accepted", () => {
    // injectMidTurn writes the FIFO with '\n\n'. If the CLI logs THAT verbatim
    // (no queue drain), the same run logic must still match.
    const bubbles = [bubble(S4, 'qm-1'), bubble(S5, 'qm-2')];
    expect(dedupeOptimisticMessages(bubbles, [hUser(`${S4}\n\n${S5}`)], 0)).toEqual([]);
  });
});

/**
 * The other direction of the invariant. Absorption may only ever hide a bubble that
 * history DEMONSTRABLY contains — a permissive matcher that eats an undelivered
 * message would convert this bug family from "annoying duplicate" into "lost work",
 * which is strictly worse and unacceptable.
 */
describe('bubble absorption — never hides a message history does not contain', () => {
  it('a send that never reached the CLI survives (no echo, no join)', () => {
    const bubbles = [bubble(S4, 'qm-1'), bubble('never made it', 'qm-2')];
    const kept = dedupeOptimisticMessages(bubbles, [hUser(S4)], 0);
    expect(kept.map(m => m.text)).toEqual(['never made it']);
  });

  it('a failed bubble is never absorbed, even when the join matches exactly', () => {
    const bubbles = [
      { text: S4, status: 'failed', queueId: 'qm-1' },
      bubble(S5, 'qm-2'),
    ];
    const kept = dedupeOptimisticMessages(bubbles, [hUser(`${S4}\n${S5}`)], 0);
    // BOTH survive, by design: the failed bubble is never hidden (the user must be
    // able to retry it), and because it breaks the run, S5 has no evidence of its
    // own and keeps rendering too. That is the acceptable failure direction — a
    // visible duplicate — and it is far better than the alternative reading, where
    // a join spanning a NEVER-DELIVERED message would hide a live one.
    expect(kept.map(m => m.status)).toEqual(['failed', 'delivered']);
  });

  it('a failed bubble is not absorbed by an id-anchored run either', () => {
    const bubbles = [
      bubble(S3, 'qm-head'),
      { text: S4, status: 'failed', queueId: 'qm-x' },
      bubble(S5, 'qm-tail'),
    ];
    const kept = dedupeOptimisticMessages(bubbles, [hUser(MERGED, 'qm-head')], 0);
    // The run stops at the failed bubble; S5 has no independent evidence, so BOTH
    // stay. Duplicate-visible is the acceptable failure direction.
    expect(kept.map(m => m.queueId)).toEqual(['qm-x', 'qm-tail']);
  });

  it('a partial prefix of the merged line proves nothing', () => {
    // History merged S4+S5 only; a later S3 send is still in flight.
    const bubbles = [bubble(S4, 'qm-1'), bubble(S5, 'qm-2'), bubble(S3, 'qm-3')];
    const kept = dedupeOptimisticMessages(bubbles, [hUser(`${S4}\n${S5}`)], 0);
    expect(kept.map(m => m.queueId)).toEqual(['qm-3']);
  });

  it('one merged history line is consumed once — a repeat batch stays visible', () => {
    const bubbles = [
      bubble(S4, 'qm-1'), bubble(S5, 'qm-2'),
      bubble(S4, 'qm-3'), bubble(S5, 'qm-4'),
    ];
    const kept = dedupeOptimisticMessages(bubbles, [hUser(`${S4}\n${S5}`)], 0);
    expect(kept.map(m => m.queueId)).toEqual(['qm-3', 'qm-4']);
  });

  it('non-adjacent bubbles never form a run (a proven bubble breaks it)', () => {
    // qm-mid is proven by its own echo, so S4+S5 must not be joined ACROSS it —
    // they were never one prompt.
    const bubbles = [bubble(S4, 'qm-1'), bubble('solo', 'qm-mid'), bubble(S5, 'qm-2')];
    const kept = dedupeOptimisticMessages(bubbles, [hUser('solo'), hUser(`${S4}\n${S5}`)], 0);
    expect(kept.map(m => m.queueId)).toEqual(['qm-1', 'qm-2']);
  });

  it('a run is capped (a 9-message pathological join is not searched)', () => {
    const texts = Array.from({ length: 9 }, (_, i) => `m${i}`);
    const bubbles = texts.map((t, i) => bubble(t, `qm-${i}`));
    const kept = dedupeOptimisticMessages(bubbles, [hUser(texts.join('\n'))], 0);
    expect(kept).toHaveLength(9); // cap 8 ⇒ no match ⇒ all kept (duplicate, not loss)
  });

  it('an assistant line that happens to equal the join absorbs nothing', () => {
    const bubbles = [bubble(S4, 'qm-1'), bubble(S5, 'qm-2')];
    const kept = dedupeOptimisticMessages(bubbles, [hAsst(`${S4}\n${S5}`)], 0);
    expect(kept).toHaveLength(2);
  });

  /**
   * REGRESSION (found by adversarial probe, not by the incident): an id-anchored run
   * must RETIRE its persisted line from the windowed multiset. The id already proves
   * that batch, so decrementing looks pointless — but without it the text-only run
   * matches the SAME line again for a second identical batch whose messages are NOT
   * in history yet. Measured pre-fix: 1 merged line + 2 identical 3-message batches
   * hid all SIX bubbles instead of three. That is the forbidden direction (hiding a
   * live send), so it is pinned here separately from the incident cases.
   */
  it('one merged line accounts for ONE batch even when the first is id-bound', () => {
    const merged = `${S3}\n${S4}\n${S5}`;
    const bubbles = [
      bubble(S3, 'qm-1a'), bubble(S4, 'qm-1b'), bubble(S5, 'qm-1c'), // id-bound head
      bubble(S3, 'qm-2a'), bubble(S4, 'qm-2b'), bubble(S5, 'qm-2c'), // not in history
    ];
    const kept = dedupeOptimisticMessages(bubbles, [hUser(merged, 'qm-1a')], 0);
    expect(kept.map(m => m.queueId)).toEqual(['qm-2a', 'qm-2b', 'qm-2c']);
  });

  it('two id-bound batches with two persisted lines both absorb (no under-consumption)', () => {
    // The retirement must not overshoot either: two distinct merged lines account
    // for two batches.
    const merged = `${S4}\n${S5}`;
    const bubbles = [
      bubble(S4, 'qm-1a'), bubble(S5, 'qm-1b'),
      bubble(S4, 'qm-2a'), bubble(S5, 'qm-2b'),
    ];
    const history = [hUser(merged, 'qm-1a'), hUser(merged, 'qm-2a')];
    expect(dedupeOptimisticMessages(bubbles, history, 0)).toEqual([]);
  });

  it('an id-bound line OUTSIDE the scan window still absorbs its own run', () => {
    // The line is at index 0 but the window starts at 2, so it has no multiset entry.
    // Retirement must be a no-op there, not a reason to skip the run.
    const merged = `${S4}\n${S5}`;
    const bubbles = [bubble(S4, 'qm-a'), bubble(S5, 'qm-b')];
    const history = [hUser(merged, 'qm-a'), hAsst('reply'), hAsst('more')];
    expect(dedupeOptimisticMessages(bubbles, history, 2)).toEqual([]);
  });
});
