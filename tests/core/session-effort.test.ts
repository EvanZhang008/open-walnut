/**
 * Unit tests for the reasoning-effort helpers and registry in core/types.ts.
 *
 * These back the ModelPicker's grey-out logic and the CLI-arg gating in
 * claude-code-session.ts (only pass --effort for effort-capable models).
 */
import { describe, it, expect } from 'vitest'
import {
  SESSION_EFFORTS,
  SESSION_EFFORT_IDS,
  VALID_SESSION_EFFORT_IDS,
  DEFAULT_SESSION_EFFORT,
  modelSupportsEffort,
  modelSupportsXhighEffort,
  modelSupportsMaxEffort,
  modelEffortCapability,
} from '../../src/core/types.js'

describe('session effort registry', () => {
  it('exposes exactly the five CLI-accepted levels in order', () => {
    // Verified against binary 2.1.170: EFFORT_LEVELS = ['low','medium','high','xhigh','max']
    expect(SESSION_EFFORT_IDS).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(SESSION_EFFORTS.map(e => e.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('every effort entry has a label and description', () => {
    for (const e of SESSION_EFFORTS) {
      expect(e.label).toBeTruthy()
      expect(e.description).toBeTruthy()
    }
  })

  it('VALID_SESSION_EFFORT_IDS is the allowlist used by the RPC layer', () => {
    for (const id of SESSION_EFFORT_IDS) {
      expect(VALID_SESSION_EFFORT_IDS.has(id)).toBe(true)
    }
    expect(VALID_SESSION_EFFORT_IDS.has('ultra')).toBe(false)
    expect(VALID_SESSION_EFFORT_IDS.has('')).toBe(false)
  })

  it('the API-default fallback level is high', () => {
    expect(DEFAULT_SESSION_EFFORT).toBe('high')
  })
})

describe('modelSupportsEffort', () => {
  it('returns false for haiku (any casing / raw or alias)', () => {
    expect(modelSupportsEffort('haiku')).toBe(false)
    expect(modelSupportsEffort('HAIKU')).toBe(false)
    expect(modelSupportsEffort('claude-haiku-4-5-20251001')).toBe(false)
  })

  it('returns true for effort-capable Claude 4 families', () => {
    expect(modelSupportsEffort('opus')).toBe(true)
    expect(modelSupportsEffort('opus[1m]')).toBe(true)
    expect(modelSupportsEffort('sonnet')).toBe(true)
    expect(modelSupportsEffort('fable')).toBe(true)
    expect(modelSupportsEffort('claude-opus-4-6')).toBe(true)
    expect(modelSupportsEffort('claude-sonnet-4-6')).toBe(true)
  })

  it('defaults to true for undefined / unknown model strings', () => {
    expect(modelSupportsEffort(undefined)).toBe(true)
    expect(modelSupportsEffort('some-future-model')).toBe(true)
  })
})

describe('modelSupportsMaxEffort', () => {
  // Binary 2.1.170 gNH allowlist, label "Fable 5, Opus 4.6+, Sonnet 4.6".
  it('is true for max-capable models (Opus 4.6+, Sonnet 4.6, Fable 5)', () => {
    expect(modelSupportsMaxEffort('claude-opus-4-6')).toBe(true)
    expect(modelSupportsMaxEffort('global.anthropic.claude-opus-4-6-v1[1m]')).toBe(true)
    expect(modelSupportsMaxEffort('claude-opus-4-8')).toBe(true)
    expect(modelSupportsMaxEffort('opus')).toBe(true)              // bare alias → opus family
    expect(modelSupportsMaxEffort('opus[1m]')).toBe(true)
    expect(modelSupportsMaxEffort('claude-sonnet-4-6')).toBe(true) // sonnet 4.6 HAS max
    expect(modelSupportsMaxEffort('fable')).toBe(true)             // fable 5 HAS max (was wrongly false)
    expect(modelSupportsMaxEffort('claude-fable-5')).toBe(true)
  })

  it('is false for models without max (Haiku, legacy Opus/Sonnet, unknown)', () => {
    expect(modelSupportsMaxEffort('haiku')).toBe(false)
    expect(modelSupportsMaxEffort('claude-opus-4-5')).toBe(false)
    expect(modelSupportsMaxEffort('claude-sonnet-4-5')).toBe(false)
    expect(modelSupportsMaxEffort(undefined)).toBe(false)
    // Unknown family → conservative (no max) even though effort defaults true.
    expect(modelSupportsMaxEffort('some-future-model')).toBe(false)
  })
})

describe('modelSupportsXhighEffort', () => {
  // Binary 2.1.170 XJH allowlist, label "Fable 5, Opus 4.8/4.7 only" (+ Sonnet 5 per docs).
  it('is true for xhigh-capable models (Opus 4.7/4.8, Fable 5, Sonnet 5)', () => {
    expect(modelSupportsXhighEffort('claude-opus-4-8')).toBe(true)
    expect(modelSupportsXhighEffort('claude-opus-4-7')).toBe(true)
    expect(modelSupportsXhighEffort('opus')).toBe(true)            // bare alias → flagship opus
    expect(modelSupportsXhighEffort('claude-fable-5')).toBe(true)
    expect(modelSupportsXhighEffort('fable')).toBe(true)
    expect(modelSupportsXhighEffort('claude-sonnet-5')).toBe(true)
  })

  it('is false where xhigh is unsupported (Opus 4.6, Sonnet 4.6, Haiku, unknown)', () => {
    expect(modelSupportsXhighEffort('claude-opus-4-6')).toBe(false)   // has max, NOT xhigh
    expect(modelSupportsXhighEffort('claude-sonnet-4-6')).toBe(false) // has max, NOT xhigh
    expect(modelSupportsXhighEffort('haiku')).toBe(false)
    expect(modelSupportsXhighEffort(undefined)).toBe(false)
    expect(modelSupportsXhighEffort('some-future-model')).toBe(false)
  })
})

describe('effort capability map: forward-compatibility (per-family default)', () => {
  it('a surprise future Opus version auto-inherits opus caps (effort + xhigh + max) — no code change', () => {
    // The whole point of the family-default map: opus-4-9 / opus-5 need no allowlist edit.
    expect(modelEffortCapability('claude-opus-4-9')).toEqual({ effort: true, xhigh: true, max: true })
    expect(modelEffortCapability('global.anthropic.claude-opus-5-v1[1m]')).toEqual({ effort: true, xhigh: true, max: true })
  })

  it('a future Sonnet inherits sonnet flagship caps (effort + xhigh + max)', () => {
    expect(modelEffortCapability('claude-sonnet-6')).toEqual({ effort: true, xhigh: true, max: true })
  })

  it('older members are pinned by per-model overrides (Opus 4.6 max-but-no-xhigh)', () => {
    expect(modelEffortCapability('claude-opus-4-6')).toEqual({ effort: true, xhigh: false, max: true })
    expect(modelEffortCapability('claude-sonnet-4-6')).toEqual({ effort: true, xhigh: false, max: true })
  })

  it('exposes the full capability object via modelEffortCapability', () => {
    expect(modelEffortCapability('opus')).toEqual({ effort: true, xhigh: true, max: true })
    expect(modelEffortCapability('sonnet')).toEqual({ effort: true, xhigh: true, max: true })
    expect(modelEffortCapability('fable')).toEqual({ effort: true, xhigh: true, max: true })
    expect(modelEffortCapability('haiku')).toEqual({ effort: false, xhigh: false, max: false })
    expect(modelEffortCapability(undefined)).toEqual({ effort: true, xhigh: false, max: false })
  })
})
