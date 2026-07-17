/**
 * Unit tests for the per-session model-catalog helpers in core/types.ts:
 * sessionModelsAsCatalog() (the degraded-mode fallback) and
 * resolveModelSwitchValue() (the shared switch-input validator behind both
 * POST /:id/model and the session:send RPC).
 */
import { describe, it, expect } from 'vitest'
import {
  SESSION_MODELS,
  SESSION_MODEL_CLI_MAP,
  sessionModelsAsCatalog,
  resolveModelSwitchValue,
} from '../../src/core/types.js'

describe('sessionModelsAsCatalog', () => {
  it('mirrors SESSION_MODELS one-to-one with value = LEGACY ALIAS id (not cliModel)', () => {
    const catalog = sessionModelsAsCatalog()
    expect(catalog.map(c => c.value)).toEqual(SESSION_MODELS.map(m => m.id))
    // value must NOT be the cliModel — a fallback-mode switch has to round-trip
    // through the alias branch of resolveModelSwitchValue (today's exact path).
    for (const c of catalog) {
      expect(SESSION_MODEL_CLI_MAP[c.value]).toBeTruthy()
    }
  })

  it('carries display fields from the registry', () => {
    for (const [i, c] of sessionModelsAsCatalog().entries()) {
      expect(c.displayName).toBe(SESSION_MODELS[i].label)
      expect(c.description).toBe(SESSION_MODELS[i].description)
    }
  })

  it('derives effort capability: haiku none, fable full, opus-family no-xhigh only where overridden', () => {
    const catalog = sessionModelsAsCatalog()
    const byValue = Object.fromEntries(catalog.map(c => [c.value, c]))
    expect(byValue['haiku'].supportsEffort).toBe(false)
    expect(byValue['haiku'].supportedEffortLevels).toEqual([])
    expect(byValue['fable'].supportsEffort).toBe(true)
    expect(byValue['fable'].supportedEffortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    // 'opus' alias resolves to family default (flagship: all levels)
    expect(byValue['opus'].supportedEffortLevels).toContain('max')
  })
})

describe('resolveModelSwitchValue', () => {
  it('maps every legacy picker alias to its CLI value (byte-identical to today)', () => {
    for (const m of SESSION_MODELS) {
      expect(resolveModelSwitchValue(m.id)).toBe(m.cliModel)
    }
  })

  it('passes catalog values (full provider IDs) through verbatim', () => {
    expect(resolveModelSwitchValue('global.anthropic.claude-fable-5[1m]'))
      .toBe('global.anthropic.claude-fable-5[1m]')
    expect(resolveModelSwitchValue('us.anthropic.claude-haiku-4-5-20251001-v1:0'))
      .toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0')
    expect(resolveModelSwitchValue('default')).toBe('default')
    // trims surrounding whitespace rather than rejecting
    expect(resolveModelSwitchValue('  global.anthropic.claude-opus-4-8  '))
      .toBe('global.anthropic.claude-opus-4-8')
  })

  it('rejects garbage: empty, whitespace inside, quotes, control chars, oversized', () => {
    expect(resolveModelSwitchValue('')).toBeNull()
    expect(resolveModelSwitchValue('   ')).toBeNull()
    expect(resolveModelSwitchValue('two words')).toBeNull()
    // the literal-quote bug that produced 400s in the field: '"global...."'
    expect(resolveModelSwitchValue('"global.anthropic.claude-opus-4-8"')).toBeNull()
    expect(resolveModelSwitchValue("model'; rm -rf /")).toBeNull()
    expect(resolveModelSwitchValue('a\nb')).toBeNull()
    expect(resolveModelSwitchValue('x'.repeat(300))).toBeNull()
  })
})
