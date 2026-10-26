/**
 * The plugin AI row's reply reader (web/src/components/settings/plugin-ai-state.ts): a reply
 * with fields missing, of the wrong type, or no reply at all renders what it has and never
 * throws, so one plugin's partial answer cannot take the Plugins section down.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MONTHLY_USD, money, pluginAiHelp, pluginAiRowVisible, readPluginAiState,
} from '../../web/src/components/settings/plugin-ai-state'

describe('readPluginAiState', () => {
  it('reads a full reply as it is', () => {
    expect(readPluginAiState({ enabled: false, monthlyUsd: 5, spentUsd: 0.11, calls: 4, lastAt: '2026-10-26T08:28:01.063Z' }))
      .toEqual({ enabled: false, monthlyUsd: 5, spentUsd: 0.11, calls: 4, lastAt: '2026-10-26T08:28:01.063Z' })
  })

  it('fills missing or malformed fields with the defaults instead of throwing', () => {
    for (const partial of [{}, { calls: 3 }, { spentUsd: null, monthlyUsd: 'ten' }, { spentUsd: Number.NaN, calls: -1 }]) {
      const state = readPluginAiState(partial)!
      expect(state.monthlyUsd).toBeGreaterThanOrEqual(0)
      expect(() => pluginAiHelp(state)).not.toThrow()
      expect(pluginAiHelp(state)).toMatch(/^\$\d+\.\d\d of \$\d+\.\d\d this month, \d+ calls?/)
    }
    expect(readPluginAiState({ calls: 3 })).toMatchObject({ enabled: true, monthlyUsd: DEFAULT_MONTHLY_USD, spentUsd: 0, calls: 3 })
  })

  it('no reply keeps the row hidden, or keeps what the row already showed', () => {
    for (const nothing of [null, undefined, '', 'oops', [], 42]) expect(readPluginAiState(nothing)).toBeNull()
    const shown = readPluginAiState({ enabled: true, monthlyUsd: 3, spentUsd: 1, calls: 2, lastAt: null })
    expect(readPluginAiState(undefined, shown)).toBe(shown)
    // A PATCH reply carries only the settings: the spend stays what it was.
    expect(readPluginAiState({ enabled: false, monthlyUsd: 3 }, shown)).toMatchObject({ enabled: false, spentUsd: 1, calls: 2 })
  })
})

describe('the row text', () => {
  it('hides an untouched plugin, shows one that used AI or was changed', () => {
    expect(pluginAiRowVisible(null)).toBe(false)
    expect(pluginAiRowVisible(readPluginAiState({}))).toBe(false)
    expect(pluginAiRowVisible(readPluginAiState({ calls: 1 }))).toBe(true)
    expect(pluginAiRowVisible(readPluginAiState({ enabled: false }))).toBe(true)
  })

  it('money never throws', () => {
    expect(money(0.004)).toBe('<$0.01')
    expect(money(0.107788)).toBe('$0.11')
    expect(money(undefined as unknown as number)).toBe('$0.00')
    expect(money(Number.NaN)).toBe('$0.00')
  })

  it('says when the budget is used up and when AI is off', () => {
    expect(pluginAiHelp(readPluginAiState({ monthlyUsd: 1, spentUsd: 1, calls: 9, enabled: false })!))
      .toBe('$1.00 of $1.00 this month, 9 calls. Out of budget: calls are refused until next month or a higher budget. Off: calls are refused.')
    expect(pluginAiHelp(readPluginAiState({ calls: 1, spentUsd: 0.5 })!)).toBe('$0.50 of $10.00 this month, 1 call')
  })
})
