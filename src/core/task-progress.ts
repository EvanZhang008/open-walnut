/**
 * The task note's Progress section, read as data.
 *
 * A note is one living document whose Work Log grows to thousands of characters,
 * while triage only ever wants the status board: "which workitems are done, which
 * are still moving, what is blocked". Pulling the whole note to answer that costs
 * multiple KB per task, so this module extracts JUST the Progress bullets.
 *
 * The section format is the contract the session self-report writes (PROGRESS in
 * session-hooks/builtins.ts): one bullet per workitem, `- [STATUS] <workitem>`,
 * with STATUS one of DONE / WIP / TODO / BLOCKED / WAIT.
 */

import { parseNoteSections } from './session-hooks/builtins.js';

/** The bracketed labels the Progress contract allows, normalized to upper case. */
export const PROGRESS_STATUSES = ['DONE', 'WIP', 'WAIT', 'TODO', 'BLOCKED'] as const;
export type ProgressStatus = (typeof PROGRESS_STATUSES)[number];

export interface ProgressLine {
  status: ProgressStatus;
  /** The bullet text with the bullet marker and the [STATUS] label removed. */
  text: string;
}

// A bullet ('-', '*', '+' or '1.') is optional: notes written by hand sometimes
// drop it, and a line that carries a leading [STATUS] label is unambiguously a
// status line either way. Bold/italic wrappers around the label are tolerated
// because markdown-happy sessions emit `- **[WIP]** …`.
const PROGRESS_LINE_RE = new RegExp(
  `^\\s*(?:[-*+]|\\d+[.)])?\\s*[*_]{0,2}\\[\\s*(${PROGRESS_STATUSES.join('|')})\\s*\\][*_]{0,2}\\s*:?\\s*(.*)$`,
  'i',
);

/**
 * The Progress bullets of a note, in note order. Returns [] when the note has no
 * Progress section or the section carries no status line — an empty list means
 * "nothing to show", never "the note was not parsed".
 */
export function extractProgressLines(note: string | undefined | null): ProgressLine[] {
  if (!note) return [];
  const body = parseNoteSections(note).sections.Progress;
  if (!body) return [];

  const lines: ProgressLine[] = [];
  for (const raw of body.split('\n')) {
    const match = PROGRESS_LINE_RE.exec(raw);
    if (!match) continue;
    // Sub-bullets of a status line (continuation detail) carry no label of their
    // own and are skipped by the regex, which is what keeps this a status board.
    const status = match[1].toUpperCase() as ProgressStatus;
    const text = match[2].trim().replace(/^[—–:-]\s*/, '');
    lines.push({ status, text });
  }
  return lines;
}

/** How many bullets sit in each status, for a one-glance progress ratio. */
export function summarizeProgress(lines: readonly ProgressLine[]): Record<ProgressStatus, number> {
  const counts = Object.fromEntries(PROGRESS_STATUSES.map((s) => [s, 0])) as Record<ProgressStatus, number>;
  for (const line of lines) counts[line.status] += 1;
  return counts;
}
