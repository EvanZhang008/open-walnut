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
// + the 4-model eval evidence: skill `decision-summarizer-self-report`.
// Do not re-introduce a summarizer/notify-deciding model without reading it. If the
// session is dead when the quiet-period fires, we skip; the next turn's report (which
// merges against the fed-back summary) covers the gap.
const SELF_REPORT_TIMEOUT_MS = 20_000;

/** Past this length, append is no longer offered — the session must either say
 *  `unchanged` or consolidate with a full `rewrite:`. Deterministic cap so appends
 *  can't grow the summary without bound. */
export const SUMMARY_APPEND_CAP = 600; // chars

/** Build the self-report prompt. `existingSummary` is injected so the session works
 *  DELTA-FIRST against the running task summary — this is what survives multi-day
 *  sessions and compactions: the prior summary is re-fed every time, so the session
 *  never needs to remember the task's beginning. Cheap-by-default protocol:
 *  `unchanged` (no output) > `append:` (one short sentence) > `rewrite:` (full
 *  paragraph, only when the summary drifted from reality or needs consolidating). */
export function buildSelfReportPrompt(existingSummary?: string): string {
  const existing = existingSummary?.trim() ?? '';
  let summaryBlock: string;
  if (!existing) {
    summaryBlock = `(no summary exists yet — write the FIRST one: one paragraph, ≤3 sentences: what the task is about + where it stands now + immediate next step)`;
  } else if (existing.length > SUMMARY_APPEND_CAP) {
    summaryBlock = `<existing_summary>\n${existing}\n</existing_summary>\nAnswer with ONE of:
- \`unchanged\` — the summary above is still accurate for where the task stands NOW.
- \`rewrite: <full paragraph>\` — the summary is long/stale; consolidate everything (old + this turn) into a fresh ≤3-sentence paragraph. Keep still-true context (goal, key decisions), drop what's obsolete.`;
  } else {
    summaryBlock = `<existing_summary>\n${existing}\n</existing_summary>\nAnswer with ONE of (cheapest that fits):
- \`unchanged\` — the summary above is still accurate for where the task stands NOW.
- \`append: <one short sentence>\` — the usual case: just the NEW progress/state since that summary. It will be appended verbatim.
- \`rewrite: <full paragraph>\` — ONLY if the summary no longer reflects reality (direction change, plan invalidated): a fresh ≤3-sentence paragraph.`;
  }
  return `You just finished a turn. Give a structured self-report of THIS session so the task dashboard can be updated WITHOUT re-reading your transcript. You have the full context — be the authoritative source. Use EXACTLY these labels, plain text, English only, self-contained (no "this bug"/"the feature"):

TASK_SUMMARY: The task's one-glance dashboard line. ${summaryBlock}
WHAT_I_DID: Concrete changes this turn — which files/functions changed and WHY (1-3 sentences).
STATUS: <succeeded|failed|blocked|waiting> — one human sentence on what works / what doesn't.
PHASE_SIGNAL: one of — plan-written | implement-done | reconfirmed | verify-pass | verify-fail | review-done | committed(<hash>) | conversational(user-asked-question).
NEXT_STEPS: What you'd do next, or what you need from the human to proceed.
BLOCKERS: Anything blocking, or "none".
USER_INTENT: <question-pending | workflow-command | autonomous> — gist of user's last message.
VERIFIED: <ran-and-saw-pass | assumed | not-applicable> — what evidence you have.
ARTIFACTS: commit hash / PR url / plan file path / key files / screenshot paths, or "none".`;
}

/** The exact labels emitted by buildSelfReportPrompt. Used to anchor extractField's
 *  field terminator so a wrapped value containing an unrelated ALL-CAPS "WORD:"
 *  line (e.g. "API:", "TODO:", "NOTE:") doesn't prematurely cut the field.
 *  CHANGES_TRIED is retired from the prompt but kept here so old buffered reports
 *  still parse. */
