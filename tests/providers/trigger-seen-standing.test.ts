/**
 * A trigger never tells its session again about an item it already told, however long the script
 * keeps reporting it.
 *
 * 2026-11-16: a pipeline watch reported three open issues on every run, as items the daemon had
 * delivered days before. Two holes let them come back:
 *  1. A seen id was stamped only when first delivered, so an id the script kept reporting aged out
 *     after SEEN_TTL_MS (or fell out of the SEEN_MAX newest) and was delivered again as new.
 *  2. The fire's `input` dropped a line about a seen item only when the line held the item's id;
 *     the script wrote "[clear] <short id> <title>", so the old issues' lines rode along in the
 *     text of every fire and read as delivered again.
 * Pure: the rules both daemon twins run (the source twin loads them as its sidecar).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  parseCheckStdout, decideCheck, applyCheckOutcome, emptyHostState, inputForNewItems, pruneSeen,
  SEEN_TTL_MS, SEEN_MAX, SEEN_TITLE_MATCH_MIN, MAX_FIRES_PER_DAY_DEFAULT, CHECK_ITEMS_CAP,
  type TriggerDef, type TriggerHostState, type CheckDecision,
} from '../../src/providers/trigger-check-core.js';

const NOW = Date.parse('2026-10-16T21:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const def: TriggerDef = { id: 'watch-1', name: 'pipeline watch', everyMs: 15 * 60_000, check: { run: 'true' } };

function parsed(out: unknown) {
  const p = parseCheckStdout(JSON.stringify(out));
  if (!p.ok) throw new Error(p.error);
  return p.output;
}

/** One check run, as the daemon does it: decide, then record. */
function run(state: TriggerHostState, out: unknown, at: number) {
  const output = parsed(out);
  const decision = decideCheck(def, output, state, at);
  const fire = applyCheckOutcome(state, output, decision, at, 1);
  return { decision, fire };
}

