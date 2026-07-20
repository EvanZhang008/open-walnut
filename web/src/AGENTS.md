# Web GUI — Quick Reference

**Full implementation details: `.claude/skills/walnut-web-frontend/SKILL.md`** (single-timeline
model, optimistic dedup, UX patterns, file structure). **Load that skill BEFORE touching session
chat, turn boundaries, or streaming block rendering** — that area has an incident history.

**Task/session search:** read
[`docs/investigation/qmd-search-performance/README.md`](../../docs/investigation/qmd-search-performance/README.md) before
changing search requests, provisional results, stale-response handling, or result merging.

## Invariants you must not break (even without reading the skill)

- **Streaming blocks are APPEND-ONLY.** No event handler deletes blocks. Absorption is a
  render-time filter (`web/src/stream/render-filter.ts`), never a mutation. A missed match may
  render a block twice briefly; it must never vanish.
- Frontend accumulation semantics live in ONE place: `web/src/stream/stream-reducer.ts` (pure
  functions). The server buffer (`src/web/session-stream-buffer.ts`) is its only twin — keep
  them semantically aligned when touching either.
- Optimistic bubble dedup is two-tier (`optimistic-dedup.ts`): non-committed messages only dedup
  against history since the turn watermark; committed against all. Id-first
  (`walnutMessageId`), then count-based multiset text matching.
- Sessions render in TWO surfaces — home slide-out `SessionPanel.tsx` (primary) AND `/sessions`
  `SessionDetailPanel.tsx`. Any session UI change updates BOTH.
- Use the structured logger `import { log } from '@/utils/log'` — never raw `console.log`;
  never `console.debug` (invisible to the disk forwarder). IDs full, never truncated.
