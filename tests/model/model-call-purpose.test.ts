/**
 * model.ts hands a caller's `purpose` to the adapter unchanged
 * (AdapterCallOptions.purpose), and the helpers nobody waits on say
 * `background`: the claude-cli adapter starts those turns in the utility band
 * when the deploy raised the server above it
 * (tests/model/providers/adapter-claude-cli-qos.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'
import type { AdapterCallOptions, ProtocolAdapter } from '../../src/model/providers/types.js'

vi.mock('../../src/constants.js', () => createMockConstants())

let lastOpts: AdapterCallOptions | undefined
const capturingAdapter: ProtocolAdapter = {
  protocol: 'claude-cli',
  sendMessage: vi.fn(async (opts: AdapterCallOptions) => { lastOpts = opts; return { content: [], stopReason: 'end_turn' } as never }),
  sendMessageStream: vi.fn(async (opts: AdapterCallOptions) => { lastOpts = opts; return { content: [], stopReason: 'end_turn' } as never }),
  resetClient: vi.fn(),
}

vi.mock('../../src/model/providers/registry.js', () => ({
  resolveProvider: vi.fn(() => ({ config: { api: 'claude-cli' }, adapter: capturingAdapter })),
  buildProviderMap: vi.fn(() => ({})),
  synthesizeFromLegacy: vi.fn(() => ({})),
  resetAllAdapters: vi.fn(),
}))

vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => ({ version: 1, user: {}, agent: { main_provider: 'claude-cli' }, providers: { 'claude-cli': { api: 'claude-cli' } } })),
}))

import { sendMessage, sendMessageStream } from '../../src/model/model.js'

beforeEach(() => { lastOpts = undefined })

const ask = { system: 'sys', messages: [{ role: 'user' as const, content: 'hi' }] }

describe('call purpose', () => {
  it('reaches the adapter from both entry points, and is absent when the caller says nothing', async () => {
    await sendMessage({ ...ask, purpose: 'background' })
    expect(lastOpts?.purpose).toBe('background')
    await sendMessageStream({ ...ask, purpose: 'background' })
    expect(lastOpts?.purpose).toBe('background')
    await sendMessage(ask)
    expect(lastOpts?.purpose).toBeUndefined()
  })

  // The helpers that run on their own: titles, summaries, placement, memory
  // upkeep. The ones a person waits on (quick-add parsing, the commit message,
  // a routine draft, compaction, the provider test, plugins) stay interactive.
  const BACKGROUND = [
    ['src/core/overview-maintainer.ts', 1], ['src/core/task-ledger-desc.ts', 1],
    ['src/core/session-organize.ts', 1], ['src/core/fork-title.ts', 2], ['src/core/session-title-backend.ts', 1],
    ['src/core/conversation-title.ts', 1], ['src/core/memory/working-memory-updater.ts', 1],
  ] as const
  const INTERACTIVE = ['src/core/quick-task-parse.ts', 'src/core/session-commit.ts', 'src/core/routines/draft.ts', 'src/web/routes/chat.ts']
  const root = path.resolve(import.meta.dirname, '../..')
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')

  it.each(BACKGROUND)('%s marks its model calls background', (file, calls) => {
    const src = read(file)
    expect(src.match(/await sendMessage\(\{/g)?.length).toBe(calls)
    expect(src.match(/purpose: 'background',/g)?.length).toBe(calls)
  })

  it.each(INTERACTIVE)('%s stays interactive', (file) => {
    expect(read(file)).not.toMatch(/purpose: 'background'/)
  })

  // A background call that may ride the CLI waits for a slot and runs in the
  // utility band: its budget fits the channel (fastCallBudgetMs), since the old
  // 10 and 15 s expired there before any answer.
  it.each([
    ['src/core/task-ledger-desc.ts', 1], ['src/core/session-organize.ts', 1], ['src/core/fork-title.ts', 2],
    ['src/core/conversation-title.ts', 1], ['src/core/project-summary.ts', 1],
  ] as const)('%s fits its model call budget to the channel', (file, calls) => {
    const src = read(file)
    expect(src.match(/setTimeout\(\(\) => controller\.abort\(\), /g)?.length).toBe(calls)
    expect(src.match(/fastCallBudgetMs\(config, [\dA-Z]/g)?.length).toBe(calls)
  })

  // A project summary has both kinds of caller: the task-count maintainer and
  // the boot sweep (nobody waits), and "Regenerate summary" (the pane spins).
  it('src/core/project-summary.ts takes its purpose from the caller', () => {
    const src = read('src/core/project-summary.ts')
    expect(src.match(/await sendMessage\(\{/g)?.length).toBe(1)
    expect(src).toMatch(/purpose: opts\.purpose \?\? 'interactive',/)
    expect(src.match(/refreshProjectSummary\([^)]*purpose: 'background' \}\)/g)?.length).toBe(2)
    // Both regenerate routes go through the on-demand refresh, which is interactive.
    expect(src).toMatch(/refreshProjectSummary\(name, \{ purpose: 'interactive', signal: stop\.signal \}\)/)
    for (const route of ['src/web/routes/projects.ts', 'src/web/routes/projects-v1.ts']) {
      expect(read(route)).toMatch(/regenerateSummaryOnDemand\(name, gone\.signal\)/)
    }
  })
})
