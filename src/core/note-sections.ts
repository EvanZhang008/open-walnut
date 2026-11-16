/**
 * The task NOTE's canonical sections and their parser: pure, so a reader (task_get's deliverable
 * line, the progress view, the stale-note check) needs no part of the session hooks.
 */

/** The six canonical NOTE sections, in render order. The NOTE is the task's single
 *  living document (design session 2026-07-18, replaces the summary+milestones pair):
 *  Executive Summary = for the human scanning; User Request = concise restatement of
 *  the user's request (intent, NOT a verbatim quote) + acceptance criteria (search
 *  entry point; rewritten on pivot with a "(pivoted from: …)" trace); Context =
 *  self-contained background, frozen once right; Progress = bulleted per-workitem lines
 *  with a bracketed status label ([DONE]/[WIP]/[TODO]/[BLOCKED]/[WAIT]); References =
 *  curated markdown-link list of every external artifact (ticket/issue/incident ids,
 *  PRs, docs) with its id AND title as plain text — the "find this task by that id"
 *  surface (added 2026-08-20, user request; OPTIONAL — old five-section notes keep
 *  parsing and the section renders only when present); Work Log = append-only
 *  did/found/result entries carrying every external ID and decision (never commit
 *  hashes, no timestamps).
 *  Renamed 2026-07-22: "Goal" → "User Request" (user feedback). Old notes with a
 *  "## Goal" header keep parsing (normalized to User Request on the next assemble). */
export const NOTE_SECTIONS = [
  'Executive Summary', 'User Request', 'Context', 'Progress', 'References', 'Work Log',
] as const;
export type NoteSection = (typeof NOTE_SECTIONS)[number];

/** Split an existing NOTE into its canonical sections. Content before the
 *  first known "## <Section>" header (or a note with no headers at all — the
 *  pre-migration free-form case) is returned under `preamble`. Exported for tests. */
export function parseNoteSections(note: string): { sections: Partial<Record<NoteSection, string>>; preamble: string } {
  const sections: Partial<Record<NoteSection, string>> = {};
  // Header must be recognized at end-of-string too (`(?:\n|$)`): a note ending with
  // an empty section (`…\n## Work Log` after trim) otherwise leaves that header text
  // inside the previous section's body, and the next assemble fabricates a SECOND
  // `## Work Log` header — corruption that compounds on every fire.
  // "Goal" is the pre-2026-07-22 name of "User Request" — old notes keep parsing
  // and are silently normalized to the new header on the next assemble.
  const headerRe = /(?:^|\n)##\s+(Executive Summary|User Request|Goal|Context|Progress|References|Work Log)[^\S\n]*(?:\n|$)/g;
  const hits: { name: NoteSection; start: number; bodyStart: number }[] = [];
  for (let m = headerRe.exec(note); m; m = headerRe.exec(note)) {
    const name = (m[1] === 'Goal' ? 'User Request' : m[1]) as NoteSection;
    hits.push({ name, start: m.index, bodyStart: m.index + m[0].length });
  }
  const preamble = note.slice(0, hits.length ? hits[0].start : note.length).trim();
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].start : note.length;
    const body = note.slice(hits[i].bodyStart, end).trim();
    // Duplicate headers (e.g. produced by the pre-fix EOF bug above): merge bodies
    // instead of last-wins, so the earlier section's content is never dropped.
    const prev = sections[hits[i].name];
    sections[hits[i].name] = prev && body ? `${prev}\n${body}` : (prev || body);
  }
  return { sections, preamble };
}
