/**
 * Built-in session hooks.
 *
 * These are the default hooks that ship with Walnut.
 * They can be overridden or disabled via config.
 */

import fs from 'node:fs';
import path from 'node:path';
import { bus } from '../event-bus.js';
import { log } from '../../logging/index.js';
import type {
  SessionHookDefinition,
  OnTurnCompletePayload,
  OnTurnErrorPayload,
  OnMessageSendPayload,
  OnToolUsePayload,
} from './types.js';

// ── Triage dedup state ──
// Prevents burst triage dispatches when daemon replays old JSONL events after
// server restart (same session:result emitted N times in milliseconds).
// Key: "sessionId:taskId", Value: last dispatch timestamp.
const triageLastDispatch = new Map<string, number>();
const TRIAGE_COOLDOWN_MS = 5_000; // 5 seconds — normal triage cycle takes 10-30s

// ── Summary trailing-debounce state ──
// Asking the session for a self-report on EVERY turn during an interactive
// back-and-forth is pointless churn. Instead we trailing-debounce: each
// turn-complete (re)arms a per-session timer; a user message cancels it (interaction
// is ongoing). The summary work fires ONCE only after the session has been quiet for
// the configured window — which is also the best available approximation of "the
// session finished" on a long-running CLI (the only real end-signal is the 2h idle
// reap). Key: sessionId, Value: pending timer. The map self-bounds: every armed
// timer either fires (and self-deletes) or is cancelled (and deletes).
const triageDebounceTimers = new Map<string, NodeJS.Timeout>();
const DEFAULT_TRIAGE_DEBOUNCE_MS = 4 * 60_000; // 4 minutes

// ── Notify dedup ──
// The self-report's PHASE_SIGNAL drives notification via a deterministic lookup
// (see decideNotify). A stuck session can re-emit the same signal every quiet
// period (verify-fail on every retry) — remember the last notified signal per
// session:task and suppress repeats. A DIFFERENT signal resets the gate.
const lastNotifiedSignal = new Map<string, string>();

/** Test-only: reset per-process triage state so unit tests are order-independent. */
export function __resetTriageRateLimiter(): void {
  triageLastDispatch.clear();
  lastNotifiedSignal.clear();
  selfReportInFlight.clear();
}

/** Test-only: clear ONLY the dispatch cooldown, keeping the in-flight set —
 *  lets tests fire back-to-back runTriage calls to assert single-flight. */
export function __clearTriageCooldown(): void {
  triageLastDispatch.clear();
}

/** Cancel a pending debounced triage for a session — used when the user resumes
 *  interaction (message-send), so a mid-conversation triage never fires. */
function cancelPendingTriage(sessionId: string): void {
  const t = triageDebounceTimers.get(sessionId);
  if (t) {
    clearTimeout(t);
    triageDebounceTimers.delete(sessionId);
  }
}

// ── Session self-report (side_question / "/btw") ──
// The SESSION ITSELF is the sole summarizer: we ask it for a structured self-report
// via the native Claude Code side_question control protocol (askSideQuestion). The
// session has its full context in-cache, so it's the authoritative source and the
// marginal cost is ~zero (rides the session's own prompt cache). The answer is NOT
// added to the session transcript.
//
// There is deliberately NO fallback summarizer agent — the session writes the summary
// and the deterministic PHASE_SIGNAL lookup below decides phase/notify. Full rationale
// + the 4-model eval evidence: docs/decision/summarizer-self-report.md.
// Do not re-introduce a summarizer/notify-deciding model without reading it. If the
// session is dead when the quiet-period fires, we skip; the next turn's report (which
// merges against the fed-back summary) covers the gap.
//
// TIMEOUT IS A LEAK GUARD, NOT A QOS KNOB. Nothing is held while we await the answer
// (no lock, no event-loop time) — the only reason to time out at all is to not leak a
// pending promise on a CLI that died mid-question. Measured answer latency is 6-18s
// with a long tail when the CLI is mid-turn (it answers control requests only between
// turns, and the answer then reflects the LATEST context — strictly better). A tight
// timeout here silently starved sessions of summaries (2026-07: 20s cut off ~60% of
// fires on remote hosts). Keep this in MINUTES.
const SELF_REPORT_TIMEOUT_MS = 10 * 60_000;

// Single-flight: at most ONE pending self-report question per session. If the previous
// ask is still awaiting an answer when a new debounce fires, asking again is pointless —
// the pending one will be answered from the session's newest context anyway (covers the
// new turns), and double-asking just queues duplicate control requests on the FIFO.
const selfReportInFlight = new Set<string>();

/** Past this NOTE length the fire becomes a MANDATORY REORGANIZE pass: the session
 *  must merge the oldest Work Log entries and bring the note back under the cap
 *  (preserving every ID and decision). MANDATORY, not advisory: a day of prod data
 *  (2026-07-18) showed the earlier "you may consolidate" wording NEVER produced a net
 *  shrink — notes grew monotonically to 12.5k+. Do not soften the prompt wording back.
 *  6000 ≈ a screenful of dense context; it also bounds the per-fire prompt cost since
 *  the full note is re-fed on every fire. */
export const NOTE_REORG_CAP = 6000; // chars

/** The five canonical NOTE sections, in render order. The NOTE is the task's single
 *  living document (design session 2026-07-18, replaces the summary+milestones pair):
 *  Executive Summary = for the human scanning; User Request = concise restatement of
 *  the user's request (intent, NOT a verbatim quote) + acceptance criteria (search
 *  entry point; rewritten on pivot with a "(pivoted from: …)" trace); Context =
 *  self-contained background, frozen once right; Progress = bulleted per-workitem lines
 *  with a bracketed status label ([DONE]/[WIP]/[TODO]/[BLOCKED]/[WAIT]); Work Log =
 *  append-only did/found/result entries carrying every external ID and decision
 *  (never commit hashes, no timestamps).
 *  Renamed 2026-07-22: "Goal" → "User Request" (user feedback). Old notes with a
 *  "## Goal" header keep parsing (normalized to User Request on the next assemble). */
