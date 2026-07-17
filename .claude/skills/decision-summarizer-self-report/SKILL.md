---
name: decision-summarizer-self-report
description: DECISION — summarizer subagent deleted (2026-07); session self-reports via side_question, code decides phase/notify. Read before touching the turn-complete summary flow or re-adding a summarizer model.
---

# Decision: Summarizer = session self-report + code lookup (no subagent)

## Summary
**What:** The per-turn task summarizer subagent (`BUILTIN_TURN_COMPLETE_TRIAGE`) and all its
support machinery (hourly rate limiter, report buffer, milestone bypass) were deleted. The
session itself writes the summary via the native `side_question` control channel; a
deterministic lookup (`decideNotify`) makes the phase/notify call.
**Key takeaway:** Summary quality is prompt-bound, not model-bound — but the phase/notify
DECISION is exactly where models disagree. So no model decides anything here: the one party
with first-hand context writes the text, code makes the calls.
**Applies to / when:** Any change to `src/core/session-hooks/builtins.ts` (runTriage,
buildSelfReportPrompt, parseSummaryDirective, decideNotify), any proposal to add/restore a
summarizer or notify-deciding agent, any "summaries are bad, switch the model" request.
**Status:** ✅ shipped to prod 2026-07-16 (uncommitted); tests lock the contract.

## Context

Every session turn used to end with a triage/summary subagent: an LLM run that read the
session's output, rewrote `task.summary`/`note`, chose the task phase, and decided whether to
notify the main agent. Usage analysis showed the summarizer family burning ~$520/month, and
successive patches (per-turn → debounced → two-tier with hourly rate limit + `pendingSelfReports`
buffer + milestone bypass) kept adding machinery without asking the root question: *should a
model be making these decisions at all?*

## Options considered

1. Keep the subagent, pick a cheaper/better model.
2. Keep the subagent, switch it from text-JSON output to tool-calling.
3. **Delete it**: session self-reports via `side_question` (rides the session's own prompt
   cache, ~zero marginal cost); deterministic lookup decides phase/notify. ← chosen

## Evidence (4-model eval, 2026-07-15)

Opus 4.8 / Sonnet 4.6 / Sonnet 5 / Haiku 4.5; 10 scenarios × 2 runs text-JSON form (80 calls)
+ 4 scenarios × 2 runs real tool-loop form (32 runs). Raw data was in `/tmp/summary-eval/`.

- **Summary quality is prompt-bound.** All four models produced accurate, self-contained
  summaries. The "worst" model (fabricated a summary on no-op turns) became 8/8 perfect after
  one prompt clarification. Apparent model gaps were prompt-ambiguity artifacts (e.g. "ready
  for review" appearing in both a phase definition and a normal-completion scenario split the
  four models four ways).
- **The notify decision is where models disagree.** Each failed differently: one false notify
  on a pure-Q&A turn; one missed notify on a genuine verify-fail; one model corrupted 4/8 tool
  calls by serializing tool-call XML markup into the first parameter string (a known
  long-context tool-calling failure mode, reproducible against the raw provider API).
- **Tool form costs ~2× text form** (extra round-trip + tool schemas), zero quality gain for a
  recorder that performs one deterministic write.

## Decision (current design, `src/core/session-hooks/builtins.ts`)

- **Self-report via `side_question`** after the trailing-debounce quiet window
  (`config.agent.triage.debounce_minutes`, default 4): the session answers a structured prompt
  (`buildSelfReportPrompt`) with labeled lines — TASK_SUMMARY / WHAT_I_DID / STATUS /
  PHASE_SIGNAL / NEXT_STEPS / BLOCKERS / USER_INTENT / VERIFIED / ARTIFACTS.
- **Existing-summary feedback loop:** the current `task.summary` is fed INTO the prompt every
  time, so multi-day / post-compaction sessions never need to *remember* the task's origin —
  we hand it back. This is what keeps summaries complete forever.
- **Three-way TASK_SUMMARY directive** (cheap-by-default): `unchanged` (~1 token, most turns)
  → `append: <one sentence>` (~20 tokens, normal progress; code concatenates) → `rewrite:
  <paragraph>` (only on direction change/drift). Past `SUMMARY_APPEND_CAP` (600 chars) the
  prompt withholds `append`, forcing the next material change to consolidate — length-triggered,
  deterministic, no consolidator agent.
- **Format: labeled plain text, NOT JSON — with mandatory language + layered error handling.**
  Chosen deliberately: (a) the eval showed strict labeled text parses at least as reliably as
  JSON, and JSON had its own failure modes (markdown fence wrapping; one model corrupting
  structured output with tool markup); (b) a JSON parse failure loses the WHOLE report, while
  labeled text degrades per-field — one malformed field, the other eight still parse; (c)
  multi-line free text inside JSON strings invites escaping errors. Reliability contract:
  - Prompt says "Use EXACTLY these labels" (mandatory language).
  - `extractField` anchors field ends on the known-label set only (a wrapped "API:" line inside
    a value can't truncate the field); tolerates `**bold**` labels.
  - `parseSummaryDirective` tolerates case/backticks/quotes/trailing punctuation on markers.
  - Safe fallbacks, never silent loss: marker-less summary content → treated as `rewrite`
    (accepting it beats dropping it); missing TASK_SUMMARY → compose from WHAT_I_DID/STATUS/
    NEXT_STEPS (legacy path); empty/failed side_question → warn-log and skip, next turn's
    merge self-heals. Every skip/failure path emits a `log.session.warn`/`info` line with
    sessionId+taskId so a parsing regression is visible in logs, not silent.
- **Deterministic notify** (`decideNotify`): notify only on `plan-written | verify-fail |
  committed | blocked`; `USER_INTENT: question-pending` always suppresses; same-signal repeats
  deduped per session:task (different signal resets the gate).
- **Phase sync:** `applySessionPhase('triage-sync')` — only possible transition is
  AGENT_COMPLETE → AWAIT_HUMAN_ACTION.
- **Event compatibility:** notifications still ride `subagent:result` with
  `agentId: 'turn-complete-triage'`, so the server's `notify_mode` gate
  ('off'/'buffered'/'realtime'), UI rendering, and usage classification are unchanged.
- **Dead session** at fire time → skip silently (info log); next turn's merge covers the gap.

## Do-not-rebuild list

- No summarizer subagent — `BUILTIN_TURN_COMPLETE_TRIAGE` is deleted from the registry; the id
  survives only as an event/usage classifier. Re-adding a model-driven summarizer or notify
  decider must first refute the eval evidence above.
- No rate limiter / report buffer / milestone bypass — that machinery only existed to amortize
  the expensive subagent.
- If summaries degrade, fix `buildSelfReportPrompt` — do not reach for a model change first.
- Do not switch the report to JSON without re-running the reliability comparison.

## References
**Code:** `src/core/session-hooks/builtins.ts` (runTriage, buildSelfReportPrompt,
parseSummaryDirective, summaryFromSelfReport, decideNotify, SUMMARY_APPEND_CAP) ·
`src/core/agent-registry.ts` (deletion NOTE) · `src/web/server.ts` (notify_mode gate)
**Tests:** `tests/core/turn-complete-self-report.test.ts` (directive parsing, merge/append
persistence, notify lookup + dedup, dead-session skip) ·
`tests/core/summary-agent-no-session-send.test.ts` (retired agent ids stay deleted) ·
`tests/e2e/session-hooks.test.ts` (turn completion dispatches no subagent) ·
`tests/e2e/triage-notify-mode.test.ts` (notify_mode gate unchanged)
**Related:** [[decision-no-session-end-gist]]