describe('an id the script keeps reporting stays seen', () => {
  it('a standing item reported every run for 45 days is delivered once, never again', () => {
    const state = emptyHostState(NOW);
    const standing = { id: 'clear|web-app|build|macos|abc123@2026-10-16T21:00:00Z', title: '[clear] web-app build on macos failed' };
    const first = run(state, { fire: true, items: [standing] }, NOW);
    expect(first.fire?.items.map((i) => i.id)).toEqual([standing.id]);
    // Every 6 hours for 45 days the script reports it again; sometimes beside a new item, so the
    // trigger fires and prunes. The old code dropped the id at day 30 and fired it again.
    let fires = 1;
    for (let at = NOW + 6 * 3600_000, n = 0; at <= NOW + 45 * DAY; at += 6 * 3600_000, n++) {
      const items = n % 7 === 0 ? [{ id: `change-${n}`, title: `[change] new thing ${n}` }, standing] : [standing];
      const { fire } = run(state, { fire: true, items }, at);
      if (fire) {
        fires++;
        expect(fire.items.map((i) => i.id), `day ${Math.round((at - NOW) / DAY)}`).not.toContain(standing.id);
      }
      expect(state.seen[standing.id], 'its stamp follows the run that last reported it').toBe(at);
    }
    expect(fires).toBeGreaterThan(1);
  });

  it('a standing item is not pushed out of the SEEN_MAX newest by newer ones', () => {
    const state = emptyHostState(NOW);
    const standing = { id: 'open|docs-site|outage|xyz' };
    run(state, { fire: true, items: [standing] }, NOW);
    // SEEN_MAX newer ids, each delivered later, while the script still reports the standing one.
    let at = NOW;
    for (let i = 0; i < SEEN_MAX + 5; i += CHECK_ITEMS_CAP) {
      at += 60_000;
      const batch = Array.from({ length: CHECK_ITEMS_CAP }, (_, k) => ({ id: `item-${i + k}` }));
      state.budget = { used: 0, atMs: at }; // the budget is not what this test is about
      run(state, { fire: true, items: [...batch, standing] }, at);
    }
    expect(Object.keys(state.seen).length).toBeLessThanOrEqual(SEEN_MAX);
    expect(standing.id in state.seen, 'still remembered').toBe(true);
    state.budget = { used: 0, atMs: at + 60_000 };
    expect(run(state, { fire: true, items: [standing] }, at + 60_000).decision).toEqual({ kind: 'quiet', reason: 'all-seen' });
  });

  it('an id the script stopped reporting still ages out', () => {
    const state = emptyHostState(NOW);
    run(state, { fire: true, items: [{ id: 'gone-1' }, { id: 'kept-1' }] }, NOW);
    run(state, { fire: true, items: [{ id: 'kept-1' }] }, NOW + 20 * DAY);
    pruneSeen(state, NOW + 31 * DAY);
    expect(state.seen['gone-1']).toBeUndefined();
    expect(state.seen['kept-1']).toBe(NOW + 20 * DAY);
  });

  it('a stamp never moves back (a clock that jumped back)', () => {
    const state = emptyHostState(NOW);
    run(state, { fire: true, items: [{ id: 'a' }] }, NOW);
    run(state, { fire: true, items: [{ id: 'a' }] }, NOW - 60_000);
    expect(state.seen.a).toBe(NOW);
  });

  // The class: every outcome of a run that read the script's items. A new outcome added to
  // CheckDecision, or a new path that skips the refresh, fails here.
  const DECISIONS = ['fire', 'fire-truncated', 'fire-false', 'all-seen', 'rate-limited'] as const;
  type Case = (typeof DECISIONS)[number];
  const setUp: Record<Case, (state: TriggerHostState, seenItem: { id: string }) => { out: unknown; expect: Partial<CheckDecision> }> = {
    fire: (_s, it) => ({ out: { fire: true, items: [{ id: 'brand-new' }, it] }, expect: { kind: 'fire' } }),
    'fire-truncated': (_s, it) => ({
      out: { fire: true, items: [...Array.from({ length: CHECK_ITEMS_CAP + 3 }, (_, i) => ({ id: `n-${i}` })), it] },
      expect: { kind: 'fire', truncated: true } as Partial<CheckDecision>,
    }),
    'fire-false': (_s, it) => ({ out: { fire: false, items: [it] }, expect: { kind: 'quiet', reason: 'fire-false' } }),
    'all-seen': (_s, it) => ({ out: { fire: true, items: [it] }, expect: { kind: 'quiet', reason: 'all-seen' } }),
    'rate-limited': (s, it) => {
      s.budget = { used: MAX_FIRES_PER_DAY_DEFAULT, atMs: NOW + DAY };
      return { out: { fire: true, items: [{ id: 'held-new' }, it] }, expect: { kind: 'quiet', reason: 'rate-limited' } };
    },
  };

  it.each(DECISIONS)('the %s outcome stamps the seen ids the script still reports', (name) => {
    const state = emptyHostState(NOW);
    const seenItem = { id: 'standing-0001' };
    run(state, { fire: true, items: [seenItem] }, NOW);
    const later = NOW + DAY;
    const c = setUp[name](state, seenItem);
    const { decision } = run(state, c.out, later);
    expect(decision).toMatchObject(c.expect);
    expect(state.seen[seenItem.id]).toBe(later);
  });

  it('the table above covers every quiet reason CheckDecision has', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/providers/trigger-check-core.ts'), 'utf8');
    const union = /kind: 'quiet'; reason: ([^}]+)\}/.exec(src)?.[1] ?? '';
    const reasons = [...union.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
    expect(reasons.length).toBeGreaterThan(0);
    for (const r of reasons) expect(DECISIONS as readonly string[], `quiet reason "${r}" has a case`).toContain(r);
  });
});

