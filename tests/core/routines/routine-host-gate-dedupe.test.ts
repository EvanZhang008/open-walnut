/**
 * C91: a routine refused by the host gate records the gate's sentence as the
 * run's failure, and tells the human ONCE per `${routineId}|${host}|${code}|${kind}`:
 * three runs on the same problem = one notification; after a run that starts
 * (the problem cleared), the same problem coming back is told again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())
const qs = vi.hoisted(() => ({ fail: true }))
vi.mock('../../../src/core/sessions/quick-start.js', async (orig) => {
  const real = await orig<typeof import('../../../src/core/sessions/quick-start.js')>()
  return {
    ...real,
    quickStartSession: vi.fn(async () => {
      if (qs.fail) {
        const body = { error: 'Claude Code on Build box is 2.1.220, but Opus 5.5 needs 2.1.280 or newer.', code: 'host_not_ready', kind: 'claude_outdated', host: 'buildbox' }
        throw new real.QuickStartError(body.error, 409, body)
      }
      return { id: 'task-1' }
    }),
  }
})
vi.mock('../../../src/core/config-manager.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getConfig: async () => ({ hosts: { buildbox: { hostname: 'build.example.com', label: 'Build box' } } }),
}))

const { createClaudeCodeExecutor, resetRoutineGateNotices } = await import('../../../src/core/routines/executors/claude-code.js')

const job = { id: 'routine-1', name: 'Nightly build' } as never
const executor = { kind: 'claude-code', config: { cwd: '/home/alice/work', host: 'buildbox', instructions: 'go' } } as never

beforeEach(() => { resetRoutineGateNotices(); qs.fail = true })

describe('routine runs refused by the host gate', () => {
  it('fail with the gate sentence and notify once for the same problem, again after it clears and recurs', async () => {
    const notify = vi.fn(async () => {})
    const ex = createClaudeCodeExecutor({ notify })
    for (let i = 0; i < 3; i++) {
      const r = await ex.run(job, executor, 'go')
      expect(r).toEqual({ status: 'error', error: 'Claude Code on Build box is 2.1.220, but Opus 5.5 needs 2.1.280 or newer.' })
    }
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toMatchObject({ dedupKey: 'routine-1|buildbox|host_not_ready|claude_outdated', title: 'Routine "Nightly build" could not start' })
    qs.fail = false
    expect((await ex.run(job, executor, 'go')).status).toBe('ok')
    qs.fail = true
    await ex.run(job, executor, 'go')
    expect(notify).toHaveBeenCalledTimes(2)
  })
})
