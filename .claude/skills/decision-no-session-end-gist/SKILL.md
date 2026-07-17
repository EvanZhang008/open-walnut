---
name: decision-no-session-end-gist
description: DECISION — session-end gist summarizer + onSessionEnd/onSessionIdle hooks deleted (2026-07); session:ended fires every turn, not on death. Read before building any "when the session ends, do X" feature.
---

# Decision: No session-end gist, no onSessionEnd hook point

## Summary
**What:** The `session-summary-gist` hook (an LLM pass over the FULL transcript on
`session:ended`) and the `onSessionEnd`/`onSessionIdle` hook mount points were deleted.
**Key takeaway:** The bus event `session:ended` fires after EVERY turn — it is a UI refresh
signal, not session death. Real process death has NO hook point; it lives in the daemon's reap
path. Any "on session end, do X" built on `session:ended` runs once per turn, not once per
session.
**Applies to / when:** Any feature request shaped "when the session ends/goes idle, do X";
any proposal to regenerate `SessionRecord.summary` with a model; anything listening to
`session:ended`.
**Status:** ✅ shipped 2026-07-14 (uncommitted).

## Context

The gist hook re-read the full session transcript (~78K tokens, zero cache hits) to produce one
search-ranking field (`SessionRecord.summary`). Because it was wired to `session:ended` — which
fires per turn — the "once per session" gist actually ran about once per active hour, costing
~$309 over 11 days for a field whose content search already covers (conversation bodies are
indexed per-turn by the serializer).

## Decision

- Gist hook deleted. `SessionRecord.summary` is backfilled for free from `task.summary` inside
  the turn-complete summary flow (see [[decision-summarizer-self-report]]).
- `onSessionEnd`/`onSessionIdle` mount points deleted from `session-hooks/types.ts`, with a
  comment there explaining why they deliberately don't exist.

## Do-not-rebuild list

- Do not re-add a full-transcript summarizer — the free backfill already fills the field, and
  per-turn indexing already covers search recall.
- A real "session died" hook must be built from the daemon reap path (`reapSession()` in
  `daemon-core.ts` — the only place that knows a CLI process actually died), never from
  `session:ended`.

## References
**Code:** `src/core/session-hooks/builtins.ts` (backfill + the NOTE where the gist used to
live) · `src/core/session-hooks/types.ts` (comment on the missing mount points) ·
`src/providers/daemon-core.ts` (`reapSession()` — the real death path)
**Related:** [[decision-summarizer-self-report]]
