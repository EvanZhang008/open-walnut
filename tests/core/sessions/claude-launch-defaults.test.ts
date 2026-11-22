/**
 * The one rule for the model and effort a Claude Code spawn runs on when nobody picked them
 * (src/core/sessions/claude-launch-defaults.ts):
 *
 *   effort: own > project default_effort > Walnut launch_defaults.effort (then agent.session_effort) > none
 *   model:  own > Walnut launch_defaults.model (never under a conversation that already has a model) > none
 */
import { describe, it, expect } from 'vitest'
import {
  isClaudeLaunchModel, observedClaudeDefaultEfforts, pickClaudeSpawnDefaults, takesLaunchDefaults, walnutDefaultEffort, walnutDefaultModel,
} from '../../../src/core/sessions/claude-launch-defaults.js'
import { SESSION_EFFORT_IDS } from '../../../src/core/types.js'

const unset = { launch_defaults: {} }
const high = { launch_defaults: { effort: 'high', model: 'sonnet' } }

describe('Walnut default model and effort settings', () => {
  it('both are unset by default: no flag, Claude Code decides', () => {
    expect(walnutDefaultEffort(unset)).toBeUndefined()
    expect(walnutDefaultModel(unset)).toBeUndefined()
    expect(walnutDefaultEffort(undefined)).toBeUndefined()
    expect(pickClaudeSpawnDefaults({ config: unset })).toEqual({ from: { model: 'claude-code', effort: 'claude-code' } })
  })

  it.each(SESSION_EFFORT_IDS)('a set effort %s is read', (effort) => {
    expect(walnutDefaultEffort({ launch_defaults: { effort } })).toBe(effort)
  })

  it('reads the older agent.session_effort when launch_defaults.effort is unset, and launch_defaults.effort over it', () => {
    expect(walnutDefaultEffort({ agent: { session_effort: 'low' } })).toBe('low')
    expect(walnutDefaultEffort({ launch_defaults: { effort: 'max' }, agent: { session_effort: 'low' } })).toBe('max')
  })

  it('ignores a value that is no effort or no model', () => {
    expect(walnutDefaultEffort({ launch_defaults: { effort: 'turbo' } })).toBeUndefined()
    expect(walnutDefaultModel({ launch_defaults: { model: '' } })).toBeUndefined()
    expect(walnutDefaultModel({ launch_defaults: { model: 'default' } })).toBeUndefined()
    expect(walnutDefaultModel({ launch_defaults: { model: 42 } })).toBeUndefined()
    expect(isClaudeLaunchModel('opus')).toBe(true)
    expect(isClaudeLaunchModel('global.anthropic.claude-fable-5-2')).toBe(true)
  })

  it('a default model must name a Claude model', () => {
    for (const m of ['sonnet', 'opus[1m]', 'claude-opus-5-5']) expect(isClaudeLaunchModel(m)).toBe(true)
    for (const m of ['gpt-6', 'default', '', '  ', 'a b']) expect(isClaudeLaunchModel(m)).toBe(false)
  })

  it('only the user\'s own sessions take them, never one of Walnut\'s lanes or a profiled session', () => {
    expect(takesLaunchDefaults({})).toBe(true)
    expect(takesLaunchDefaults({ lane: null, profile: undefined })).toBe(true)
    expect(takesLaunchDefaults({ lane: 'chat:walnut:c1' })).toBe(false)
    expect(takesLaunchDefaults({ profile: { slim: true } })).toBe(false)
    expect(takesLaunchDefaults(null)).toBe(false)
  })
})

describe('pickClaudeSpawnDefaults: precedence', () => {
  it('a launch with no pick takes Walnut\'s defaults', () => {
    expect(pickClaudeSpawnDefaults({ config: high })).toEqual({
      model: 'sonnet', effort: 'high', from: { model: 'walnut', effort: 'walnut' },
    })
  })

  it('the spawn\'s own pick wins over every default', () => {
    expect(pickClaudeSpawnDefaults({ config: high, projectEffort: 'medium', model: 'opus', effort: 'low' })).toEqual({
      model: 'opus', effort: 'low', from: { model: 'own', effort: 'own' },
    })
  })

  it('the project\'s default effort wins over Walnut\'s', () => {
    expect(pickClaudeSpawnDefaults({ config: high, projectEffort: 'medium' }).effort).toBe('medium')
    expect(pickClaudeSpawnDefaults({ config: unset, projectEffort: 'xhigh' })).toMatchObject({ effort: 'xhigh', from: { effort: 'project' } })
  })

  it('a resume or fork keeps its conversation\'s model, but still takes the default effort', () => {
    expect(pickClaudeSpawnDefaults({ config: high, keepsModel: true })).toEqual({
      effort: 'high', from: { model: 'claude-code', effort: 'walnut' },
    })
  })

  it('a recorded effort (a switch in the session) survives the resume over the default', () => {
    expect(pickClaudeSpawnDefaults({ config: high, effort: 'xhigh', keepsModel: true }).effort).toBe('xhigh')
  })

  it('the picker\'s explicit Auto ("default") is no own model', () => {
    expect(pickClaudeSpawnDefaults({ config: high, model: 'default' }).model).toBe('sonnet')
  })
})

describe('observedClaudeDefaultEfforts: Claude Code\'s own effort per model, as last seen', () => {
  const row = (o: Partial<{ claudeSessionId: string; engine: string; model: string; effort: string; effectiveEffort: string; lastActiveAt: string }>) => ({
    claudeSessionId: 's', lastActiveAt: '2026-11-21T08:00:00Z', ...o,
  })

  it('keeps only sessions Walnut gave no effort, the newest per model, newest first', () => {
    const out = observedClaudeDefaultEfforts([
      row({ claudeSessionId: 'old-fable', model: 'claude-fable-5-2', effectiveEffort: 'low', lastActiveAt: '2026-11-20T00:00:00Z' }),
      row({ claudeSessionId: 'fable', model: 'claude-fable-5-2[1m]', effectiveEffort: 'medium', lastActiveAt: '2026-11-21T09:00:00Z' }),
      row({ claudeSessionId: 'opus', model: 'claude-opus-5-5', effectiveEffort: 'high', lastActiveAt: '2026-11-21T07:00:00Z' }),
      row({ claudeSessionId: 'picked', model: 'claude-sonnet-5-5', effort: 'low', effectiveEffort: 'low' }),
      row({ claudeSessionId: 'codex', engine: 'codex', model: 'gpt', effectiveEffort: 'high' }),
      row({ claudeSessionId: 'no-engine-gpt', model: 'gpt-6.2-sol', effectiveEffort: 'high' }),
      row({ claudeSessionId: 'unread', model: 'claude-haiku-5-5' }),
    ])
    expect(out.map((r) => [r.sessionId, r.effort])).toEqual([['fable', 'medium'], ['opus', 'high']])
  })
})
