/**
 * The agent policy as a pure decision (src/core/vault/agent.ts decideAgentUse), the whole
 * matrix: switch (Any = allow, Ask, Off) x item access (unset, never, ask, allow) x sensitive x
 * grant (none, covering, covering fewer fields, expired). The expected answer is written out
 * here as the rule the docs state, not derived from the code. Plus the grant-length words and
 * the "Keep Passwords unlocked" choices (unlock-length.ts).
 */
import { describe, it, expect } from 'vitest'
import { decideAgentUse, grantLengthText, type AgentsSwitch } from '../../../src/core/vault/agent.js'
import { NEW_VAULT_UNLOCK_FOR, unlockChoice, unlocksAtStart } from '../../../src/core/vault/unlock-length.js'
import type { AgentAccess } from '../../../src/core/vault/types.js'

const NOW = 1_800_000_000_000
// Reveal grants: they cover every use, so the matrix below is about fields and time only.
const GRANTS = {
  none: undefined,
  covering: { until: NOW + 60_000, fields: ['password', 'username'], use: 'reveal' },
  partial: { until: NOW + 60_000, fields: ['username'], use: 'reveal' },
  expired: { until: NOW - 1, fields: ['password'], use: 'reveal' },
  forever: { until: Infinity, fields: ['password'], use: 'reveal' },
} as const

/** The documented rule (docs/reference/passwords.md, "Agents"). */
function expected(mode: AgentsSwitch, access: AgentAccess | undefined, sensitive: boolean, grant: keyof typeof GRANTS): string {
  if (access === 'never') return 'refuse'
  if (grant === 'covering' || grant === 'forever') return 'release:grant'
  if (mode === 'off') return sensitive ? 'ask:bio' : 'ask'
  if (sensitive) return 'ask:bio'
  if (mode === 'allow' || access === 'allow') return 'release:allow'
  return 'ask'
}

describe('decideAgentUse: the whole matrix', () => {
  const modes: AgentsSwitch[] = ['allow', 'ask', 'off']
  const accesses: Array<AgentAccess | undefined> = [undefined, 'never', 'ask', 'allow']
  for (const mode of modes) for (const access of accesses) for (const sensitive of [false, true]) for (const grant of Object.keys(GRANTS) as Array<keyof typeof GRANTS>) {
    it(`${mode} x ${access ?? 'unset'} x ${sensitive ? 'sensitive' : 'plain'} x grant ${grant}`, () => {
      const d = decideAgentUse({ mode, access, sensitive, fields: ['password'], grant: GRANTS[grant], now: NOW })
      const got = d.kind === 'refuse' ? 'refuse' : d.kind === 'release' ? `release:${d.via}` : d.biometric ? 'ask:bio' : 'ask'
      expect(got).toBe(expected(mode, access, sensitive, grant))
      if (d.kind === 'refuse') expect(d.code).toBe('agent_never')
    })
  }

  it('a grant covers only the fields it was given', () => {
    expect(decideAgentUse({ mode: 'ask', access: 'ask', sensitive: false, fields: ['username', 'password'], grant: GRANTS.partial, now: NOW }).kind).toBe('ask')
    expect(decideAgentUse({ mode: 'ask', access: 'ask', sensitive: false, fields: ['username'], grant: GRANTS.partial, now: NOW })).toEqual({ kind: 'release', via: 'grant' })
  })
})

