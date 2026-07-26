# Testing — Quick Reference

**Full implementation details: `.claude/skills/walnut-testing/SKILL.md`** (5-tier pyramid,
per-tier configs, known pre-existing failures, live test pattern, Playwright modes).

## Essentials

- Tiers: unit (`tests/core|agent`) → integration (`tests/web/routes`, supertest) → e2e
  (`tests/e2e`, real server on port 0) → browser (`tests/e2e/browser`, Playwright) → live
  (`*.live.test.ts`, real APIs, opt-in via `WALNUT_LIVE_TEST=1`).
- Every test file mocks constants to a unique tmpdir: `vi.mock('../../src/constants.js', () =>
  createMockConstants())` — no shared-state pollution between files.
- **The full suite has a pre-existing red baseline — never judge regressions from the aggregate
  count.** Run the touched file in isolation, then diff against a clean HEAD baseline (cp files
  aside → `git checkout HEAD -- <src>` → rerun → restore; `git stash` is banned). Identical
  failure names on HEAD = pre-existing, not yours. The known-failures list is in the skill.
- **Browser tier is serialized machine-wide.** One Chromium per worker (~385 MB), `workers`
  capped at 4, and an exclusive lease on :3457 so a second `npx playwright test` queues instead
  of colliding (specs hardcode that port; `reuseExistingServer` would otherwise let two runs
  share one fixture server). `[pw-concurrency] … Queuing` = working as designed. Debris from a
  killed run: `scripts/pw-cleanup.sh status|clean`. Details in the root AGENTS.md.
- **Timeout-shaped browser failures are usually machine load, not product bugs.** Check
  `scripts/pw-cleanup.sh status` first — at load 486 (14 cores) every spec failed on
  `page.waitForLoadState`. Fixture cold boot: ~20 s idle, ~70 s at load 133.
