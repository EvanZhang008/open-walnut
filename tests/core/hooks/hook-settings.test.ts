/**
 * L1 unit — hook settings: the generic "a hook can have knobs" layer.
 *
 * Before this, a hook was on/off only, so anything with a parameter grew a
 * bespoke block in an unrelated settings section. These tests pin the round trip
 * (config → descriptor → value → validated patch → config) and, most
 * importantly, that writing ONE knob never erases its neighbours — the shipped
 * bug that motivated the recursive merge.
 */

import { describe, it, expect } from 'vitest'
import {
  getByPath,
  patchForPath,
  deepMerge,
  mergeTopLevel,
  resolveSetting,
  coerceSetting,
  buildSettingsPatch,
  type HookSettingDescriptor,
} from '../../../src/core/hooks/settings.js'
import { DAEMON_POLICIES } from '../../../src/core/hooks/daemon-policies.js'
import { TURN_RETRY_DEFAULTS } from '../../../src/providers/daemon-core.js'

const budget: HookSettingDescriptor = {
  key: 'budget_hours',
  label: 'Retry budget',
  path: 'session.turn_retry.budget_hours',
  type: 'number',
  unit: 'hours',
  default: 12,
  min: 0,
  max: 168,
}

describe('getByPath', () => {
  it('reads a nested value', () => {
    expect(getByPath({ session: { turn_retry: { budget_hours: 6 } } }, 'session.turn_retry.budget_hours')).toBe(6)
  })

  it('returns undefined for any missing link instead of throwing', () => {
    expect(getByPath({}, 'session.turn_retry.budget_hours')).toBeUndefined()
    expect(getByPath({ session: null }, 'session.turn_retry.budget_hours')).toBeUndefined()
    expect(getByPath(undefined, 'a.b')).toBeUndefined()
    // A scalar mid-path (hand-edited config.yaml) must not crash the API.
    expect(getByPath({ session: 'oops' }, 'session.turn_retry.budget_hours')).toBeUndefined()
  })
})

describe('patchForPath', () => {
  it('builds the minimal nested object', () => {
    expect(patchForPath('session.turn_retry.budget_hours', 6))
      .toEqual({ session: { turn_retry: { budget_hours: 6 } } })
  })

  it('handles a single-segment path', () => {
    expect(patchForPath('enabled', true)).toEqual({ enabled: true })
  })

  it('names ONLY the keys on the path (no stale copy of siblings)', () => {
    const patch = patchForPath('session.turn_retry.budget_hours', 6)
    expect(Object.keys(patch)).toEqual(['session'])
    expect(Object.keys((patch.session as Record<string, unknown>).turn_retry as object)).toEqual(['budget_hours'])
  })
})

describe('deepMerge', () => {
  it('keeps siblings at EVERY level — the bug this exists for', () => {
    const current = {
      session: {
        cron_policy: 'session-only',
        idle_timeout_minutes: 45,
        turn_retry: { enabled: true, budget_hours: 12, max_attempts: 200 },
      },
    }
    const merged = deepMerge(current, { session: { turn_retry: { enabled: false } } }) as typeof current
    // The toggle applied...
    expect(merged.session.turn_retry.enabled).toBe(false)
    // ...siblings INSIDE the patched object survived...
    expect(merged.session.turn_retry.budget_hours).toBe(12)
    expect(merged.session.turn_retry.max_attempts).toBe(200)
    // ...and siblings one level UP survived too.
    expect(merged.session.cron_policy).toBe('session-only')
    expect(merged.session.idle_timeout_minutes).toBe(45)
  })

  it('replaces arrays wholesale rather than merging them', () => {
    // enabled_modes: ['plan'] means exactly that list, not "add plan".
    const merged = deepMerge({ a: ['x', 'y', 'z'] }, { a: ['plan'] })
    expect(merged).toEqual({ a: ['plan'] })
  })

  it('replaces when either side is not a plain object', () => {
    expect(deepMerge(5, { a: 1 })).toEqual({ a: 1 })
    expect(deepMerge({ a: 1 }, 7)).toBe(7)
    expect(deepMerge({ a: { b: 1 } }, { a: null })).toEqual({ a: null })
  })

  it('does not mutate the input', () => {
    const current = { session: { turn_retry: { enabled: true } } }
    deepMerge(current, { session: { turn_retry: { enabled: false } } })
    expect(current.session.turn_retry.enabled).toBe(true)
  })
})

describe('mergeTopLevel', () => {
  it('returns ONLY the touched top-level keys, fully merged', () => {
    const current = {
      session: { cron_policy: 'session-only', turn_retry: { enabled: true, budget_hours: 12 } },
      hooks: { defs: [{ id: 'keep-me' }] },
      agent: { main_model: 'x' },
    }
    const out = mergeTopLevel(current, { session: { turn_retry: { budget_hours: 6 } } })
    // Untouched top-level keys are absent — sending them back would rewrite
    // unrelated sections and clobber a concurrent writer.
    expect(Object.keys(out)).toEqual(['session'])
    const session = out.session as Record<string, unknown>
    expect(session.cron_policy).toBe('session-only')
    expect((session.turn_retry as Record<string, unknown>).enabled).toBe(true)
    expect((session.turn_retry as Record<string, unknown>).budget_hours).toBe(6)
  })
})

