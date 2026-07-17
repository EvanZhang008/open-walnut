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
