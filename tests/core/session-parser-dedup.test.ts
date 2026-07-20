/**
 * Unit tests for parseSessionMessages() — the JSONL → messages parser, focused on
 * mid-turn FIFO message dedup (Pattern A vs Pattern B) and its timing/edge cases.
 *
 * These test the parser DIRECTLY (pure function, no daemon, no fs) so they are fast
 * and isolated from the daemon-uniform read path.
 *
 * ── Background: how mid-turn (FIFO-injected) user messages appear in JSONL ──
 * When the user sends a message WHILE a turn is running, walnut writes it to the CLI's
 * FIFO stdin. Claude Code logs a `queue-operation` `enqueue` entry, and — when it actually
 * processes the message — ALSO a normal `type:"user"` line with the SAME content. So the
 * message is present TWICE in the raw JSONL. The parser must emit it exactly ONCE:
 *   · Pattern A: enqueue + a nearby real `user` STRING twin  → skip the enqueue (twin renders)
 *   · Pattern B: enqueue with NO nearby twin (consumed mid-stream / cancelled) → emit synthetic
 *
 * The OLD parser paired enqueue↔dequeue by a GLOBAL FIFO count. `--resume`/compact boundaries
 * leave orphan dequeues/removes so the counts don't balance → a stray dequeue claims the wrong
 * enqueue → a later enqueue is falsely "unmatched" and re-emitted as Pattern B even though its
 * real twin is 2 lines down → the message renders TWICE. These tests lock in the content-match
 * (windowed) fix that replaced it.
 */
import { describe, it, expect } from 'vitest';
import { parseSessionMessages } from '../../src/core/session-history.js';

// ── JSONL line builders (mirror real Claude Code shapes) ──

let ts = 0;
/** Monotonic ISO timestamp so ordering is deterministic across builders. */
function nextTs(): string {
  ts += 1000;
  return new Date(Date.UTC(2025, 0, 1, 0, 0, 0, 0) + ts).toISOString();
}

function userStr(content: string, uuid?: string) {
  return JSON.stringify({
    type: 'user',
    timestamp: nextTs(),
    uuid: uuid ?? `u-${ts}`,
    message: { role: 'user', content }, // string content = a real user line
  });
}

/** A real user line whose content is an ARRAY of blocks (image refs, long text).
 *  The CLI logs mid-turn twins this way ~0.3% of the time — the parser must still
 *  match the first text block against a pending enqueue. */
function userArr(text: string, uuid?: string) {
  return JSON.stringify({
    type: 'user',
    timestamp: nextTs(),
    uuid: uuid ?? `u-${ts}`,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}

function assistantText(text: string, id?: string) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: nextTs(),
    message: { id: id ?? `a-${ts}`, role: 'assistant', content: [{ type: 'text', text }] },
  });
}

function enqueue(content: string) {
  return JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content, timestamp: nextTs() });
}
function dequeue() {
  return JSON.stringify({ type: 'queue-operation', operation: 'dequeue', timestamp: nextTs() });
}
function remove() {
  return JSON.stringify({ type: 'queue-operation', operation: 'remove', timestamp: nextTs() });
}
/** walnut sentinel lines the parser must ignore entirely. */
function sentinel(type: string) {
  return JSON.stringify({ type });
}

function build(...lines: string[]): string {
  return lines.join('\n');
}

/** Extract just the user-message texts in order (what the timeline shows). */
function userTexts(content: string): string[] {
  return parseSessionMessages(content)
    .filter(m => m.role === 'user')
    .map(m => m.text);
}

