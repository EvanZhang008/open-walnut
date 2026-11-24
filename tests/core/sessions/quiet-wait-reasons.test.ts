/**
 * The class rule (2026-11-24, the user: never a message lost, and its sender always told): a quiet
 * note that waits past its max hold either goes by itself soon or tells its sender it is not
 * delivered yet. Two notes waited 6 h and 16 h for stopped sessions and their senders never heard.
 *
 * src/core/sessions/held-notices-sweep.ts: every reason the quiet lap leaves a note waiting is a
 * QUIET_WAITS entry (the 'wait' verdict, the refusals of a normal turn and a delivery that fails
 * name one, and op_result's why is only ever read from it). This pins each reason's class here, so
 * a new reason fails until it says whether its sender is told after the max hold, why it clears by
 * itself, or why there is nobody further to tell.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { QUIET_WAITS } from '../../../src/core/sessions/held-notices-sweep.js';

const SRC = fs.readFileSync(path.resolve(__dirname, '../../../src/core/sessions/held-notices-sweep.ts'), 'utf8');

/** Each reason: its sender is told after this many max holds, or it clears by itself (and why). */
const CLASS: Record<string, { tellsAfter: number } | { clears: string } | { noOneToTell: string }> = {
  // A turn ends on its own (the first lap after it delivers); one of hours, or a status left reading
  // running, is told after three max holds.
  running: { tellsAfter: 3 },
  // Only Walnut's tells wait there: they are the telling; each note's op_result shows where they wait.
  tellNoQuietTurn: { noOneToTell: 'what waits is Walnut\'s notice to a sender; op_result sender_told shows it' },
  // Retried every lap, never given up.
  failing: { tellsAfter: 1 },
  // A switch or a move ends in minutes; one that lasts another max hold is told.
  switching: { tellsAfter: 2 },
  stopped: { tellsAfter: 1 },
  orgOff: { tellsAfter: 1 },
  router: { tellsAfter: 1 },
  needAction: { tellsAfter: 1 },
  snoozed: { tellsAfter: 1 },
};

describe('every reason a quiet note waits past its max hold tells its sender, or clears by itself', () => {
  it('each reason is classified here, and its class is what the lap does', () => {
    expect(Object.keys(QUIET_WAITS).sort()).toEqual(Object.keys(CLASS).sort());
    for (const [kind, w] of Object.entries(QUIET_WAITS) as Array<[string, { tellAfter: number | null; cause: string }]>) {
      const c = CLASS[kind];
      if ('clears' in c) expect(w.tellAfter, `${kind} clears by itself: ${c.clears}`).toBeNull();
      else if ('noOneToTell' in c) expect(w.tellAfter, `${kind}: ${c.noOneToTell}`).toBeNull();
      else expect(w.tellAfter, `${kind}: its sender is told`).toBe(c.tellsAfter);
      expect(w.cause.length, `${kind} says what holds the note`).toBeGreaterThan(10);
    }
  });

  it('every wait the lap builds names a QUIET_WAITS reason, never words of its own', () => {
    const waits = [...SRC.matchAll(/act: 'wait'(.{0,40})/g)].map((m) => m[1]);
    // The type's own line and every construction site.
    const built = waits.filter((rest) => !rest.startsWith(';'));
    expect(built.length).toBeGreaterThan(0);
    for (const rest of built) {
      const kind = rest.match(/^, wait: '(\w+)'/)?.[1];
      expect(kind, `a 'wait' verdict names its reason: act: 'wait'${rest}`).toBeTruthy();
      expect(Object.keys(QUIET_WAITS)).toContain(kind);
    }
    // The held-for-user refusal names one too.
    for (const m of SRC.matchAll(/heldForUser = (.+);/g)) {
      for (const k of m[1].matchAll(/'(\w+)' as const/g)) expect(Object.keys(QUIET_WAITS)).toContain(k[1]);
    }
    // Every waitOn names a reason: a literal one, or a verdict's.
    const calls = [...SRC.matchAll(/waitOn\(sid, ([^,]+),/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(2);
    for (const arg of calls) {
      const lit = arg.match(/^'(\w+)'$/)?.[1];
      if (lit) expect(Object.keys(QUIET_WAITS)).toContain(lit);
      else expect(['v.wait', 'holdFor'], `waitOn(sid, ${arg}, ...)`).toContain(arg);
    }
    for (const m of SRC.matchAll(/const holdFor: QuietWaitKind \| undefined = (.+);/g)) {
      for (const k of m[1].matchAll(/'(\w+)'/g)) expect(Object.keys(QUIET_WAITS)).toContain(k[1]);
    }
    // A look or a delivery that throws waits too: its catch names the failing reason.
    const lap = SRC.slice(SRC.indexOf('export async function deliverDueQuietNotes'));
    expect(lap).toMatch(/catch \(err\) \{[\s\S]{0,400}waitOn\(sid, 'failing'/);
    // op_result's why is set only through waitOn (which tells) or cleared.
    for (const m of SRC.matchAll(/setQuietWaitWhy\(sid, ([^)]+\)?)\)/g)) expect(['null', 'waitWhy(kind)']).toContain(m[1]);
  });
});
