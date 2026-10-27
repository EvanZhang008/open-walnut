/**
 * model.ts records a call in the usage table when the caller names a feature
 * (`usage`), and only then: callers that record their own usage (micro-agent,
 * ai-direct, the overview maintainer, compaction) pass nothing and stay counted
 * once. Recording runs off the caller's path and never fails the call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'
import type { ModelResult, ProtocolAdapter } from '../../src/model/providers/types.js'
import type { RecordParams } from '../../src/core/usage/types.js'

vi.mock('../../src/constants.js', () => createMockConstants())

let nextResult: ModelResult = { content: [], stopReason: 'end_turn' }
const stubAdapter: ProtocolAdapter = {
  protocol: 'claude-cli',
  sendMessage: vi.fn(async () => nextResult),
  sendMessageStream: vi.fn(async () => nextResult),
  resetClient: vi.fn(),
}

vi.mock('../../src/model/providers/registry.js', () => ({
  resolveProvider: vi.fn(() => ({ config: { api: 'claude-cli' }, adapter: stubAdapter })),
  buildProviderMap: vi.fn(() => ({})),
  synthesizeFromLegacy: vi.fn(() => ({})),
  resetAllAdapters: vi.fn(),
}))

vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => ({ version: 1, user: {}, agent: { main_provider: 'claude-cli', main_model: 'stub-main-model' }, providers: { 'claude-cli': { api: 'claude-cli' } } })),
}))

const record = vi.fn((_params: RecordParams) => ({}))
vi.mock('../../src/core/usage/index.js', () => ({ usageTracker: { record: (p: RecordParams) => record(p) } }))

import { sendMessage, sendMessageStream } from '../../src/model/model.js'

const ask = { system: 'sys', messages: [{ role: 'user' as const, content: 'hi' }] }
const answer = (usage?: ModelResult['usage']): ModelResult => ({
  content: [{ type: 'text', text: 'ok', citations: null }] as never, stopReason: 'end_turn', ...(usage && { usage }),
})
const settle = () => new Promise((r) => setTimeout(r, 20))

beforeEach(() => {
  record.mockReset()
  record.mockImplementation(() => ({}))
})

describe('model call usage', () => {
  it('records one row with the feature, the model and all four token counts', async () => {
    nextResult = answer({
      model: 'stub-haiku', input_tokens: 120, output_tokens: 30,
      cache_creation_input_tokens: 7, cache_read_input_tokens: 900,
    })
    await sendMessage({ ...ask, usage: { source: 'title', agentId: 'fork-title', taskId: 't-1', sessionId: 's-1' } })
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1))
    const row = record.mock.calls[0]![0]
    expect(row).toMatchObject({
      source: 'title', agentId: 'fork-title', taskId: 't-1', sessionId: 's-1', model: 'stub-haiku',
      input_tokens: 120, output_tokens: 30, cache_creation_input_tokens: 7, cache_read_input_tokens: 900,
    })
    expect(row.duration_ms).toBeGreaterThanOrEqual(0)
  })

  it('falls back to the resolved model, and works for the streaming call too', async () => {
    nextResult = answer({ input_tokens: 5, output_tokens: 1 })
    await sendMessageStream({ ...ask, usage: { source: 'transfer' } })
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1))
    const row = record.mock.calls[0]![0]
    expect(row).toMatchObject({ source: 'transfer', model: 'stub-main-model', input_tokens: 5, output_tokens: 1 })
    expect(row).not.toHaveProperty('taskId')
    expect(row).not.toHaveProperty('agentId')
  })

  it('records nothing without `usage`, or when the adapter reports no usage', async () => {
    nextResult = answer({ input_tokens: 10, output_tokens: 2 })
    await sendMessage(ask)
    await sendMessageStream(ask)
    nextResult = answer()
    await sendMessage({ ...ask, usage: { source: 'summary' } })
    await settle()
    expect(record).not.toHaveBeenCalled()
  })

  it('a recording failure never fails the call', async () => {
    record.mockImplementation(() => { throw new Error('usage db is locked') })
    nextResult = answer({ input_tokens: 10, output_tokens: 2 })
    const result = await sendMessage({ ...ask, usage: { source: 'quick-parse' } })
    expect(result.content).toHaveLength(1)
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1))
    await settle()
  })

  // Callers that record their own usage must not ask model.ts to record too.
  const root = path.resolve(import.meta.dirname, '../..')
  it.each([
    'src/model/micro-agent.ts', 'src/core/ai/ai-direct.ts', 'src/core/overview-maintainer.ts', 'src/web/routes/chat.ts',
  ])('%s records its own usage and passes none to model.ts', (file) => {
    const src = fs.readFileSync(path.join(root, file), 'utf8')
    expect(src).toMatch(/usageTracker\.record\(/)
    expect(src).not.toMatch(/\busage: \{ source:/)
  })
})
