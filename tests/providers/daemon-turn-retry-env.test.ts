/**
 * L1 unit — the turn-retry CONFIG CONTRACT: user config → daemon spawn env →
 * daemon-side resolved config.
 *
 * The Mac owns policy (config), the daemon owns execution (env read at boot).
 * A typo on either side of that handoff looks exactly like "the feature doesn't
 * work", with no error anywhere, so the round trip is pinned here.
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { buildTurnRetryEnv, resolveTurnRetryConfig } from '../../src/providers/daemon-core.js'

const ROOT = path.resolve(__dirname, '../..')

describe('buildTurnRetryEnv — config → spawn env', () => {
  it('emits NOTHING when disabled or absent, so a default install spawns a no-op daemon', () => {
    expect(buildTurnRetryEnv(undefined)).toEqual({})
    expect(buildTurnRetryEnv({})).toEqual({})
    expect(buildTurnRetryEnv({ enabled: false })).toEqual({})
    // Even with tuning values present, disabled must emit nothing at all.
    expect(buildTurnRetryEnv({ enabled: false, budget_hours: 24 })).toEqual({})
  })

  it('converts human units (hours/seconds) to the ms the daemon expects', () => {
    expect(buildTurnRetryEnv({
      enabled: true, budget_hours: 12, max_attempts: 200,
      backoff_seconds: 30, backoff_max_seconds: 600,
    })).toEqual({
      WALNUT_TURN_RETRY: '1',
      WALNUT_TURN_RETRY_BUDGET_MS: String(12 * 3600_000),
      WALNUT_TURN_RETRY_MAX_ATTEMPTS: '200',
      WALNUT_TURN_RETRY_BACKOFF_MS: '30000',
      WALNUT_TURN_RETRY_BACKOFF_MAX_MS: '600000',
    })
  })

  it('omits a garbage value so the daemon applies its own default instead of NaN', () => {
    const env = buildTurnRetryEnv({
      enabled: true,
      budget_hours: Number.NaN,
      max_attempts: -5,
      backoff_seconds: Number.POSITIVE_INFINITY,
    })
    expect(env.WALNUT_TURN_RETRY).toBe('1')
    expect(env).not.toHaveProperty('WALNUT_TURN_RETRY_BUDGET_MS')
    expect(env).not.toHaveProperty('WALNUT_TURN_RETRY_MAX_ATTEMPTS')
    expect(env).not.toHaveProperty('WALNUT_TURN_RETRY_BACKOFF_MS')
    // No 'NaN' / 'Infinity' strings anywhere — those would poison the daemon's math.
    for (const v of Object.values(env)) expect(v).toMatch(/^\d+$/)
  })

  it('supports a fractional budget (0.5h = 30min)', () => {
    expect(buildTurnRetryEnv({ enabled: true, budget_hours: 0.5 }).WALNUT_TURN_RETRY_BUDGET_MS)
      .toBe('1800000')
  })

  it('round-trips through the daemon-side resolver with the values intact', () => {
    // THE contract test: what the Mac writes is what the daemon reads.
    const env = buildTurnRetryEnv({
      enabled: true, budget_hours: 6, max_attempts: 50,
      backoff_seconds: 45, backoff_max_seconds: 300,
    })
    expect(resolveTurnRetryConfig(env)).toEqual({
      enabled: true,
      budgetMs: 6 * 3600_000,
      maxAttempts: 50,
      backoffBaseMs: 45_000,
      backoffMaxMs: 300_000,
    })
  })

  it('round-trips a disabled config to a daemon that will not retry', () => {
    expect(resolveTurnRetryConfig(buildTurnRetryEnv({ enabled: false })).enabled).toBe(false)
  })

  it('falls back to the 12h default when only the master switch is set', () => {
    const cfg = resolveTurnRetryConfig(buildTurnRetryEnv({ enabled: true }))
    expect(cfg.enabled).toBe(true)
    expect(cfg.budgetMs).toBe(12 * 3600_000)
    expect(cfg.backoffBaseMs).toBe(30_000)
    expect(cfg.backoffMaxMs).toBe(600_000)
  })
})

describe('spawn-env wiring on BOTH daemon paths', () => {
  const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8')

  // The user asked for retries on local AND remote hosts. Local sessions go
  // through local-daemon.ts, remote ones through daemon-connection.ts — a var
  // added to only one silently leaves half the hosts non-retrying.
  it('both the local and the remote spawn paths pass the retry env through', () => {
    for (const f of ['src/providers/local-daemon.ts', 'src/providers/daemon-connection.ts']) {
      const src = read(f)
      expect(src, `${f}: does not build the retry env`).toContain('buildTurnRetryEnv')
    }
  })

  it('the local path SCRUBS inherited retry vars before applying config', () => {
    // local-daemon builds its env from ...process.env, so a var inherited from
    // whatever spawned walnut would enable retries the user's config has off.
    // The delete must come BEFORE the config-driven assign, or it erases it.
    const src = read('src/providers/local-daemon.ts')
    const scrub = src.indexOf('delete env.WALNUT_TURN_RETRY')
    const apply = src.indexOf('buildTurnRetryEnv')
    expect(scrub, 'no scrub of inherited WALNUT_TURN_RETRY').toBeGreaterThan(-1)
    expect(apply).toBeGreaterThan(-1)
    expect(scrub, 'the scrub runs AFTER the config apply — it would erase the real value')
      .toBeLessThan(apply)
    // Every tuning var needs scrubbing too, not just the master switch.
    for (const v of ['BUDGET_MS', 'MAX_ATTEMPTS', 'BACKOFF_MS', 'BACKOFF_MAX_MS']) {
      expect(src, `WALNUT_TURN_RETRY_${v} is not scrubbed`).toContain(`delete env.WALNUT_TURN_RETRY_${v}`)
    }
  })

  it('the daemon logs its resolved retry policy at boot (ops visibility)', () => {
    const src = read('src/providers/daemon-standalone.ts')
    const at = src.indexOf("'daemon started'")
    expect(at, 'no daemon-started log').toBeGreaterThan(-1)
    expect(src.slice(at, at + 800), 'boot log omits the retry policy').toContain('turnRetry')
  })
})
