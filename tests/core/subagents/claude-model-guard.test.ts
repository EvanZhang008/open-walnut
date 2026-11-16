/**
 * A Claude subagent given a model that does not exist fails at once, as an engine with no such
 * model does, never running on the default model. Claude Code itself gives no error for a name
 * it does not know (2026-11-16: through Bedrock, `claude -p --model no-such-model-smoke` answered
 * on Opus with is_error false, and a smoke run's subagent did the same), so Walnut refuses the
 * name before anything starts.
 */
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('claude-model-guard'))

import { isClaudeModelName, SESSION_MODELS } from '../../../src/core/types.js'
import { startLightSubagent } from '../../../src/core/subagents/registry.js'

describe('a Claude subagent\'s model', () => {
  it('is a Claude model: every picker alias and its CLI form, and full ids that name a Claude family', () => {
    for (const m of SESSION_MODELS) {
      expect(isClaudeModelName(m.id), m.id).toBe(true)
      expect(isClaudeModelName(m.cliModel), m.cliModel).toBe(true)
    }
    for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2', 'claude-3-5-sonnet-20241022',
      'global.anthropic.claude-opus-5-5', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'claude-opus-4-6[1m]',
      'arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/abc123']) {
      expect(isClaudeModelName(id), id).toBe(true)
    }
  })

  it('is refused when it names no Claude model', () => {
    for (const id of ['no-such-model-smoke', 'gpt-6.1-sol', 'gemini-3-pro', 'opus 5', 'claude', 'claude-gpt', '']) {
      expect(isClaudeModelName(id), id).toBe(false)
    }
  })

  it('fails the run before anything starts, with model_unavailable and the names it takes', async () => {
    await expect(startLightSubagent('5ab0a6e1-aaaa-4bbb-8ccc-dddddddddd77', { engine: 'claude', model: 'no-such-model-smoke', prompt: 'Reply PONG' }))
      .rejects.toMatchObject({ code: 'model_unavailable', status: 400, message: expect.stringContaining('no-such-model-smoke') })
    // The default engine is Claude Code too.
    await expect(startLightSubagent('5ab0a6e1-aaaa-4bbb-8ccc-dddddddddd77', { model: 'no-such-model-smoke', prompt: 'Reply PONG' }))
      .rejects.toMatchObject({ code: 'model_unavailable' })
  })
})