export const NOTE_SECTIONS = [
  'Executive Summary', 'User Request', 'Context', 'Progress', 'Work Log',
] as const;
export type NoteSection = (typeof NOTE_SECTIONS)[number];

/** Report label per note section (what the session answers with). */
const NOTE_LABELS: Record<NoteSection, string> = {
  'Executive Summary': 'EXEC_SUMMARY',
  'User Request': 'USER_REQUEST',
  'Context': 'CONTEXT',
  'Progress': 'PROGRESS',
  'Work Log': 'WORK_LOG',
};

/** Legacy report label accepted per section: sessions mid-turn when the rename
 *  shipped still answer with the old label. */
const LEGACY_NOTE_LABELS: Partial<Record<NoteSection, string>> = {
  'User Request': 'GOAL',
};

/** Build the self-report prompt. `existingNote` is injected so the session works
 *  DELTA-FIRST against the task's living NOTE — this is what survives multi-day
 *  sessions and compactions: the prior note is re-fed every time, so the session
 *  never needs to remember the task's beginning. Cheap-by-default protocol: most
 *  sections answer `unchanged`; Work Log appends one entry; Progress is rewritten
 *  only when a workitem's status actually moved. */
export function buildSelfReportPrompt(existingNote?: string): string {
  const existing = existingNote?.trim() ?? '';
  const reorg = existing.length > NOTE_REORG_CAP;

  let noteBlock: string;
  if (!existing) {
    noteBlock = `The task NOTE is EMPTY. Write ALL five sections now (label + content each).`;
  } else {
    noteBlock = `<existing_note>\n${existing}\n</existing_note>
For EACH of the five labels answer \`unchanged\` OR the new content. If the note above is NOT yet in this five-section structure, this is a MIGRATION: answer all five with content, preserving EVERY fact from the note above (facts may move between sections; none may be dropped).
NOTE BUDGET: ${existing.length}/${NOTE_REORG_CAP} chars used.${reorg ? `
The note is ${existing.length} chars — OVER the ${NOTE_REORG_CAP}-char budget. This fire is a MANDATORY REORGANIZE: answer WORK_LOG with \`rewrite: <full section>\` that merges the OLDEST entries into consolidated ones (several old entries → one), and rewrite any other section that carries superseded or duplicated detail. Target: bring the FULL note back under ${NOTE_REORG_CAP} chars — the note must come back SHORTER than it went in. HARD RULE: keep every external ID (tickets, request/approval ids, hosts, URLs) and every decision+reason; commit hashes may be dropped; only drop process narration, dead-end play-by-play, and detail already superseded.` : ''}`;
  }

  return `You just finished a turn. Update this task's NOTE — the single living document that lets a human (or a fresh AI with zero context) pick the task up. You have the full context — be the authoritative source. ${noteBlock}

Section contract (plain text under each label, English, self-contained — never "this bug"/"the feature"). Style rules for ALL sections: any name a zero-context reader wouldn't know (project codenames, internal tools, niche libraries, team jargon) gets a FEW-WORDS parenthetical on first use — "walnut (a personal task butler)" — not a sentence of background; well-known public things (React, S3, GitHub) need none. Reference code by file path only, NEVER line numbers (they drift). Terse beats thorough-sounding.
EXEC_SUMMARY: For the HUMAN scanning: 2-3 plain sentences — what this task is + where it stands. No jargon.
USER_REQUEST: A concise, accurate restatement of what the user asked for — capture the intent faithfully but do NOT quote the user verbatim (raw messages carry typos and thinking-out-loud; distill them). Include the acceptance criteria, detailed enough to be the search entry point. If the user changed direction, rewrite and keep a "(pivoted from: <old> — <why>)" trace inline.
CONTEXT: Background a newcomer needs: where the problem came from, why it matters, constraints, systems involved. Write once, keep frozen; only add when genuinely new background surfaced.
PROGRESS: HIGH-LEVEL status board, one BULLET per workitem/component: "- [STATUS] <workitem> — <detail>". STATUS is one of the plain-text labels wrapped in square brackets — [DONE] (finished), [WIP] (in progress), [TODO] (not started yet), [BLOCKED]/[WAIT] (blocked, or waiting on a human / review / deployment). Use the bracketed label text, NOT emoji. Simple and concise — details belong in WORK_LOG, not here.
WORK_LOG: \`append: <one entry>\` — what you DID, what you FOUND (conclusions, gotchas, dead ends), the RESULT (key decisions + why). ALWAYS carry EXTERNAL ids — ticket ids, request ids, approval ids, PR links, incident ids — a reader can't re-derive those. NEVER include commit hashes (low value; git history has them). No timestamps. \`unchanged\` only if this turn produced nothing worth tracing.
NEVER delete facts: when something is superseded, update it in place and keep an "(was: …)" trace.

Then these status fields (same plain-label format):
RECAP: ONE line, as simple as possible — what just happened in your latest turn(s), for a user re-opening this session ("Fixed the timeout bug, tests green, awaiting commit approval"). Always answer this; never "unchanged".
PHASE_SIGNAL: one of — plan-written | implement-done | reconfirmed | verify-pass | verify-fail | review-done | committed(<hash>) | conversational(user-asked-question).
STATUS: <succeeded|failed|blocked|waiting> — one sentence on what works / what doesn't.
WHAT_I_DID: 1-2 sentences, this turn's concrete change (used verbatim in notifications).
NEXT_STEPS: What you'd do next, or what you need from the human.
BLOCKERS: Anything blocking, or "none".
USER_INTENT: <question-pending | workflow-command | autonomous> — gist of user's last message.
VERIFIED: <ran-and-saw-pass | assumed | not-applicable>.`;
}

