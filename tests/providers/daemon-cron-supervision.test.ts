import { describe, expect, it } from 'vitest'
import {
  beginCronRecovery,
  buildCronResumeArgs,
  createCronSupervision,
  CRON_RECOVERY_WINDOW_MS,
  decideCronRecovery,
  disableCronSupervision,
  enableCronSupervision,
  sameCronProcess,
} from '../../src/providers/daemon-cron-supervision.js'

const sid = '11111111-2222-4333-8444-555555555555'
const now = 1_000_000
const launch = {
  cwd: '/workspace/demo', args: ['claude', '-p', '--model', 'example-model'],
  mode: 'default', cliVersion: '2.1.258',
}
const deadActive = { process: 'dead', cron: 'active' } as const
const record = () => createCronSupervision(sid, launch, now)

describe('cron supervision policy', () => {
  it('delays the first recovery and preserves its persisted deadline', () => {
    const original = record()
    expect(decideCronRecovery(original, deadActive, now)).toEqual({ action: 'wait', until: now + 5000 })
    const queued = { ...original, retryAt: now + 5000 }
    expect(decideCronRecovery(queued, deadActive, now + 1000)).toEqual({ action: 'wait', until: now + 5000 })
    expect(decideCronRecovery(queued, deadActive, now + 5000)).toEqual({ action: 'resume', generation: 1 })
  })

  it.each([
    ['alive', 'active', 'checking'],
    ['dead', 'inactive', 'inactive'],
    ['unknown', 'active', 'checking'],
    ['dead', 'unknown', 'checking'],
  ] as const)('does not spawn for %s process / %s cron', (process, cron, state) => {
    expect(decideCronRecovery(record(), { process, cron }, now)).toMatchObject({ action: 'none', state })
  })

  it('never undoes user stop, even with fresh active evidence', () => {
    const stopped = disableCronSupervision(record(), now + 1)
    const restored = JSON.parse(JSON.stringify(stopped))
    expect(decideCronRecovery(restored, deadActive, now + 10000)).toMatchObject({ action: 'none', state: 'disabled' })
    expect(beginCronRecovery(restored, 1, now + 10000)).toBeNull()
    expect(beginCronRecovery(restored, restored.generation, now + 10000)).toBeNull()
  })

  it('makes an old asynchronous recovery stale after disable then reenable', () => {
    const enabled = enableCronSupervision(disableCronSupervision(record(), now + 1), now + 2)
    expect(enabled.generation).toBe(3)
    expect(beginCronRecovery(enabled, 1, now + 3)).toBeNull()
    expect(beginCronRecovery(enabled, 3, now + 3)?.state).toBe('restarting')
  })

  it('persists and exhausts the three-attempt budget across process restarts', () => {
    let current = record()
    for (let i = 0; i < 3; i++) {
      const started = beginCronRecovery(current, current.generation, now + i)
      expect(started).not.toBeNull()
      current = JSON.parse(JSON.stringify(started))
    }
    expect(decideCronRecovery(current, deadActive, now + 10000)).toMatchObject({
      action: 'none', state: 'blocked', reason: 'retry-budget-exhausted',
    })
    expect(beginCronRecovery(current, 1, now + 10000)).toBeNull()
  })

  it('does not replenish the budget when the system clock moves backwards', () => {
    const current = { ...record(), attempts: [now, now + 1, now + 2] }
    expect(decideCronRecovery(current, deadActive, now - 1000)).toMatchObject({ state: 'blocked' })
  })

  it('does not automatically clear a blocked state after its time window', () => {
    const current = { ...record(), state: 'blocked' as const, reason: 'retry-budget-exhausted', attempts: [now] }
    expect(decideCronRecovery(current, deadActive, now + CRON_RECOVERY_WINDOW_MS + 1)).toMatchObject({ state: 'blocked' })
    expect(enableCronSupervision(current, now).attempts).toEqual([])
  })

  it('keeps a blocked decision through temporary unknown and inactive evidence', () => {
    const current = { ...record(), state: 'blocked' as const, reason: 'retry-budget-exhausted' }
    for (const cron of ['unknown', 'inactive', 'active'] as const) {
      expect(decideCronRecovery(current, { process: 'dead', cron }, now)).toMatchObject({ state: 'blocked' })
    }
  })

  it('requires original launch settings instead of inventing defaults', () => {
    expect(decideCronRecovery({ ...record(), launch: null }, deadActive, now)).toMatchObject({
      state: 'blocked', reason: 'missing-launch-spec',
    })
  })

  it('checks boot, PID and start time without issuing signals', () => {
    const expected = { bootId: 'boot-a', pid: 200, startTime: '1000' }
    expect(sameCronProcess(expected, { ...expected })).toBe(true)
    expect(sameCronProcess(expected, { ...expected, bootId: 'boot-b' })).toBe(false)
    expect(sameCronProcess(expected, { ...expected, startTime: '2000' })).toBe(false)
    expect(sameCronProcess(expected, null)).toBe(false)
    expect(sameCronProcess({ ...expected, pid: 1 }, { ...expected, pid: 1 })).toBe(false)
    expect(sameCronProcess({ ...expected, startTime: '' }, { ...expected, startTime: '' })).toBe(false)
  })
})

describe('cron resume launch arguments', () => {
  it('keeps identity and permission flags but removes one-use launch flags', () => {
    const args = ['claude', '-p', '--session-id', sid, '--resume-session-at', 'cut-1', '--fork-session',
      '--model', 'example-model', '--effort', 'high', '--permission-mode', 'default',
      '--append-system-prompt', 'Keep the original identity.']
    expect(buildCronResumeArgs(args, sid)).toEqual(['claude', '-p', '--model', 'example-model',
      '--effort', 'high', '--permission-mode', 'default', '--append-system-prompt',
      'Keep the original identity.', '--resume', sid])
    expect(args).toContain('--resume-session-at')
  })

  it('replaces an old resume id and supports equals-style flags', () => {
    expect(buildCronResumeArgs(['claude', '-p', '--resume=old-id', '--resume-session-at=cut', '--continue'], sid))
      .toEqual(['claude', '-p', '--resume', sid])
  })

  it('does not interpret option-looking prompt text as a launch option', () => {
    expect(buildCronResumeArgs(['claude', '-p', '--append-system-prompt', '--resume', '--model', 'example'], sid))
      .toEqual(['claude', '-p', '--append-system-prompt', '--resume', '--model', 'example', '--resume', sid])
  })

  it('rejects positional prompts and unknown options instead of replaying work', () => {
    expect(() => buildCronResumeArgs(['claude', '-p', 'continue the work'], sid)).toThrow('Unsupported')
    expect(() => buildCronResumeArgs(['claude', '-p', '--unknown-option', 'value'], sid)).toThrow('Unsupported')
    expect(() => buildCronResumeArgs([], sid)).toThrow('Missing CLI executable')
  })

  it('rejects an invalid session id', () => {
    expect(() => buildCronResumeArgs(['claude'], '../escape')).toThrow('Invalid session id')
  })
})
