# No Session-End Gist or Session-End Hook

Status: accepted and implemented 2026-07-14.

## Summary

The `session-summary-gist` hook and the `onSessionEnd` / `onSessionIdle` hook
mount points were deleted. The gist performed an LLM pass over the full
transcript whenever `session:ended` fired.

The key lifecycle fact is that `session:ended` fires after every turn. It is a
UI refresh signal, not process death. Real process death has no session-hook
mount point; it is known only in the daemon reap path. Any feature built as
"when the session ends, do X" on `session:ended` runs once per turn, not once
per session.

## Context

The gist hook reread a full session transcript of roughly 78,000 tokens with no
cache hits to produce one search-ranking field, `SessionRecord.summary`.
Because it listened to a per-turn event, the intended once-per-session work ran
about once per active hour. It cost roughly $309 over 11 days for a field whose
content was already covered by per-turn conversation indexing.

## Decision

- Keep the gist hook deleted.
- Backfill `SessionRecord.summary` at no additional model cost from
  `task.summary` in the turn-complete self-report flow. See
  [Summarizer self-report](summarizer-self-report.md).
- Keep `onSessionEnd` and `onSessionIdle` absent from the session-hook types.
- Build any future process-death behavior from `reapSession()` in the daemon
  core, which is the lifecycle boundary that actually knows a CLI process died.

## Do Not Rebuild

- Do not add another full-transcript session summarizer. The free backfill
  supplies the ranking field and per-turn indexing already covers conversation
  content.
- Do not treat `session:ended` as process death.
- Do not add process-death behavior to session hooks unless the daemon reap
  path explicitly emits a new event with the required semantics.

## Follow-up: `session:will-reap` (2026-08-22)

The properly-sourced pre-death signal this record left open now exists. `SessionHealthMonitor.checkIdleTimeout` is the idle reaper, so it announces its own decision: a session it is about to kill gets one `session:will-reap` event, emitted after every exemption (team-active, background work, pending permission, liveness) and after the `last_status_change` freshness protection, carrying `remainingMs` (0 to 5 minutes), `idleDurationMs`, `idleTimeoutMs` and `reason: 'idle_timeout'`. The matching session-hook point is `onSessionWillReap`, which plugins may register through the normal hook API.

This does not reopen the deleted hook points. It is not process death: only `reapSession()` in the daemon core sees an actual exit. And it is not per-turn: it fires at most once per idle episode, while the CLI is still alive, so a consumer can act before the process goes away. Real activity re-arms it. `session:ended` is still a per-turn UI refresh signal with no hook point, and must never be treated as either one.

## References

- [Session hook built-ins](../../src/core/session-hooks/builtins.ts)
- [Session hook types](../../src/core/session-hooks/types.ts)
- [Daemon reap path](../../src/providers/daemon-core.ts)
- [Summarizer self-report](summarizer-self-report.md)
