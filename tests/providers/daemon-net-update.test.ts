/**
 * A host network machine's daemon is updated over its own link (src/providers/daemon-net-update.ts):
 * the decision, the scope read from `walnut daemon status`, which daemon goes (the prebuilt binary,
 * else on a compiled server the host's walnut file), the target read by the probe, and the updater's
 * clock (settle, hold, the host setting's hold logged once, a request past it, the cooldown and
 * the backoff after a failure, no more automatic tries after MAX_AUTO_FAILURES, and a host whose
 * own Walnut puts its build back left alone), and an update whose answer never came back over
 * the link (under way, then lost, then read back once the host returns). The io itself is
 * daemon-net-update-io.test.ts.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_AUTO_FAILURES, NetDaemonUpdater, decideNetUpdate, localDaemonBinary, netDaemonSource, scopeFromStatus,
  type NetUpdateFacts, type NetUpdaterDeps, type NetUpdateLink,
} from '../../src/providers/daemon-net-update.js'
import { NetUpdateHeldError } from '../../src/providers/daemon-net-update-io.js'
import { setAcpUpgradeHoldFileForTest } from '../../src/providers/acp-upgrade-hold.js'
import { DAEMON_UPDATE_BEHIND_MAX_MS, daemonUpdateOverdue } from '../../src/providers/daemon-update-behind.js'
import { buildBackoffSettled } from '../../src/providers/daemon-build-backoff.js'
import { updateStoresSettled } from '../../src/providers/daemon-update-store.js'
import { holdAndRecord, recordStoreWrites } from '../helpers/store-write-order.js'
import { NET_UPDATE_LOST_AFTER_MS, NET_UPDATE_RUNNER_MAX_MS } from '../../src/providers/daemon-net-update-record.js'
import type { RemoteDaemonUpdateIo } from '../../src/providers/daemon-service-update.js'
import { permissionRisk } from '../../src/providers/host-exec-guards.js'
import { log } from '../../src/logging/index.js'

const OLD = 'walnut-daemon-d1224409d3cf'
const NEW = 'walnut-daemon-288f4bee1ea6'
const COOLDOWN = 10 * 60_000
const ALL_CAPS = new Set(['host-exec-v1', 'host-exec-v2', 'fs-write-part-v1', 'service-update-v1', 'host-facts-v1', 'net-v1'])

function facts(over: Partial<NetUpdateFacts> = {}): NetUpdateFacts {
  return {
    kind: 'net', host: 'studio-mac', testServer: false, follower: false, expected: NEW, running: OLD, startup: 'service',
    serviceExecutable: '/Users/u/Library/Application Support/Open Walnut/Daemon/versions/x/walnut',
    has: (c) => ALL_CAPS.has(c), autofixOff: null, turnedOff: false, requested: false, lastAttempt: null,
    now: 1_000_000_000, cooldownMs: COOLDOWN,
    target: 'darwin-arm64', source: { file: '/srv/dist/daemon-binaries/daemon-darwin-arm64' },
    ...over,
  }
}

describe('decideNetUpdate', () => {
  it('updates a net host on another build whose daemon is a managed service, when this build has its binary', () => {
    expect(decideNetUpdate(facts())).toEqual({ go: true, source: { file: '/srv/dist/daemon-binaries/daemon-darwin-arm64' }, target: 'darwin-arm64' })
    const gz = Buffer.from('gz')
    expect(decideNetUpdate(facts({ source: { gz, id: 'b1' } }))).toEqual({ go: true, source: { gz, id: 'b1' }, target: 'darwin-arm64' })
  })

  it.each<[string, Partial<NetUpdateFacts>, string]>([
    ['an ephemeral or read-only server', { testServer: true }, 'test-server'],
    ['a follower (the companion may run another build)', { follower: true }, 'follower'],
    ['this Mac', { kind: 'local', host: '__local__' }, 'local'],
    ['an ssh host (its own path)', { kind: 'ssh' }, 'not-net'],
    ['the cloud box (its companion updates it)', { kind: 'cloud-tunnel' }, 'not-net'],
    ['a source-run server with no build version', { expected: null }, 'no-build-version'],
    ['a daemon already on this build', { running: NEW }, 'current'],
    ['a daemon no service runs', { startup: 'on-demand' }, 'unmanaged'],
    ['a service daemon that names no executable', { serviceExecutable: null }, 'unmanaged'],
    ['a daemon without service-update-v1', { has: (c) => c !== 'service-update-v1' && ALL_CAPS.has(c) }, 'unmanaged'],
    ['a daemon without fs.writePart', { has: (c) => c !== 'fs-write-part-v1' && ALL_CAPS.has(c) }, 'old-daemon'],
    ['a daemon without exec.run', { has: (c) => c !== 'host-exec-v1' && ALL_CAPS.has(c) }, 'old-daemon'],
    ['a host whose config says autofix: false', { autofixOff: 'config' }, 'held'],
    ['a server with WALNUT_HOST_AUTOFIX=0', { autofixOff: 'env' }, 'held'],
    ['a config that could not be read (whether the host allows it is unknown)', { autofixOff: 'config-unreadable' }, 'held'],
    ['WALNUT_NET_DAEMON_UPDATE=0', { turnedOff: true }, 'turned-off'],
    ['a try toward the same build inside the cooldown', { lastAttempt: { expected: NEW, at: 1_000_000_000 - 60_000 } }, 'cooldown'],
    ['a host that came back on another build after this server updated it', { contested: true }, 'contested'],
    ['a daemon another Walnut shares that has every capability this build has (daemon-shared.ts)', { shared: 'another Walnut uses it' }, 'shared'],
    ['a build whose automatic tries all failed', { failedTries: MAX_AUTO_FAILURES }, 'gave-up'],
    ['an unknown system', { target: null }, 'platform-unknown'],
    ['no daemon for the host', { source: { missing: 'this build has no daemon binary for darwin-x64' } }, 'no-binary'],
  ])('does not update %s', (_label, over, skip) => {
    const d = decideNetUpdate(facts(over))
    expect(d).toMatchObject({ go: false, skip })
    if (d.go === false) expect(d.why.length).toBeGreaterThan(10)
  })

  it('a request goes past the host setting, the switch and the cooldown, never past the rest', () => {
    const asked = { requested: true, autofixOff: 'config', turnedOff: true, contested: true, shared: 'another Walnut uses it', failedTries: 99, lastAttempt: { expected: NEW, at: 1_000_000_000 - 1 } }
    expect(decideNetUpdate(facts(asked)).go).toBe(true)
    expect(decideNetUpdate(facts({ ...asked, testServer: true }))).toMatchObject({ go: false, skip: 'test-server' })
    expect(decideNetUpdate(facts({ ...asked, follower: true }))).toMatchObject({ go: false, skip: 'follower' })
    expect(decideNetUpdate(facts({ ...asked, startup: 'on-demand' }))).toMatchObject({ go: false, skip: 'unmanaged' })
    expect(decideNetUpdate(facts({ ...asked, source: { missing: 'none' } }))).toMatchObject({ go: false, skip: 'no-binary' })
  })

  it('the cooldown is per build: a newer deploy tries again at once', () => {
    expect(decideNetUpdate(facts({ failedTries: MAX_AUTO_FAILURES - 1 })).go).toBe(true)
    expect(decideNetUpdate(facts({ lastAttempt: { expected: 'walnut-daemon-000000000000', at: 1_000_000_000 - 1 } })).go).toBe(true)
    expect(decideNetUpdate(facts({ lastAttempt: { expected: NEW, at: 1_000_000_000 - COOLDOWN - 1 } })).go).toBe(true)
  })

  it('asks for the host lookups only once everything cheaper allows an update', () => {
    expect(decideNetUpdate(facts({ target: undefined, source: undefined }))).toEqual({ go: 'lookup' })
    expect(decideNetUpdate(facts({ target: undefined, source: undefined, running: NEW }))).toMatchObject({ skip: 'current' })
    expect(decideNetUpdate(facts({ target: undefined, source: undefined, autofixOff: 'config' }))).toMatchObject({ skip: 'held' })
  })
})

describe('scopeFromStatus', () => {
  const status = (s: Record<string, unknown>) => `walnut daemon: note\n${JSON.stringify({ platform: 'darwin', configPath: '/x.plist', installed: true, foreign: false, active: true, enabled: true, startup: 'login', ...s }, null, 2)}\n`
  it('takes a user or cron service of Walnut\'s own', () => {
    expect(scopeFromStatus(status({ scope: 'user' }))).toEqual({ scope: 'user' })
    expect(scopeFromStatus(status({ scope: 'cron' }))).toEqual({ scope: 'cron' })
  })
  it('refuses a system service, a foreign or missing one, and an unreadable answer', () => {
    expect(scopeFromStatus(status({ scope: 'system' }))).toHaveProperty('why')
    expect(scopeFromStatus(status({ scope: 'user', foreign: true }))).toHaveProperty('why')
    expect(scopeFromStatus(status({ scope: 'user', installed: false }))).toHaveProperty('why')
    expect(scopeFromStatus('zsh: command not found')).toHaveProperty('why')
  })
})

describe('localDaemonBinary, netDaemonSource', () => {
  let dir: string
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-net-bin-')) })
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  const walnutFile = { gz: Buffer.from('walnut file gz'), id: 'build-1' }

  it('finds this build\'s binary for the host and checks its version stamp', async () => {
    const t = 'darwin-arm64' as const
    expect(await localDaemonBinary(t, NEW, dir)).toMatchObject({ missing: expect.stringContaining('darwin-arm64') })
    await fs.writeFile(path.join(dir, 'daemon-darwin-arm64'), 'bin')
    expect(await localDaemonBinary(t, NEW, dir)).toEqual({ file: path.join(dir, 'daemon-darwin-arm64') })
    await fs.writeFile(path.join(dir, 'daemon-darwin-arm64.version'), `${OLD}\n`)
    expect(await localDaemonBinary(t, NEW, dir)).toMatchObject({ missing: expect.stringContaining('rebuild') })
    await fs.writeFile(path.join(dir, 'daemon-darwin-arm64.version'), `${NEW}\n`)
    expect(await localDaemonBinary(t, NEW, dir)).toEqual({ file: path.join(dir, 'daemon-darwin-arm64') })
    // A musl system has no prebuilt daemon (bun's glibc build would not start there).
    await fs.writeFile(path.join(dir, 'daemon-linux-x64-musl'), 'bin')
    expect(await localDaemonBinary('linux-x64-musl', NEW, dir)).toHaveProperty('missing')
  })

  it('a prebuilt binary for the target wins, even on a compiled server', async () => {
    await fs.writeFile(path.join(dir, 'daemon-linux-x64'), 'bin')
    const hostFile = vi.fn(async () => walnutFile)
    expect(await netDaemonSource('linux-x64', NEW, undefined, { dir, compiled: () => true, hostFile })).toEqual({ file: path.join(dir, 'daemon-linux-x64') })
    expect(hostFile).not.toHaveBeenCalled()
  })

  it('a compiled server with no daemon binaries sends this build\'s walnut file for the target', async () => {
    const say = vi.fn()
    const hostFile = vi.fn(async (_t: string, tell: (m: string) => void) => { tell('downloading'); return walnutFile })
    for (const t of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'linux-arm64-musl'] as const) {
      expect(await netDaemonSource(t, NEW, say, { dir, compiled: () => true, hostFile })).toEqual(walnutFile)
      expect(hostFile).toHaveBeenLastCalledWith(t, say)
    }
    expect(say).toHaveBeenCalledWith('downloading')
    // A prebuilt one of another build does not stop it.
    await fs.writeFile(path.join(dir, 'daemon-darwin-arm64'), 'bin')
    await fs.writeFile(path.join(dir, 'daemon-darwin-arm64.version'), OLD)
    expect(await netDaemonSource('darwin-arm64', NEW, say, { dir, compiled: () => true, hostFile })).toEqual(walnutFile)
  })

  it('a server run from a dist without the binary has nothing to send, and a walnut file not to be had says why', async () => {
    const hostFile = vi.fn(async () => walnutFile)
    expect(await netDaemonSource('linux-x64', NEW, undefined, { dir, compiled: () => false, hostFile })).toMatchObject({ missing: expect.stringContaining('no daemon binary') })
    expect(hostFile).not.toHaveBeenCalled()
    const failing = async () => { throw new Error('version 0.0.0-dev was never released') }
    expect(await netDaemonSource('linux-x64', NEW, undefined, { dir, compiled: () => true, hostFile: failing }))
      .toMatchObject({ missing: expect.stringContaining('never released') })
  })
})

function link(over: Partial<NetUpdateLink> = {}): NetUpdateLink & { sends: string[]; lines: string[] } {
  const sends: string[] = []
  const lines: string[] = []
  return {
    host: 'studio-mac', connected: true, daemonVersion: OLD, daemonStartup: 'service',
    serviceExecutable: '/Users/u/Library/Application Support/Open Walnut/Daemon/versions/x/walnut',
    hasCapability: (c) => ALL_CAPS.has(c),
    sends, lines,
    async send(cmd, params) {
      sends.push(cmd)
      if (cmd === 'exec.run') {
        const line = Array.isArray(params?.argv) ? String((params.argv as string[])[2]) : String(params?.command)
        lines.push(line)
        if (line.includes('walnut daemon status')) {
          return { ok: true, exitCode: 0, output: JSON.stringify({ installed: true, foreign: false, scope: 'user' }) }
        }
      }
      return { ok: false, error: `unexpected ${cmd}` }
    },
    ...over,
  }
}

function updater(over: Partial<NetUpdaterDeps> = {}, conn = link()) {
  const update = vi.fn(async () => {})
  const deps: NetUpdaterDeps = {
    conn, kind: () => 'net', testServer: () => false, follower: () => false, expectedVersion: () => NEW, hold: () => null, cooldownMs: COOLDOWN,
    autofixOff: async () => null, target: async () => 'darwin-arm64',
    source: async () => ({ file: '/srv/daemon-darwin-arm64' }), update, settleMs: 10, recheckMs: 20, env: {},
    ...over,
  }
  return { u: new NetDaemonUpdater(deps), update, conn }
}

describe('NetDaemonUpdater', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('its view, read on every status frame, never hashes the build (no sync work on a request path)', () => {
    // 2026-11-04 review: the getter asked expectedVersion() (a sync hash of the daemon file) on every getDaemonConnectState.
    const expectedVersion = vi.fn(() => NEW)
    const { u } = updater({ expectedVersion })
    for (let i = 0; i < 20; i++) expect(u.view).toBeNull()
    expect(expectedVersion).not.toHaveBeenCalled()
  })

  it('a connect settles, then updates the managed service in the scope its status names', async () => {
    const { u, update, conn } = updater()
    u.schedule()
    await vi.waitFor(() => expect(u.state.phase).toBe('updated'))
    expect(update).toHaveBeenCalledTimes(1)
    const [source, version, io, scope] = update.mock.calls[0] as unknown as [{ binary: string }, string, { serviceUpdate?: unknown }, string]
    expect(source).toEqual({ binary: '/srv/daemon-darwin-arm64' })
    expect(version).toBe(NEW)
    expect(scope).toBe('user')
    expect(typeof io.serviceUpdate).toBe('function')
    // It asks the host for host_exec runs first (exec-runs-hold.ts), then reads the service.
    expect(conn.sends).toEqual(['exec.list', 'exec.run'])
    // The status line names the service file quoted (a Mac's install root has spaces), and the
    // host's macOS guard would let it run.
    // It prints a marker first: only what follows it is the answer, never what the login profile printed.
    expect(conn.lines[0]).toMatch(/^printf '%s\\n' walnut-update-output-[0-9a-f]{8}; /)
    expect(conn.lines[0].endsWith(`; '${conn.serviceExecutable}' walnut daemon status 2>/dev/null || true`)).toBe(true)
    expect(permissionRisk(conn.lines[0], '/', '/Users/u')).toBeNull()
    u.stop()
  })

  it('holds a host whose setting says autofix: false, says so once, and updates it on request', async () => {
    const warn = vi.spyOn(log.session, 'warn')
    const { u, update } = updater({ autofixOff: async () => 'config' })
    u.schedule(0)
    await vi.waitFor(() => expect(u.state.phase).toBe('held'))
    // Each scheduled check replaces the state when it ends: wait for it to end held again.
    for (let i = 0; i < 2; i++) {
      const prev = u.state
      u.schedule(0)
      await vi.waitFor(() => { expect(u.state).not.toBe(prev); expect(u.state.phase).toBe('held') }, { timeout: 10_000, interval: 10 })
    }
    expect(update).not.toHaveBeenCalled()
    expect(warn.mock.calls.filter(([m]) => /held by the host setting/.test(String(m)))).toHaveLength(1)
    const asked = await u.request()
    expect(['running', 'updated']).toContain(asked.phase)
    await vi.waitFor(() => expect(u.state.phase).toBe('updated'))
    expect(update).toHaveBeenCalledTimes(1)
    u.stop()
  })

  // 2026-11-04: a task's request checked its grant once, before the dial; the update then waited
  // for an automatic check, read the host, uploaded and handed over, and a revoke in between still
  // replaced the daemon. The asker's gate is read before each step that changes the host.
  describe('the asker\'s gate (host_daemon_update under a task\'s grant)', () => {
    const revoked = () => { throw new Error('This task\'s grant to use studio-mac was revoked while this call waited; nothing ran there.') }

    it('a gate that refuses when the run would start starts nothing', async () => {
      const { u, update, conn } = updater({ autofixOff: async () => 'config' })
      await expect(u.request(undefined, revoked)).rejects.toThrow(/was revoked while this call waited/)
      expect(update).not.toHaveBeenCalled()
      expect(conn.sends).toEqual([])
      u.stop()
    })

    it('a gate that refuses while the host is read uploads nothing', async () => {
      let allowed = true
      const { u, update } = updater({ autofixOff: async () => 'config', target: async () => { allowed = false; return 'darwin-arm64' } })
      const s = await u.request(undefined, () => { if (!allowed) revoked() })
      expect(s).toMatchObject({ phase: 'skipped', skip: 'refused', message: expect.stringContaining('was revoked') })
      expect(update).not.toHaveBeenCalled()
      u.stop()
    })

    it('a gate that refuses after the upload holds the handover: the host keeps its daemon', async () => {
      let allowed = true
      const base = link()
      const conn = link({
        async send(cmd, params) {
          if (cmd === 'fs.writePart') { base.sends.push(cmd); return { ok: true, done: true, sha256: params?.sha256 } }
          return base.send(cmd, params)
        },
      })
      const update = vi.fn(async (_src: unknown, _v: string, io: { serviceUpdate?: (o: { command: string; directory: string; executable: string }) => Promise<string> }) => {
        allowed = false // the upload is on the host; the user revokes now
        await io.serviceUpdate!({ command: 'walnut daemon update', directory: '/tmp/open-walnut-update.gate1', executable: '/x/walnut' })
      })
      const { u } = updater({ autofixOff: async () => 'config', update: update as never, io: { holdWaitMs: 10, sleep: () => new Promise((r) => setTimeout(r, 1)) } }, conn)
      await u.request(undefined, () => { if (!allowed) revoked() })
      await vi.waitFor(() => expect(u.state.phase).toBe('postponed'))
      expect(u.state.message).toContain('was revoked')
      // The update script was written, the detached start never ran.
      expect(base.sends).toContain('fs.writePart')
      expect(base.lines.filter((l) => l.includes('update.sh'))).toEqual([])
      u.stop()
    })
  })

  it('touches nothing on a host whose daemon is current, unmanaged, or from a test server', async () => {
    for (const over of [{ conn: link({ daemonVersion: NEW }) }, { conn: link({ daemonStartup: 'on-demand' }) }, { testServer: () => true }] as Array<Partial<NetUpdaterDeps> & { conn?: NetUpdateLink }>) {
      const { u, update } = updater(over, over.conn ?? link())
      const s = await u.request()
      expect(s.phase).toBe('skipped')
      expect(update).not.toHaveBeenCalled()
    }
  })

  it('a status that is not a user or cron service of Walnut\'s changes nothing', async () => {
    const conn = link({ async send() { return { ok: true, exitCode: 0, output: JSON.stringify({ installed: true, scope: 'system' }) } } })
    const { u, update } = updater({}, conn)
    expect(await u.request()).toMatchObject({ phase: 'skipped', skip: 'unmanaged' })
    expect(update).not.toHaveBeenCalled()
  })

  it('writes in flight postpone it, and it goes ahead once they are done', async () => {
    let writes = 1
    const { u, update } = updater({ hold: () => (writes > 0 ? '1 write in flight' : null) })
    u.schedule(0)
    await vi.waitFor(() => expect(u.state.phase).toBe('postponed'))
    expect(update).not.toHaveBeenCalled()
    writes = 0
    await vi.waitFor(() => expect(u.state.phase).toBe('updated'))
    expect(update).toHaveBeenCalledTimes(1)
    u.stop()
  })

  it('host_exec runs on the host postpone it before anything is uploaded, also on request; it goes ahead once they end', async () => {
    // 2026-11-03: a deploy updated a Mac's daemon under a five minute iOS test run there through host_exec.
    let runs = [{ jobId: 'hx-ios', running: true }]
    const base = link()
    const conn = link({
      async send(cmd, params) {
        if (cmd === 'exec.list') { base.sends.push(cmd); return { ok: true, jobs: runs } }
        return base.send(cmd, params)
      },
    })
    const { u, update } = updater({}, conn)
    u.schedule(0)
    await vi.waitFor(() => expect(u.state.phase).toBe('postponed'))
    expect(u.state.message).toBe('waiting: 1 host_exec run on the host would end with the daemon')
    expect(update).not.toHaveBeenCalled()
    expect(base.lines).toEqual([])
    // Someone asks for it: the run still holds it, and the answer says why.
    expect(await u.request()).toMatchObject({ phase: 'postponed', message: 'waiting: 1 host_exec run on the host would end with the daemon' })
    expect(update).not.toHaveBeenCalled()
    runs = []
    await vi.waitFor(() => expect(u.state.phase).toBe('updated'))
    expect(update).toHaveBeenCalledTimes(1)
    u.stop()
  })

  it('overdue (behind past the bound), host_exec runs no longer hold it and a daemon that can is asked to go over its work', async () => {
    // 2026-11-05: the reasons took turns and a host stayed on an old daemon for hours (daemon-update-behind.ts).
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'net-overdue-'))
    setAcpUpgradeHoldFileForTest(path.join(dir, 'holds.json'))
    try {
      const now = Date.now()
      for (let t = now - DAEMON_UPDATE_BEHIND_MAX_MS - 60_000; t < now; t += 30 * 60_000) daemonUpdateOverdue('studio-mac', OLD, true, t)
      for (const [caps, overBusy] of [[[...ALL_CAPS, 'service-update-force-v1'], true], [[...ALL_CAPS], true]] as const) {
        const base = link({ hasCapability: (c) => (caps as readonly string[]).includes(c) })
        const conn = link({
          hasCapability: base.hasCapability,
          async send(cmd, params) {
            if (cmd === 'exec.list') return { ok: true, jobs: [{ jobId: 'hx-forever', running: true }] }
            return base.send(cmd, params)
          },
        })
        // From the launch on (after the upload), this server's file changes to the host wait for the
        // swap (daemon-over-busy.ts); the upload itself is not held.
        const order: string[] = []
        const fence = vi.fn(() => { order.push('fence'); return () => { order.push('release') } })
        const host = conn.send.bind(conn)
        conn.send = async (cmd, params) => {
          if (cmd === 'fs.writePart') return { ok: true, done: true, sha256: (params as { sha256: string }).sha256 }
          if (cmd === 'fs.read') return { ok: true, data: String((params as { path: string }).path).endsWith('update.done') ? 'done' : '{"ok":true}' }
          if (cmd === 'exec.run' && String((params as { argv?: string[] }).argv?.[2] ?? (params as { command?: string }).command).includes('setsid')) {
            order.push('launch')
            return { ok: true, exitCode: 0, output: 'walnut-update-started' }
          }
          return host(cmd, params)
        }
        const update = vi.fn(async (_s: unknown, _v: unknown, io: { serviceUpdate?: (o: { command: string; directory: string; executable: string }) => Promise<string> }) => {
          order.push('upload')
          await io.serviceUpdate!({ command: 'walnut daemon update', directory: '/tmp/open-walnut-update.abc123', executable: '/x/walnut' })
        })
        const { u } = updater({ fence, update: update as never, io: { pollMs: 5, waitMs: 2_000, holdWaitMs: 50 } }, conn)
        u.schedule(0)
        await vi.waitFor(() => expect(u.state.phase).toBe('updated'))
        expect(update).toHaveBeenCalledTimes(1)
        expect((update.mock.calls[0] as unknown[])[4]).toEqual({ overBusy, onBuildFailed: expect.any(Function) })
        expect(order).toEqual(['upload', 'fence', 'launch', 'release'])
        u.stop()
      }
    } finally {
      setAcpUpgradeHoldFileForTest(null)
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('a busy refusal is a postponement, never a failure: after the cooldown, or overdue after the recheck', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'net-busy-'))
    setAcpUpgradeHoldFileForTest(path.join(dir, 'holds.json'))
    try {
      for (const late of [false, true]) {
        if (late) { const now = Date.now(); for (let t = now - DAEMON_UPDATE_BEHIND_MAX_MS - 60_000; t < now; t += 30 * 60_000) daemonUpdateOverdue('studio-mac', OLD, true, t) }
        let calls = 0
        const { u } = updater({
          cooldownMs: late ? 60_000 : 40,
          update: vi.fn(async () => { calls += 1; if (calls === 1) throw new Error('Managed daemon update failed: service.handover: running host_exec jobs must finish first') }),
        })
        u.schedule(0)
        await vi.waitFor(() => expect(u.state.phase).toBe('updated'))
        expect(calls).toBe(2)
        u.stop()
      }
    } finally {
      setAcpUpgradeHoldFileForTest(null)
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('a skip that ends by itself is decided again when it ends, with no reconnect: an unknown system, the cooldown', async () => {
    vi.useFakeTimers()
    let probes = 0
    const { u, update } = updater({ cooldownMs: 1_000, target: async () => (++probes === 1 ? null : 'darwin-arm64') })
    u.schedule(0)
    await vi.advanceTimersByTimeAsync(50)
    expect(u.state).toMatchObject({ phase: 'skipped', skip: 'platform-unknown' })
    // A reconnect inside the cooldown is a cooldown skip, which keeps the timer to its end.
    u.schedule(0)
    await vi.advanceTimersByTimeAsync(50)
    expect(u.state).toMatchObject({ phase: 'skipped', skip: 'cooldown' })
    expect(update).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(7_000)
    expect(update).toHaveBeenCalledTimes(1)
    expect(u.state.phase).toBe('updated')
    u.stop()
  })

  it('a hold that outlasted its wait before the detached start is a postponement by a cooldown, not a failure', async () => {
    let calls = 0
    const { u } = updater({
      cooldownMs: 40,
      update: vi.fn(async () => { calls += 1; if (calls === 1) throw new NetUpdateHeldError('a send started') }),
    })
    u.schedule(0)
    await vi.waitFor(() => expect(u.state.phase).toBe('updated'))
    expect(calls).toBe(2)
    u.stop()
  })

  it('a failure keeps the running daemon, waits out the cooldown, then tries again later and later', async () => {
    vi.useFakeTimers()
    const update = vi.fn(async () => { throw new Error('Managed daemon update failed: busy') })
    const { u } = updater({ update, cooldownMs: 1_000 })
    u.schedule(0)
    await vi.advanceTimersByTimeAsync(5)
    expect(u.state.phase).toBe('failed')
    expect(update).toHaveBeenCalledTimes(1)
    // A reconnect inside the cooldown does not try again.
    u.schedule(0)
    await vi.advanceTimersByTimeAsync(5)
    expect(update).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(update).toHaveBeenCalledTimes(2)
    // The second failure waits twice as long.
    await vi.advanceTimersByTimeAsync(1_500)
    expect(update).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(600)
    expect(update).toHaveBeenCalledTimes(3)
    u.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(update).toHaveBeenCalledTimes(3)
  })

  // 2026-11-04 review: a build that stopped the host's daemon and then did not start was tried
  // again after 10, 20, 40 min up to 6 h, each try stopping the healthy daemon once more.
  it('a build that stopped the daemon and did not stay serving is left a day, by a server started again too', async () => {
    vi.useFakeTimers()
    const file = path.join(os.tmpdir(), `walnut-net-backoff-${process.pid}-${Date.now()}.json`)
    process.env.WALNUT_BUILD_BACKOFF_FILE = file
    try {
      const update = vi.fn(async () => { throw Object.assign(new Error('Managed daemon update failed: the daemon never answered as ready'), { buildFailed: true }) })
      const first = updater({ update, cooldownMs: 1_000 })
      first.u.schedule(0)
      await vi.waitFor(() => expect(first.u.state.phase).toBe('failed'))
      expect(update).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(6 * 3600_000)
      expect(update).toHaveBeenCalledTimes(1)
      first.u.stop()
      await buildBackoffSettled()
      // The server started again (a deploy): its updater reads the day off from the file.
      const again = updater({ update, cooldownMs: 1_000 })
      again.u.schedule(0)
      await vi.waitFor(() => expect(again.u.state).toMatchObject({ phase: 'failed', message: expect.stringContaining('tried again in a day') }))
      expect(update).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(18 * 3600_000 + 1_000)
      await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2))
      again.u.stop()
    } finally {
      delete process.env.WALNUT_BUILD_BACKOFF_FILE
      await fs.rm(file, { force: true })
    }
  })

  it('an update the host deferred (launchd starting no jobs, a dark wake) is a postponement: no failure, no backoff, asked again after the cooldown', async () => {
    // 2026-11-04: a Mac in a dark wake loaded the new job and the restored one and started neither.
    vi.useFakeTimers()
    let calls = 0
    const update = vi.fn(async () => {
      calls += 1
      if (calls <= MAX_AUTO_FAILURES + 1) throw new Error('Managed daemon update failed: update deferred: launchd is starting no jobs in this login session now (a dark wake with the lid closed, or a login not finished); nothing was changed, and the running daemon keeps serving; ')
    })
    const { u } = updater({ update, cooldownMs: 1_000 })
    u.schedule(0)
    await vi.advanceTimersByTimeAsync(5)
    expect(u.state).toMatchObject({ phase: 'postponed', message: expect.stringMatching(/^waiting: update deferred: launchd is starting no jobs/) })
    expect(u.view).toBeNull()
    // Every cooldown, never later and later, and never given up on.
    for (let n = 2; n <= MAX_AUTO_FAILURES + 1; n += 1) {
      await vi.advanceTimersByTimeAsync(1_000)
      expect(update).toHaveBeenCalledTimes(n)
    }
    expect(u.state.phase).toBe('postponed')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(u.state.phase).toBe('updated')
    u.stop()
  })

  it('stops trying a build by itself after MAX_AUTO_FAILURES failures, and tries it again on request', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(log.session, 'warn')
    const update = vi.fn(async () => { throw new Error('the update did not start detached from the daemon') })
    const { u } = updater({ update, cooldownMs: 1_000 })
    u.schedule(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(update).toHaveBeenCalledTimes(MAX_AUTO_FAILURES)
    expect(u.state).toMatchObject({ phase: 'skipped', skip: 'gave-up' })
    u.schedule(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(update).toHaveBeenCalledTimes(MAX_AUTO_FAILURES)
    expect(warn.mock.calls.filter(([, f]) => (f as { skip?: string })?.skip === 'gave-up')).toHaveLength(1)
    const asked = u.request()
    await vi.advanceTimersByTimeAsync(10)
    expect((await asked).phase).toBe('failed')
    expect(update).toHaveBeenCalledTimes(MAX_AUTO_FAILURES + 1)
    u.stop()
  })

  it('leaves a host alone once something there put another build back after this server updated it', async () => {
    const warn = vi.spyOn(log.session, 'warn')
    const conn = link()
    const { u, update } = updater({}, conn)
    u.schedule(0)
    await vi.waitFor(() => expect(u.state.phase).toBe('updated'))
    // The handover: the host comes back on this build, then its own Walnut puts its build back.
    Object.assign(conn, { daemonVersion: NEW })
    expect((await u.request()).skip).toBe('current')
    Object.assign(conn, { daemonVersion: OLD })
    for (let i = 0; i < 2; i++) {
      // The scheduled check replaces the state when it ends.
      const prev = u.state
      u.schedule(0)
      await vi.waitFor(() => {
        expect(u.state).not.toBe(prev)
        expect(u.state).toMatchObject({ phase: 'skipped', skip: 'contested' })
      }, { timeout: 10_000, interval: 10 })
    }
    expect(update).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls.filter(([, f]) => (f as { skip?: string })?.skip === 'contested')).toHaveLength(1)
    // Asked for, it moves the host again.
    await u.request()
    await vi.waitFor(() => expect(u.state.phase).toBe('updated'))
    expect(update).toHaveBeenCalledTimes(2)
    u.stop()
  })

  it('a request while an automatic check is still deciding waits for it, then goes past what held it', async () => {
    let answer!: (v: string | null) => void
    let first = true
    // The automatic check's read of the host setting is slow; every later read answers at once.
    const autofixOff = () => (first ? (first = false, new Promise<string | null>((r) => { answer = r })) : Promise.resolve('config'))
    const { u, update } = updater({ autofixOff })
    u.schedule(0)
    await vi.waitFor(() => expect(u.state.phase).toBe('checking'))
    const asked = u.request()
    await new Promise((r) => setTimeout(r, 20))
    answer('config')
    expect(['running', 'updated']).toContain((await asked).phase)
    await vi.waitFor(() => expect(u.state.phase).toBe('updated'))
    expect(update).toHaveBeenCalledTimes(1)
    u.stop()
  })

  it('one update at a time: a reconnect or a request while one runs joins it', async () => {
    let release!: () => void
    const update = vi.fn(() => new Promise<void>((r) => { release = r }))
    const { u } = updater({ update })
    const first = await u.request()
    expect(first.phase).toBe('running')
    u.schedule(0)
    await new Promise((r) => setTimeout(r, 30))
    expect((await u.request()).phase).toBe('running')
    expect(update).toHaveBeenCalledTimes(1)
    release()
    await vi.waitFor(() => expect(u.state.phase).toBe('updated'))
    u.stop()
  })

  it('reads the target with the probe, and sends a compiled server\'s walnut file as its gz', async () => {
    const probe = 'os=Darwin\narch=x86_64\nlibc=\ntranslated=1\nglibc=\nbits=\nloader=\n'
    const base = link()
    const conn = link({
      async send(cmd, params) {
        const line = Array.isArray(params?.argv) ? String((params.argv as string[])[2]) : String(params?.command)
        if (cmd === 'exec.run' && line.includes('uname -s')) { base.lines.push(line); return { ok: true, exitCode: 0, output: probe } }
        return base.send(cmd, params)
      },
    })
    const gz = Buffer.from('walnut file gz')
    const source = vi.fn(async () => ({ gz, id: 'build-1' }))
    const { u, update } = updater({ target: undefined, source }, conn)
    await u.request()
    await vi.waitFor(() => expect(u.state.phase).toBe('updated'))
    // An x86_64 shell under Rosetta on an Apple silicon Mac is that Mac's own arm64 target.
    expect(source).toHaveBeenCalledWith('darwin-arm64', NEW, expect.any(Function))
    expect(update.mock.calls[0]![0]).toEqual({ binary: null, gz })
    // The status comes before the probe, and the probe is a line the macOS guard lets run.
    expect(base.lines.map((l) => (l.includes('uname -s') ? 'probe' : l.includes('daemon status') ? 'status' : l))).toEqual(['status', 'probe'])
    expect(permissionRisk(base.lines[1]!, '/', '/Users/u')).toBeNull()
    u.stop()
  })

  it('a lookup that found no daemon to send waits a cooldown before it looks again', async () => {
    const source = vi.fn(async () => ({ missing: 'this build has no daemon binary for linux-x64' }))
    const { u, update } = updater({ source, target: async () => 'linux-x64' })
    expect(await u.request()).toMatchObject({ phase: 'skipped', skip: 'no-binary' })
    u.schedule(0)
    await vi.waitFor(() => expect(u.state).toMatchObject({ phase: 'skipped', skip: 'cooldown' }), { timeout: 10_000, interval: 10 })
    expect(source).toHaveBeenCalledTimes(1)
    expect(update).not.toHaveBeenCalled()
    u.stop()
  })

  it('never schedules for a host of another kind', async () => {
    const { u, update } = updater({ kind: () => 'ssh' })
    u.schedule(0)
    await new Promise((r) => setTimeout(r, 30))
    expect(u.state.phase).toBe('idle')
    expect(update).not.toHaveBeenCalled()
  })
})

/**
 * 2026-11-04: a Mac went away during its own update and the server said nothing about why.
 * The detached runner leaves its record in the staging dir; the link drops, the server's
 * wait ends, and the record is read when the host is back.
 */