const SELF_REPORT_LABELS = [
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

/** How the session answered the TASK_SUMMARY field. Exported for unit tests. */
export type SummaryDirective =
  | { kind: 'unchanged' }
  | { kind: 'append'; text: string }
  | { kind: 'rewrite'; text: string }
  | { kind: 'none' }; // field absent/empty — legacy report or parse miss

/** Parse the TASK_SUMMARY field's three-way directive. Tolerant of markdown wrapping
 *  (backticks/quotes/bold) and marker casing, but the markers themselves are strict
 *  prefixes — `append:` / `rewrite:` / `unchanged`. A non-empty answer WITHOUT a
 *  marker is treated as `rewrite` (the model forgot the marker; losing its paragraph
 *  would be worse than accepting it). Exported for unit tests. */
export function parseSummaryDirective(report: string): SummaryDirective {
  let raw = extractField(report, 'TASK_SUMMARY').trim();
  if (!raw) return { kind: 'none' };
  // Strip symmetric markdown wrapping the model may add around the whole answer.
  raw = raw.replace(/^[`*"']+/, '').replace(/[`*"']+$/, '').trim();
  if (/^unchanged\b[.!]?$/i.test(raw)) return { kind: 'unchanged' };
  const append = raw.match(/^append\s*:\s*([\s\S]+)$/i);
  if (append) return { kind: 'append', text: append[1].replace(/\s+/g, ' ').trim() };
  const rewrite = raw.match(/^rewrite\s*:\s*([\s\S]+)$/i);
  if (rewrite) return { kind: 'rewrite', text: rewrite[1].replace(/\s+/g, ' ').trim() };
  // No marker but real content → safest interpretation is a full rewrite.
  return { kind: 'rewrite', text: raw.replace(/\s+/g, ' ').trim() };
}

/** Resolve the new task.summary from a self-report + the current summary.
 *  Returns '' when nothing should be persisted (unchanged / empty report).
 *  Exported for unit tests. */
export function summaryFromSelfReport(report: string, existingSummary = ''): string {
  const directive = parseSummaryDirective(report);
  switch (directive.kind) {
    case 'unchanged':
      return '';
    case 'append': {
      const base = existingSummary.replace(/\s+/g, ' ').trim();
      if (!base) return directive.text; // nothing to append to — the sentence IS the summary
      return `${base}${/[.!?]$/.test(base) ? '' : '.'} ${directive.text}`;
    }
    case 'rewrite':
      return directive.text;
    case 'none':
      break; // legacy report without TASK_SUMMARY — compose from the other fields
  }
  const status = extractField(report, 'STATUS');
  const did = extractField(report, 'WHAT_I_DID');
  const next = extractField(report, 'NEXT_STEPS');
  // Single-paragraph summary: WHAT_I_DID is the spine; append the NEXT_STEPS as a
  // trailing "Next: …" clause when present, and a short status qualifier only when
  // it adds signal (failed / blocked / waiting — "succeeded" is implied by progress).
  // No multi-section **labels** — one task summary, not a stack of sub-headers.
  const base = did || status;
  if (!base) return '';
  let summary = base.trim();
  const lowStatus = status.toLowerCase();
  if (status && /(fail|block|wait)/.test(lowStatus) && !summary.toLowerCase().includes(status.trim().toLowerCase())) {
    summary += ` (${status.trim()})`;
  }
  if (next) summary += ` Next: ${next.trim()}`;
  return summary.replace(/\s+/g, ' ').trim();
}

/** PHASE_SIGNAL values that mark a real, milestone-worthy transition. The noise
 *  values (reconfirmed / conversational) are intentionally excluded so the
 *  milestone log stays one-line-per-meaningful-step, not per-turn. */
const MILESTONE_PHASE_SIGNALS = [
  'plan-written', 'implement-done', 'verify-pass', 'verify-fail', 'review-done', 'committed',
] as const;

/** Friendly label per milestone phase, prefixed to the WHAT_I_DID line. */
const MILESTONE_LABELS: Record<string, string> = {
  'plan-written': '📝 Plan written',
  'implement-done': '🔧 Implemented',
  'verify-pass': '✅ Verified',
  'verify-fail': '❌ Verify failed',
  'review-done': '🔎 Reviewed',
  'committed': '📦 Committed',
};

/**
 * Build a ONE-LINE milestone string from a self-report, or null if this turn's
 * PHASE_SIGNAL isn't a real milestone. The line is `<label> — <WHAT_I_DID>`; the
 * matched signal is returned so callers can log/test it. Exported for unit tests.
 */
export function milestoneFromSelfReport(report: string): { signal: string; line: string } | null {
  const rawSignal = extractField(report, 'PHASE_SIGNAL').toLowerCase();
  if (!rawSignal) return null;
  // PHASE_SIGNAL may be `committed(abc1234)` or `conversational(user-asked-question)`
  // — match on the bare keyword prefix.
  const signal = MILESTONE_PHASE_SIGNALS.find((s) => rawSignal.startsWith(s));
  if (!signal) return null;
  const did = extractField(report, 'WHAT_I_DID').replace(/\s+/g, ' ').trim();
  if (!did) return null;
  return { signal, line: `${MILESTONE_LABELS[signal]} — ${did}` };
}

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
 * SESSION writes its own merged summary via side_question (it re-receives the
 * existing task.summary each time, so multi-day / post-compaction sessions never
 * lose the task's origin), and code deterministically persists summary + milestone,
 * decides notify via the PHASE_SIGNAL lookup (decideNotify), and syncs the phase.
 * Session dead / no answer → skip silently; the next turn's merged report covers
 * the gap.
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
    // ── Ask the session for a structured self-report (side_question) ──
    // The session answers from its own in-cache context (cost rides the session's
    // prompt cache, not Walnut). The existing task.summary is fed INTO the prompt
    // so the session merges rather than rewrites-from-memory — this is what keeps
    // summaries complete across multi-day sessions and compactions. Session dead /
    // timeout → skip; the next turn's merged report covers the gap.
    const { sessionRunner } = await import('../../providers/claude-code-session.js');
    const session = sessionRunner.findByClaudeId(p.sessionId);
    if (!session) {
      log.session.info('turn-complete-summary: session not live — skipped (next turn will merge)', {
        sessionId: p.sessionId, taskId: p.taskId,
      });
      return;
    }

    let existingSummary = '';
    try {
      const { getTask } = await import('../task-manager.js');
      existingSummary = (await getTask(taskId)).summary ?? '';
    } catch { /* task readable failures already guarded upstream */ }

    let selfReport = '';
    try {
      selfReport = (await session.askSideQuestion(
        buildSelfReportPrompt(existingSummary), SELF_REPORT_TIMEOUT_MS,
      )).trim();
    } catch (err) {
      log.session.warn('turn-complete-summary: side_question failed — skipped (next turn will merge)', {
        sessionId: p.sessionId, taskId: p.taskId, error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!selfReport) return;

    log.session.info('turn-complete-summary: got session self-report', {
      sessionId: p.sessionId, taskId: p.taskId, reportLen: selfReport.length,
    });

    // (a) Persist the summary per the session's directive: `unchanged` → '' (skip),
    // `append:` → existing + one sentence, `rewrite:` → replace. updateSummary runs
    // plugin content validation and can reject (e.g. CJK drift on externally-synced
    // tasks) — log and move on; the milestone/notify decisions below don't depend
    // on the persist.
    //
    // Observability contract: parse outcomes are NEVER silent. Every fire logs the
    // resolved directive; a report that parses to NOTHING (no directive AND no
    // legacy-composable fields) is a format regression → ERROR with a report head
    // so `walnut-logs.sh errors` surfaces it immediately.
    const directive = parseSummaryDirective(selfReport);
    const summary = summaryFromSelfReport(selfReport, existingSummary);
    log.session.info('turn-complete-summary: directive parsed', {
      sessionId: p.sessionId, taskId: p.taskId,
      directive: directive.kind, summaryLen: summary.length,
    });
    if (directive.kind === 'none' && !summary) {
      log.session.error('turn-complete-summary: self-report UNPARSEABLE — no TASK_SUMMARY directive and no legacy fields; prompt/format regression?', {
        sessionId: p.sessionId, taskId: p.taskId,
        reportHead: selfReport.slice(0, 300),
      });
    }
    if (summary) {
      try {
        const { updateSummary } = await import('../task-manager.js');
        await updateSummary(taskId, summary);
      } catch (err) {
        log.session.debug('turn-complete-summary: summary persist skipped', {
          taskId: p.taskId, error: err instanceof Error ? err.message : String(err),
        });
      }
      // Backfill SessionRecord.summary for free — this replaces the removed
      // session-summary-gist hook (which paid a full-transcript LLM pass for
      // the same field). QMD prepends it as the highest-signal search chunk.
      try {
        const { updateSessionRecord } = await import('../session-tracker.js');
        await updateSessionRecord(p.sessionId, {
          summary,
          summaryGeneratedAt: new Date().toISOString(),
        });
      } catch (err) {
        log.session.debug('turn-complete-summary: session summary backfill skipped', {
          sessionId: p.sessionId, error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // (b) Append a compact milestone line — only on a real PHASE_SIGNAL transition
    // (plan-written / implement-done / verify-* / review-done / committed). One
    // line per meaningful step, sourced from the session's own WHAT_I_DID.
    // PHASE_SIGNAL drives both milestone AND notify — a missing field silently
    // degrades both, so warn when it's absent (format drift indicator).
    if (!extractField(selfReport, 'PHASE_SIGNAL')) {
      log.session.warn('turn-complete-summary: report has NO PHASE_SIGNAL field — milestone/notify skipped this turn (format drift?)', {
        sessionId: p.sessionId, taskId: p.taskId,
      });
    }
    const milestone = milestoneFromSelfReport(selfReport);
    if (milestone) {
      try {
        const { appendMilestone } = await import('../task-manager.js');
        await appendMilestone(taskId, milestone.line);
        log.session.info('turn-complete-summary: milestone recorded', {
          taskId: p.taskId, sessionId: p.sessionId, signal: milestone.signal,
        });
      } catch (err) {
        log.session.debug('turn-complete-summary: milestone persist skipped', {
          taskId: p.taskId, error: err instanceof Error ? err.message : String(err),
        });
      }
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
        result: selfReport,
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
 * side_question → code persists summary/milestone + PHASE_SIGNAL lookup decides
 * phase/notify. No subagent is dispatched.
 */
export const turnCompleteTriageHook: SessionHookDefinition = {
  id: 'turn-complete-triage',
  name: 'Turn Complete Summary (onTurnComplete)',
  description: 'Collects a session self-report and persists summary/milestone/phase when a turn completes.',
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
