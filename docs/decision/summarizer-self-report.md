# Summarizer Self-Report

Status: accepted and implemented 2026-07-16; note format revised 2026-07-18.

## Summary

The per-turn task summarizer subagent (`BUILTIN_TURN_COMPLETE_TRIAGE`) and its
support machinery (hourly rate limiter, report buffer, and milestone bypass)
were deleted. The session writes the summary through the native `side_question`
control channel. A deterministic lookup, `decideNotify`, makes the phase and
notification decisions.

Summary quality is prompt-bound rather than model-bound, but models disagree on
phase and notification decisions. The party with first-hand turn context writes
the text; code makes the decisions.

This record applies to changes in `src/core/session-hooks/builtins.ts`,
especially `runTriage`, `buildSelfReportPrompt`, `parseNoteSections`,
`parseSectionAnswer`, `assembleNote`, `noteShrinkRejected`, and
`decideNotify`. It also applies to proposals to restore a summarizer or
notification-deciding agent.

## Context

Every session turn previously ended with a triage and summary subagent. That
model reread the session output, rewrote `task.summary` and `note`, chose the
task phase, and decided whether to notify the main agent. Usage analysis showed
this family of calls costing roughly $520 per month.

Successive mitigations changed per-turn execution to debouncing and then to a
two-tier design with an hourly limiter, `pendingSelfReports` buffer, and
milestone bypass. Those changes added machinery without answering whether a
model should make deterministic workflow decisions.

## Options Considered

1. Keep the subagent and choose a cheaper or better model.
2. Keep the subagent and replace text JSON output with tool calling.
3. Delete it: have the session self-report through `side_question`, then make
   phase and notification decisions in code.

Option 3 was selected.

## Evidence

A four-model evaluation on 2026-07-15 covered Opus 4.8, Sonnet 4.6, Sonnet 5,
and Haiku 4.5. It used 10 scenarios with two text-JSON runs each (80 calls), and
four scenarios with two real tool-loop runs each (32 runs).

- **Summary quality was prompt-bound.** All four models produced accurate,
  self-contained summaries. The weakest initial behavior, fabricating a summary
  on no-op turns, became 8/8 correct after one prompt clarification. Other
  apparent model gaps traced to ambiguous wording.
- **Notification decisions were inconsistent.** One model falsely notified on
  a pure Q&A turn, one missed a genuine verification failure, and one corrupted
  4/8 tool calls by serializing tool-call markup into the first parameter.
- **Tool form cost roughly twice as much as text form.** It required an extra
  round trip and tool schemas without improving quality for one deterministic
  write.

Raw provider outputs were intentionally not committed. This record retains the
method, aggregate outcomes, and resulting constraints needed to reevaluate the
decision.

## Decision

### Self-Report Timing

After the trailing-debounce quiet window
(`config.agent.triage.debounce_minutes`, default four minutes), the session
answers `buildSelfReportPrompt` through `side_question`. The labeled response
contains five note sections (`EXEC_SUMMARY`, `GOAL`, `CONTEXT`, `PROGRESS`,
`WORK_LOG`) plus `WHAT_I_DID`, `STATUS`, `PHASE_SIGNAL`, `NEXT_STEPS`,
`BLOCKERS`, `USER_INTENT`, and `VERIFIED`.

### One Living Note

The note is the single living task document and replaces the separate summary
and milestones pair:

- **Executive Summary:** human-facing and freely rewritten.
- **Goal:** the search entry point. It starts with the user's request verbatim
  in a `Request:` line, followed by an `Objective:` line containing the derived
  goal and acceptance criteria. A pivot preserves a `(pivoted from: ...)`
  trace.
- **Context:** self-contained background for a newcomer; frozen once correct.
- **Progress:** one high-level line per work item, prefixed with `DONE`, `WIP`,
  `TODO`, or `BLOCKED/WAIT`. Details belong in Work Log.
