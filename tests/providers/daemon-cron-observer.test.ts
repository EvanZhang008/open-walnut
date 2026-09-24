import { describe, expect, it, vi } from 'vitest'
import { createCronObserver, supportsCronRestore, type CronObserverDeps } from '../../src/providers/daemon-cron-observer.js'
import { createCronSupervision } from '../../src/providers/daemon-cron-supervision.js'
import { DEFAULT_CRON_RESTORE_CONFIG, slimCronTranscriptLine } from '../../src/providers/daemon-cron-transcript.js'

const now = Date.UTC(2026, 7, 1, 12)
const sid = '11111111-2222-4333-8444-555555555555'
const launch = { cwd: '/workspace/demo', args: ['claude', '-p'], mode: 'default', cliVersion: '2.1.258' }
const identity = { bootId: 'boot-a', pid: 200, startTime: '100' }
const record = { ...createCronSupervision(sid, launch, now), process: identity }
const lines = [
  { type: 'assistant', uuid: 'a', parentUuid: null, timestamp: new Date(now).toISOString(), message: { content: [{ type: 'tool_use', name: 'CronCreate', id: 'tool', input: { cron: '* * * * *', prompt: 'Example' } }] } },
  { type: 'user', uuid: 'b', parentUuid: 'a', timestamp: new Date(now + 1).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'tool' }] }, toolUseResult: { id: '1234abcd', durable: false, recurring: true } },
].map(slimCronTranscriptLine)

function lab(overrides: Partial<CronObserverDeps> = {}) {
  const deps: CronObserverDeps = {
    bootId: 'boot-a', clock: () => now + 1000,
    process: vi.fn(async () => ({ status: 'dead' as const })),
    cliVersion: vi.fn(async () => '2.1.258'),
    config: vi.fn(async () => DEFAULT_CRON_RESTORE_CONFIG),
    transcript: vi.fn(async () => lines),
    launchBlocker: vi.fn(async () => null),
    ...overrides,
  }
  return { deps, observe: createCronObserver(deps) }
}

describe('cron recovery observation', () => {
  it('combines the real CLI loaded-chain facts with confirmed process death', async () => {
    const l = lab()
    expect(await l.observe(record)).toEqual({ process: 'dead', cron: 'active' })
    expect(l.deps.launchBlocker).toHaveBeenCalledExactlyOnceWith(launch, expect.any(AbortSignal))
  })

  it('does not call a living process scheduler-confirmed', async () => {
    const l = lab({ process: async () => ({ status: 'alive', identity }) })
    expect(await l.observe(record)).toEqual({ process: 'alive', cron: 'active', identity })
    expect(l.deps.cliVersion).not.toHaveBeenCalled()
    expect(l.deps.launchBlocker).not.toHaveBeenCalled()
  })

  it('does not guess through PID reuse, a different boot, or a missing identity', async () => {
    for (const actual of [{ ...identity, startTime: '101' }, { ...identity, bootId: 'boot-b' }]) {
      const l = lab({ process: async () => ({ status: 'alive', identity: actual }) })
      expect(await l.observe(record)).toEqual({ process: 'unknown', cron: 'unknown' })
      expect(l.deps.transcript).not.toHaveBeenCalled()
    }
    expect(await lab({ process: async () => ({ status: 'alive', identity }) }).observe({ ...record, process: null }))
      .toEqual({ process: 'unknown', cron: 'unknown' })
  })

  it('refuses unverified CLI versions and rechecks the installed version after death', async () => {
    expect(supportsCronRestore('2.1.258')).toBe(true)
    for (const version of ['2.1.268', '2.1.999', 'unknown', '2.1.258-dev']) {
      const l = lab({ cliVersion: async () => version })
      expect(await l.observe(record)).toMatchObject({ process: 'dead', blockedReason: 'unsupported-cli-version' })
      expect(l.deps.transcript).not.toHaveBeenCalled()
    }
  })

  it('keeps partial reads and access failures unknown instead of treating them as no cron', async () => {
    for (const error of [new Error('torn tail'), Object.assign(new Error('access denied'), { code: 'EACCES' })]) {
      const l = lab({ transcript: async () => { throw error } })
      expect(await l.observe(record)).toEqual({ process: 'dead', cron: 'unknown' })
    }
  })

  it('blocks on missing recovery inputs and required hooks', async () => {
    const missing = lab({ transcript: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) } })
    expect(await missing.observe(record)).toMatchObject({ blockedReason: 'recovery-input-missing', cron: 'unknown' })
    expect(await lab({ launchBlocker: async () => 'hooks-unavailable' }).observe(record))
      .toEqual({ process: 'dead', cron: 'active', blockedReason: 'hooks-unavailable' })
  })

  it('uses expiration and disable settings without reading more inputs than necessary', async () => {
    const expired = lab({ clock: () => now + DEFAULT_CRON_RESTORE_CONFIG.recurringMaxAgeMs })
    expect(await expired.observe(record)).toEqual({ process: 'dead', cron: 'inactive' })
    expect(expired.deps.launchBlocker).not.toHaveBeenCalled()
    const disabled = lab({ config: async () => ({ ...DEFAULT_CRON_RESTORE_CONFIG, enabled: false }) })
    expect(await disabled.observe(record)).toEqual({ process: 'dead', cron: 'inactive' })
    expect(disabled.deps.transcript).not.toHaveBeenCalled()
  })

  it('cannot proceed without a boot identity or saved launch settings', async () => {
    expect(await lab({ bootId: '' }).observe(record)).toEqual({ process: 'unknown', cron: 'unknown' })
    expect(await lab().observe({ ...record, launch: null })).toMatchObject({ blockedReason: 'missing-launch-spec' })
  })

  it('returns unknown on deadline even when a read ignores its abort signal', async () => {
    const l = lab({ timeoutMs: 20, transcript: async () => new Promise(() => {}) })
    expect(await l.observe(record)).toEqual({ process: 'dead', cron: 'unknown' })
    expect(l.deps.launchBlocker).not.toHaveBeenCalled()
  })

  it('propagates one shared abort signal to every observation boundary', async () => {
    const l = lab()
    await l.observe(record)
    const signal = vi.mocked(l.deps.process).mock.calls[0][1]
    expect(l.deps.cliVersion).toHaveBeenCalledWith(launch, signal)
    expect(l.deps.config).toHaveBeenCalledWith(signal)
    expect(l.deps.transcript).toHaveBeenCalledWith(record, signal)
  })
})
