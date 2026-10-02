/**
 * Live opt-ins count only in the live tier.
 *
 * Loaded inside every worker of the mock tiers (imported first by
 * runtime-dir-isolation.ts, which vitest.config.ts and vitest.e2e.config.ts
 * load first; vitest.live.config.ts loads neither). It removes every variable
 * that turns a test live: WALNUT_LIVE_* (a real remote host, mailbox or
 * subscription), LIVE, and WALNUT_TEST_REAL_CLAUDE (which lifts
 * src/core/test-claude-guard.ts).
 *
 * What it protects (2026-10-02)
 * -----------------------------
 * A shell profile exported WALNUT_LIVE_HOST for the live daemon script, so every
 * e2e run on that machine, whoever started it, ran the live daemon files inside
 * the mock tier: their servers dialed the real dev box, replaced its production
 * daemon with the test build, and flapped its cloud bridge for an hour; one file
 * kill -9's that daemon once its sessions answer, and only the mock guard kept
 * them from answering. Live files are named `*.live.test.ts` (ratchet:
 * tests/setup/live-tier-only.test.ts), and this makes an exported opt-in inert
 * everywhere else.
 */

/** A variable that makes a test reach something real. */
export const LIVE_OPT_IN = /^(WALNUT_LIVE_.+|LIVE|WALNUT_TEST_REAL_CLAUDE)$/

/** Remove every live opt-in from `env`; returns the names removed. */
export function stripLiveOptIns(env: NodeJS.ProcessEnv): string[] {
  const removed = Object.keys(env).filter((k) => LIVE_OPT_IN.test(k)).sort()
  for (const k of removed) delete env[k]
  return removed
}

stripLiveOptIns(process.env)