- **Work Log:** append-only `did` / `found` / `result` entries retaining every
  ID and decision, without timestamps.

`task.summary` is derived from Executive Summary for lists, search, and iOS
short text. It is never independently authored. The Summary (AI) and Milestones
UI cards were removed.

### Existing-Note Feedback

The current `task.note` is included in every prompt. Multi-day and
post-compaction sessions therefore receive the task's origin and accumulated
facts rather than relying on conversational memory.

Each section normally answers `unchanged` or supplies replacement content.
Work Log normally answers `append: <entry>`. After `NOTE_REORG_CAP` (6,000
characters), the prompt permits a reorganization pass. It may merge old Work
Log entries but must retain every ID and decision and may drop only process
narration.

### Fact-Loss Guards

- The assembler never shrinks a note on its own; unchanged sections remain
  byte-for-byte.
- A pre-migration free-form note remains as a preamble until a complete
  five-section response supersedes it.
- `noteShrinkRejected` blocks a rewrite that drops more than 60 percent of a
  large note and emits an error log.
- The prompt forbids deleting facts. Changed facts are superseded with
  `(was: ...)`.

### Plain-Text Protocol

The report uses labeled plain text rather than JSON:

- Strict labels are mandatory.
- `extractField` ends fields only at known labels, so wrapped content such as
  `API:` does not truncate a value, and bold labels are tolerated.
- `parseSectionAnswer` tolerates case, backticks, and quotes around markers.
  Markerless non-empty content is accepted as new content. A missing label
  means unchanged.
- If no note label parses, the code logs an error. Shrink rejection also logs
  an error. Empty or failed `side_question` calls log a warning and skip the
  update so the next turn can self-heal.

Labeled text was selected because strict labeled parsing was at least as
reliable as JSON in the evaluation. JSON introduced fence wrapping, escaping,
and tool-markup failures, while a JSON parse failure discards the whole report.
The labeled protocol degrades field by field.

### Workflow Decisions

- `decideNotify` notifies only for `plan-written`, `verify-fail`, `committed`,
  or `blocked`.
- `USER_INTENT: question-pending` always suppresses notification.
- Repeated identical signals are deduplicated per session and task. A different
  signal resets the gate.
- `applySessionPhase('triage-sync')` permits only
  `AGENT_COMPLETE -> AWAIT_HUMAN_ACTION`.
- Notifications continue to use `subagent:result` with
  `agentId: 'turn-complete-triage'`, preserving the server's `notify_mode`
  gate, UI behavior, and usage classification.
- The event contains only the compact notification in `result`. The full
  self-report is consumed into task and session fields and never enters the
  main chat.
- If the session is dead when the debounce fires, skip with an info log. The
  next turn's merge covers the gap.

## Do Not Rebuild

- Do not restore a summarizer subagent. The
  `BUILTIN_TURN_COMPLETE_TRIAGE` ID survives only as an event and usage
  classifier. A model-driven summarizer or notification decider must first
  refute the evaluation evidence.
- Do not restore the rate limiter, report buffer, or milestone bypass. They
  existed only to amortize the removed subagent.
- If summaries degrade, fix `buildSelfReportPrompt` before considering a model
  change.
- Do not change the report to JSON without rerunning the reliability
  comparison.

## References

- [Session hook implementation](../../src/core/session-hooks/builtins.ts)
- [Agent registry deletion guard](../../src/core/agent-registry.ts)
- [Notification mode gate](../../src/web/server.ts)
- [Self-report unit tests](../../tests/core/turn-complete-self-report.test.ts)
- [Retired-agent guard tests](../../tests/core/summary-agent-no-session-send.test.ts)
- [Session-hook E2E tests](../../tests/e2e/session-hooks.test.ts)
- [Notification-mode E2E tests](../../tests/e2e/triage-notify-mode.test.ts)
- [No session-end gist](no-session-end-gist.md)
