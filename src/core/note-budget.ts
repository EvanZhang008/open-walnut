/**
 * The task NOTE's size budget: the cap past which a turn-end fire must reorganize the
 * note, the shrink guard that keeps a rewrite from dropping facts, the section sizes
 * the reorganize prompt shows, and the per-task record of reorganize fires that did
 * not shrink. Pure apart from that in-memory record, so tests need no session hooks.
 */
import { NOTE_SECTIONS, parseNoteSections } from './note-sections.js';

/** Past this NOTE length the fire becomes a MANDATORY REORGANIZE pass: the session
 *  must merge the oldest Work Log entries and bring the note back under the cap
 *  (preserving every ID and decision). MANDATORY, not advisory: a day of prod data
 *  (2026-07-18) showed the earlier "you may consolidate" wording NEVER produced a net
 *  shrink — notes grew monotonically to 12.5k+. Do not soften the prompt wording back.
 *  6000 ≈ a screenful of dense context; it also bounds the per-fire prompt cost since
 *  the full note is re-fed on every fire. */
export const NOTE_REORG_CAP = 6000; // chars

/** The sections the shrink guard protects (Work Log is history the reorganize merges). */
export const SHRINK_PROTECTED_SECTIONS = ['Executive Summary', 'User Request', 'Context', 'Progress', 'References'] as const;

/** On a reorganize fire a protected section's floor follows the shrink the prompt asked
 *  for: 40% of its share of the cap (its old size × cap / old note size), kept between
 *  REORG_SECTION_FLOOR and REORG_SECTION_CEILING and never above the ordinary 40% of
 *  its old size. 2026-11-19: a legacy note whose extra "## " headings all parsed into
 *  Progress (115k chars) was reorganized to 6k on every fire, and the ordinary floor
 *  (40% = 46k) rejected each one, so the note never changed again. The ceiling leaves
 *  room for a reorganize that moves facts between sections; a note just over the cap
 *  keeps nearly the ordinary floor. */
export const REORG_SECTION_FLOOR = 600; // chars
export const REORG_SECTION_CEILING = 1200; // chars

/** The smallest body a protected section may come back with. */
export function sectionFloor(oldBodyLen: number, oldNoteLen: number, section: string): number {
  const ordinary = oldBodyLen * 0.4;
  if (oldNoteLen <= NOTE_REORG_CAP) return ordinary;
  // References is a curated index the reorganize prompt orders deduped: only "not emptied".
  if (section === 'References') return 0;
  const share = oldBodyLen * (NOTE_REORG_CAP / oldNoteLen);
  const scaled = Math.min(REORG_SECTION_CEILING, Math.max(REORG_SECTION_FLOOR, share * 0.4));
  return Math.min(ordinary, scaled);
}

/** Shrink guard: a new note dramatically shorter than the old one means the session
 *  dropped facts (the assembler never shrinks on its own — only rewrites can).
 *
 *  COUPLING INVARIANT (do not "tighten" a ratio without re-deriving this): a
 *  MANDATORY REORGANIZE (old > NOTE_REORG_CAP) is INSTRUCTED to land under
 *  NOTE_REORG_CAP, so any floor proportional to a big old note rejects exactly the
 *  compliant reorganize — deadlock: the note can never shrink, every fire re-runs a
 *  doomed reorganize. Reorganize fires therefore judge against the cap: cap × 0.4 for
 *  the whole note, sectionFloor for a section. */
export function noteShrinkRejected(oldNote: string, newNote: string): boolean {
  const oldSections = parseNoteSections(oldNote).sections;
  const newSections = parseNoteSections(newNote).sections;
  const reorg = oldNote.length > NOTE_REORG_CAP;
  // References joins the protected set once present: it is the external-ID index,
  // exactly the content the reorganize prompt orders preserved. (Absent from old
  // notes → empty oldBody → no checks; the section stays optional.)
  // Deletion is judged on BODY, not header presence: a section whose body was
  // already empty loses nothing when its header disappears — and the assembler
  // renders no header for an empty body, so a presence check would reject every
  // subsequent fire on such a note (permanent freeze).
  for (const section of SHRINK_PROTECTED_SECTIONS) {
    const oldBody = oldSections[section]?.trim() ?? '';
    const newBody = newSections[section]?.trim() ?? '';
    if (oldBody && !newBody) return true;
    if (oldBody.length >= 100 && newBody.length < sectionFloor(oldBody.length, oldNote.length, section)) return true;
  }

  if (oldNote.length < 1500) return false; // small unstructured notes rewrite freely
  if (reorg) return newNote.length < NOTE_REORG_CAP * 0.4;
  return newNote.length < oldNote.length * 0.4;
}

/** Every non-empty part of the note with its length, largest first, for the reorganize
 *  prompt: "User Request 2349, References 2081, …". 2026-11-19 prod data: the bulk of an
 *  over-cap note was usually OUTSIDE the Work Log the prompt pointed at (a 10k note
 *  held a 1.9k Work Log), and about half of all reorganize fires came back longer. */
export function noteSectionSizes(note: string): string {
  const { sections, preamble } = parseNoteSections(note);
  const rows: [string, number][] = NOTE_SECTIONS
    .map((s): [string, number] => [s, sections[s]?.trim().length ?? 0])
    .filter(([, n]) => n > 0);
  if (preamble) rows.push(['text above the first section', preamble.length]);
  return rows.sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`).join(', ');
}

/** One reorganize fire that comes back longer is ordinary (the turn's own entry, a
 *  rewrite that drifts; about half of them on 2026-11-19 prod data); a task whose note
 *  is longer after this many reorganize misses IN A ROW than before the first of them
 *  has a reorganize that is not working for it, and that is what gets a warn. */
export const REORG_MISS_STREAK = 3;

const reorgMisses = new Map<string, { run: number; startLen: number }>();

/** How a reorganize fire went: `shrank` (the note that is kept is shorter), `missed`
 *  (not, but no warn), or `stuck` (REORG_MISS_STREAK misses in a row, or a multiple,
 *  with the note longer than before the run began). A fire whose note the shrink guard
 *  rejected counts as a miss: the note stayed as it was. In memory: a restart starts
 *  every task's run over. */
export function recordReorgOutcome(taskId: string, oldLen: number, keptLen: number): { verdict: 'shrank' | 'missed' | 'stuck'; misses: number; startLen: number } {
  const prev = reorgMisses.get(taskId);
  reorgMisses.delete(taskId); // re-insert keeps the map in last-touched order
  if (keptLen < oldLen) return { verdict: 'shrank', misses: 0, startLen: oldLen };
  const cur = { run: (prev?.run ?? 0) + 1, startLen: prev?.startLen ?? oldLen };
  reorgMisses.set(taskId, cur);
  if (reorgMisses.size > 1000) reorgMisses.delete(reorgMisses.keys().next().value as string);
  const stuck = cur.run % REORG_MISS_STREAK === 0 && keptLen > cur.startLen;
  return { verdict: stuck ? 'stuck' : 'missed', misses: cur.run, startLen: cur.startLen };
}

/** Test seam. */
export function __resetReorgMisses(): void { reorgMisses.clear(); }