/** The exact labels emitted by buildSelfReportPrompt. Used to anchor extractField's
 *  field terminator so a wrapped value containing an unrelated ALL-CAPS "WORD:"
 *  line (e.g. "API:", "TODO:", "NOTE:") doesn't prematurely cut the field.
 *  TASK_SUMMARY / CHANGES_TRIED / ARTIFACTS are retired from the prompt but kept
 *  here as terminators so old buffered reports still parse.
 *  ⚠️ Adding a NOTE section requires syncing FIVE places: NOTE_SECTIONS,
 *  NOTE_LABELS, the header regex in parseNoteSections, this list, and the prompt
 *  text — missing the regex silently dumps the new section into `preamble`;
 *  missing this list makes the new label bleed into the previous field. */
const SELF_REPORT_LABELS = [
  'EXEC_SUMMARY', 'USER_REQUEST', 'GOAL', 'CONTEXT', 'PROGRESS', 'WORK_LOG', 'RECAP',
  'TASK_SUMMARY', 'WHAT_I_DID', 'STATUS', 'CHANGES_TRIED', 'PHASE_SIGNAL', 'NEXT_STEPS',
  'BLOCKERS', 'USER_INTENT', 'VERIFIED', 'ARTIFACTS',
] as const;
const NEXT_LABEL_LOOKAHEAD = `(?:${SELF_REPORT_LABELS.join('|')})`;

/** Pull a single labeled field out of a self-report. Tolerant of leading bold
 *  markers and missing fields. Returns '' if absent. Exported for unit tests. */
export function extractField(report: string, label: string): string {
  // Match "LABEL:" at line start (optionally **bold**), capture until the next
  // KNOWN self-report label line or end of string. No 'm' flag — we want `$` to
  // mean end-of-STRING so a multi-line field captures fully; the label start is
  // anchored with (?:^|\n). Terminating only on the known label set (not any
  // ALL-CAPS WORD:) preserves wrapped content like "...see API: notes" inside a
  // field. `label` is escaped defensively though all call sites pass constants.
  const safe = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `(?:^|\\n)\\s*\\*{0,2}${safe}\\*{0,2}\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*\\*{0,2}${NEXT_LABEL_LOOKAHEAD}\\*{0,2}\\s*:|$)`,
  );
  const m = report.match(re);
  return m ? m[1].trim() : '';
}

/** Split an existing NOTE into its five canonical sections. Content before the
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
  const headerRe = /(?:^|\n)##\s+(Executive Summary|User Request|Goal|Context|Progress|Work Log)[^\S\n]*(?:\n|$)/g;
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

/** Per-section answer from a self-report: unchanged | append (Work Log) | new content. */
export type SectionAnswer =
  | { kind: 'unchanged' }
  | { kind: 'append'; text: string }
  | { kind: 'rewrite'; text: string }
  | { kind: 'none' }; // label absent — treat as unchanged, but track for observability

/** Parse one section's answer out of a self-report. Tolerant of markdown wrapping
 *  and casing on the markers; a marker-less non-empty answer is new content
 *  (losing it would be worse than accepting it) — EXCEPT for Work Log, whose
 *  contract is append-only ("carries every ID and decision"): a session that
 *  forgets the `append:` prefix must not wipe the whole log with one turn's
 *  entry, so marker-less Work Log content defaults to append. Exported for unit tests. */
