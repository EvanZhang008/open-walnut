/**
 * The walnut-trigger check contract, driven directly: what a script may print,
 * how items are deduped, what the caps do, and that the runner's deadline kills
 * the whole pipeline. Real `/bin/sh` for the runner; everything else is pure.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseCheckStdout, decideCheck, applyCheckOutcome, applyCheckError, ackFire, emptyHostState,
  coerceHostState, buildCheckStdin, runCheckProcess, checkErrorOf, validateTriggerDef, pruneSeen,
  headChars, tailChars,
  CHECK_STDOUT_CAP, CHECK_STATE_CAP, CHECK_INPUT_CAP, CHECK_ITEMS_CAP, MAX_FIRES_PER_DAY_DEFAULT, SEEN_MAX,
  FIRE_BUDGET_WINDOW_MS, CHECK_ITEMS_PARSE_MAX, fireBudgetNextAtMs, fireBudgetUsed, dayKey,
  PENDING_FIRES_MAX, MIN_EVERY_MS, CHECK_ITEM_ID_MAX, CHECK_WARNINGS_MAX, shortItemId, boundedWarnings,
  triggersSetHash, triggerStateFileName,
  type TriggerDef,
} from '../../src/providers/trigger-check-core.js';

const NOW = Date.parse('2026-09-15T10:00:00Z');
const def: TriggerDef = { id: 'job-1', name: 'PR comments', everyMs: 60_000, check: { run: 'true' } };

function parsedOk(stdout: string) {
  const p = parseCheckStdout(stdout);
  if (!p.ok) throw new Error(`expected ok, got ${p.error}`);
  return p;
}

describe('parseCheckStdout', () => {
  it('reads the LAST line, so a script may log above it', () => {
    const p = parsedOk('fetching...\n3 comments\n{"fire": true, "items": [{"id": "a"}]}\n');
    expect(p.output.fire).toBe(true);
    expect(p.output.items?.map((i) => i.id)).toEqual(['a']);
    expect(p.output.hasState).toBe(false);
  });

  it('refuses empty, non-JSON, non-object, and a missing fire flag, each with a reason', () => {
    expect(parseCheckStdout('')).toMatchObject({ ok: false, error: expect.stringContaining('empty') });
    expect(parseCheckStdout('done')).toMatchObject({ ok: false, error: expect.stringContaining('not JSON') });
    expect(parseCheckStdout('[1,2]')).toMatchObject({ ok: false, error: expect.stringContaining('object') });
    expect(parseCheckStdout('{"items": []}')).toMatchObject({ ok: false, error: expect.stringContaining('"fire"') });
  });

  it('validates items: objects with string ids, duplicates folded, count capped', () => {
    // With nothing usable left the script is broken, not one item: still an error.
    expect(parseCheckStdout('{"fire": true, "items": [1]}')).toMatchObject({ ok: false, error: expect.stringContaining('items[0]') });
    expect(parseCheckStdout('{"fire": true, "items": [{"id": ""}]}')).toMatchObject({ ok: false, error: expect.stringContaining('items[0].id') });
    const dup = parsedOk('{"fire": true, "items": [{"id": "a", "n": 1}, {"id": "a", "n": 2}, {"id": "b"}]}');
    expect(dup.output.items).toEqual([{ id: 'a', n: 1 }, { id: 'b' }]);
    // Parsing keeps more than one fire carries (the per-fire cap applies to NEW
    // items, after dedup); only past CHECK_ITEMS_PARSE_MAX is the tail dropped.
    const many = Array.from({ length: CHECK_ITEMS_CAP + 5 }, (_, i) => ({ id: `i${i}` }));
    const kept = parsedOk(JSON.stringify({ fire: true, items: many }));
    expect(kept.output.items).toHaveLength(CHECK_ITEMS_CAP + 5);
    expect(kept.itemsTruncated).toBe(false);
    const huge = Array.from({ length: CHECK_ITEMS_PARSE_MAX + 5 }, (_, i) => ({ id: `${i}` }));
    const capped = parsedOk(JSON.stringify({ fire: true, items: huge }));
    expect(capped.output.items).toHaveLength(CHECK_ITEMS_PARSE_MAX);
    expect(capped.itemsTruncated).toBe(true);
  });

  // 2026-10-09: one id of 490 chars failed five runs in a row and the trigger was
  // stopped; the other items and the cursor were lost with it.
  describe('one bad item never fails the run', () => {
    const longId = (tail: string) => `${'acme-pipeline/approval-workflow/'.repeat(14)}${tail}`;

    it('shortens an over-long id to a stable head plus hash and keeps the original', () => {
      const raw = longId('run-1');
      expect(raw.length).toBeGreaterThan(CHECK_ITEM_ID_MAX);
      const p = parsedOk(JSON.stringify({ fire: true, items: [{ id: 'short' }, { id: raw, title: 't' }], state: { c: 7 } }));
      const [short, long] = p.output.items!;
      expect(short).toEqual({ id: 'short' });
      expect(long.id.length).toBeLessThanOrEqual(CHECK_ITEM_ID_MAX);
      expect(long.id).toBe(shortItemId(raw));
      expect(long.id.startsWith(raw.slice(0, 100))).toBe(true);
      expect(long).toMatchObject({ fullId: raw, title: 't' });
      // The state still goes through.
      expect(p.output.state).toEqual({ c: 7 });
      expect(p.output.warnings).toEqual([
        `items[1].id was ${raw.length} chars (over ${CHECK_ITEM_ID_MAX}); the daemon shortened it to a stable id and kept the original in "fullId"`,
      ]);
      // Same id in, same id out (the seen set dedups it next run); a different
      // tail behind the same long head is a different id.
      expect(shortItemId(raw)).toBe(shortItemId(longId('run-1')));
      expect(shortItemId(longId('run-2'))).not.toBe(shortItemId(raw));
      expect(shortItemId('a'.repeat(CHECK_ITEM_ID_MAX))).toBe('a'.repeat(CHECK_ITEM_ID_MAX));
    });

    it('never cuts a long id inside a surrogate pair', () => {
      // U+1F600 is two UTF-16 units; place one across the cut point.
      const raw = `${'x'.repeat(CHECK_ITEM_ID_MAX - 18)}\u{1F600}${'y'.repeat(300)}`;
      const id = shortItemId(raw);
      const head = id.slice(0, id.lastIndexOf('~'));
      expect(head.endsWith('\uD83D')).toBe(false);
      expect(id).toMatch(/~[0-9a-f]{16}$/);
    });

    it('a shortened id is seen next run, so the item fires once', () => {
      const raw = longId('seen');
      const out = (stdout: string) => parsedOk(stdout).output;
      const state = emptyHostState(NOW);
      const first = out(JSON.stringify({ fire: true, items: [{ id: raw }] }));
      const fire = applyCheckOutcome(state, first, decideCheck(def, first, state, NOW), NOW, 1);
      expect(fire?.items.map((i) => i.id)).toEqual([shortItemId(raw)]);
      expect(fire?.warnings?.[0]).toContain('shortened');
      const again = out(JSON.stringify({ fire: true, items: [{ id: raw }] }));
      expect(decideCheck(def, again, state, NOW + 60_000)).toEqual({ kind: 'quiet', reason: 'all-seen' });
    });

    it('drops an item with no usable id, keeps the rest, and says so', () => {
      const p = parsedOk(JSON.stringify({ fire: true, items: [{ id: 'a' }, { id: 3 }, 'b', { id: 'c' }], state: 's' }));
      expect(p.output.items!.map((i) => i.id)).toEqual(['a', 'c']);
      expect(p.output.state).toBe('s');
      expect(p.output.warnings).toEqual(['2 items dropped, the first because items[1].id must be a non-empty string']);
    });

    it('bounds the warnings it carries', () => {
      const items = Array.from({ length: 9 }, (_, i) => ({ id: longId(`n${i}`) }));
      const p = parsedOk(JSON.stringify({ fire: true, items }));
      expect(p.output.items).toHaveLength(9);
      expect(p.output.warnings).toHaveLength(CHECK_WARNINGS_MAX);
      expect(p.output.warnings!.at(-1)).toBe('and 5 more warnings like these');
      expect(boundedWarnings(['a\nb   c', ' '])).toEqual(['a b c']);
    });

    it('a clean run carries no warnings key at all', () => {
      expect(parsedOk('{"fire": true, "items": [{"id": "a"}]}').output).not.toHaveProperty('warnings');
    });
  });

  it('caps input with a visible marker and keeps state only when the key was printed', () => {
    const long = 'x'.repeat(CHECK_INPUT_CAP + 10);
    const p = parsedOk(JSON.stringify({ fire: true, input: long, state: null }));
    expect(p.inputTruncated).toBe(true);
    expect(p.output.input).toContain('[input truncated');
    expect(p.output.hasState).toBe(true);
    expect(p.output.state).toBeNull();
    expect(parseCheckStdout('{"fire": true, "input": 5}')).toMatchObject({ ok: false, error: expect.stringContaining('"input"') });
  });

  it('refuses stdout over the cap and a state blob over its cap', () => {
    expect(parseCheckStdout('a'.repeat(CHECK_STDOUT_CAP + 1))).toMatchObject({ ok: false, error: expect.stringContaining('stdout exceeded') });
    const big = JSON.stringify({ fire: false, state: 'y'.repeat(CHECK_STATE_CAP + 1) });
    expect(parseCheckStdout(big)).toMatchObject({ ok: false, error: expect.stringContaining('"state" exceeded') });
  });
});

describe('decideCheck + applyCheckOutcome', () => {
  it('fire:false is quiet and still stores the new cursor', () => {
    const state = emptyHostState(NOW);
    const p = parsedOk('{"fire": false, "state": {"cursor": 7}}');
    const d = decideCheck(def, p.output, state, NOW);
    expect(d).toEqual({ kind: 'quiet', reason: 'fire-false' });
    expect(applyCheckOutcome(state, p.output, d, NOW, 12)).toBeNull();
    expect(state.state).toEqual({ cursor: 7 });
    expect(state.lastRunAtMs).toBe(NOW);
    expect(state.lastFireAtMs).toBeUndefined();
  });

  it('fires only for unseen ids; a second run with the same items is quiet; new ones fire again', () => {
    const state = emptyHostState(NOW);
    const first = parsedOk('{"fire": true, "items": [{"id": "a"}, {"id": "b"}], "input": "two new"}');
    const d1 = decideCheck(def, first.output, state, NOW);
    expect(d1).toMatchObject({ kind: 'fire', input: 'two new' });
    const fire1 = applyCheckOutcome(state, first.output, d1, NOW, 5);
    expect(fire1?.seq).toBe(1);
    expect(fire1?.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(state.pendingFires).toHaveLength(1);

    const again = decideCheck(def, first.output, state, NOW + 60_000);
    expect(again).toEqual({ kind: 'quiet', reason: 'all-seen' });
    expect(applyCheckOutcome(state, first.output, again, NOW + 60_000, 5)).toBeNull();

    const third = parsedOk('{"fire": true, "items": [{"id": "b"}, {"id": "c"}]}');
    const d3 = decideCheck(def, third.output, state, NOW + 120_000);
    expect(d3).toMatchObject({ kind: 'fire' });
    expect((d3 as { items: { id: string }[] }).items.map((i) => i.id)).toEqual(['c']);
  });

  it('fire:true with no items fires every run (the script judged for itself)', () => {
    const state = emptyHostState(NOW);
    const p = parsedOk('{"fire": true, "input": "CI is red"}');
    expect(decideCheck(def, p.output, state, NOW)).toMatchObject({ kind: 'fire', items: [] });
    applyCheckOutcome(state, p.output, decideCheck(def, p.output, state, NOW), NOW, 1);
    expect(decideCheck(def, p.output, state, NOW + 1)).toMatchObject({ kind: 'fire' });
  });

  it('a script that prints no state key keeps the previous cursor; null replaces it', () => {
    const state = emptyHostState(NOW);
    state.state = { cursor: 1 };
    const noKey = parsedOk('{"fire": false}');
    applyCheckOutcome(state, noKey.output, decideCheck(def, noKey.output, state, NOW), NOW, 1);
    expect(state.state).toEqual({ cursor: 1 });
    const nulled = parsedOk('{"fire": false, "state": null}');
    applyCheckOutcome(state, nulled.output, decideCheck(def, nulled.output, state, NOW), NOW, 1);
    expect(state.state).toBeNull();
  });

  it('a spent budget holds the fire, then gives back one fire per 24h / cap (no calendar day)', () => {
    const state = emptyHostState(NOW);
    const p = parsedOk('{"fire": true}');
    // A burst of the whole budget.
    for (let i = 0; i < MAX_FIRES_PER_DAY_DEFAULT; i++) {
      const d = decideCheck(def, p.output, state, NOW + i);
      expect(d.kind).toBe('fire');
      applyCheckOutcome(state, p.output, d, NOW + i, 1);
    }
    expect(decideCheck(def, p.output, state, NOW + 1000)).toEqual({ kind: 'quiet', reason: 'rate-limited' });
    // A held run marks nothing seen.
    const withItems = parsedOk('{"fire": true, "items": [{"id": "late"}]}');
    const limited = decideCheck(def, withItems.output, state, NOW + 1001);
    expect(limited).toEqual({ kind: 'quiet', reason: 'rate-limited' });
    applyCheckOutcome(state, withItems.output, limited, NOW + 1001, 1);
    expect(state.seen.late).toBeUndefined();

    // One fire comes back after 24h / 24 = 1 hour, not at the next midnight.
    const refill = FIRE_BUDGET_WINDOW_MS / MAX_FIRES_PER_DAY_DEFAULT;
    const last = NOW + MAX_FIRES_PER_DAY_DEFAULT - 1;
    // (The burst itself drained a few ms worth, hence "about".)
    expect(Math.abs(fireBudgetNextAtMs(def, state, NOW + 1001) - (last + refill))).toBeLessThan(50);
    expect(decideCheck(def, withItems.output, state, last + refill - 1_000).kind).toBe('quiet');
    const back = decideCheck(def, withItems.output, state, last + refill);
    expect(back).toMatchObject({ kind: 'fire', items: [{ id: 'late' }] });
    applyCheckOutcome(state, withItems.output, back, last + refill, 1);
    expect(state.seen.late).toBe(last + refill);
    // ...and only one: the next is another refill away.
    expect(decideCheck(def, p.output, state, last + refill + 60_000).kind).toBe('quiet');
    expect(decideCheck(def, p.output, state, last + 2 * refill).kind).toBe('fire');
    // A full window of quiet gives the whole burst back.
    const rested = last + refill + FIRE_BUDGET_WINDOW_MS;
    expect(fireBudgetUsed(MAX_FIRES_PER_DAY_DEFAULT, state.budget, rested)).toBe(0);

    const custom: TriggerDef = { ...def, limits: { maxFiresPerDay: 1 } };
    const fresh = emptyHostState(NOW);
    applyCheckOutcome(fresh, p.output, decideCheck(custom, p.output, fresh, NOW), NOW, 1);
    expect(decideCheck(custom, p.output, fresh, NOW + 1)).toEqual({ kind: 'quiet', reason: 'rate-limited' });
    expect(decideCheck(custom, p.output, fresh, NOW + FIRE_BUDGET_WINDOW_MS).kind).toBe('fire');
  });

  it('a held fire keeps the previous cursor, so the next allowed check delivers the same items', () => {
    // A cursor script: it reports what came after its cursor and moves the cursor
    // to the newest item. The 2026-10-01 loss: the held run saved the moved cursor.
    const feed: Array<{ id: string; ts: number }> = [];
    const run = (cursor: number) => {
      const after = feed.filter((m) => m.ts > cursor);
      const next = after.length ? after[after.length - 1].ts : cursor;
      return parsedOk(JSON.stringify({ fire: after.length > 0, items: after.map((m) => ({ id: m.id })), state: { ts: next } }));
    };
    const cursorOf = (st: ReturnType<typeof emptyHostState>) => ((st.state as { ts?: number } | null)?.ts ?? 0);
    const capped: TriggerDef = { ...def, limits: { maxFiresPerDay: 2 } };
    const state = emptyHostState(NOW);
    const delivered: string[] = [];
    const tick = (at: number) => {
      const out = run(cursorOf(state));
      const d = decideCheck(capped, out.output, state, at);
      const fire = applyCheckOutcome(state, out.output, d, at, 1);
      if (fire) delivered.push(...fire.items.map((i) => i.id));
      return d;
    };
    feed.push({ id: 'm1', ts: 1 });
    expect(tick(NOW).kind).toBe('fire');
    feed.push({ id: 'm2', ts: 2 });
    expect(tick(NOW + 300_000).kind).toBe('fire');
    // The budget is spent: m3 and m4 are held, and the cursor stays at m2.
    feed.push({ id: 'm3', ts: 3 });
    expect(tick(NOW + 600_000)).toEqual({ kind: 'quiet', reason: 'rate-limited' });
    expect(state.state).toEqual({ ts: 2 });
    feed.push({ id: 'm4', ts: 4 });
    expect(tick(NOW + 900_000)).toEqual({ kind: 'quiet', reason: 'rate-limited' });
    expect(state.state).toEqual({ ts: 2 });
    // The refill (12h for a cap of 2) fires once with BOTH held items.
    const d = tick(NOW + 300_000 + FIRE_BUDGET_WINDOW_MS / 2);
    expect(d).toMatchObject({ kind: 'fire', items: [{ id: 'm3' }, { id: 'm4' }] });
    expect(state.state).toEqual({ ts: 4 });
    expect(delivered).toEqual(['m1', 'm2', 'm3', 'm4']);
    // Quiet and all-seen runs still save the cursor: only a held fire keeps the old one.
    const quiet = parsedOk('{"fire": false, "state": {"ts": 9}}');
    applyCheckOutcome(state, quiet.output, decideCheck(capped, quiet.output, state, NOW + FIRE_BUDGET_WINDOW_MS), NOW + FIRE_BUDGET_WINDOW_MS, 1);
    expect(state.state).toEqual({ ts: 9 });
  });

  it('a backlog longer than one fire is walked: the cursor is kept until the last of it is delivered', () => {
    // 450 new messages after a long hold, from a cursor script that prints them all.
    const ids = Array.from({ length: 450 }, (_, i) => `m${i + 1}`);
    const out = parsedOk(JSON.stringify({ fire: true, items: ids.map((id) => ({ id })), state: { ts: 450 } }));
    const lenient: TriggerDef = { ...def, limits: { maxFiresPerDay: 288 } };
    const state = emptyHostState(NOW);
    state.state = { ts: 0 };
    const delivered: string[] = [];
    for (let i = 0; i < 3; i++) {
      const d = decideCheck(lenient, out.output, state, NOW + i * 300_000);
      expect(d.kind).toBe('fire');
      const fire = applyCheckOutcome(state, out.output, d, NOW + i * 300_000, 1)!;
      delivered.push(...fire.items.map((it) => it.id));
      // The cursor moves only with the fire that carried the last new item.
      expect(state.state).toEqual(i < 2 ? { ts: 0 } : { ts: 450 });
      expect(fire.itemsTruncated).toBe(i < 2 ? true : undefined);
    }
    expect(delivered).toEqual(ids);
    expect(decideCheck(lenient, out.output, state, NOW + 900_000)).toEqual({ kind: 'quiet', reason: 'all-seen' });
  });

  it('a clock that jumped ahead and came back does not freeze the budget', () => {
    const p = parsedOk('{"fire": true}');
    const capped: TriggerDef = { ...def, limits: { maxFiresPerDay: 24 } };
    const state = emptyHostState(NOW);
    // Spent while the clock read a day ahead.
    const ahead = NOW + FIRE_BUDGET_WINDOW_MS;
    for (let i = 0; i < 24; i++) applyCheckOutcome(state, p.output, decideCheck(capped, p.output, state, ahead + i), ahead + i, 1);
    // Back to the real time: the first check rebases the stamp, and an hour later a fire is back.
    applyCheckOutcome(state, p.output, decideCheck(capped, p.output, state, NOW), NOW, 1);
    expect(state.budget.atMs).toBe(NOW);
    expect(decideCheck(capped, p.output, state, NOW + FIRE_BUDGET_WINDOW_MS / 24 + 1_000).kind).toBe('fire');
  });

  it('a raised cap takes effect at once; a lowered one holds for one refill, not days', () => {
    const p = parsedOk('{"fire": true}');
    const state = emptyHostState(NOW);
    for (let i = 0; i < 24; i++) applyCheckOutcome(state, p.output, decideCheck(def, p.output, state, NOW + i), NOW + i, 1);
    expect(decideCheck(def, p.output, state, NOW + 100).kind).toBe('quiet');
    // 24 -> 288 (the Slack monitor fix): 264 free fires right away.
    const busy: TriggerDef = { ...def, limits: { maxFiresPerDay: 288 } };
    expect(decideCheck(busy, p.output, state, NOW + 100).kind).toBe('fire');
    for (let i = 0; i < 200; i++) applyCheckOutcome(state, p.output, decideCheck(busy, p.output, state, NOW + 200 + i), NOW + 200 + i, 1);
    expect(state.budget.used).toBeGreaterThan(200);
    // 288 -> 4 with 224 spent: the spend clamps to the cap, so one refill (6h) frees a fire.
    const strict: TriggerDef = { ...def, limits: { maxFiresPerDay: 4 } };
    const at = NOW + 1_000;
    expect(decideCheck(strict, p.output, state, at).kind).toBe('quiet');
    const next = fireBudgetNextAtMs(strict, state, at);
    expect(next).toBeLessThanOrEqual(at + FIRE_BUDGET_WINDOW_MS / 4);
    // The prediction is what decideCheck then does.
    expect(decideCheck(strict, p.output, state, next - 1_000).kind).toBe('quiet');
    expect(decideCheck(strict, p.output, state, next).kind).toBe('fire');
  });

  it('migrates the old per-day counter: today\'s fires carry over as spent, another day\'s are gone', () => {
    const today = coerceHostState({ seen: {}, seq: 30, day: { key: dayKey(NOW), fires: 24 } }, NOW);
    expect(today.budget).toEqual({ used: 24, atMs: NOW });
    expect('day' in today).toBe(false);
    const p = parsedOk('{"fire": true}');
    expect(decideCheck(def, p.output, today, NOW).kind).toBe('quiet');
    expect(decideCheck(def, p.output, today, NOW + FIRE_BUDGET_WINDOW_MS / 24).kind).toBe('fire');
    const yesterday = coerceHostState({ seen: {}, day: { key: '2026-09-14', fires: 24 } }, NOW);
    expect(yesterday.budget).toEqual({ used: 0, atMs: NOW });
    expect(decideCheck(def, p.output, yesterday, NOW).kind).toBe('fire');
    // A written budget round-trips; junk in it is a fresh budget.
    expect(coerceHostState({ budget: { used: 3.5, atMs: NOW - 10 } }, NOW).budget).toEqual({ used: 3.5, atMs: NOW - 10 });
    expect(coerceHostState({ budget: { used: 'x', atMs: NOW } }, NOW).budget).toEqual({ used: 0, atMs: NOW });
    // A clock that went backwards drains nothing (and never refunds a negative spend).
    expect(fireBudgetUsed(24, { used: 5, atMs: NOW + 60_000 }, NOW)).toBe(5);
  });

  it('pending fires are at-least-once: kept until acked, oldest dropped past the cap', () => {
    const state = emptyHostState(NOW);
    const p = parsedOk('{"fire": true}');
    const lenient: TriggerDef = { ...def, limits: { maxFiresPerDay: 0 } };
    for (let i = 0; i < PENDING_FIRES_MAX + 3; i++) {
      applyCheckOutcome(state, p.output, decideCheck(lenient, p.output, state, NOW + i), NOW + i, 1);
    }
    expect(state.pendingFires).toHaveLength(PENDING_FIRES_MAX);
    expect(state.pendingFires[0].seq).toBe(4);
    expect(ackFire(state, 4)).toBe(true);
    expect(ackFire(state, 4)).toBe(false);
    expect(state.pendingFires.find((f) => f.seq === 4)).toBeUndefined();
  });

  it('errors count consecutively and a clean run resets the count', () => {
    const state = emptyHostState(NOW);
    applyCheckError(state, NOW);
    applyCheckError(state, NOW + 1);
    expect(state.consecutiveErrors).toBe(2);
    const p = parsedOk('{"fire": false}');
    applyCheckOutcome(state, p.output, decideCheck(def, p.output, state, NOW + 2), NOW + 2, 1);
    expect(state.consecutiveErrors).toBe(0);
  });

  it('seen is bounded by count and age', () => {
    const state = emptyHostState(NOW);
    for (let i = 0; i < SEEN_MAX + 10; i++) state.seen[`k${i}`] = NOW - i;
    state.seen.ancient = NOW - 40 * 24 * 60 * 60 * 1000;
    pruneSeen(state, NOW);
    expect(Object.keys(state.seen)).toHaveLength(SEEN_MAX);
    expect(state.seen.ancient).toBeUndefined();
    expect(state.seen.k0).toBe(NOW);
  });
});

describe('host state on disk', () => {
  it('coerces garbage to an empty state and keeps valid fields', () => {
    const garbage = coerceHostState('nope', NOW);
    // Every fresh state mints its own epoch; everything else is the empty shape.
    expect(garbage.epoch).toMatch(/^[0-9a-f]{12}$/);
    expect({ ...garbage, epoch: 'x' }).toEqual({ ...emptyHostState(NOW), epoch: 'x' });
    const c = coerceHostState({ epoch: 'abc123', seen: { a: NOW, b: 'x' }, state: { c: 1 }, seq: 3, pendingFires: [{ seq: 3, atMs: NOW, items: [] }, 'junk'] }, NOW);
    expect(c.epoch).toBe('abc123');
    expect(c.seen).toEqual({ a: NOW });
    expect(c.state).toEqual({ c: 1 });
    expect(c.seq).toBe(3);
    expect(c.pendingFires).toHaveLength(1);
  });

  it('a state file from before epochs gets a fresh one, and two fresh states never share', () => {
    const legacy = coerceHostState({ seen: {}, seq: 7 }, NOW);
    expect(legacy.epoch).toMatch(/^[0-9a-f]{12}$/);
    expect(legacy.seq).toBe(7);
    expect(emptyHostState(NOW).epoch).not.toBe(emptyHostState(NOW).epoch);
  });

  it('stdin carries state, lastFireAt and now as ISO strings, newline-terminated', () => {
    const state = emptyHostState(NOW);
    state.state = { cursor: 'abc' };
    state.lastFireAtMs = NOW - 5000;
    const stdin = buildCheckStdin(state, NOW);
    // `read -r LINE` under `set -e` returns 1 on an unterminated last line; the
    // skill's bash template depends on this newline.
    expect(stdin.endsWith('\n')).toBe(true);
    expect(stdin.trimEnd().includes('\n')).toBe(false);
    expect(JSON.parse(stdin)).toEqual({
      state: { cursor: 'abc' }, lastFireAt: new Date(NOW - 5000).toISOString(), now: new Date(NOW).toISOString(),
    });
    expect(JSON.parse(buildCheckStdin(emptyHostState(NOW), NOW)).lastFireAt).toBeNull();
  });
});

describe('validateTriggerDef', () => {
  it('fills defaults, clamps the timeout, and refuses a cadence under the floor', () => {
    const ok = validateTriggerDef({ id: 'j', everyMs: 300_000, check: { run: 'echo hi', timeoutSeconds: 9999 } });
    expect(ok).toMatchObject({ ok: true, def: { name: 'j', check: { run: 'echo hi', timeoutSeconds: 300 } } });
    expect(validateTriggerDef({ id: 'j', everyMs: MIN_EVERY_MS - 1, check: { run: 'x' } })).toMatchObject({ ok: false });
    expect(validateTriggerDef({ id: 'j', everyMs: 60_000, check: { run: '  ' } })).toMatchObject({ ok: false, error: expect.stringContaining('check.run') });
  });
});

describe('the fire budget cap on the wire', () => {
  // A cap below 1 never crosses the wire (the server sends "no limit" as a
  // cadence-sized cap), so the daemon refuses one rather than guessing its meaning.
  it('refuses a cap below 1 and names the default', () => {
    const zero = validateTriggerDef({ id: 'j', everyMs: 60_000, check: { run: 'x' }, limits: { maxFiresPerDay: 0 } });
    expect(zero).toMatchObject({ ok: false, error: expect.stringContaining('at least 1') });
    expect(validateTriggerDef({ id: 'j', everyMs: 60_000, check: { run: 'x' }, limits: { maxFiresPerDay: -3 } })).toMatchObject({ ok: false });
    expect(validateTriggerDef({ id: 'j', everyMs: 60_000, check: { run: 'x' }, limits: { maxFiresPerDay: 1 } }))
      .toMatchObject({ ok: true, def: { limits: { maxFiresPerDay: 1 } } });
    // Omitting it is how a trigger asks for the default, and stores nothing.
    const none = validateTriggerDef({ id: 'j', everyMs: 60_000, check: { run: 'x' } });
    expect(none.ok && none.def.limits).toBeUndefined();
  });
});

describe('surrogate-safe truncation', () => {
  // Every one of these strings is persisted (the fire's input into the daemon's
  // state JSON, the stderr tail into job state and notifications), and a lone
  // surrogate makes a strict JSON reader reject the whole file.
  it('never keeps half an astral character at either end', () => {
    const rocket = '\u{1F680}';
    expect(headChars(`${'a'.repeat(9)}${rocket}bb`, 10)).toBe('a'.repeat(9));
    expect(headChars(`${'a'.repeat(8)}${rocket}bb`, 10)).toBe(`${'a'.repeat(8)}${rocket}`);
    expect(tailChars(`bb${rocket}${'a'.repeat(9)}`, 10)).toBe('a'.repeat(9));
    expect(tailChars(`bb${rocket}${'a'.repeat(8)}`, 10)).toBe(`${rocket}${'a'.repeat(8)}`);
    // Shorter than the bound: returned whole, both ways.
    expect(headChars(rocket, 10)).toBe(rocket);
    expect(tailChars(rocket, 10)).toBe(rocket);
  });

  it('a truncated fire input survives a JSON round trip', () => {
    const long = `${'x'.repeat(CHECK_INPUT_CAP - 1)}\u{1F680}${'y'.repeat(50)}`;
    const parsed = parseCheckStdout(JSON.stringify({ fire: true, input: long }));
    expect(parsed.ok).toBe(true);
    const input = parsed.ok ? parsed.output.input! : '';
    expect(input).toContain('[input truncated at');
    expect(/[\uD800-\uDBFF]/.test(input)).toBe(false);
    expect(JSON.parse(JSON.stringify({ input })).input).toBe(input);
  });
});

describe('the daemon-side fingerprints', () => {
  it('the set hash ignores push order and moves on any field that changes a run', () => {
    const a: TriggerDef = { id: 'a', name: 'A', everyMs: 60_000, check: { run: 'x', timeoutSeconds: 30 } };
    const b: TriggerDef = { id: 'b', name: 'B', everyMs: 60_000, check: { run: 'y', timeoutSeconds: 30 } };
    expect(triggersSetHash([a, b])).toBe(triggersSetHash([b, a]));
    expect(triggersSetHash([a])).not.toBe(triggersSetHash([a, b]));
    for (const changed of [
      { ...a, name: 'A2' },
      { ...a, everyMs: 61_000 },
      { ...a, check: { ...a.check, run: 'x2' } },
      { ...a, check: { ...a.check, cwd: '/tmp' } },
      { ...a, check: { ...a.check, timeoutSeconds: 31 } },
      { ...a, limits: { maxFiresPerDay: 3 } },
    ]) {
      expect(triggersSetHash([changed, b]), JSON.stringify(changed)).not.toBe(triggersSetHash([a, b]));
    }
  });

  it('a state file name is a plain <id>.json only when the id cannot escape the directory', () => {
    expect(triggerStateFileName('routine-7')).toBe('routine-7.json');
    for (const hostile of ['../../etc/passwd', 'a/b', '..', '.hidden', 'x\u0000y']) {
      const name = triggerStateFileName(hostile);
      expect(name).not.toContain('/');
      expect(name.startsWith('.')).toBe(false);
      expect(name.endsWith('.json')).toBe(true);
    }
    // Two ids that collapse to the same safe stem still get separate files.
    expect(triggerStateFileName('a/b')).not.toBe(triggerStateFileName('a:b'));
  });
});

describe('runCheckProcess (real /bin/sh)', () => {
  it('feeds stdin, captures stdout, and the parse reads the last line', async () => {
    const r = await runCheckProcess(
      { run: 'read line; echo "log: $line"; echo "{\\"fire\\": true, \\"items\\": [{\\"id\\": \\"x\\"}]}"' },
      '{"state":null}',
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('log: {"state":null}');
    expect(parsedOk(r.stdout).output.items?.[0].id).toBe('x');
    expect(checkErrorOf(r, parseCheckStdout(r.stdout))).toBeNull();
  });

  it('kills the whole pipeline at the deadline', async () => {
    const started = Date.now();
    const r = await runCheckProcess({ run: 'sleep 20 | cat', timeoutSeconds: 1 }, '{}');
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(checkErrorOf(r, null)).toContain('timed out');
  });

  it('reports a non-zero exit with the stderr tail, and a missing cwd by name', async () => {
    const r = await runCheckProcess({ run: 'echo boom >&2; exit 3' }, '{}');
    expect(r.exitCode).toBe(3);
    expect(checkErrorOf(r, null)).toContain('exit 3: boom');
    const missing = await runCheckProcess({ run: 'true', cwd: '/nonexistent/walnut-trigger-cwd' }, '{}');
    expect(missing.spawnError).toContain('cwd does not exist');
  });

  it('stops reading past the stdout cap and reports the overflow', async () => {
    const r = await runCheckProcess({ run: 'yes | head -c 200000', timeoutSeconds: 5 }, '{}');
    expect(r.stdoutOverflow).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(CHECK_STDOUT_CAP);
    expect(checkErrorOf(r, null)).toContain('stdout exceeded');
  });

  // The skill's bash template, byte for byte: `set -euo pipefail` + `read -r`.
  // Without the trailing newline on stdin, `read` returns 1 at EOF and `set -e`
  // ends the script before it prints anything (verified: exit 1, empty stdout).
  // Run the way the skill arms it, `bash <file>`: `pipefail` is not POSIX, and dash
  // (Ubuntu's /bin/sh) rejects it with exit 2 when the text goes straight to `sh -c`.
  it("runs the skill's bash template: read -r under set -e survives the stdin the daemon writes", async () => {
    const template = 'set -euo pipefail\nread -r STDIN\necho "stdin was: $STDIN" >&2\n'
      + 'echo \'{"fire": false, "state": {"cursor": 1}}\'';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-trigger-template-'));
    const file = path.join(dir, 'check.sh');
    fs.writeFileSync(file, template);
    const r = await runCheckProcess({ run: `bash ${file}` }, buildCheckStdin(emptyHostState(NOW), NOW))
      .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
    expect(r.exitCode).toBe(0);
    expect(r.stderrTail).toContain('stdin was: {"state":null');
    expect(parsedOk(r.stdout).output.state).toEqual({ cursor: 1 });
  });

  it('decodes a multi-byte character split across two stdout chunks', async () => {
    // A 3-byte character written in two halves with a flush in between: per-chunk
    // decoding would yield U+FFFD and the JSON line would not parse.
    // Octal escapes: `\x` is a bash extension that dash (Ubuntu's /bin/sh) prints literally.
    const run = 'printf \'{"fire": true, "items": [{"id": "\\344\\270\'; sleep 0.2; printf \'\\255"}]}\\n\'';
    const r = await runCheckProcess({ run, timeoutSeconds: 5 }, '{}\n');
    expect(r.exitCode).toBe(0);
    expect(parsedOk(r.stdout).output.items?.[0].id).toBe('中');
  });

  it('redacts credential shapes out of the stderr tail before it becomes an error string', async () => {
    const r = await runCheckProcess({
      run: 'echo "curl: Authorization: Bearer abcdefgh12345678 failed; retry with token=sekrit-value-99" >&2; exit 7',
    }, '{}\n');
    const error = checkErrorOf(r, null)!;
    expect(error).toContain('exit 7');
    expect(error).not.toContain('abcdefgh12345678');
    expect(error).not.toContain('sekrit-value-99');
    expect(error).toContain('[redacted]');
  });
});

describe('fires carry what the server needs to dedup and to explain', () => {
  it('records itemsTruncated on the queued fire when the script printed more than the cap', () => {
    const state = emptyHostState(NOW);
    const many = Array.from({ length: CHECK_ITEMS_CAP + 3 }, (_, i) => ({ id: `i${i}` }));
    const parsed = parsedOk(JSON.stringify({ fire: true, items: many }));
    const fire = applyCheckOutcome(state, parsed.output, decideCheck(def, parsed.output, state, NOW), NOW, 5, { itemsTruncated: parsed.itemsTruncated })!;
    expect(fire.items).toHaveLength(CHECK_ITEMS_CAP);
    expect(fire.itemsTruncated).toBe(true);
    const plain = applyCheckOutcome(emptyHostState(NOW), parsedOk('{"fire": true}').output, { kind: 'fire', items: [] }, NOW, 5)!;
    expect(plain.itemsTruncated).toBeUndefined();
  });
});
