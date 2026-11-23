/**
 * "Regenerate summary" in the project pane: the client waits as long as the
 * server may work on one (SUMMARY_REGENERATE_DEADLINE_MS, a direct attempt and
 * then a `claude -p` fallback). With the default 15 s the spinner stopped while
 * a CLI turn kept its slot for up to 45 s more, and every repeat click started
 * another turn.
 *
 * Real: web/src/api/projects.ts and its client. Fake: fetch, the model module
 * (only the server's constant is read); the page's deadlines are recorded.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-regenerate-timeout'))
vi.mock('../../src/model/model.js', () => ({ sendMessage: vi.fn() }))
/** Every page deadline goes through deadline-signal.ts: record the ones set. */
const deadlines = vi.hoisted(() => ({ set: [] as number[] }))
vi.mock('../../web/src/utils/deadline-signal', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../web/src/utils/deadline-signal')>()
  return { deadlineSignal: (ms: number) => { deadlines.set.push(ms); return real.deadlineSignal(ms) } }
})

import { REGENERATE_SUMMARY_TIMEOUT_MS, regenerateProjectSummary } from '../../web/src/api/projects'
import { SUMMARY_REGENERATE_DEADLINE_MS } from '../../src/core/project-summary.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('regenerateProjectSummary (web client)', () => {
  it('waits longer than the server works on one regenerate', async () => {
    expect(REGENERATE_SUMMARY_TIMEOUT_MS).toBeGreaterThan(SUMMARY_REGENERATE_DEADLINE_MS)
    deadlines.set = []
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ summary: 'Marina work.', summary_task_count: 1 }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await regenerateProjectSummary('marina')).toEqual({ summary: 'Marina work.', summary_task_count: 1 })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/projects/marina/summary/regenerate')
    expect(deadlines.set).toEqual([REGENERATE_SUMMARY_TIMEOUT_MS])
  })
})
