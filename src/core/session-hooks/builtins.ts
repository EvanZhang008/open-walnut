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

// ── Triage trailing-debounce state ──
// Turn-complete triage is the expensive path (Opus subagent + optional main-agent
// turn over the full conversation). Running it on EVERY turn during an interactive
// back-and-forth burns money for no benefit. Instead we trailing-debounce: each
// turn-complete (re)arms a per-session timer; a user message cancels it (interaction
// is ongoing). Triage fires ONCE only after the session has been quiet for the
// configured window — which is also the best available approximation of "the session
// finished" on a long-running CLI (the only real end-signal is the 2h idle reap).
// Key: sessionId, Value: pending timer. The map self-bounds: every armed timer either
// fires (and self-deletes) or is cancelled (and deletes), so no separate prune needed.
const triageDebounceTimers = new Map<string, NodeJS.Timeout>();
const DEFAULT_TRIAGE_DEBOUNCE_MS = 4 * 60_000; // 4 minutes

// ── Triage agent rate limit ──
// Two-tier design: the CHEAP tier (side_question self-report → code-only persist of
// summary/milestone) runs on every debounced fire; the EXPENSIVE tier (triage
// subagent) is rate-limited to once per hour per session:task. Self-reports that
// arrive while the agent is rate-limited are BUFFERED; when the agent finally runs
// it receives the whole buffered batch and reconciles all of them at once.
// A milestone-worthy PHASE_SIGNAL (plan-written / committed / verify-* …) BYPASSES
// the rate limit — those are the moments a notification decision can't wait an hour.
const triageAgentLastRun = new Map<string, number>();
const TRIAGE_AGENT_MIN_INTERVAL_MS = 60 * 60_000; // 1 hour

/** Self-reports accumulated while the triage agent was rate-limited.
 *  Key: "sessionId:taskId". Drained (and cleared) when the agent runs. */
const pendingSelfReports = new Map<string, Array<{ turnIndex?: number; at: string; report: string }>>();
const MAX_BUFFERED_REPORTS = 20; // safety bound; oldest dropped beyond this

/** Test-only: reset rate-limiter + buffers so unit tests are order-independent.
 *  `keepAgentRuns` clears only the 5s replay cooldown — lets a test invoke runTriage
 *  back-to-back while preserving the 1h agent rate-limit state under test. */
