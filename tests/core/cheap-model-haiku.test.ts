/**
 * The fast background model is the FIRST haiku row of the main provider's
 * catalog. Pin that it is Haiku 5.5 on the API providers, and that its row asks
 * for no thinking round (background parses wanted none on Haiku 4.5 either)
 * and no 1M beta (the window is native).
 */
import { describe, expect, it } from 'vitest'
import { fastModelFor } from '../../src/core/cheap-model.js'
import { MODEL_CATALOG } from '../../src/model/providers/model-catalog.js'

describe('fast model = Haiku 5.5', () => {
  it.each([
    ['bedrock', 'global.anthropic.claude-haiku-5-5'],
    ['anthropic', 'claude-haiku-5-5'],
  ])('%s picks %s', (provider, id) => {
    expect(fastModelFor({ agent: { main_provider: provider } } as never)).toBe(id)
    const row = MODEL_CATALOG[provider]!.find((m) => m.id === id)!
    expect(row.label).toBe('Haiku 5.5')
    expect(row.context_window).toBe(1_000_000)
    expect(row.compat?.native_1m).toBe(true)
    expect(row.compat?.thinking_format).toBeUndefined()
  })

  it('an explicit agent.fast_model still wins', () => {
    expect(fastModelFor({ agent: { main_provider: 'bedrock', fast_model: 'x' } } as never)).toBe('x')
  })
})