describe('a grant covers the use it was approved for', () => {
  const grant = (use?: 'fill' | 'env' | 'reveal') => ({ until: NOW + 60_000, fields: ['password'], ...(use ? { use } : {}) })
  const under = (mode: AgentsSwitch, held: 'fill' | 'env' | 'reveal' | undefined, use: 'fill' | 'env' | 'reveal') =>
    decideAgentUse({ mode, access: 'ask', sensitive: false, fields: ['password'], use, grant: grant(held), now: NOW })

  it('Ask: a reveal grant covers env and fill; a fill or env grant never covers reveal', () => {
    for (const use of ['reveal', 'env', 'fill'] as const) expect(under('ask', 'reveal', use)).toEqual({ kind: 'release', via: 'grant' })
    expect(under('ask', 'fill', 'fill')).toEqual({ kind: 'release', via: 'grant' })
    expect(under('ask', 'env', 'env')).toEqual({ kind: 'release', via: 'grant' })
    expect(under('ask', 'fill', 'reveal').kind).toBe('ask')
    expect(under('ask', 'env', 'reveal').kind).toBe('ask')
    expect(under('ask', 'fill', 'env').kind).toBe('ask')
    expect(under('ask', 'env', 'fill').kind).toBe('ask')
  })

  it('a grant an older Walnut kept (no use) reads fill, the narrowest; a use not named reads reveal', () => {
    expect(under('ask', undefined, 'fill')).toEqual({ kind: 'release', via: 'grant' })
    expect(under('ask', undefined, 'reveal').kind).toBe('ask')
    expect(under('ask', undefined, 'env').kind).toBe('ask')
    expect(decideAgentUse({ mode: 'ask', access: 'ask', sensitive: false, fields: ['password'], grant: grant('fill'), now: NOW }).kind).toBe('ask')
  })

  it('Any: a reveal is still given without an approval (the person\'s choice), whatever grant is held', () => {
    expect(under('allow', 'fill', 'reveal')).toEqual({ kind: 'release', via: 'allow' })
    expect(under('allow', undefined, 'reveal')).toEqual({ kind: 'release', via: 'allow' })
  })
})

describe('grant lengths', () => {
  it('reads as the person picked it', () => {
    expect(grantLengthText(0)).toBe('this one use')
    expect(grantLengthText(3_600_000)).toBe('for an hour')
    expect(grantLengthText(43_200_000)).toBe('for 12 hours')
    expect(grantLengthText(172_800_000)).toBe('for 48 hours')
    expect(grantLengthText(-1)).toBe('until you revoke it')
  })
})

describe('Keep Passwords unlocked', () => {
  it('no choice in config keeps the old 15-minute idle lock (an existing install); a new vault\'s setup writes 48 hours', () => {
    expect(unlockChoice(undefined, false)).toMatchObject({ unlockFor: 'idle', lockAfterIdleMinutes: 15, autoLockMinutes: 15, limits: { idleMs: 15 * 60_000, maxMs: 12 * 3_600_000 } })
    expect(unlockChoice({}, false).unlockFor).toBe('idle')
    expect(NEW_VAULT_UNLOCK_FOR).toBe('48h')
    const c = unlockChoice({ unlock_for: NEW_VAULT_UNLOCK_FOR }, false)
    expect(c).toMatchObject({ unlockFor: '48h', lockAfterIdleMinutes: null, autoLockMinutes: 2880, limits: { idleMs: 48 * 3_600_000, maxMs: 48 * 3_600_000 } })
  })

  it('a config an older Walnut wrote (only auto_lock_minutes) keeps its idle minutes and the 12-hour cap', () => {
    expect(unlockChoice({ auto_lock_minutes: 30 }, false)).toMatchObject({ unlockFor: 'idle', lockAfterIdleMinutes: 30, autoLockMinutes: 30, limits: { idleMs: 30 * 60_000, maxMs: 12 * 3_600_000 } })
    expect(unlockChoice({ auto_lock_minutes: 15, unlock_for: 'idle' }, false).limits.idleMs).toBe(15 * 60_000)
  })

  it('1 h and 12 h are lengths from the unlock', () => {
    expect(unlockChoice({ unlock_for: '1h' }, false)).toMatchObject({ autoLockMinutes: 60, limits: { idleMs: 3_600_000, maxMs: 3_600_000 } })
    expect(unlockChoice({ unlock_for: '12h' }, false)).toMatchObject({ autoLockMinutes: 720, limits: { idleMs: 43_200_000, maxMs: 43_200_000 } })
  })

  it('until restart has no clock; Forever is the machine key, and without it reads until restart', () => {
    expect(unlockChoice({ unlock_for: 'restart' }, false)).toMatchObject({ unlockFor: 'restart', limits: { idleMs: Infinity, maxMs: Infinity } })
    expect(typeof unlockChoice({ unlock_for: 'restart' }, false).autoLockMinutes).toBe('number')
    expect(unlockChoice({ unlock_for: 'always' }, false).unlockFor).toBe('restart')
    // The machine key on: Forever, whatever the config says.
    expect(unlockChoice({ unlock_for: '1h' }, true).unlockFor).toBe('always')
    expect(unlockChoice({ unlock_for: 'bogus' }, false).unlockFor).toBe('idle')
    expect(unlocksAtStart('restart')).toBe(true)
    expect(unlocksAtStart('always')).toBe(true)
    expect(unlocksAtStart('48h')).toBe(false)
  })
})
