/**
 * Project tracking note — the path rule and the skeleton, as pure functions.
 *
 * ONE note per project, at a path the SERVER derives: `Projects/<folded
 * name>/Tracking.md`, vault-relative (the vault root is NOTES_DIR, so on disk
 * that is `notes/Projects/<folded name>/Tracking.md`). The authority on where a
 * project's note lives is `task_projects.metadata.tracking_note`, not this
 * function — this function only decides where a note that does not exist yet
 * SHOULD go, so that a model never has to guess a path and mint a second note
 * beside the real one.
 *
 * Pure on purpose: the path rule is the part that has to be graded against a
 * table of hostile names (tests/core/tracking-note.test.ts), and a pure module
 * can be imported by the ops layer, the web layer and a test alike.
 */

import yaml from 'js-yaml';

/** Vault folder every project's tracking note lives under. */
export const TRACKING_NOTE_DIR = 'Projects';

/** The note's filename. Specific enough that a user's own note rarely collides;
 *  when one does, the ensure path ADOPTS it instead of overwriting. */
export const TRACKING_NOTE_FILENAME = 'Tracking.md';

/** Frontmatter `kind` — what marks a note as a tracking note. */
export const TRACKING_NOTE_KIND = 'project-tracking';

/**
 * The anchor an agent appends a `## Log` line under: `note_edit` with
 * `old_str: TRACKING_LOG_ANCHOR`, `new_str: TRACKING_LOG_ANCHOR + '- …\n'`.
 *
 * This is the ONE edit that is safe without a prior `note_read`: prepending
 * directly under a fixed heading cannot lose another writer's lines, because the
 * anchor text is still there after they wrote. Editing the Workstreams table is
 * the opposite — it anchors on a row a concurrent writer may have changed — so
 * that edit MUST carry the `contentHash` from a prior `note_read` and lose the
 * race with a conflict rather than clobbering.
 */
export const TRACKING_LOG_ANCHOR = '## Log\n';

/** Space is the first printable char; everything below it is a C0 control. */
const FIRST_PRINTABLE_CHAR = 0x20;
const DEL_CHAR = 0x7f;

/**
 * Fold a project name into a usable path segment.
 *
 * RESTATED from `projectSafeName` in src/core/sessions/ask-agent.ts:50 — the two
 * must agree, so change them together. It is restated rather than imported
 * because ask-agent.ts is the session/ask layer (it pulls in the agent registry
 * and the whole ask-project rule) and this module is pure.
 *
 * Note what the fold does NOT handle: a name that starts with `.` or is nothing
 * but dots. `askProjectFor` is exempt because it prefixes "Ask ", which already
 * rules out the hidden-directory case; a tracking note has no such prefix, so
 * `isUsableSegment` below refuses those names outright. `assertValidProjectName`
 * (task-manager) refuses them at the registry gate too, so any name that reaches
 * here in that shape was invented by a caller, never registered by the user.
 */
function projectSafeName(raw: string): string {
  return raw
    .replace(/[/\\\0]/g, '-')
    .replace(/\.{2,}/g, '.')
    .trim()
    .slice(0, 60)
    .trim();
}

/**
 * Is the folded name usable as ONE vault directory segment?
 *
 * Refused (each returns "no note", never a guessed path): empty; all-dots or
 * leading-dot (a hidden directory, and `.`/`..` would collapse the path so two
 * different projects would share one note); and control characters, because a
 * newline inside a path segment breaks every tree, listing and log line that
 * carries it.
 *
 * Char codes rather than a character class: a control-character range in a
 * regex literal is exactly what `no-control-regex` exists to flag.
 */
function isUsableSegment(folded: string): boolean {
  if (!folded) return false;
  if (folded.startsWith('.')) return false;
  for (const ch of folded) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < FIRST_PRINTABLE_CHAR || code === DEL_CHAR) return false;
  }
  return true;
}

/**
 * Where `project`'s tracking note belongs, vault-relative and WITH `.md` (the
 * same convention `config.favorites.notes` uses).
 *
 * `null` means "this name has no tracking note": the caller must SKIP the
 * project, never invent a path. Inbox ('' — the absence of a project) is one of
 * those: it has no registry row, so it can hold no metadata key either.
 */
export function trackingNotePathFor(project: string): string | null {
  const folded = projectSafeName(project ?? '');
  if (!isUsableSegment(folded)) return null;
  return `${TRACKING_NOTE_DIR}/${folded}/${TRACKING_NOTE_FILENAME}`;
}

/**
 * The frontmatter `updated` stamp: UTC, minute precision (`2026-09-21T14:10Z`).
 *
 * Minute precision because this field is read by humans and by the triage
 * runner's soft check ("did the last run update its state?"), never diffed for
 * ordering. Accepts any parseable date string and normalizes it to UTC, so a
 * caller passing a local-offset ISO string cannot stamp two notes on two clocks.
 */
export function trackingStamp(nowIso: string): string {
  const at = new Date(nowIso);
  if (Number.isNaN(at.getTime())) throw new Error(`trackingStamp: not a date: ${nowIso}`);
  return `${at.toISOString().slice(0, 16)}Z`;
}

/**
 * The tracking note a project starts life with.
 *
 * A FRESH note asserts NOTHING about the project: empty sections and a
 * Workstreams table with only its header row. The formats live in HTML comments,
 * one under each heading, so the agent still sees the shape of a row (an
 * `[[task:<id>]]` owner, a source that names where the update came from) while
 * the vault states no workstream, question or log entry that is not real. Example
 * rows used to be written as CONTENT; a human opening a project they had never
 * tracked would read "Design review | in progress" about work that does not
 * exist, which is exactly the confident-wrong-answer failure.
 *
 * The formats are `<placeholder>` TEMPLATES, not plausible sample rows, for a
 * second reason: a sample row's text is the text an agent later writes for real,
 * so its first `note_edit` on that row matched TWICE (once in the comment) and
 * failed with "old_str appears 2 times". A template shares no text with real
 * content, so a row anchor stays unique. Found by
 * tests/integration/tracking-note-ops.test.ts.
 *
 * `[[task:…]]` inside a real row is an Obsidian-shaped link the notes indexer
 * will list as unresolved; that is deliberate, it keeps the vault's own
 * affordance, and Walnut's note renderer shows it as plain text.
 *
 * The comments are invisible in both readers of these bytes: Obsidian hides them,
 * and `renderNoteMarkdown` (web/src/utils/markdown.ts) drops a comment-only HTML
 * token rather than escaping it — the pane and the vault must not disagree about
 * what a fresh note says.
 *
 * `project` is emitted through the YAML dumper, not interpolated: a project name
 * may legally contain `:` or `#`, and a frontmatter block whose YAML does not
 * parse loses its `id`, which makes the server stamp a NEW id on every write.
 */
export function TRACKING_SKELETON(project: string, nowIso: string): string {
  const projectLine = yaml.dump({ project }, { lineWidth: -1 }).trimEnd();
  return `---
${projectLine}
kind: ${TRACKING_NOTE_KIND}
updated: ${trackingStamp(nowIso)}
---

## Status

<!-- one sentence on where this stands, then the next milestone -->

## Workstreams

| Item | State | Owner task | Last update | Source |
| --- | --- | --- | --- | --- |
<!-- row format: | <workstream> | <in progress / blocked / done> | [[task:<id>]] | <Mon D> | <mail / slack>: <what changed> | -->

## Open questions

<!-- format: - <the question>? (raised in <where>, <Mon D>, <who owes an answer>) -->

## Log

<!-- format: - <YYYY-MM-DD HH:MM> triage: <what arrived>; <what you did about it> -->
`;
}
