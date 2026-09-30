/**
 * The unprompted title and label calls obey the background-AI gate.
 *
 * A conversation's auto title (after its first exchange) and a new task's
 * one-line ledger label are model calls nobody asked for. Every other such call
 * is skipped under `backgroundAiDisabled()` (tests, WALNUT_DISABLE_BACKGROUND_AI),
 * but these two were not, so every test server that wrote a chat row or created
 * a task ran the configured engine for them: on a dev machine, the real `claude`
 * CLI (the 2026-09-30 gate found its transcripts from six route test files). A
 * test must never spawn the real CLI.
 *
 * The workers themselves stay callable (their own unit tests call them directly
 * with a mocked model); only the unprompted CALL SITES are gated.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-bg-ai-sites'))

// Belt and braces while the gate is lifted below: no model call can leave this file.
vi.mock('../../src/model/model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/model/model.js')>()),
  sendMessage: vi.fn(async () => { throw new Error('no model calls in this test') }),
}))

const generateConversationTitle = vi.hoisted(() => vi.fn(async () => null))
vi.mock('../../src/core/conversation-title.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/conversation-title.js')>()),
  generateConversationTitle,
}))
const getTask = vi.hoisted(() => vi.fn(async () => null))
vi.mock('../../src/core/task-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/task-manager.js')>()),
  getTask,
}))

import * as chatHistory from '../../src/core/chat-history.js'
import { createConversation } from '../../src/core/conversations.js'
import { scheduleLedgerDesc } from '../../src/core/task-ledger-desc.js'
import { backgroundAiDisabled } from '../../src/core/cheap-model.js'

const GATE_ENV = ['VITEST', 'VITEST_WORKER_ID', 'NODE_ENV', 'WALNUT_DISABLE_BACKGROUND_AI'] as const

/** Run `fn` as a production server would: every gate variable cleared, then restored. */
async function asProduction(fn: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(GATE_ENV.map((k) => [k, process.env[k]]))
  for (const k of GATE_ENV) delete process.env[k]
  try {
    expect(backgroundAiDisabled()).toBe(false)
    await fn()
  } finally {
    for (const k of GATE_ENV) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

async function oneExchange(conversationId: string): Promise<void> {
  await chatHistory.addUserMessage('what is on today', { displayText: 'what is on today', agentId: 'general', conversationId })
  await chatHistory.addAIMessages(
    [{ role: 'assistant', content: [{ type: 'text', text: 'two meetings' }] }] as never,
    { agentId: 'general', conversationId },
  )
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

beforeEach(() => {
  generateConversationTitle.mockClear()
  getTask.mockClear()
})

describe('conversation auto title', () => {
  it('is not generated on a test server', async () => {
    expect(backgroundAiDisabled()).toBe(true)
    const conv = await createConversation('general')
    await oneExchange(conv.id)
    await settle()
    expect(generateConversationTitle).not.toHaveBeenCalled()
  })

  it('is generated on a production server (the gate, not a broken call site)', async () => {
    const conv = await createConversation('general')
    await asProduction(async () => {
      await oneExchange(conv.id)
      await settle()
    })
    expect(generateConversationTitle).toHaveBeenCalledWith('general', conv.id)
  })

  it('every call site in src is gated (the ones above plus the lane touch in session-chat.ts)', () => {
    const root = path.join(import.meta.dirname, '..', '..', 'src')
    const sites: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.ts') && !full.endsWith(path.join('core', 'conversation-title.ts'))) {
          const lines = fs.readFileSync(full, 'utf-8').split('\n')
          lines.forEach((line, i) => {
            if (!/\bgenerateConversationTitle\(/.test(line)) return
            const before = lines.slice(Math.max(0, i - 12), i).join('\n')
            sites.push(`${path.relative(root, full)}:${i + 1}:${/backgroundAiDisabled\(\)/.test(before) ? 'gated' : 'UNGATED'}`)
          })
        }
      }
    }
    walk(root)
    expect(sites.length).toBeGreaterThanOrEqual(2)
    expect(sites.filter((s) => s.endsWith('UNGATED'))).toEqual([])
  })
})

describe('task ledger label', () => {
  it('is not scheduled on a test server', async () => {
    scheduleLedgerDesc('task-abc')
    await settle()
    expect(getTask).not.toHaveBeenCalled()
  })

  it('is scheduled on a production server', async () => {
    await asProduction(async () => {
      scheduleLedgerDesc('task-abc')
      await settle()
    })
    expect(getTask).toHaveBeenCalledWith('task-abc')
  })
})
