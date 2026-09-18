/**
 * Property + fuzz coverage for the collapsed folder tail (C13).
 *
 * The checklist asked for an invariant that cannot hold as written: "no hidden row received mail this
 * session" contradicts the promotion cap of three (C56), and the cap is the P0. A fourth arrival in one
 * session HAS to stay hidden, or 58 labels can walk back into the pane one tick at a time. So the
 * invariant is stated the only way it can be true, and this is the corrected form:
 *
 *   1. NOTHING IS LOST OR DOUBLED. Every ordinary label appears exactly once across `promoted` and
 *      `hidden`, and every role row appears in `shown`, whatever the reasons say.
 *   2. THE CAP IS THE ONLY REASON A NEW ARRIVAL STAYS HIDDEN. A hidden row with `added > 0` implies
 *      `promoted.length === PROMOTED_CAP`, so the pane is never quietly sitting on new mail while it has
 *      room to show it.
 *   3. THE COLLAPSE ROW DESCRIBES ITS OWN HIDDEN SET. Both numbers it renders (the unread mail behind it
 *      and, in its hover text, how many folders hold that mail) are recomputed here from the hidden set
 *      itself, so the row cannot drift from what it stands over.
 *   4. SERVER ORDER SURVIVES. Promotion never reorders: the three that are lifted are the first three
 *      wanted rows in the server's order, and expanding is one list with no promotion block in it.
 *
 * Seeds are printed in every failure message, so a red run is replayable. No dependency: mulberry32,
 * the same generator the other property tests in this repository use.
 */
import { describe, expect, it } from 'vitest';
import type { MailboxDto } from '../../web/src/api/mail';
import { PROMOTED_CAP, hiddenTail, importantFolders } from '../../web/src/apps/mail/mail-smart';
import { pairKey } from '../../web/src/apps/mail/mail-store';

/** Deterministic PRNG (mulberry32): no dependency, replayable from the seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ACCOUNT = 'dense:harbour';
const ROLES: MailboxDto['role'][] = ['inbox', 'archive', 'drafts', 'sent', 'spam', 'trash'];

interface Shape {
  rows: MailboxDto[];
  labels: MailboxDto[];
  arrivals: Record<string, number>;
  selectedMailboxId: string | null;
  recent: string[];
}

/**
 * One account's folder list, at a random density around the measured one (64 folders, 58 of them labels).
 *
 * Arrivals, selection and the recent list are drawn INDEPENDENTLY of each other and of unread, because
 * the three reasons to lift a row overlap in production: the row you just opened is often the row that
 * just received mail.
 */
function shapeOf(rng: () => number): Shape {
  const labelCount = Math.floor(rng() * 70);
  const rows: MailboxDto[] = ROLES
    .filter(() => rng() > 0.15)
    .map((role) => ({
      accountId: ACCOUNT, mailboxId: `role-${role}`, name: role, role, unread: Math.floor(rng() * 9), total: 0,
    }));
  const labels: MailboxDto[] = [];
  for (let index = 0; index < labelCount; index += 1) {
    labels.push({
      accountId: ACCOUNT,
      mailboxId: `label-${String(index).padStart(2, '0')}`,
      name: `Label ${index}`,
      role: 'other',
      // Heavy tails and zeros both matter: six of the real account's labels hold 2 to 55 stale unread.
      unread: rng() > 0.7 ? Math.floor(rng() * 60) : 0,
      total: Math.floor(rng() * 400),
    });
  }
  const all = [...rows, ...labels];
  const arrivals: Record<string, number> = {};
  for (const row of labels) {
    if (rng() > 0.85) arrivals[pairKey(ACCOUNT, row.mailboxId)] = 1 + Math.floor(rng() * 4);
  }
  const recent = labels.filter(() => rng() > 0.9).map((one) => one.mailboxId).slice(0, 5);
  const pick = rng();
  const selectedMailboxId = pick > 0.6 && all.length > 0
    ? all[Math.floor(rng() * all.length)]!.mailboxId
    : null;
  return { rows: all, labels, arrivals, selectedMailboxId, recent };
}

function ids(rows: MailboxDto[]): string[] {
  return rows.map((one) => one.mailboxId);
}

