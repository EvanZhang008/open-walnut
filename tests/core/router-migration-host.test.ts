import { describe, expect, it, vi } from 'vitest'
import { cronJobRevision } from '../../src/core/cron/job-revision.js'
import type { CronJob } from '../../src/core/cron/types.js'
import { ensureLegacySnapshotHost, snapshotLegacyWatcher, type MigrationHostDeps } from '../../src/core/router/migration-host.js'

function fixture() {
  const job = { id: 'watch-dock', name: 'Dock mail', enabled: false, createdAtMs: 1, updatedAtMs: 2,
    schedule: { kind: 'every', everyMs: 300_000 }, check: { run: 'fixture-check', host: 'fixture-host' }, state: {} } as CronJob
  const state = { cursor: '42', seen: { 'message-1': Date.now() }, pendingFires: [] }
  const push = vi.fn(async () => undefined)
  const send = vi.fn(async () => ({ ok: true, supported: true, complete: true, frozen: true, state, seenReliableUntil: Date.now() + 86_400_000 }))
  const deps: MigrationHostDeps = {
    job: vi.fn(async () => structuredClone(job)),
    daemon: vi.fn(async () => ({ host: 'fixture-host', hasCapability: () => true, pushTriggersNow: push, send })),
  }
  return { job, state, push, send, deps }
}

describe('legacy watcher host snapshot', () => {
  it('waits for the configured pause and reads one exact scoped host state, without running a check', async () => {
    const w = fixture()
    expect(await snapshotLegacyWatcher(w.job.id, '/fixture-home', w.deps)).toMatchObject({
      supported: true, complete: true, frozen: true, state: w.state,
      config: { id: w.job.id, enabled: false },
    })
    expect(w.push).toHaveBeenCalledOnce()
    expect(w.send).toHaveBeenCalledExactlyOnceWith('triggers.state.snapshot', { home: '/fixture-home', triggerId: w.job.id }, 5000)
    expect(w.push.mock.invocationCallOrder[0]).toBeLessThan(w.send.mock.invocationCallOrder[0]!)
  })

  it('refuses an enabled routine, a disconnected host, or an older host before any state command', async () => {
    const w = fixture()
    w.job.enabled = true
    expect(await snapshotLegacyWatcher(w.job.id, '/fixture-home', w.deps)).toMatchObject({ supported: false })
    expect(w.send).not.toHaveBeenCalled()
    w.deps.daemon = async () => null
    await expect(ensureLegacySnapshotHost(w.job.id, '/fixture-home', w.deps)).rejects.toMatchObject({ code: 'watcher_state_unsupported' })
    w.deps.daemon = async () => ({ host: 'fixture-host', hasCapability: () => false, pushTriggersNow: w.push, send: w.send })
    await expect(ensureLegacySnapshotHost(w.job.id, '/fixture-home', w.deps)).rejects.toMatchObject({ code: 'watcher_state_unsupported' })
    expect(w.push).not.toHaveBeenCalled()
  })

  it('rejects a definition edit that lands while the host snapshot answers', async () => {
    const w = fixture()
    const before = cronJobRevision(w.job)
    w.send.mockImplementation(async () => {
      w.job.check = { run: 'changed-check', host: 'fixture-host' }
      return { ok: true, supported: true, complete: true, frozen: true, state: w.state, seenReliableUntil: Date.now() + 86_400_000 }
    })
    expect(await snapshotLegacyWatcher(w.job.id, '/fixture-home', w.deps)).toMatchObject({ supported: false, reason: expect.stringContaining('changed') })
    expect(cronJobRevision(w.job)).not.toBe(before)
  })

  it.each([
    { ok: false }, { ok: true, supported: false, reason: 'A check is still running' },
    { ok: true, supported: true, complete: false, frozen: true },
    { ok: true, supported: true, complete: true, frozen: false },
    { ok: true, supported: true, complete: true, frozen: true, state: null },
  ])('never treats an incomplete host answer as a frozen backup: %j', async (reply) => {
    const w = fixture()
    w.send.mockResolvedValue(reply as never)
    expect(await snapshotLegacyWatcher(w.job.id, '/fixture-home', w.deps)).toMatchObject({ supported: false })
  })

  it('keeps the host refusal when its push or state read fails', async () => {
    const w = fixture()
    w.push.mockRejectedValue(new Error('host unreachable'))
    expect(await snapshotLegacyWatcher(w.job.id, '/fixture-home', w.deps)).toMatchObject({ supported: false, reason: 'host unreachable' })
    expect(w.send).not.toHaveBeenCalled()
  })
})
