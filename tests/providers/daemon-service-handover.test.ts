import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RegistryEntry } from '../../src/providers/daemon-core.js'
import { daemonInstallRoot } from '../../src/providers/daemon-service-config.js'
import { consumeDaemonServiceHandover, prepareDaemonServiceHandover } from '../../src/providers/daemon-service-handover.js'

const { boot, probe } = vi.hoisted(() => ({ boot: vi.fn(), probe: vi.fn() }))
vi.mock('../../src/providers/daemon-cron-host.js', () => ({ readCronBootId: boot, probeCronProcess: probe }))

const uid = os.userInfo().uid
const ownerPid = 4242
const sessionPid = 4343
const hooks = { version: 1 as const, hash: 'policy-hash', hooks: [] }
let home: string
let stateDir: string

function entry(pid = sessionPid): RegistryEntry {
  return {
    pid, startTime: `start-${pid}`, pipePath: `/fixture/${pid}.pipe`, jsonlPath: `/fixture/${pid}.jsonl`,
    pgidPath: `/fixture/${pid}.pgid`, cwd: '/fixture/Unicode \u5de5\u4f5c', spawnedAt: '2026-09-01T00:00:00.000Z', // CJK "work"
    parented: false, mode: 'default', cliVersion: '2.1.258',
    args: ['claude', '-p', '--permission-mode', 'default', '--model', 'fixture-model'],
    pendingCtrl: { reqId: 'permission-1', toolName: 'Bash', request: { input: 'fixture' }, receivedAt: 123 },
  }
}

async function prepare(entries: Record<string, RegistryEntry> = { session: entry() }, instanceId = 'old-instance') {
  const registryFile = path.join(home, `${instanceId}-sessions.json`)
  await fs.writeFile(registryFile, JSON.stringify({ version: 1, sessions: entries }), { mode: 0o600 })
  return prepareDaemonServiceHandover({
    stateDir, uid, home, platform: 'linux', instanceId, pid: ownerPid,
    startTime: 'owner-start', entries, hooks, registryFile,
  })
}

const consume = () => consumeDaemonServiceHandover({ stateDir, uid, platform: 'linux' })
const read = (name: string) => fs.readFile(path.join(stateDir, name), 'utf8')
const privateWrite = (name: string, value: unknown) => fs.writeFile(path.join(stateDir, name), JSON.stringify(value), { mode: 0o600 })

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-handover-test-'))
  stateDir = daemonInstallRoot('linux', home)
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 })
  boot.mockResolvedValue('boot-1')
  probe.mockImplementation(async (identity) => ({ status: identity.pid === ownerPid ? 'dead' : 'alive', identity }))
})

afterEach(async () => {
  vi.restoreAllMocks()
  boot.mockReset()
  probe.mockReset()
  await fs.rm(home, { recursive: true, force: true })
})