describe('the collapsed tail, over 600 random folder lists (C13)', () => {
  it('loses nothing, doubles nothing, and keeps the server order in every part', () => {
    for (let seed = 1; seed <= 600; seed += 1) {
      const rng = mulberry32(seed);
      const shape = shapeOf(rng);
      const where = `seed ${seed}`;
      const out = importantFolders({ [ACCOUNT]: shape.rows }, ACCOUNT, {
        arrivals: shape.arrivals,
        selectedMailboxId: shape.selectedMailboxId,
        recent: shape.recent,
      });
      // Every ordinary label exactly once, and no role row anywhere near the tail.
      expect([...ids(out.promoted), ...ids(out.hidden)].sort(), where)
        .toEqual(ids(shape.labels).sort());
      expect(ids(out.shown), where).toEqual(ids(shape.rows.filter((one) => one.role !== 'other')));
      expect(new Set([...ids(out.promoted), ...ids(out.hidden)]).size, where)
        .toBe(shape.labels.length);
      // Server order inside each part: a promotion may not reshuffle the list.
      const order = new Map(ids(shape.labels).map((id, at) => [id, at]));
      for (const part of [out.promoted, out.hidden]) {
        const places = ids(part).map((id) => order.get(id)!);
        expect(places, `${where}: server order`).toEqual([...places].sort((x, y) => x - y));
      }
    }
  });

  it('hides a folder that received mail ONLY when the cap is already full', () => {
    for (let seed = 1; seed <= 600; seed += 1) {
      const rng = mulberry32(seed + 10_000);
      const shape = shapeOf(rng);
      const where = `seed ${seed + 10_000}`;
      const out = importantFolders({ [ACCOUNT]: shape.rows }, ACCOUNT, {
        arrivals: shape.arrivals,
        selectedMailboxId: shape.selectedMailboxId,
        recent: shape.recent,
      });
      expect(out.promoted.length, `${where}: the cap`).toBeLessThanOrEqual(PROMOTED_CAP);
      const hiddenWithMail = out.hidden.filter(
        (one) => (shape.arrivals[pairKey(ACCOUNT, one.mailboxId)] ?? 0) > 0,
      );
      if (hiddenWithMail.length > 0) {
        expect(out.promoted.length, `${where}: only the cap may hide new mail`).toBe(PROMOTED_CAP);
      }
      // The selected row can never be hidden by its own collapse row.
      if (shape.selectedMailboxId && out.promoted.length < PROMOTED_CAP) {
        expect(ids(out.hidden), `${where}: the selection stays visible`)
          .not.toContain(shape.selectedMailboxId);
      }
    }
  });

  it('describes its own hidden set: the unread it prints and the folders in its hover text', () => {
    for (let seed = 1; seed <= 600; seed += 1) {
      const rng = mulberry32(seed + 20_000);
      const shape = shapeOf(rng);
      const where = `seed ${seed + 20_000}`;
      const out = importantFolders({ [ACCOUNT]: shape.rows }, ACCOUNT, {
        arrivals: shape.arrivals,
        selectedMailboxId: shape.selectedMailboxId,
        recent: shape.recent,
      });
      const behind = hiddenTail(ACCOUNT, out.hidden, {});
      const byHand = out.hidden.reduce(
        (acc, one) => ({
          folders: acc.folders + (one.unread > 0 ? 1 : 0),
          unread: acc.unread + Math.max(0, one.unread),
        }),
        { folders: 0, unread: 0 },
      );
      expect(behind, `${where}: the clause matches the hidden set`).toEqual(byHand);
      // And an unread mail that is on screen is never counted as hidden.
      const shownUnread = [...out.shown, ...out.promoted].reduce((sum, one) => sum + one.unread, 0);
      const allUnread = shape.rows.reduce((sum, one) => sum + one.unread, 0);
      expect(shownUnread + behind.unread, `${where}: every unread mail is on one side`).toBe(allUnread);
    }
  });

  it('expands to ONE list with no promotion block and no holes, over the same 600 shapes', () => {
    for (let seed = 1; seed <= 600; seed += 1) {
      const rng = mulberry32(seed + 30_000);
      const shape = shapeOf(rng);
      const where = `seed ${seed + 30_000}`;
      const out = importantFolders({ [ACCOUNT]: shape.rows }, ACCOUNT, {
        arrivals: shape.arrivals,
        selectedMailboxId: shape.selectedMailboxId,
        recent: shape.recent,
        expanded: true,
      });
      expect(out.promoted, where).toEqual([]);
      expect(ids(out.hidden), where).toEqual(ids(shape.labels));
    }
  });
});