export function __resetTriageRateLimiter(opts?: { keepAgentRuns?: boolean }): void {
  triageLastDispatch.clear();
  if (!opts?.keepAgentRuns) {
    triageAgentLastRun.clear();
    pendingSelfReports.clear();
  }
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
// Instead of the triage subagent reading the full session JSONL to GUESS what the
// session did, we ask the SESSION ITSELF for a structured self-report via the
// native Claude Code side_question control protocol (ClaudeCodeSession.askSideQuestion).
// The session has its full context in-cache, so it's the authoritative source and
// far cheaper than a 4000-token history read. The answer is NOT added to the
// session transcript. Best-effort: on timeout/failure we fall back to the old
// history-reading triage path, so triage never regresses.
// Must stay comfortably under the dispatcher's DEFAULT_HANDLER_TIMEOUT_MS (30s in
// dispatcher.ts) — the hook runs as an inline `handler`, so if the side_question
// outlived that budget the dispatcher would abort the whole hook and triage would
// never dispatch. 20s leaves ~10s headroom for updateSummary + the emit.
const SELF_REPORT_TIMEOUT_MS = 20_000;
const SELF_REPORT_PROMPT =
`You just finished a turn. Give a structured self-report of THIS session so a supervisor can update the task WITHOUT re-reading your transcript. You have the full context — be the authoritative source. Use EXACTLY these labels, each 1-3 sentences, plain text, English only, self-contained (no "this bug"/"the feature"):

WHAT_I_DID: Concrete changes this turn — which files/functions changed and WHY.
STATUS: <succeeded|failed|blocked|waiting> — one human sentence on what works / what doesn't.
CHANGES_TRIED: Approaches attempted, dead-ends, and why abandoned (so next turn won't repeat).
PHASE_SIGNAL: one of — plan-written | implement-done | reconfirmed | verify-pass | verify-fail | review-done | committed(<hash>) | conversational(user-asked-question).
NEXT_STEPS: What you'd do next, or what you need from the human to proceed.
BLOCKERS: Anything blocking, or "none".
USER_INTENT: <question-pending | workflow-command | autonomous> — gist of user's last message.
VERIFIED: <ran-and-saw-pass | assumed | not-applicable> — what evidence you have.
ARTIFACTS: commit hash / PR url / plan file path / key files / screenshot paths, or "none".`;

/** The exact labels emitted by SELF_REPORT_PROMPT. Used to anchor extractField's
 *  field terminator so a wrapped value containing an unrelated ALL-CAPS "WORD:"
 *  line (e.g. "API:", "TODO:", "NOTE:") doesn't prematurely cut the field. */
const SELF_REPORT_LABELS = [
  'WHAT_I_DID', 'STATUS', 'CHANGES_TRIED', 'PHASE_SIGNAL', 'NEXT_STEPS',
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

/** Build the compact Tier-1 task.summary text from a session self-report. The
 *  triage subagent may further refine this, but persisting it here guarantees a
 *  stable summary even if the subagent is skipped/fails. Exported for unit tests. */
export function summaryFromSelfReport(report: string): string {
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

/**
 * runTriage: the actual (expensive) turn-complete triage work — session self-report
 * + triage subagent dispatch. Invoked from the trailing-debounce timer below, NOT
 * directly on turn completion, so a burst of interactive turns collapses into one run.
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
  // each one spawns a full triage subagent (task_get + task_update + notify_main_agent).
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
      const { DEFAULT_TRIAGE_AGENT_ID } = await import('../agent-registry.js');
      const { getConfig } = await import('../config-manager.js');
      const config = await getConfig();
      const triageAgentId = config.agent?.session_triage_agent ?? DEFAULT_TRIAGE_AGENT_ID;

      // Build recent notification history so triage can avoid duplicates
      let notificationContext = '';
      try {
        const { getTriageEntries } = await import('../chat-history.js');
        const { entries } = await getTriageEntries(10, p.taskId);
        // Filter to entries that actually triggered main agent notification:
        // New entries: tag:'ai' source:'triage' (stored via addAIMessages)
        // Legacy entries: notification === false (stored via addNotification)
        const notified = entries.filter(e => e.tag === 'ai' || e.notification === false);
        if (notified.length > 0) {
          const lines = notified.slice(0, 5).map(e => {
            const ts = e.timestamp ? new Date(e.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '?';
            const contentStr = typeof e.content === 'string' ? e.content : '';
            const summary = contentStr.slice(0, 150) || '(no content)';
            return `[${ts}] ${summary}`;
          });
          notificationContext = `<recent_notifications>\nThese are the most recent notifications you sent to the main agent for this task:\n${lines.join('\n')}\n</recent_notifications>`;
        }
      } catch (err) {
        log.session.warn('failed to load notification history for triage', {
          taskId: p.taskId, error: err instanceof Error ? err.message : String(err),
        });
      }

      // ── CHEAP TIER: ask the session for a structured self-report (side_question) ──
      // The session is the authoritative source for what it just did, and it answers
      // from its own in-cache context (cost lands on the Claude Code session, not
      // Walnut). When this succeeds we (a) persist a Tier-1 summary immediately and
      // (b) inject the self-report so the triage subagent reconciles instead of
      // reading the full JSONL. On any failure we leave selfReport='' → triage falls
      // back to the history-reading path (its session_history context source loads).
      let selfReport = '';
      try {
        const { sessionRunner } = await import('../../providers/claude-code-session.js');
        const session = sessionRunner.findByClaudeId(p.sessionId);
        if (session) {
          selfReport = (await session.askSideQuestion(SELF_REPORT_PROMPT, SELF_REPORT_TIMEOUT_MS)).trim();
          if (selfReport) {
            // (a) Persist an EARLY Tier-1 summary as a best-effort optimization so a
            // usable summary exists even before the triage subagent runs. This can
            // fail — updateSummary runs plugin content validation, and although the
            // prompt asks for English, models drift to CJK (see CLAUDE.md Opus 4.8
            // note) and externally-synced sources reject CJK. That's OK: we ALSO
            // inject the self-report as triage context below, so the triage subagent
            // still produces the authoritative summary via its own validated path.
            // Hence a persist failure is logged at debug, not treated as data loss.
            const summary = summaryFromSelfReport(selfReport);
            if (summary) {
              try {
                const { updateSummary } = await import('../task-manager.js');
                await updateSummary(taskId, summary);
              } catch (err) {
                log.session.debug('turn-complete-triage: early summary persist skipped (triage subagent will still summarize)', {
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
                log.session.debug('turn-complete-triage: session summary backfill skipped', {
                  sessionId: p.sessionId, error: err instanceof Error ? err.message : String(err),
                });
              }
            }

            // (b) Append a compact milestone line — only on a real PHASE_SIGNAL
            // transition (plan-written / implement-done / verify-* / review-done /
            // committed). This replaces the verbose per-turn conversation_log: one
            // line per meaningful step, sourced from the session's own WHAT_I_DID.
            const milestone = milestoneFromSelfReport(selfReport);
            if (milestone) {
              try {
                const { appendMilestone } = await import('../task-manager.js');
                await appendMilestone(taskId, milestone.line);
                log.session.info('turn-complete-triage: milestone recorded', {
                  taskId: p.taskId, sessionId: p.sessionId, signal: milestone.signal,
                });
              } catch (err) {
                log.session.debug('turn-complete-triage: milestone persist skipped', {
                  taskId: p.taskId, error: err instanceof Error ? err.message : String(err),
                });
              }
            }

            log.session.info('turn-complete-triage: got session self-report', {
              sessionId: p.sessionId, taskId: p.taskId, reportLen: selfReport.length,
            });
          }
        }
      } catch (err) {
        // side_question unavailable (session dead / timeout / write fail) → fall back.
        log.session.warn('turn-complete-triage: side_question self-report failed, falling back to history read', {
          sessionId: p.sessionId, taskId: p.taskId, error: err instanceof Error ? err.message : String(err),
        });
      }

      // ── EXPENSIVE TIER: the triage subagent, rate-limited to 1/hour ──
      // The cheap tier above already persisted summary + milestone from the
      // self-report, so most fires need no agent at all. Buffer the report and
      // return. The agent runs when (a) an hour has passed since its last run for
      // this session:task, (b) this turn carries a milestone-worthy PHASE_SIGNAL
      // (notification decisions can't wait an hour), or (c) there is no self-report
      // (session dead/timeout — the agent's history-read is the only summary path).
      const hasMilestoneSignal = selfReport ? milestoneFromSelfReport(selfReport) !== null : false;
      const lastAgentRun = triageAgentLastRun.get(dedupKey) ?? 0;
      const agentDue = now - lastAgentRun >= TRIAGE_AGENT_MIN_INTERVAL_MS;

      // Prune stale rate-limit entries (and their orphaned buffers) so the maps
      // stay bounded across a long-lived server with many sessions.
      if (triageAgentLastRun.size > 200) {
        for (const [k, ts] of triageAgentLastRun) {
          if (now - ts > 2 * TRIAGE_AGENT_MIN_INTERVAL_MS) {
            triageAgentLastRun.delete(k);
            pendingSelfReports.delete(k);
          }
        }
      }

      if (selfReport && !agentDue && !hasMilestoneSignal) {
        const buf = pendingSelfReports.get(dedupKey) ?? [];
        buf.push({ turnIndex: p.turnIndex, at: new Date().toISOString(), report: selfReport });
        if (buf.length > MAX_BUFFERED_REPORTS) buf.shift();
        pendingSelfReports.set(dedupKey, buf);
        log.session.info('turn-complete-triage: agent rate-limited — self-report buffered', {
          sessionId: p.sessionId, taskId: p.taskId,
          buffered: buf.length, nextAgentInMs: TRIAGE_AGENT_MIN_INTERVAL_MS - (now - lastAgentRun),
        });
        return;
      }
      triageAgentLastRun.set(dedupKey, now);

      // Drain anything buffered during the rate-limited window and hand the agent
      // the whole batch (oldest first) so its reconciliation sees every turn.
      const buffered = pendingSelfReports.get(dedupKey) ?? [];
      pendingSelfReports.delete(dedupKey);
      const reports = [...buffered.map(b => b.report), ...(selfReport ? [selfReport] : [])];

      const sessionType = p.isPlanSession ? 'plan-mode ' : '';
      // With self-report(s), triage reconciles them against the prior summary and
      // reads PHASE_SIGNAL directly — no JSONL guessing. Without any, it falls
      // back to reading <session_history>.
      const batchNote = reports.length > 1
        ? ` ${reports.length} turns completed since the last triage run; ALL their self-reports are below in chronological order — reconcile the full batch, not just the last one.`
        : '';
      const triageTask = reports.length > 0
        ? `A Claude Code ${sessionType}session finished ${reports.length > 1 ? `${reports.length} turns` : 'a turn'} for task ${p.taskId}. Session ID: ${p.sessionId}. Turn index: ${p.turnIndex ?? 'unknown'}.${batchNote}\n\nThe session reported its own status below (<session_self_summary>). Use it as the authoritative source — do NOT call session_history (you already have what you need). Reconcile it with the existing task summary, refresh the summary/note, and decide from its PHASE_SIGNAL and USER_INTENT fields only whether to notify the main agent.`
        : `A Claude Code ${sessionType}session just finished for task ${p.taskId}. Session ID: ${p.sessionId}. Turn index: ${p.turnIndex ?? 'unknown'}.\n\nThe <session_history> context below contains recent messages (User + Assistant) with [index] labels. Use these to understand what happened, refresh the summary/note, and decide whether to notify. If you need full details of a specific message, call session_history with index=N.`;

      const selfReportContext = reports.length > 0
        ? `<session_self_summary>\nThe session produced ${reports.length > 1 ? 'these structured self-reports (oldest first)' : 'this structured self-report'} of the turn${reports.length > 1 ? 's' : ''} since the last triage. Treat them as authoritative; do not re-read the transcript.\n\n${reports.join('\n\n---\n\n')}\n</session_self_summary>`
        : '';
      const combinedContext = [selfReportContext, notificationContext].filter(Boolean).join('\n\n');

      bus.emit('subagent:start', {
        agentId: triageAgentId,
        task: triageTask,
        taskId: p.taskId,
        context_override: {
          taskId: p.taskId, sessionId: p.sessionId, cwd: p.session?.cwd, host: p.session?.host,
          // With a self-report in hand, skip the 4000-token session_history read
          // it replaces — otherwise the loader runs regardless of the prompt.
          ...(reports.length > 0 ? { suppressSources: ['session_history' as const] } : {}),
        },
        ...(combinedContext ? { context: combinedContext } : {}),
      }, ['subagent-runner'], { source: 'turn-complete-triage' });

    log.session.info('turn-complete-triage hook: dispatched', {
      sessionId: p.sessionId,
      taskId: p.taskId,
      agentId: triageAgentId,
      batchedReports: reports.length,
      bypassedRateLimit: hasMilestoneSignal && !agentDue,
    });
  } catch (err) {
    log.session.error('turn-complete-triage hook failed', {
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
 * pending timer (see messageSendTriageHook) — interaction resumed, no mid-chat triage.
 *
 * The fired work itself is two-tier (see runTriage): a cheap per-fire self-report
 * persist, and the triage subagent rate-limited to 1/hour (milestones bypass).
 */
export const turnCompleteTriageHook: SessionHookDefinition = {
  id: 'turn-complete-triage',
  name: 'Turn Complete Triage (onTurnComplete)',
  description: 'Dispatches triage subagent when a session turn completes successfully.',
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
    // nonexistent task burns an Opus round-trip + side_question updating nothing.
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