describe('a line about a seen item leaves the input, by its id or its title', () => {
  // The shape of the 2026-11-16 fire, in invented names: the script lists every event it saw this
  // run as "[event] <short id> <title> ...", one new change and three standing clears it had
  // reported days before (seen items).
  const newChange = { id: 'change|web-app|build|linux|5d8173204c', title: '[change] web-app nightly build on linux failed: unit tests, lint step' };
  const clears = [
    { id: 'clear|docs-site|link-check|main|cffb664e95@2026-11-10T20:08:13+00:00', title: '[clear] docs-site link check on main: 3 broken links in the guide' },
    { id: 'clear|mobile|build|ios|bd2e267f8d@2026-10-21T14:17:30+00:00', title: '[clear] mobile nightly build on ios failed: signing step timed out' },
    { id: 'clear|mobile|build|android|f120cfd924@2026-10-28T01:29:17+00:00', title: '[clear] mobile nightly build on android failed: emulator did not boot' },
  ];
  const input = [
    'Owner this week: someone; ask them first',
    '[change] 7278c1 web-app nightly build on linux failed: unit tests, lint step | since 11-15 17:42',
    '[clear] 201921 docs-site link check on main: 3 broken links in the guide',
    '[clear] 22b719 mobile nightly build on ios failed: signing step timed out',
    '  last note: waiting on the owner',
    '[clear] 0babf2 mobile nightly build on android failed: emulator did not boot',
    'Detail: track.py show <id>',
  ].join('\n');

  it('the fire for one new change carries its line and the script\'s own words, none of the three old clears', () => {
    const state = emptyHostState(NOW);
    for (const c of clears) state.seen[c.id] = NOW - 5 * DAY;
    const { decision, fire } = run(state, { fire: true, items: [newChange, ...clears], input }, NOW);
    expect(decision).toMatchObject({ kind: 'fire' });
    expect(fire?.items.map((i) => i.id)).toEqual([newChange.id]);
    expect(fire?.input).toBe([
      'Owner this week: someone; ask them first',
      '[change] 7278c1 web-app nightly build on linux failed: unit tests, lint step | since 11-15 17:42',
      'Detail: track.py show <id>',
    ].join('\n'));
  });

  it('a line naming a new item stays even when it also holds an old item\'s title', () => {
    const old = { id: 'open|x|1', title: '[open] web-app nightly build on linux failed' };
    const fresh = { id: 'open|x|2', title: '[open] web-app nightly build on linux failed again: lint' };
    const text = '[open] aa11 web-app nightly build on linux failed again: lint';
    expect(inputForNewItems(text, [fresh], [old])).toBe(text);
    // The same title on a new and an old item: the line is the new one's.
    expect(inputForNewItems('[open] 1 ' + old.title.slice(7), [{ ...fresh, title: old.title }], [old])).toBe('[open] 1 ' + old.title.slice(7));
  });

  it('a short title is no proof a line is about it; an item with no title is matched by id only', () => {
    const short = { id: 'k1', title: '[ok] build ok' };
    expect('build ok'.length).toBeLessThan(SEEN_TITLE_MATCH_MIN);
    expect(inputForNewItems('main: build ok\nnew-one ready', [{ id: 'new-one' }], [short])).toBe('main: build ok\nnew-one ready');
    expect(inputForNewItems('a line about something else entirely', [{ id: 'n' }], [{ id: 'old-item-1' }])).toBe('a line about something else entirely');
    // A title that is not a string is ignored, not thrown on.
    expect(inputForNewItems('x', [{ id: 'n' }], [{ id: 'old-item-2', title: 42 as unknown as string }])).toBe('x');
  });

  it('a title with no tag matches too, and only whole: a line holding part of it stays', () => {
    const old = { id: 'o-1', title: 'Nightly backup of the photo library finished' };
    expect(inputForNewItems(`${old.title} at 03:00\nnew: n-1`, [{ id: 'n-1' }], [old])).toBe('new: n-1');
    expect(inputForNewItems('Nightly backup of the photo library started', [{ id: 'n-1' }], [old])).toBe('Nightly backup of the photo library started');
  });
});