describe('parseSessionMessages — Pattern A/B mid-turn dedup', () => {
  it('Pattern A: enqueue immediately followed by its real user twin → emitted ONCE', () => {
    const jsonl = build(
      userStr('Original prompt'),
      assistantText('working...'),
      enqueue('mid-turn message'),
      dequeue(),
      userStr('mid-turn message'), // the real twin
      assistantText('done'),
    );
    const texts = userTexts(jsonl);
    expect(texts.filter(t => t === 'mid-turn message')).toHaveLength(1);
    expect(texts).toEqual(['Original prompt', 'mid-turn message']);
  });

  it('Pattern B: enqueue with NO real user twin (consumed mid-stream) → emitted as synthetic', () => {
    const jsonl = build(
      userStr('Original prompt'),
      assistantText('working...'),
      enqueue('never re-logged'),
      remove(), // consumed/cancelled — no user STRING twin follows
      assistantText('done'),
    );
    const texts = userTexts(jsonl);
    expect(texts).toContain('never re-logged'); // must NOT be dropped
    expect(texts.filter(t => t === 'never re-logged')).toHaveLength(1);
  });

  it('REGRESSION (compact dup bug): unbalanced dequeue/remove must NOT duplicate a Pattern A msg', () => {
    // Reproduces the real bug: orphan dequeues (from --resume) precede the enqueue whose
    // real twin follows. Old global-FIFO paired the orphan dequeue with this enqueue's slot
    // incorrectly, leaving it "unmatched" → emitted Pattern B + the real twin → duplicate.
    const jsonl = build(
      dequeue(), // ORPHAN dequeue (enqueue was in a prior --resume'd process)
      userStr('First prompt'),
      assistantText('a1'),
      remove(), // ORPHAN remove
      enqueue("Let's design"),
      dequeue(),
      userStr("Let's design"), // real twin — must dedup against the enqueue above
      assistantText('a2'),
    );
    const texts = userTexts(jsonl);
    expect(texts.filter(t => t === "Let's design")).toHaveLength(1);
  });

  it('REGRESSION (msg loss bug): a genuine Pattern B enqueue is never eaten by a stray remove', () => {
    // Old FIFO: the `remove` popped the oldest enqueue (this one) WITHOUT emitting it →
    // the message silently vanished. Content-match keeps it because no user twin exists.
    const jsonl = build(
      userStr('start'),
      enqueue('/compact and continue'), // Pattern B — no matching user STRING anywhere
      dequeue(),
      // (compaction summary follows, different content — NOT a twin)
      userStr('This session is being continued from a previous conversation...'),
      assistantText('ok'),
    );
    const texts = userTexts(jsonl);
    expect(texts).toContain('/compact and continue');
  });

  it('multiset: two identical mid-turn sends map 1:1 to two enqueues (both deduped, none doubled)', () => {
    const jsonl = build(
      userStr('start'),
      enqueue('again'),
      dequeue(),
      userStr('again'),
      assistantText('a1'),
      enqueue('again'),
      dequeue(),
      userStr('again'),
      assistantText('a2'),
    );
    const texts = userTexts(jsonl);
    // exactly two 'again' (the two real twins), NOT four (would be if enqueues weren't deduped)
    expect(texts.filter(t => t === 'again')).toHaveLength(2);
  });

  it('far same-text collision: enqueue does NOT claim an identical user hundreds of lines later', () => {
    // "continue" recurs across turns. A Pattern B enqueue near the top must NOT be silently
    // skipped by claiming a far-away (>window) identical "continue" — that would drop it AND
    // steal the far user's own dedup. Window bound (50) prevents this.
    const lines: string[] = [userStr('start'), enqueue('continue') /* Pattern B: consumed */, remove()];
    // 60 assistant lines of distance (beyond the 50-line lookahead window)
    for (let i = 0; i < 60; i++) lines.push(assistantText(`step ${i}`));
    // a LATER, unrelated real "continue" (its own turn-start; has NO enqueue)
    lines.push(userStr('continue'));
    lines.push(assistantText('final'));
    const texts = userTexts(build(...lines));
    // Both "continue" must survive: the Pattern B synthetic + the far real one.
    expect(texts.filter(t => t === 'continue')).toHaveLength(2);
  });

  it('ignores walnut sentinel lines (last-prompt / mode / permission-mode) around queue ops', () => {
    const jsonl = build(
      userStr('start'),
      sentinel('last-prompt'),
      sentinel('mode'),
      sentinel('permission-mode'),
      enqueue('hi'),
      sentinel('last-prompt'),
      dequeue(),
      userStr('hi'),
      assistantText('done'),
    );
    const texts = userTexts(jsonl);
    expect(texts).toEqual(['start', 'hi']); // sentinels contribute nothing; 'hi' once
  });

  it('interleaves multiple mid-turn messages at their chronological positions', () => {
    // Mirrors the documented Pattern A test: prompt, a1, "hi", a2, "stop", a3.
    const jsonl = build(
      userStr('Read 3 files'),
      assistantText('File 1 read.', 'a1'),
      enqueue('hi'),
      dequeue(),
      userStr('hi'),
      assistantText('File 2 read.', 'a2'),
      enqueue('stop'),
      dequeue(),
      userStr('stop'),
      assistantText('Stopping.', 'a3'),
    );
    const msgs = parseSessionMessages(jsonl);
    const seq = msgs.map(m => `${m.role}:${m.text || (m.tools?.length ? '[tools]' : '')}`);
    expect(seq).toEqual([
      'user:Read 3 files',
      'assistant:File 1 read.',
      'user:hi',
      'assistant:File 2 read.',
      'user:stop',
      'assistant:Stopping.',
    ]);
  });

  it('Pattern B enqueues with distinct content are all emitted (nothing dropped)', () => {
    const jsonl = build(
      userStr('start'),
      enqueue('msg-a'),
      remove(),
      enqueue('msg-b'),
      remove(),
      assistantText('done'),
    );
    const texts = userTexts(jsonl);
    expect(texts).toContain('msg-a');
    expect(texts).toContain('msg-b');
  });

  it('Pattern A with ARRAY-content twin (image ref / long text) is deduped, not doubled', () => {
    // Real corpus: ~0.3% of enqueue twins log content as an ARRAY of blocks (e.g. a
    // message carrying an image ref). If the parser only matched string twins, these
    // would render twice. The first text block must match the enqueue content.
    const jsonl = build(
      userStr('start'),
      assistantText('working', 'a1'),
      enqueue('[Image #2] look at the icons'),
      dequeue(),
      userArr('[Image #2] look at the icons'), // real twin, ARRAY content
      assistantText('done', 'a2'),
    );
    const texts = userTexts(jsonl);
    expect(texts.filter(t => t === '[Image #2] look at the icons')).toHaveLength(1);
    expect(texts).toEqual(['start', '[Image #2] look at the icons']);
  });

  it('empty JSONL / no queue ops → plain user+assistant passthrough', () => {
    const jsonl = build(userStr('hello'), assistantText('hi there'));
    expect(userTexts(jsonl)).toEqual(['hello']);
    expect(parseSessionMessages('')).toEqual([]);
  });

  // ── Batched twin (inc-1784349380504): queue drained into ONE '\n'-joined prompt ──
  // When ≥2 sends are queued at turn start, the CLI logs a SINGLE user line whose
  // content is the '\n'-join of the queued messages. Neither message alone matches,
  // so without the merged pass each enqueue re-emits as Pattern B AND the joined
  // line renders → everything in the batch shows twice.
  describe('batched twin (queue drained into one prompt)', () => {
    it('two queued sends drained into one joined user line → each shows ONCE (as the merged line)', () => {
      const msgA = '我想的有两个方法第一个是能在Plugin里面paste一个configuration';
      const msgB = '而且我们可以借鉴Cloud Code的Plugin他们是怎么做的呢';
      const jsonl = build(
        userStr('start'),
        assistantText('long answer streaming...', 'a1'),
        enqueue(msgA),
        enqueue(msgB),
        dequeue(),
        dequeue(),
        userStr(`${msgA}\n${msgB}`), // CLI logs the drained batch as ONE joined line
        assistantText('answering both', 'a2'),
      );
      const texts = userTexts(jsonl);
      // The joined line renders once; the individual enqueues must NOT re-emit.
      expect(texts).toEqual(['start', `${msgA}\n${msgB}`]);
    });

    it('three queued sends drained into one joined line (corpus max run) → no duplicates', () => {
      const parts = ['first queued', 'second queued', 'third queued'];
      const jsonl = build(
        userStr('start'),
        assistantText('busy', 'a1'),
        enqueue(parts[0]),
        enqueue(parts[1]),
        enqueue(parts[2]),
        userStr(parts.join('\n')),
        assistantText('done', 'a2'),
      );
      expect(userTexts(jsonl)).toEqual(['start', parts.join('\n')]);
    });

    it('exact twins still win over the merged pass (mixed batch + solo send)', () => {
      // solo send re-logged exactly + a later 2-batch: the exact pass must claim the
      // solo twin first; the merged pass only consumes the true batch enqueues.
      const jsonl = build(
        userStr('start'),
        assistantText('turn 1', 'a1'),
        enqueue('solo message'),
        userStr('solo message'), // exact twin
        assistantText('turn 2', 'a2'),
        enqueue('batch one'),
        enqueue('batch two'),
        userStr('batch one\nbatch two'),
        assistantText('turn 3', 'a3'),
      );
      expect(userTexts(jsonl)).toEqual(['start', 'solo message', 'batch one\nbatch two']);
    });

    it('a genuine Pattern B enqueue near a batch is NOT eaten by the merged pass', () => {
      // Only a contiguous run whose join EXACTLY equals the user line may be claimed.
      // An unrelated Pattern B enqueue (never re-logged) must still emit as synthetic.
      const jsonl = build(
        userStr('start'),
        assistantText('busy', 'a1'),
        enqueue('cancelled mid-stream'), // Pattern B — no twin anywhere
        enqueue('batch one'),
        enqueue('batch two'),
        userStr('batch one\nbatch two'),
        assistantText('done', 'a2'),
      );
      const texts = userTexts(jsonl);
      expect(texts).toContain('cancelled mid-stream'); // synthetic survives
      expect(texts.filter(t => t.includes('batch one'))).toHaveLength(1); // merged line only
    });

    it('joined-looking user line with NO matching enqueues is untouched', () => {
      // A user genuinely typing a multi-line message must not be affected.
      const jsonl = build(
        userStr('line one\nline two'),
        assistantText('reply', 'a1'),
      );
      expect(userTexts(jsonl)).toEqual(['line one\nline two']);
    });
  });
});
