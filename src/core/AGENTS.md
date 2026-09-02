# Core Layer — Quick Reference

**Full implementation details: `.claude/skills/walnut-core-internals/SKILL.md`** (task model,
phase lifecycle, session monitoring, message queue, JSONL patterns, compaction). Load that skill
before non-trivial work in `src/core/`.

**Decision records live in [`docs/decision/`](../../docs/decision/).** Read the relevant record
before rebuilding or "fixing" anything it says was deliberately removed. In particular, read
the [self-report](../../docs/decision/summarizer-self-report.md) and
[session-end](../../docs/decision/no-session-end-gist.md) decisions before changing
turn-complete task updates or session lifecycle hooks.

**Search/indexing:** the engine is `src/lib/hybrid-search/` (self-contained library: tokenizer,
FTS5 schema, two keyword lanes, vector rescore, embed worker) with `src/core/search/` as the
walnut adapter (serializers, event-bus wiring, backfill). Read
[`src/lib/hybrid-search/README.md`](../lib/hybrid-search/README.md) before changing interactive
search, the tokenizer, embedding models, or the indexing path. The library must keep ZERO walnut
imports (`tests/lib/hybrid-search-boundary.test.ts` enforces it).

## Invariants you must not break (even without reading the skill)

- **Daemon-uniform file access (THE one rule):** every read of a Claude Code session-data file
  (transcripts, subagent jsonl, workflow manifests, plan files, stream copies) goes through
  `DaemonFileReader(host ?? '__local__')` — local AND remote, no raw `fs`/`ssh` reads.
  Sanctioned helpers live in `session-file-reader.ts` / `session-history.ts` / `session-changes.ts`.
  Documented exceptions (partial-read fast paths pending a daemon `fs.readRange`):
  `team-reader.ts`, `subagent-poller.ts`, `_areTeammatesStillActive()`.
- **Daemon socket writes:** every daemon→client WS write in `daemon-standalone.ts` MUST use
  `safeSend` (Bun silently drops sends under backpressure). Plain-Node `daemon-source.ts` doesn't
  need it — see the PARITY NOTE there.
- **Canonical JSONL** (`~/.claude/projects/<cwd>/<sid>.jsonl`) is owned by Claude Code — Walnut
  never writes to it. Walnut's own copy is the streams-dir jsonl.
- Task `phase` is the source of truth; `status` is derived (`applyPhase()` mutates both).
- Child tasks (`parent_task_id`) are the canonical subtask model; embedded `task.subtasks` is
  legacy — do not extend.