export function parseSectionAnswer(report: string, section: NoteSection): SectionAnswer {
  let raw = extractField(report, NOTE_LABELS[section]).trim();
  const legacy = LEGACY_NOTE_LABELS[section];
  if (!raw && legacy) raw = extractField(report, legacy).trim();
  if (!raw) return { kind: 'none' };
  raw = raw.replace(/^[`*"']+/, '').replace(/[`*"']+$/, '').trim();
  if (/^unchanged\b[.!]?$/i.test(raw)) return { kind: 'unchanged' };
  const append = raw.match(/^append\s*:\s*([\s\S]+)$/i);
  if (append) return { kind: 'append', text: append[1].trim() };
  const rewrite = raw.match(/^rewrite\s*:\s*([\s\S]+)$/i);
  if (rewrite) return { kind: 'rewrite', text: rewrite[1].trim() };
  return section === 'Work Log' ? { kind: 'append', text: raw } : { kind: 'rewrite', text: raw };
}

/** Assemble the new NOTE from the existing one + the report's per-section answers.
 *  Returns null when NOTHING changed (all sections unchanged/none — skip persist).
 *  A pre-structure free-form note is preserved: if the report did not provide
 *  content for all sections (migration incomplete), the old free-form body is kept
 *  as the preamble so no fact is ever dropped by the assembler itself.
 *  Exported for unit tests. */
export function assembleNote(existingNote: string, report: string): { note: string; changed: NoteSection[] } | null {
  const { sections: old, preamble } = parseNoteSections(existingNote);
  const changed: NoteSection[] = [];
  const next: Partial<Record<NoteSection, string>> = { ...old };
  let reportAnsweredAll = true;

  for (const s of NOTE_SECTIONS) {
    const ans = parseSectionAnswer(report, s);
    if (ans.kind === 'unchanged' || ans.kind === 'none') {
      reportAnsweredAll = false;
      continue;
    }
    if (ans.kind === 'append') {
      next[s] = old[s] ? `${old[s]}\n- ${ans.text.replace(/^-\s*/, '')}` : `- ${ans.text.replace(/^-\s*/, '')}`;
    } else {
      next[s] = ans.text;
    }
    changed.push(s);
  }
  if (changed.length === 0) return null;

  // The preamble (free-form text above the first header) is dropped ONLY when THIS
  // report answered all five sections with content — i.e. an actual migration pass
  // that was instructed to fold every preamble fact into the sections. Checking the
  // merged result (`next`) instead would drop a preamble on any single-section
  // append once the note has all five headers — silent fact loss.
  const migrated = reportAnsweredAll;
  const parts: string[] = [];
  if (preamble && !migrated) parts.push(preamble);
  for (const s of NOTE_SECTIONS) {
    if (next[s]) parts.push(`## ${s}\n${next[s]}`);
  }
  return { note: parts.join('\n\n'), changed };
}

/** Shrink guard: a new note dramatically shorter than the old one means the session
 *  dropped facts (the assembler never shrinks on its own — only rewrites can).
 *
 *  COUPLING INVARIANT (do not "tighten" the ratio without re-deriving this): a
 *  MANDATORY REORGANIZE (old > NOTE_REORG_CAP) is INSTRUCTED to land under
 *  NOTE_REORG_CAP, so for old ≥ cap/0.4 (=15000) a proportional floor rejects every
 *  compliant reorganize — deadlock: the note can never shrink, every fire re-runs a
 *  doomed reorganize. Reorganize fires therefore use an ABSOLUTE floor (cap × 0.4)
 *  instead of the proportional one. Exported for tests. */
export function noteShrinkRejected(oldNote: string, newNote: string): boolean {
  const oldSections = parseNoteSections(oldNote).sections;
  const newSections = parseNoteSections(newNote).sections;
  for (const section of ['Executive Summary', 'User Request', 'Context', 'Progress'] as const) {
    const oldPresent = Object.prototype.hasOwnProperty.call(oldSections, section);
    const newPresent = Object.prototype.hasOwnProperty.call(newSections, section);
    if (oldPresent && !newPresent) return true;
    const oldBody = oldSections[section]?.trim() ?? '';
    const newBody = newSections[section]?.trim() ?? '';
    if (oldBody && !newBody) return true;
    if (oldBody.length >= 100 && newBody.length < oldBody.length * 0.4) return true;
  }

  if (oldNote.length < 1500) return false; // small unstructured notes rewrite freely
  if (oldNote.length > NOTE_REORG_CAP) return newNote.length < NOTE_REORG_CAP * 0.4;
  return newNote.length < oldNote.length * 0.4;
}

// NOTE: the legacy three-way TASK_SUMMARY directive (parseSummaryDirective /
// summaryFromSelfReport) and the milestones log (milestoneFromSelfReport) were
// RETIRED 2026-07-18 — the NOTE is now the single living document (five sections,
// per-section answers above); task.summary is derived from Executive Summary and
// the Work Log section replaced milestones. See docs/decision/summarizer-self-report.md.

/** Signals that warrant waking the user, and their notification headlines. Everything
 *  else (implement-done / verify-pass / review-done / reconfirmed / conversational)
 *  is progress the user discovers on their own schedule. */
const NOTIFY_SIGNALS: Record<string, string> = {
  'plan-written': 'Plan ready for review',
  'verify-fail': 'Verification failed — needs a decision',
  'committed': 'Committed — ready for review/deploy',
  'blocked': 'Blocked — needs human input',
};

/**
 * Deterministic notify decision from a self-report. Replaces the retired triage
 * subagent's judgment call: a 4-model eval (2026-07) showed models disagree exactly
 * on this gate (false notifies, missed notifies) while the policy is a lookup table.
 *
 *   notify ← plan-written | verify-fail | committed | blocked (STATUS/BLOCKERS)
 *   silent ← everything else
 *
 * An engaged user (USER_INTENT: question-pending) always suppresses — they will see
 * the result themselves. A repeat of the same signal for the same session:task is
 * deduped via lastNotifiedSignal (a stuck session re-emitting verify-fail every
 * quiet period must not re-notify); a different signal resets the gate.
 * Exported for unit tests.
 */
export function decideNotify(report: string, dedupKey: string): string | null {
  const intent = extractField(report, 'USER_INTENT').toLowerCase();
  if (intent.startsWith('question-pending')) return null;

  const signal = extractField(report, 'PHASE_SIGNAL').toLowerCase();
  const status = extractField(report, 'STATUS').toLowerCase();
  const blockers = extractField(report, 'BLOCKERS').trim();
  const isBlocked = /^blocked/.test(status) || (!!blockers && !/^none\b/i.test(blockers));

  let kind: string | null = null;
  if (signal.startsWith('plan-written')) kind = 'plan-written';
  else if (signal.startsWith('verify-fail')) kind = 'verify-fail';
  else if (signal.startsWith('committed')) kind = 'committed';
  else if (isBlocked) kind = 'blocked';
  if (!kind) return null;

  if (lastNotifiedSignal.get(dedupKey) === kind) return null;
  // Bounded: one entry per session:task; drop oldest past a generous cap.
  if (lastNotifiedSignal.size > 500) {
    const first = lastNotifiedSignal.keys().next().value;
    if (first) lastNotifiedSignal.delete(first);
  }
  lastNotifiedSignal.set(dedupKey, kind);

  const did = extractField(report, 'WHAT_I_DID').replace(/\s+/g, ' ').trim();
  const next = extractField(report, 'NEXT_STEPS').replace(/\s+/g, ' ').trim();
  let msg = did ? `${NOTIFY_SIGNALS[kind]}: ${did}` : NOTIFY_SIGNALS[kind];
  if (kind === 'blocked' && blockers && !/^none\b/i.test(blockers)) {
    msg += ` Blocker: ${blockers.replace(/\s+/g, ' ').trim()}`;
  }
  if (next) msg += ` Next: ${next}`;
  return msg;
}

/**
 * runTriage: the turn-complete summary work. Invoked from the trailing-debounce
 * timer below, NOT directly on turn completion, so a burst of interactive turns
 * collapses into one run.
 *
 * Single-tier design (the expensive triage subagent was deleted 2026-07): the
 * SESSION writes its own merged NOTE via side_question (it re-receives the
 * existing task.note each time, so multi-day / post-compaction sessions never
 * lose the task's origin), and code deterministically persists the note (deriving
 * task.summary from Executive Summary), decides notify via the PHASE_SIGNAL
 * lookup (decideNotify), and syncs the phase. Session dead / no answer → skip
 * silently; the next turn's merged report covers the gap.
 *
 * The TRIAGE_COOLDOWN_MS guard is checked HERE (fire time), not at arm time: the
 * debounce re-arms on every turn-complete during an interactive burst, and checking
 * the cooldown at arm time would suppress those legitimate re-arms. Checked at fire
 * time it only suppresses the rare case where two fires land within the cooldown
 * (e.g. a replayed event firing right after a real one). Exported for unit tests.
 */
export async function runTriage(p: OnTurnCompletePayload): Promise<void> {
  // Defensive: the arming handler already gated on taskId/task, but runTriage may be
  // called directly (tests) and the timer fires asynchronously — re-narrow taskId so
  // the type flows and a stale/cleared task can't trigger a no-op triage.
  if (!p.taskId) return;
  const taskId = p.taskId;

  // Cooldown: prevent burst dispatches from replayed events after server restart.
  // The daemon may replay N result events in milliseconds — without this guard,
  // each one would fire a redundant side_question + summary persist per replayed event.
  const dedupKey = `${p.sessionId}:${p.taskId}`;
  const now = Date.now();

  // Prune stale entries to prevent unbounded growth
  if (triageLastDispatch.size > 100) {
    for (const [k, ts] of triageLastDispatch) {
      if (now - ts > TRIAGE_COOLDOWN_MS) triageLastDispatch.delete(k);
    }
  }

  const lastAt = triageLastDispatch.get(dedupKey);
  if (lastAt && now - lastAt < TRIAGE_COOLDOWN_MS) {
    log.session.warn('turn-complete-triage: skipped — cooldown', {
      taskId: p.taskId, sessionId: p.sessionId,
      msSinceLast: now - lastAt,
    });
    return;
  }
  triageLastDispatch.set(dedupKey, now);

  try {
    // ── Ask the provider session for a structured self-report ──
    // Native Claude uses side_question; ACP uses its provider-native hidden
    // report request. The merge/phase/notify policy below is provider-neutral.
    const { sessionRunner } = await import('../../providers/claude-code-session.js');

    // Single-flight: a previous ask still awaiting its answer already covers this
    // fire — when it resolves, the session answers from its LATEST context, which
    // includes whatever turns re-armed this debounce. Asking again would only queue
    // a duplicate control request.
    if (selfReportInFlight.has(p.sessionId)) {
      log.session.info('turn-complete-summary: previous ask still in flight — skipped (its answer covers this turn)', {
        sessionId: p.sessionId, taskId: p.taskId,
      });
      return;
    }

    // Claim the single-flight slot BEFORE the async getTask below — checking at
    // line-of-ask leaves a TOCTOU window where two concurrent fires (same session,
    // different tasks — dedupKey differs so the cooldown doesn't gate) both pass
    // the has() check and double-ask.
    selfReportInFlight.add(p.sessionId);

    let existingNote = '';
    let selfReport = '';
    const askedAt = Date.now();
    try {
      try {
        const { getTask } = await import('../task-manager.js');
        // Trimmed at the source: the prompt (NOTE BUDGET + reorg gate) trims
        // internally, so the accountability/shrink checks below must measure the
        // SAME string or a 6006-raw/5992-trimmed note logs spurious reorg warns.
        existingNote = ((await getTask(taskId)).note ?? '').trim();
      } catch (err) {
        // Do NOT degrade to an empty note: the prompt would say "NOTE is EMPTY,
        // write ALL five sections", the model rewrites from scratch, the shrink
        // guard compares against '' (never rejects), and a transient read failure
        // becomes a full overwrite of the real note. Skip; next fire covers it.
        log.session.warn('turn-complete-summary: task note read failed — skipped (next turn will merge)', {
          sessionId: p.sessionId, taskId: p.taskId,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      selfReport = (await sessionRunner.requestTurnCompleteSelfReport(
        p.sessionId,
        buildSelfReportPrompt(existingNote), SELF_REPORT_TIMEOUT_MS,
      )).trim();
    } catch (err) {
      log.session.warn('turn-complete-summary: provider self-report failed — skipped (next turn will merge)', {
        sessionId: p.sessionId, taskId: p.taskId,
        error: err instanceof Error ? err.message : String(err),
        elapsedMs: Date.now() - askedAt,
        host: p.session?.host ?? '__local__',
      });
      return;
    } finally {
      selfReportInFlight.delete(p.sessionId);
    }
    if (!selfReport) return;

    // The ask can take minutes (the CLI answers control requests between turns).
    // The note may have been written meanwhile — by a human in the Note editor, or
    // by another session on the same task (in-flight is keyed per-session, notes
    // are per-task). Re-read and merge against the FRESH copy: answers are
    // per-section, so re-assembly is cheap, and appends replay cleanly. Without
    // this, updateNote() below writes an assembly built on the stale base and
    // silently reverts the concurrent write.
    try {
      const { getTask } = await import('../task-manager.js');
      const freshNote = ((await getTask(taskId)).note ?? '').trim();
      if (freshNote !== existingNote) {
        log.session.info('turn-complete-summary: note changed during ask — merging against fresh copy', {
          sessionId: p.sessionId, taskId: p.taskId,
          staleLen: existingNote.length, freshLen: freshNote.length,
        });
        existingNote = freshNote;
      }
    } catch { /* keep the pre-ask copy; better than dropping the report */ }

    log.session.info('turn-complete-summary: got session self-report', {
      sessionId: p.sessionId, taskId: p.taskId, reportLen: selfReport.length,
      elapsedMs: Date.now() - askedAt,
    });

    // (a) Persist the NOTE per the session's per-section answers (unchanged /
    // append / new content per section). updateNote runs plugin content validation
    // and can reject — log and move on; the notify decision below doesn't depend
    // on the persist.
    //
    // Observability contract: parse outcomes are NEVER silent. Every fire logs the
    // changed sections; a report where NO note label parsed at all is a format
    // regression → ERROR with a report head so `walnut-logs.sh errors` surfaces it.
    let assembled = assembleNote(existingNote, selfReport);
    const anyLabelPresent = NOTE_SECTIONS.some((s) => parseSectionAnswer(selfReport, s).kind !== 'none');
    log.session.info('turn-complete-summary: note sections parsed', {
      sessionId: p.sessionId, taskId: p.taskId,
      changed: assembled?.changed ?? [], noteLen: assembled?.note.length ?? existingNote.length,
    });
    // Reorganize accountability: the over-budget prompt DEMANDS a net shrink —
    // a reorg fire that comes back same-or-longer means the session ignored it.
    if (existingNote.length > NOTE_REORG_CAP) {
      const newLen = assembled?.note.length ?? existingNote.length;
      if (newLen >= existingNote.length) {
        log.session.warn('turn-complete-summary: REORGANIZE fire did not shrink the note', {
          sessionId: p.sessionId, taskId: p.taskId,
          oldLen: existingNote.length, newLen, cap: NOTE_REORG_CAP,
        });
      } else {
        log.session.info('turn-complete-summary: reorganize shrank the note', {
          sessionId: p.sessionId, taskId: p.taskId,
          oldLen: existingNote.length, newLen, cap: NOTE_REORG_CAP,
        });
      }
    }
    if (!anyLabelPresent) {
      log.session.error('turn-complete-summary: self-report UNPARSEABLE — no note section labels found; prompt/format regression?', {
        sessionId: p.sessionId, taskId: p.taskId,
        reportHead: selfReport.slice(0, 300),
      });
    }
    if (assembled) {
      let notePersisted = false;
      let persistedNote = '';
      for (let attempt = 0; attempt < 3 && assembled; attempt++) {
        if (noteShrinkRejected(existingNote, assembled.note)) {
          log.session.error('turn-complete-summary: note persist REJECTED — new note dropped too much content (shrink guard)', {
            sessionId: p.sessionId, taskId: p.taskId,
            oldLen: existingNote.length, newLen: assembled.note.length,
          });
          break;
        }
        try {
          const { compareAndSetNote } = await import('../task-manager.js');
          const persisted = await compareAndSetNote(taskId, existingNote, assembled.note);
          if (persisted.updated) {
            notePersisted = true;
            persistedNote = assembled.note;
            break;
          }
          existingNote = (persisted.task.note ?? '').trim();
          assembled = assembleNote(existingNote, selfReport);
          log.session.info('turn-complete-summary: note CAS missed — reassembled against concurrent edit', {
            sessionId: p.sessionId,
            taskId: p.taskId,
            attempt: attempt + 1,
            freshLen: existingNote.length,
          });
        } catch (err) {
          log.session.warn('turn-complete-summary: note persist failed', {
            taskId: p.taskId, error: err instanceof Error ? err.message : String(err),
          });
          break;
        }
      }
      // Derive the short task.summary + SessionRecord.summary only from the
      // exact note version that won the CAS.
      const exec = notePersisted
        ? parseNoteSections(persistedNote).sections['Executive Summary']
        : undefined;
      if (exec) {
        const shortSummary = exec.replace(/\s+/g, ' ').trim();
        try {
          const { updateSummary } = await import('../task-manager.js');
          await updateSummary(taskId, shortSummary);
        } catch (err) {
          log.session.debug('turn-complete-summary: summary derive skipped', {
            taskId: p.taskId, error: err instanceof Error ? err.message : String(err),
          });
        }
        try {
          const { updateSessionRecord } = await import('../session-tracker.js');
          await updateSessionRecord(p.sessionId, {
            summary: shortSummary,
            summaryGeneratedAt: new Date().toISOString(),
          });
        } catch (err) {
          log.session.debug('turn-complete-summary: session summary backfill skipped', {
            sessionId: p.sessionId, error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // (a2) Session recap — one line, "what just happened here", shown as a tip
    // under the session in the UI. Independent of the note persist: even an
    // all-unchanged report carries a fresh recap of the latest turn.
    const recap = extractField(selfReport, 'RECAP').replace(/\s+/g, ' ').trim();
    if (recap && !/^unchanged\b[.!]?$/i.test(recap)) {
      try {
        const { updateSessionRecord } = await import('../session-tracker.js');
        await updateSessionRecord(p.sessionId, {
          // 300-char cap: the composer recap tip (.session-recap-tip in
          // web/src/styles/globals.css) renders the FULL recap with wrapping —
          // this server-side cap is what bounds it to ~5 lines worst case.
          recap: recap.slice(0, 300),
          recapAt: new Date().toISOString(),
        });
      } catch (err) {
        log.session.debug('turn-complete-summary: recap persist skipped', {
          sessionId: p.sessionId, error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // (b) PHASE_SIGNAL drives phase-sync AND notify — a missing field silently
    // degrades both, so warn when it's absent (format drift indicator).
    if (!extractField(selfReport, 'PHASE_SIGNAL')) {
      log.session.warn('turn-complete-summary: report has NO PHASE_SIGNAL field — notify skipped this turn (format drift?)', {
        sessionId: p.sessionId, taskId: p.taskId,
      });
    }

    // (c) Phase sync — deterministic, replaces the triage subagent's Step 3 AND the
    // server's old post-triage fallback (which ran after EVERY triage result). The
    // session has been quiet for the debounce window and the turn is over, so the
    // ball is in the human's court: AGENT_COMPLETE → AWAIT_HUMAN_ACTION
    // (+ needs_attention). applySessionPhase's 'triage-sync' trigger only fires from
    // AGENT_COMPLETE, so an in-progress or human-verified task is never touched.
    try {
      const { applySessionPhase } = await import('../phase.js');
      await applySessionPhase(taskId, 'triage-sync', 'turn-complete-summary', { sessionId: p.sessionId });
    } catch (err) {
      log.session.warn('turn-complete-summary: phase sync failed', {
        taskId: p.taskId, error: err instanceof Error ? err.message : String(err),
      });
    }

    const notifyMessage = decideNotify(selfReport, dedupKey);
    if (notifyMessage) {
      // (d) Notify — same event contract the triage subagent's notify_main_agent
      // produced. agentId stays 'turn-complete-triage' so the server's notify_mode
      // gate ('off'/'buffered'/'realtime'), UI rendering, and usage classification
      // all work unchanged. runId carries the session id (there is no subagent run
      // anymore).
      bus.emit('subagent:result', {
        runId: `self-report-${p.sessionId}-${p.turnIndex ?? 0}`,
        agentId: 'turn-complete-triage',
        agentName: 'Session Summary',
        taskId: p.taskId,
        // The full report is a private control response already persisted into
        // task/session fields above. Only the compact decision may enter the
        // main-chat notification path.
        result: notifyMessage,
        notification: notifyMessage,
      }, ['main-ai'], { source: 'turn-complete-summary' });

      log.session.info('turn-complete-summary: notify decided', {
        sessionId: p.sessionId, taskId: p.taskId, message: notifyMessage.slice(0, 200),
      });
    }
  } catch (err) {
    log.session.error('turn-complete-summary hook failed', {
      sessionId: p.sessionId,
      taskId: p.taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * turn-complete-triage: trailing-debounces the summary work on turn completion.
 * Hook: onTurnComplete. Each turn-complete (re)arms a per-session timer; the work
 * fires ONCE after the session has been quiet for `debounce_minutes`
 * (config.agent.triage.debounce_minutes, default 4). A user message-send cancels the
 * pending timer (see messageSendTriageHook) — interaction resumed, no mid-chat fire.
 *
 * The fired work (see runTriage) is a single free pass: session self-report via
 * side_question → code persists the note (+ derived summary) + PHASE_SIGNAL
 * lookup decides phase/notify. No subagent is dispatched.
 */
export const turnCompleteTriageHook: SessionHookDefinition = {
  id: 'turn-complete-triage',
  name: 'Turn Complete Summary (onTurnComplete)',
  description: 'Collects a session self-report and persists the task note/summary/phase when a turn completes.',
  hooks: ['onTurnComplete'],
  priority: 50,
  source: 'builtin',
  enabled: true,
  handler: async (payload) => {
    const p = payload as OnTurnCompletePayload;
    // No real task → no triage. Catches both a taskless session (taskId === '',
    // the sentinel for ad-hoc /sessions chats and on-demand agent conversations)
    // and a dangling taskId (non-empty, but the task no longer exists in
    // tasks.json — deleted/stale/cross-workspace; the payload builder resolves
    // `task` via getTask() and leaves it undefined when that throws). Triaging a
    // nonexistent task burns a side_question updating nothing.
    if (!p.taskId || !p.task) return;

    // Skip triage for embedded subagent sessions (provider='embedded').
    if (p.session?.provider === 'embedded') return;

    // Trailing debounce: (re)arm the per-session timer. A prior pending run for this
    // session is cancelled — a burst of turn-completes thus collapses into one run
    // that fires only after the configured quiet window. Read the window fresh each
    // time so a settings change takes effect on the next turn.
    const { getConfig } = await import('../config-manager.js');
    const config = await getConfig();
    const debounceMs = config.agent?.triage?.debounce_minutes != null
      ? Math.max(0, config.agent.triage.debounce_minutes * 60_000)
      : DEFAULT_TRIAGE_DEBOUNCE_MS;

    cancelPendingTriage(p.sessionId);
    const timer = setTimeout(() => {
      triageDebounceTimers.delete(p.sessionId);
      void runTriage(p);
    }, debounceMs);
    timer.unref?.(); // don't keep the process alive for a pending triage
    triageDebounceTimers.set(p.sessionId, timer);

    log.session.debug('turn-complete-triage: armed debounce', {
      sessionId: p.sessionId, taskId: p.taskId, debounceMs,
    });
  },
};

/**
 * message-send-triage: On user message-send, cancels any pending turn-complete
 * triage so it never fires mid-conversation.
 *
 * NOTE: This hook NO LONGER dispatches a per-message triage subagent. That
 * behaviour (an Opus subagent on EVERY user message just to classify "did the
 * user change direction?") was almost always a no-op CONTINUE yet cost a full
 * Opus round-trip per message — a large share of the runaway "subagent" spend.
 * Turn-complete triage already refreshes summary/phase/note after each turn,
 * which is sufficient. We keep the hook solely for its cancel side-effect: a
 * user message means the user is engaged, so the debounced turn-complete triage
 * must be cancelled (otherwise it could fire while the user is mid-chat — the
 * mid-conversation triage problem). Re-enable per-message triage only behind an
 * explicit opt-in if a real need resurfaces.
 */
export const messageSendTriageHook: SessionHookDefinition = {
  id: 'message-send-triage',
  name: 'Message Send Triage',
  description: 'Cancels pending turn-complete triage on user message-send (no per-message subagent).',
  hooks: ['onMessageSend'],
  priority: 60,
  source: 'builtin',
  enabled: true,
  handler: async (payload) => {
    const p = payload as OnMessageSendPayload;
    // Interaction resumed: cancel any pending debounced turn-complete triage for this
    // session so it never fires mid-conversation. Done unconditionally — the
    // dispatcher only delivers onMessageSend for user-initiated sends (it skips
    // 'agent'/'subagent-runner' sources), so this is always a real user message.
    // This is now the hook's ENTIRE job — no subagent is dispatched.
    cancelPendingTriage(p.sessionId);
  },
};

/**
 * session-error-notify: Logs session errors.
 */
export const sessionErrorNotifyHook: SessionHookDefinition = {
  id: 'session-error-notify',
  name: 'Session Error Notify',
  description: 'Logs session errors for monitoring.',
  hooks: ['onTurnError'],
  priority: 90,
  source: 'builtin',
  enabled: true,
  handler: async (payload) => {
    const p = payload as OnTurnErrorPayload;
    log.session.warn('session hook: turn error detected', {
      sessionId: p.sessionId,
      taskId: p.taskId,
      error: p.error?.slice(0, 200),
      isSessionError: p.isSessionError,
    });
  },
};

// ── CWD rename detector ──
// Escape a string for use inside a RegExp character class / pattern.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Conservative: absolute `mv` / `git mv` where the first operand equals task.cwd.
// We intentionally don't try to parse relative paths or shell pipelines —
// false positives would be worse than the Layer-2 tail check catching it.
function detectCwdRename(command: string, cwd: string): string | null {
  const escaped = escapeRegExp(cwd.replace(/\/+$/, ''));
  // Match: optional leading whitespace, (git )?mv, optional flags, then <cwd>(/)? <dest>
  const re = new RegExp(
    `^\\s*(?:git\\s+)?mv\\s+(?:-[-\\w]+\\s+)*${escaped}/?\\s+("[^"]+"|'[^']+'|\\S+)`,
  );
  const m = command.match(re);
  if (!m) return null;
  let dst = m[1];
  if ((dst.startsWith('"') && dst.endsWith('"')) || (dst.startsWith("'") && dst.endsWith("'"))) {
    dst = dst.slice(1, -1);
  }
  // Relative dest resolves against the Bash tool's cwd, which is task.cwd — not its parent.
  if (!path.isAbsolute(dst)) {
    dst = path.resolve(cwd, dst);
  }
  return dst;
}

/**
 * Session CWD rename defense — Layers 1 + 2.
 *
 * Why this exists: Claude Code stores session JSONL at
 * `~/.claude/projects/<sanitize(cwd)>/<sid>.jsonl` where
 * `sanitize = replace(/[^a-zA-Z0-9]/g, '-')`. `claude --resume` is strictly
 * cwd-scoped with no fallback search. If a session renames its own cwd
 * mid-work, subsequent resumes silently lose all history.
 *
 *  - Layer 1 (onToolUse, here): regex-match `mv`/`git mv` of task.cwd in Bash
 *    calls → updateTask({cwd: new}) which triggers JSONL migration to the new
 *    encoded dir. Regex is intentionally conservative (absolute paths only).
 *  - Layer 2 (onTurnComplete, here): existsSync tail-check for renames the
 *    regex missed (Node fs.renameSync, IDE drives, rsync, external deletes)
 *    → flag task.cwd_missing + notify once (dedup on transition).
 *  - Layer 3 (providers/cwd-check.ts): pre-spawn existsSync guard — aborts
 *    spawn with SESSION_ERROR instead of "session created and running" when
 *    the spawn would ENOENT.
 */
export const cwdRenameDetectorHook: SessionHookDefinition = {
  id: 'cwd-rename-detector',
  name: 'CWD Rename Detector',
  description: 'Auto-updates task.cwd when a session renames its own working directory, and flags missing cwds at turn end.',
  hooks: ['onToolUse', 'onTurnComplete'],
  priority: 40,
  source: 'builtin',
  enabled: true,
  handler: async (payload) => {
    const ctx = payload as OnToolUsePayload & OnTurnCompletePayload;
    const taskId = ctx.taskId;
    const cwd = ctx.session?.cwd ?? ctx.task?.cwd;
    // Skip remote sessions — migration happens on a different filesystem.
    if (ctx.session?.host) return;
    if (!taskId || !cwd) return;

    // Phase discriminator: `toolName` is a required field on OnToolUsePayload
    // and absent from OnTurnCompletePayload. Gating here ensures the turn-end
    // existsSync check does NOT run on every Edit/Write/Read tool call.
    if ('toolName' in payload) {
      // Branch 1 (Layer 1): onToolUse(Bash) — detect session-initiated renames.
      if ((ctx as OnToolUsePayload).toolName !== 'Bash') return;
      const cmd = ((ctx as OnToolUsePayload).input?.command ?? '') as string;
      if (!cmd) return;
      const newCwd = detectCwdRename(cmd, cwd);
      if (!newCwd) return;
      log.session.info('cwd-rename-detector: matched mv pattern', {
        sessionId: ctx.sessionId, taskId, oldCwd: cwd, newCwd, cmd: cmd.slice(0, 200),
      });
      try {
        const { updateTask } = await import('../task-manager.js');
        // updateTask triggers JSONL migration + session-record cwd sync (see task-manager.ts).
        await updateTask(taskId, { cwd: newCwd }, { source: 'cwd-rename-detector' });
      } catch (err) {
        log.session.warn('cwd-rename-detector: updateTask failed', {
          sessionId: ctx.sessionId, taskId, error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // Branch 2 (Layer 2): onTurnComplete — tail check for missed renames / external deletes.
    try {
      if (fs.existsSync(cwd)) return;
      log.session.warn('cwd-rename-detector: cwd missing at turn end', {
        sessionId: ctx.sessionId, taskId, cwd,
      });
      // Dedup notification: only emit when the flag transitions false→true so
      // a persistently-broken cwd doesn't spam the UI on every turn.
      const { getTask, updateTask } = await import('../task-manager.js');
      let wasMissing = false;
      try {
        const existing = await getTask(taskId);
        wasMissing = existing.cwd_missing === true;
      } catch {
        // Task may have been archived/deleted between turns — treat as "not flagged yet".
      }
      await updateTask(taskId, { cwd_missing: true }, { source: 'cwd-rename-detector' });
      if (!wasMissing) {
        bus.emit('notification', {
          taskId,
          message: `Working directory no longer exists: ${cwd}. Update the task's working directory to resume.`,
          severity: 'warning',
        }, ['web-ui', 'main-agent'], { source: 'cwd-rename-detector' });
      }
    } catch (err) {
      log.session.warn('cwd-rename-detector: turn-end check failed', {
        sessionId: ctx.sessionId, taskId, error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};

// NOTE: the former session-summary-gist hook (an LLM pass over the FULL transcript
// on 'onSessionEnd') was removed. It was built before per-turn summaries existed and
// was triggered by a misnamed event: session:ended fires after EVERY turn (it's a UI
// refresh signal), not on real session death — so the "once per session" gist ran
// once per active hour, re-reading an ever-growing transcript with zero cache hits.
// Its only output (SessionRecord.summary, a search-ranking boost) is now backfilled
// for free from task.summary by the cheap tier above; conversation bodies are already
// indexed per-turn by serializer v2, so search recall is unaffected.

/** All built-in hook definitions. */
export const builtinHooks: SessionHookDefinition[] = [
  turnCompleteTriageHook,
  messageSendTriageHook,
  sessionErrorNotifyHook,
  cwdRenameDetectorHook,
];