describe('an update whose answer never came back over the link', () => {
  afterEach(() => { vi.restoreAllMocks() })
  const DIR = '/tmp/open-walnut-update.Abc123xyz9'

  /**
   * A host that runs the launcher, drops the link right after it (unless `stay`), and answers
   * fs.read from `files` while connected; `flaky` makes the link fail reads while it is up.
   */
  function awayLink(files: Map<string, string>, o: { stay?: boolean; flaky?: () => boolean } = {}) {
    const base = link()
    const conn = link({
      async send(cmd, params) {
        base.sends.push(cmd)
        if (cmd === 'exec.list') return { ok: true, jobs: [] }
        if (cmd === 'fs.writePart') return { ok: true, done: true, sha256: params?.sha256 }
        if (cmd === 'fs.read') {
          if (!conn.connected || o.flaky?.()) throw new Error('DaemonConnection not connected to studio-mac')
          const data = files.get(String(params?.path))
          return data === undefined ? { ok: false, error: 'ENOENT' } : { ok: true, data }
        }
        if (cmd === 'exec.run') {
          const line = Array.isArray(params?.argv) ? String((params.argv as string[])[2]) : String(params?.command)
          base.lines.push(line)
          if (line.includes('update.go')) {
            if (!o.stay) (conn as { connected: boolean }).connected = false
            return { ok: true, exitCode: 0, output: 'walnut-update-started pid=4242 group=4242 own=4100' }
          }
          if (line.includes('rm -rf')) return { ok: true, exitCode: 0, output: '' }
        }
        return base.send(cmd, params)
      },
    })
    return { conn, base }
  }

  function setup(files: Map<string, string>, o: Parameters<typeof awayLink>[1] & { waitMs?: number } = {}) {
    let now = 1_000_000_000
    const { conn, base } = awayLink(files, o)
    const update = vi.fn(async (_s: unknown, _v: unknown, io: RemoteDaemonUpdateIo) => {
      await io.serviceUpdate!({ command: `${DIR}/daemon walnut daemon update --yes --scope user --executable ${DIR}/daemon`, directory: DIR, executable: `${DIR}/daemon`, scope: 'user' })
      return 'applied' as const
    })
    const { u } = updater({
      update: update as unknown as NetUpdaterDeps['update'], cooldownMs: 60 * 60_000, now: () => now,
      io: { pollMs: 5, waitMs: o.waitMs ?? 60 },
    }, conn)
    return { u, conn, base, update, advance: (ms: number) => { now += ms } }
  }

  it('says updating while the host is away, lost after a while, and reads the failure with its reason once the host is back', async () => {
    const error = vi.spyOn(log.session, 'error')
    const files = new Map<string, string>()
    const { u, conn, base, advance } = setup(files)
    u.schedule(0)
    await vi.waitFor(() => expect(u.state.phase).toBe('failed'))
    expect(u.state.message).toContain('did not report back')
    // 2026-11-04 review 5: this logged "the running daemon keeps serving", which nobody could know.
    const said = error.mock.calls.map(([m]) => String(m)).filter((m) => m.startsWith('DaemonConnection: host network daemon update failed'))
    expect(said).toEqual(['DaemonConnection: host network daemon update failed; its answer did not come back over the link (it dropped during the update), so what the host runs is read once it is back'])
    expect(u.view).toMatchObject({ state: 'updating', at: 1_000_000_000 })
    advance(NET_UPDATE_LOST_AFTER_MS)
    expect(u.view).toMatchObject({ state: 'lost' })

    // The runner finished there: the update answered ok, and its tail had to put the previous config back.
    files.set(`${DIR}/update.done`, 'rc=0 tries=1 tail=restored\n')
    files.set(`${DIR}/update.out`, 'walnut daemon: note\n{"ok":true}\n')
    files.set(`${DIR}/update.tail`, 'outcome=restored\nno daemon answered within 90 s, so the previous service config was put back, and its daemon answers\n')
    ;(conn as { connected: boolean }).connected = true
    // Back on the link, its record not read yet: no word until the check reads it.
    expect(u.view).toBeNull()
    u.schedule(0)
    await vi.waitFor(() => expect(u.view).toMatchObject({ state: 'failed', at: 1_000_000_000 }))
    expect(u.view!.message).toBe('afterwards on the host: no daemon answered within 90 s, so the previous service config was put back, and its daemon answers')
    expect(error.mock.calls.some(([m]) => /did not go through \(read back once the host returned\)/.test(String(m)))).toBe(true)
    expect(base.lines.some((line) => line.endsWith(`rm -rf ${DIR}`))).toBe(true)
    // Read once: a later check does not read it again.
    const reads = base.sends.filter((c) => c === 'fs.read').length
    u.schedule(0)
    await new Promise((r) => setTimeout(r, 40))
    expect(base.sends.filter((c) => c === 'fs.read').length).toBe(reads)
    u.stop()
  })

  // 2026-11-04 review: a late record that said the build stopped the daemon and did not stay
  // serving only fed the status, and the next try within the hour stopped the daemon again.
  it('a record read back late that says the build did not stay serving holds the build a day, on disk', async () => {
    const file = path.join(os.tmpdir(), `walnut-net-late-${process.pid}-${Date.now()}.json`)
    process.env.WALNUT_BUILD_BACKOFF_FILE = file
    try {
      const files = new Map<string, string>()
      const { u, conn } = setup(files)
      u.schedule(0)
      await vi.waitFor(() => expect(u.state.phase).toBe('failed'))
      files.set(`${DIR}/update.done`, 'rc=1 tries=1 tail=serving\n')
      files.set(`${DIR}/update.out`, `${JSON.stringify({ ok: false, failure: { code: 'notReady', stopped: true, message: 'the new daemon never answered as ready', rollback: 'the previous service config was put back' } })}\n`)
      files.set(`${DIR}/update.tail`, 'outcome=serving\na daemon answers\n')
      ;(conn as { connected: boolean }).connected = true
      u.schedule(0)
      await vi.waitFor(() => expect(u.view).toMatchObject({ state: 'failed' }))
      await buildBackoffSettled()
      const kept = Object.values(JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, { expected: string; reason: string }>)
      expect(kept).toEqual([expect.objectContaining({ expected: NEW, reason: expect.stringContaining('never answered as ready') })])
      u.stop()
    } finally {
      delete process.env.WALNUT_BUILD_BACKOFF_FILE
      await fs.rm(file, { force: true })
    }
  })

  // 2026-11-04 review 4: the launched update lived in this server's memory, so a deploy during it
  // (the server restarted) left the next server no hold and no cooldown: it stopped the healthy
  // daemon once more for the same build, and never read or removed the runner's dir.
  it('a server restarted while the update ran reads its record back (kept from the launch): a build that failed is held, and no second update starts', async () => {
    const stamp = `${process.pid}-${Date.now()}`
    const unread = path.join(os.tmpdir(), `walnut-net-unread-${stamp}.json`)
    const backoff = path.join(os.tmpdir(), `walnut-net-unread-backoff-${stamp}.json`)
    process.env.WALNUT_UPDATE_UNREAD_FILE = unread
    process.env.WALNUT_BUILD_BACKOFF_FILE = backoff
    try {
      const files = new Map<string, string>()
      const first = setup(files, { waitMs: 5_000 })
      first.u.schedule(0)
      await vi.waitFor(() => expect(first.base.lines.some((line) => line.includes('update.go'))).toBe(true))
      // Kept on disk from the launch on, before any wait ended; then this server is stopped (a deploy).
      await updateStoresSettled()
      expect(Object.values(JSON.parse(await fs.readFile(unread, 'utf8')))).toEqual([expect.objectContaining({ directory: DIR, expected: NEW })])
      first.u.stop()
      // The runner finished: the new daemon never answered after the old one stopped.
      files.set(`${DIR}/update.done`, 'rc=1 tries=1 tail=serving\n')
      files.set(`${DIR}/update.out`, `${JSON.stringify({ ok: false, failure: { code: 'notReady', stopped: true, message: 'the new daemon never answered as ready', rollback: 'the previous service config was put back' } })}\n`)
      files.set(`${DIR}/update.tail`, 'outcome=serving\na daemon answers\n')
      // The hold is on disk before the host's record goes (2026-11-04 review 5: only asked for).
      let lines: string[] = []
      let removedFirst: boolean | null = null
      const writes = recordStoreWrites({ delayMs: 150, onDisk: (w) => { if (w === 'daemon-build-backoff.json:set') removedFirst = lines.some((line) => line.endsWith(`rm -rf ${DIR}`)) } })
      const second = setup(files)
      lines = second.base.lines
      ;(second.conn as { connected: boolean }).connected = true
      second.u.schedule(0)
      await vi.waitFor(() => expect(second.base.lines.some((line) => line.endsWith(`rm -rf ${DIR}`))).toBe(true))
      await vi.waitFor(() => expect(removedFirst).not.toBeNull())
      expect(removedFirst).toBe(false)
      await vi.waitFor(() => expect(second.u.state.phase).toBe('failed'))
      expect(second.update).not.toHaveBeenCalled()
      expect(second.u.view).toMatchObject({ state: 'failed', message: expect.stringContaining('never answered as ready') })
      await buildBackoffSettled()
      expect(Object.values(JSON.parse(await fs.readFile(backoff, 'utf8')))).toEqual([expect.objectContaining({ expected: NEW })])
      // The record goes after the hold (its own write comes once the host's dir is removed).
      await vi.waitFor(async () => expect(JSON.parse(await fs.readFile(unread, 'utf8'))).toEqual({}))
      // The hold before the record goes (2026-11-04 review 5: a server killed in between kept neither).
      expect(holdAndRecord(writes)).toEqual(['daemon-build-backoff.json:set', 'daemon-update-unread.json:clear'])
      second.u.stop()
    } finally {
      delete process.env.WALNUT_UPDATE_UNREAD_FILE
      delete process.env.WALNUT_BUILD_BACKOFF_FILE
      for (const f of [unread, backoff]) await fs.rm(f, { force: true })
    }
  })

  it('a failure of the build answered in time: its hold is on disk before the update\'s record goes', async () => {
    const files = new Map<string, string>([
      [`${DIR}/update.done`, 'rc=1 tries=1 tail=serving\n'],
      [`${DIR}/update.out`, `${JSON.stringify({ ok: false, failure: { code: 'notReady', stopped: true, message: 'the new daemon never answered as ready' } })}\n`],
      [`${DIR}/update.tail`, 'outcome=serving\na daemon answers\n'],
    ])
    const { u, update } = setup(files, { stay: true })
    update.mockImplementationOnce(async (_s: unknown, _v: unknown, io: RemoteDaemonUpdateIo) => {
      await io.serviceUpdate!({ command: `${DIR}/daemon walnut daemon update --yes --scope user --executable ${DIR}/daemon`, directory: DIR, executable: `${DIR}/daemon`, scope: 'user' })
      throw Object.assign(new Error('Managed daemon update failed: the new daemon never answered as ready'), { buildFailed: true })
    })
    const writes = recordStoreWrites()
    u.schedule(0)
    await vi.waitFor(() => expect(u.state.phase).toBe('failed'))
    expect(holdAndRecord(writes)).toEqual(['daemon-update-unread.json:set', 'daemon-build-backoff.json:set', 'daemon-update-unread.json:clear'])
    u.stop()
  })

  it('a record that says it went through clears the failure; a host that lost the record says so unless it runs the new build', async () => {
    const files = new Map<string, string>()
    const first = setup(files)
    first.u.schedule(0)
    await vi.waitFor(() => expect(first.u.state.phase).toBe('failed'))
    files.set(`${DIR}/update.done`, 'rc=0 tries=1 tail=serving\n')
    files.set(`${DIR}/update.out`, '{"ok":true}\n')
    files.set(`${DIR}/update.tail`, 'outcome=serving\na daemon answers\n')
    ;(first.conn as { connected: boolean }).connected = true
    ;(first.conn as { daemonVersion: string }).daemonVersion = NEW
    first.u.schedule(0)
    await vi.waitFor(() => expect(first.base.lines.some((line) => line.endsWith(`rm -rf ${DIR}`))).toBe(true))
    expect(first.u.view).toBeNull()
    first.u.stop()

    // A reboot cleared /tmp: no record and no script. Still on the old build, it says so.
    const second = setup(new Map())
    second.u.schedule(0)
    await vi.waitFor(() => expect(second.u.state.phase).toBe('failed'))
    ;(second.conn as { connected: boolean }).connected = true
    second.u.schedule(0)
    await vi.waitFor(() => expect(second.u.view?.message).toBe(`the update left no record on the host (it may have restarted), and its daemon is still ${OLD}`))
    second.u.stop()
  })
  it('a reconnect while the update is still awaited leaves the record to that wait, which reads it', async () => {
    const info = vi.spyOn(log.session, 'info')
    const files = new Map<string, string>()
    const { u, conn, base } = setup(files, { waitMs: 5_000 })
    u.schedule(0)
    await vi.waitFor(() => expect(base.lines.some((line) => line.includes('update.go'))).toBe(true))
    // The new daemon is up: the link is back, and its connect schedules a read while the wait still runs.
    ;(conn as { connected: boolean }).connected = true
    u.schedule(0)
    await new Promise((r) => setTimeout(r, 40))
    files.set(`${DIR}/update.out`, '{"ok":true}\n')
    files.set(`${DIR}/update.tail`, 'outcome=serving\na daemon answers\n')
    files.set(`${DIR}/update.done`, 'rc=0 tries=1 tail=serving\n')
    await vi.waitFor(() => expect(u.state.phase).toBe('updated'))
    expect(base.lines.some((line) => line.includes('rm -rf'))).toBe(false)
    expect(info.mock.calls.some(([m]) => /read back once the host returned/.test(String(m)))).toBe(false)
    expect(u.view).toBeNull()
    u.stop()
  })

  it('waits for a runner still at work instead of starting another update, and gives up on one that died', async () => {
    let flaky = false
    const files = new Map<string, string>()
    const { u, conn, base, update, advance } = setup(files, { flaky: () => flaky })
    u.schedule(0)
    await vi.waitFor(() => expect(u.state.phase).toBe('failed'))
    files.set(`${DIR}/update.sh`, '#!/bin/sh\n')
    ;(conn as { connected: boolean }).connected = true
    // A read the link could not answer is no answer: nothing is concluded from it.
    flaky = true
    expect(await u.request()).toMatchObject({ phase: 'postponed', message: 'waiting: the previous daemon update is still running on the host' })
    flaky = false
    // Its script is there and its done line is not: still at work, so no second update.
    expect(await u.request()).toMatchObject({ phase: 'postponed' })
    expect(update).toHaveBeenCalledTimes(1)
    // Long past what a runner takes: it died (a reboot with a /tmp that survives), so its dir goes.
    advance(NET_UPDATE_RUNNER_MAX_MS)
    u.schedule(0)
    await vi.waitFor(() => expect(base.lines.some((line) => line.endsWith(`rm -rf ${DIR}`))).toBe(true))
    expect(u.view?.message).toBe(`the update left no record on the host (it may have restarted), and its daemon is still ${OLD}`)
    // The host runs the build after all (another way put it there): the line goes.
    ;(conn as { daemonVersion: string }).daemonVersion = NEW
    expect(u.view).toBeNull()
    u.stop()
  })

  it('counts "did not come back" from when the link dropped, not from the launch', async () => {
    const files = new Map<string, string>()
    const { u, conn, advance } = setup(files, { stay: true })
    u.schedule(0)
    await vi.waitFor(() => expect(u.state.phase).toBe('failed'))
    // Busy tries kept the old daemon up for minutes after the launch.
    expect(u.view).toBeNull()
    advance(9 * 60_000)
    ;(conn as { connected: boolean }).connected = false
    expect(u.view).toMatchObject({ state: 'updating' })
    advance(NET_UPDATE_LOST_AFTER_MS - 60_000)
    expect(u.view).toMatchObject({ state: 'updating' })
    advance(60_000)
    expect(u.view).toMatchObject({ state: 'lost' })
    u.stop()
  })
})

describe('defaultAutofixOff', () => {
  it('holds when the config cannot be read, and reads the host\'s own autofix setting otherwise', async () => {
    const { defaultAutofixOff } = await import('../../src/providers/daemon-net-update.js')
    expect(await defaultAutofixOff('pc', async () => { throw new Error('EACCES') })).toBe('config-unreadable')
    expect(await defaultAutofixOff('pc', async () => null)).toBe('config-unreadable')
    expect(await defaultAutofixOff('pc', async () => ({ hosts: { pc: { autofix: false } } }))).toBe('config')
    expect(await defaultAutofixOff('pc', async () => ({ hosts: { other: { autofix: false } } }))).toBeNull()
  })
})