describe('daemon service handover snapshot', () => {
  it('preserves live session launch and permission state without changing the caller inventory', async () => {
    const entries = { session: entry(), exited: entry(4444) }
    probe.mockImplementation(async (identity) => ({ status: identity.pid === sessionPid ? 'alive' : 'dead', identity }))
    await prepare(entries)
    const snapshot = JSON.parse(await read('handover.json'))
    expect(snapshot.registry.sessions).toEqual({ session: { ...entries.session, bootId: 'boot-1' } })
    expect(entries.session.bootId).toBeUndefined()
    expect(snapshot.owner).toEqual({ bootId: 'boot-1', pid: ownerPid, startTime: 'owner-start' })
    expect((await fs.stat(path.join(stateDir, 'handover.json'))).mode & 0o777).toBe(0o600)
    await consume()
    expect(JSON.parse(await read('sessions.json'))).toEqual(snapshot.registry)
    expect(JSON.parse(await read('hooks.json'))).toEqual(hooks)
    await expect(read('handover.json')).rejects.toMatchObject({ code: 'ENOENT' })
    await consume()
    expect(JSON.parse(await read('sessions.json'))).toEqual(snapshot.registry)
  })

  it.each([0, 80])('transfers %i live sessions with their individual launch arguments', async (count) => {
    const entries = Object.fromEntries(Array.from({ length: count }, (_, i) => [`session-${i}`, entry(5000 + i)]))
    await prepare(entries)
    await consume()
    const actual = JSON.parse(await read('sessions.json')).sessions
    expect(Object.keys(actual)).toHaveLength(count)
    for (const [sid, value] of Object.entries(entries)) expect(actual[sid]).toEqual({ ...value, bootId: 'boot-1' })
  })

  it.each(['requested', 'cleared'] as const)('takes final permission and retry state after the owner exits: %s', async (permission) => {
    await prepare()
    const latest = entry()
    latest.pendingCtrl = permission === 'requested'
      ? { reqId: 'permission-2', toolName: 'Edit', request: { input: 'later' }, receivedAt: 456 }
      : undefined
    latest.turnRetry = { attempts: 2, streakStartedAt: 100, lastAttemptAt: 200, lastHandledV: 300 }
    await fs.writeFile(path.join(home, 'old-instance-sessions.json'), JSON.stringify({ version: 1, sessions: { session: latest } }), { mode: 0o600 })
    await consume()
    expect(JSON.parse(await read('sessions.json')).sessions.session).toEqual({ ...latest, bootId: 'boot-1' })
  })

  it.each(['gone', 'replaced'] as const)('does not restore stale state for a session that is %s at exit', async (change) => {
    await prepare()
    const sessions = change === 'gone' ? {} : { session: entry(4545) }
    await fs.writeFile(path.join(home, 'old-instance-sessions.json'), JSON.stringify({ version: 1, sessions }), { mode: 0o600 })
    await consume()
    expect(JSON.parse(await read('sessions.json')).sessions).toEqual({})
  })

  it.each(['missing', 'malformed', 'symlink', 'mode'] as const)('refuses an unreadable final registry without consuming the snapshot: %s', async (fault) => {
    await prepare()
    const source = path.join(home, 'old-instance-sessions.json')
    if (fault === 'missing' || fault === 'symlink') await fs.unlink(source)
    if (fault === 'malformed') await fs.writeFile(source, '{')
    if (fault === 'mode') await fs.chmod(source, 0o644)
    if (fault === 'symlink') await fs.symlink(path.join(stateDir, 'handover.json'), source)
    await expect(consume()).rejects.toThrow()
    expect(JSON.parse(await read('handover.json')).instanceId).toBe('old-instance')
    await expect(read('sessions.json')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(read('hooks.json')).rejects.toMatchObject({ code: 'ENOENT' })
    if (fault === 'symlink') await fs.unlink(source)
    await fs.writeFile(source, JSON.stringify({ version: 1, sessions: { session: entry() } }), { mode: 0o600 })
    await fs.chmod(source, 0o600)
    await consume()
    expect(JSON.parse(await read('sessions.json')).sessions.session.pid).toBe(sessionPid)
    await expect(read('handover.json')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the old boot identity when a reboot removed the runtime registry', async () => {
    await prepare()
    await fs.unlink(path.join(home, 'old-instance-sessions.json'))
    boot.mockResolvedValue('boot-2')
    await consume()
    expect(JSON.parse(await read('sessions.json')).sessions.session.bootId).toBe('boot-1')
  })

  it('never replaces another daemon instance pending handover', async () => {
    await prepare()
    const saved = JSON.parse(await read('handover.json'))
    saved.instanceId = 'another-instance'
    await privateWrite('handover.json', saved)
    const previous = await read('handover.json')
    await expect(prepare({ replacement: entry() })).rejects.toThrow('earlier service handover')
    expect(await read('handover.json')).toBe(previous)
  })

  it('publishes exactly one snapshot when two preparations reach the same directory', async () => {
    const results = await Promise.allSettled([prepare({ first: entry() }, 'first-instance'), prepare({ second: entry() }, 'second-instance')])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const entries = JSON.parse(await read('handover.json')).registry.sessions
    expect(Object.keys(entries)).toHaveLength(1)
    expect(await fs.readdir(stateDir)).toEqual(['handover.json'])
  })

  it.each(['unknown', 'missing-start', 'missing-boot'])('refuses incomplete process evidence: %s', async (fault) => {
    if (fault === 'unknown') probe.mockResolvedValue({ status: 'unknown' })
    if (fault === 'missing-boot') boot.mockResolvedValue('')
    const value = entry()
    if (fault === 'missing-start') value.startTime = null
    await expect(prepare({ session: value })).rejects.toThrow(/identity|boot/)
    await expect(read('handover.json')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['alive', 'unknown'])('keeps the snapshot and destination untouched while the old owner is %s', async (status) => {
    await prepare()
    await privateWrite('sessions.json', { previous: true })
    await privateWrite('hooks.json', { previous: true })
    probe.mockResolvedValue({ status })
    await expect(consume()).rejects.toThrow('previous daemon')
    expect(JSON.parse(await read('sessions.json'))).toEqual({ previous: true })
    expect(JSON.parse(await read('hooks.json'))).toEqual({ previous: true })
    expect(JSON.parse(await read('handover.json')).instanceId).toBe('old-instance')
  })

  it('retries after registry publication fails without losing the pending snapshot', async () => {
    await prepare()
    await privateWrite('sessions.json', { previous: true })
    const rename = fs.rename.bind(fs)
    const intercepted = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === path.join(stateDir, 'sessions.json')) throw new Error('registry write interrupted')
      return rename(from, to)
    })
    await expect(consume()).rejects.toThrow('registry write interrupted')
    expect(JSON.parse(await read('sessions.json'))).toEqual({ previous: true })
    expect(JSON.parse(await read('handover.json')).instanceId).toBe('old-instance')
    intercepted.mockRestore()
    await consume()
    expect(JSON.parse(await read('sessions.json')).sessions.session.pid).toBe(sessionPid)
    await expect(read('handover.json')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('identifies a published snapshot even when sync fails and preserves it for the successor', async () => {
    const open = fs.open.bind(fs)
    const intercepted = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const file = await open(...args)
      if (args[0] === stateDir) vi.spyOn(file, 'sync').mockRejectedValue(new Error('directory sync interrupted'))
      return file
    })
    await expect(prepare()).rejects.toMatchObject({ code: 'handover-published' })
    intercepted.mockRestore()
    expect(await fs.readdir(stateDir)).toEqual(['handover.json'])
    probe.mockImplementation(async (identity) => ({ status: 'alive', identity }))
    await expect(consume()).rejects.toThrow('previous daemon')
    await expect(prepare({ replacement: entry(4545) })).rejects.toThrow('earlier service handover')
    expect(Object.keys(JSON.parse(await read('handover.json')).registry.sessions)).toEqual(['session'])
    probe.mockImplementation(async (identity) => ({ status: identity.pid === ownerPid ? 'dead' : 'alive', identity }))
    await consume()
  })

  it.each(['directory-mode', 'directory-symlink', 'snapshot-mode', 'snapshot-symlink', 'registry-symlink'])('rejects non-private filesystem objects: %s', async (fault) => {
    await prepare()
    const outside = path.join(home, 'outside.json')
    await fs.writeFile(outside, 'keep')
    if (fault === 'directory-mode') await fs.chmod(stateDir, 0o755)
    if (fault === 'directory-symlink') {
      await fs.rename(stateDir, `${stateDir}-real`)
      await fs.symlink(`${stateDir}-real`, stateDir)
    }
    if (fault === 'snapshot-mode') await fs.chmod(path.join(stateDir, 'handover.json'), 0o644)
    if (fault === 'snapshot-symlink') {
      await fs.unlink(path.join(stateDir, 'handover.json'))
      await fs.symlink(outside, path.join(stateDir, 'handover.json'))
    }
    if (fault === 'registry-symlink') await fs.symlink(outside, path.join(stateDir, 'sessions.json'))
    await expect(consume()).rejects.toThrow()
    expect(await fs.readFile(outside, 'utf8')).toBe('keep')
  })

  it.each([null, [], {}, { version: 2 }, { version: 1, registry: { sessions: [] } }])('does not consume a malformed snapshot: %j', async (snapshot) => {
    await privateWrite('handover.json', snapshot)
    await expect(consume()).rejects.toThrow()
    expect(JSON.parse(await read('handover.json'))).toEqual(snapshot)
    await expect(read('sessions.json')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
