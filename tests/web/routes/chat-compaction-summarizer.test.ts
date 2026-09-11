/**
 * The compaction summarizer is a ONE-SHOT model call, not an agent turn.
 *
 * Summarizing a conversation needs no tools and no second round trip: the whole
 * history is already in the request. What still has to hold is the shape of that
 * one call, because each part of it was a real bug once:
 *   - exactly ONE call per compaction (a loop would bill the summary repeatedly);
 *   - the real history goes on the wire as MessageParam[] with the instruction
 *     LAST, so the provider sees the same message prefix the chat does (serialized
 *     text would lose the cached prefix and change what is summarized);
 *   - maxTokens 20_000, the reference ceiling for a checkpoint summary — a smaller
 *     budget truncates the summary mid-section and the truncation is what gets
 *     persisted;
 *   - the usage row is filed under `compaction` with a real model label, since a
 *     one-shot answer carries none.
 *
 * Real: the summarizer factory and the usage tracker. Mocked: constants (temp
 * dirs) and the model call itself.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-compaction-summarizer'))

const sendMessage = vi.hoisted(() => vi.fn())
vi.mock('../../../src/agent/model.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/agent/model.js')>()
  return { ...actual, sendMessage }
})

import { WALNUT_HOME, CONFIG_FILE } from '../../../src/constants.js'
import type { MessageParam } from '../../../src/agent/model.js'
import { createCompactionCallbacks } from '../../../src/web/routes/chat.js'

const HISTORY: MessageParam[] = [
  { role: 'user', content: 'how do I deploy?' } as MessageParam,
  { role: 'assistant', content: 'run the deploy script' } as MessageParam,
]

interface SentRequest {
  system?: string
  messages: MessageParam[]
  tools?: unknown
  config?: { maxTokens?: number }
}

beforeEach(async () => {
  sendMessage.mockReset()
  sendMessage.mockResolvedValue({
    content: [{ type: 'text', text: 'the checkpoint summary' }],
    stopReason: 'end_turn',
  })
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true })
  await fs.writeFile(CONFIG_FILE, yaml.dump({
    version: 1,
    user: { name: 'Ada' },
    agent: { main_model: 'global.anthropic.claude-sonnet-4-6' },
  }), 'utf-8')
})

afterEach(async () => {
  const { usageTracker } = await import('../../../src/core/usage/index.js')
  usageTracker.close()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('createCompactionCallbacks', () => {
  it('summarizes in one call: history + instruction last, no tools, maxTokens 20_000', async () => {
    const { summarizer } = await createCompactionCallbacks()
    const summary = await summarizer('Summarize the conversation so far.', HISTORY)

    expect(summary).toBe('the checkpoint summary')
    expect(sendMessage).toHaveBeenCalledTimes(1)

    const req = sendMessage.mock.calls[0][0] as SentRequest
    expect(req.config?.maxTokens).toBe(20_000)
    // No tools: a summarizer that could call a tool would need a loop to answer.
    expect(req.tools).toBeUndefined()
    expect(req.messages).toHaveLength(HISTORY.length + 1)
    expect(req.messages.slice(0, HISTORY.length)).toEqual(HISTORY)
    expect(req.messages[req.messages.length - 1]).toEqual({
      role: 'user', content: 'Summarize the conversation so far.',
    })
    expect(typeof req.system).toBe('string')
  })

  it('returns only the answer text, so a multi-block reply still lands as a summary', async () => {
    sendMessage.mockResolvedValue({
      content: [
        { type: 'thinking', thinking: 'weighing what matters' },
        { type: 'text', text: 'part one. ' },
        { type: 'text', text: 'part two.' },
      ],
      stopReason: 'end_turn',
    })
    const { summarizer } = await createCompactionCallbacks()
    expect(await summarizer('go', HISTORY)).toBe('part one. part two.')
  })

  it('an empty answer is empty, not the literal shape of the response', async () => {
    // compact() decides what to do with a blank summary; the summarizer must not
    // hand it a stringified object, which would be persisted as the checkpoint.
    sendMessage.mockResolvedValue({ content: [], stopReason: 'end_turn' })
    const { summarizer } = await createCompactionCallbacks()
    expect(await summarizer('go', HISTORY)).toBe('')
  })

  it('files the usage under compaction, labelled with the configured model', async () => {
    sendMessage.mockResolvedValue({
      content: [{ type: 'text', text: 'summary' }],
      stopReason: 'end_turn',
      // A one-shot answer carries no model label of its own.
      usage: { input_tokens: 1200, output_tokens: 300 },
    })
    const { usageTracker } = await import('../../../src/core/usage/index.js')
    const { summarizer } = await createCompactionCallbacks({ trackUsage: true })
    await summarizer('go', HISTORY)

    const rows = usageTracker.getRecentRecords(10)
    const row = rows.find((r) => r.source === 'compaction')
    expect(row, 'the compaction call must be attributable').toBeTruthy()
    expect(row!.model).toBe('global.anthropic.claude-sonnet-4-6')
    expect(row!.input_tokens).toBe(1200)
    expect(row!.output_tokens).toBe(300)
  })

  it('does not record usage when the caller did not ask for it', async () => {
    sendMessage.mockResolvedValue({
      content: [{ type: 'text', text: 'summary' }],
      stopReason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 5 },
    })
    const { usageTracker } = await import('../../../src/core/usage/index.js')
    const { summarizer } = await createCompactionCallbacks()
    await summarizer('go', HISTORY)
    const rows = usageTracker.getRecentRecords(10)
    expect(rows.some((r) => r.source === 'compaction')).toBe(false)
  })
})