describe('resolveSetting', () => {
  it('uses the stored value when present', () => {
    expect(resolveSetting(budget, { session: { turn_retry: { budget_hours: 6 } } }).value).toBe(6)
  })

  it('falls back to the declared default when config holds nothing', () => {
    expect(resolveSetting(budget, {}).value).toBe(12)
  })

  it('ignores a stored value of the WRONG type (hand-edited yaml)', () => {
    expect(resolveSetting(budget, { session: { turn_retry: { budget_hours: 'twelve' } } }).value).toBe(12)
    expect(resolveSetting(budget, { session: { turn_retry: { budget_hours: null } } }).value).toBe(12)
  })

  it('accepts a stored 0 rather than treating it as absent', () => {
    // 0 is meaningful here (disable by budget); a `||` fallback would eat it.
    expect(resolveSetting(budget, { session: { turn_retry: { budget_hours: 0 } } }).value).toBe(0)
  })

  it('resolves booleans and rejects a non-boolean stored value', () => {
    const flag: HookSettingDescriptor = { key: 'f', label: 'F', path: 'a.b', type: 'boolean', default: false }
    expect(resolveSetting(flag, { a: { b: true } }).value).toBe(true)
    expect(resolveSetting(flag, { a: { b: 'yes' } }).value).toBe(false)
  })
})

describe('coerceSetting', () => {
  it('accepts an in-range number', () => {
    expect(coerceSetting(budget, 6)).toEqual({ ok: true, value: 6 })
    expect(coerceSetting(budget, 0)).toEqual({ ok: true, value: 0 })
    expect(coerceSetting(budget, 168)).toEqual({ ok: true, value: 168 })
  })

  it('REJECTS out-of-range rather than silently clamping', () => {
    // Clamping teaches the user nothing; they'd never learn the real ceiling.
    const over = coerceSetting(budget, 999)
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.error).toContain('<= 168')
    const under = coerceSetting(budget, -1)
    expect(under.ok).toBe(false)
    if (!under.ok) expect(under.error).toContain('>= 0')
  })

  it('rejects non-numbers, NaN and Infinity', () => {
    for (const bad of ['6', null, undefined, {}, [], Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(coerceSetting(budget, bad).ok, `accepted ${String(bad)}`).toBe(false)
    }
  })

  it('rejects a non-boolean for a boolean setting', () => {
    const flag: HookSettingDescriptor = { key: 'f', label: 'F', path: 'a.b', type: 'boolean', default: false }
    expect(coerceSetting(flag, true)).toEqual({ ok: true, value: true })
    expect(coerceSetting(flag, 'true').ok).toBe(false)
    expect(coerceSetting(flag, 1).ok).toBe(false)
  })
})

describe('buildSettingsPatch', () => {
  const descriptors = DAEMON_POLICIES.find(p => p.id === 'turn-error-auto-retry')!.settings!

  it('writes several knobs at once, preserving unrelated config', () => {
    const current = {
      session: { cron_policy: 'session-only', turn_retry: { enabled: true, budget_hours: 12 } },
    }
    const built = buildSettingsPatch(descriptors, { budget_hours: 6, max_attempts: 50 }, current)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const session = built.patch.session as Record<string, unknown>
    const tr = session.turn_retry as Record<string, unknown>
    expect(tr.budget_hours).toBe(6)
    expect(tr.max_attempts).toBe(50)
    expect(tr.enabled).toBe(true)          // untouched knob survives
    expect(session.cron_policy).toBe('session-only') // unrelated sibling survives
  })

  it('rejects an unknown key', () => {
    const built = buildSettingsPatch(descriptors, { nonsense: 1 }, {})
    expect(built.ok).toBe(false)
    if (!built.ok) expect(built.error).toContain('Unknown setting')
  })

  it('is all-or-nothing: one bad value rejects the whole payload', () => {
    // A partial write would leave the hook half-configured.
    const built = buildSettingsPatch(descriptors, { budget_hours: 6, max_attempts: -5 }, {})
    expect(built.ok).toBe(false)
  })
})

describe('declared defaults match the runtime defaults', () => {
  // If these drift, Settings shows one budget while the daemon enforces another
  // — the most confusing possible failure, and invisible without this test.
  const settings = DAEMON_POLICIES.find(p => p.id === 'turn-error-auto-retry')!.settings!
  const byKey = (k: string) => settings.find(s => s.key === k)!.default

  it('turn-retry knobs agree with TURN_RETRY_DEFAULTS', () => {
    expect(byKey('budget_hours')).toBe(TURN_RETRY_DEFAULTS.budgetMs / 3600_000)
    expect(byKey('max_attempts')).toBe(TURN_RETRY_DEFAULTS.maxAttempts)
    expect(byKey('backoff_seconds')).toBe(TURN_RETRY_DEFAULTS.backoffBaseMs / 1000)
    expect(byKey('backoff_max_seconds')).toBe(TURN_RETRY_DEFAULTS.backoffMaxMs / 1000)
  })

  it('every declared setting path sits under the policy config prefix', () => {
    // A typo'd path would write a key nothing ever reads: the UI would look
    // like it saved while the daemon kept its default forever.
    for (const policy of DAEMON_POLICIES) {
      for (const s of policy.settings ?? []) {
        expect(s.path.split('.').length, `${s.key}: path must be nested`).toBeGreaterThan(1)
        if (policy.configPath) {
          const prefix = policy.configPath.split('.').slice(0, -1).join('.')
          expect(s.path.startsWith(prefix + '.'), `${s.key} (${s.path}) not under ${prefix}`).toBe(true)
        }
      }
    }
  })

  it('every setting declares bounds a UI can render', () => {
    for (const policy of DAEMON_POLICIES) {
      for (const s of policy.settings ?? []) {
        expect(s.label.length, `${s.key}: needs a label`).toBeGreaterThan(0)
        if (s.type === 'number') {
          expect(typeof s.default).toBe('number')
          expect(s.min, `${s.key}: needs a min`).not.toBeUndefined()
          expect(s.max, `${s.key}: needs a max`).not.toBeUndefined()
          expect(s.min!).toBeLessThan(s.max!)
        }
      }
    }
  })
})
