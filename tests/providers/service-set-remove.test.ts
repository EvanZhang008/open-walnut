/**
 * `walnut daemon uninstall --walnut <id>` removes the set's own dir once nothing of the set runs
 * (src/providers/service-set-remove.ts). Drill D5 (2026-11-23): the uninstall left
 * ~/.open-walnut-host/walnuts/<id16>/ (about 400 MB of staged versions and the follower's data).
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeServiceSetDir } from '../../src/providers/service-set-remove.js'
import { serviceSet, serviceSetBase } from '../../src/providers/service-set.js'
import { DETACHED_RUNS_STATE_DIR, HOST_SERVER_STATE_DIR } from '../../src/providers/daemon-service-state-move.js'
import { registryText } from '../../src/providers/detached-registry.js'

const SET = '0123456789abcdef'
const OTHER = 'fedcba9876543210'
let home: string

beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'set-remove-')) })
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }) })

async function layout(id = SET) {
  const set = serviceSet('linux', home, id, { uid: 1000 })
  await fs.mkdir(path.join(set.installRoot, 'versions', 'abc'), { recursive: true })
  await fs.writeFile(path.join(set.installRoot, 'versions', 'abc', 'daemon'), 'x')
  await fs.mkdir(set.runtimeDir, { recursive: true })
  await fs.mkdir(path.join(serviceSetBase(home, id), 'data'), { recursive: true })
  return set
}
const exists = (p: string) => fs.lstat(p).then(() => true, () => false)
// Fake process table: pid -> start time (the daemon's), and what ps names as its start (the detached registry's).
const table = (live: Record<number, string>) => ({
  isAlive: (pid: number) => pid in live, startTimeOf: (pid: number) => live[pid] ?? null, psStartOf: async (pid: number) => live[pid] ?? null,
})
// Where the twins keep the follower's pid files (HOST_SERVER_DIR under the state root, the install root).
async function followerPid(set: ReturnType<typeof serviceSet>, held: { pid: number; startTime: string }) {
  await fs.mkdir(path.join(set.installRoot, HOST_SERVER_STATE_DIR), { recursive: true })
  await fs.writeFile(path.join(set.installRoot, HOST_SERVER_STATE_DIR, 'server-k.pid'), JSON.stringify(held))
}

describe('removeServiceSetDir (drill D5)', () => {
  it('removes the set\'s own dir when its daemon is stopped and no CLI or follower of it lives; another set stays', async () => {
    const set = await layout()
    const other = await layout(OTHER)
    // A registry entry and a follower pid file whose processes are gone, and one whose pid was reused.
    await fs.writeFile(path.join(set.installRoot, 'sessions.json'), JSON.stringify({ version: 1, sessions: { s1: { pid: 4001, startTime: '10' }, s2: { pid: 4002, startTime: '11' } } }))
    await followerPid(set, { pid: 4003, startTime: '12' })
    await fs.writeFile(path.join(set.runtimeDir, 'daemon.pid'), '4004\n')
    expect(await removeServiceSetDir(home, set, 1000, table({ 4002: '99' }))).toEqual({ removed: true, dir: serviceSetBase(home, SET) })
    expect(await exists(serviceSetBase(home, SET))).toBe(false)
    expect(await exists(other.installRoot)).toBe(true)
  })

  it('keeps it, saying why, while its daemon, a CLI of it or its follower lives, or its registry does not read', async () => {
    const set = await layout()
    await fs.writeFile(path.join(set.runtimeDir, 'daemon.pid'), '5001\n')
    expect(await removeServiceSetDir(home, set, 1000, table({ 5001: '1' }))).toMatchObject({ removed: false, why: 'its daemon still runs (pid 5001)' })
    await fs.rm(path.join(set.runtimeDir, 'daemon.pid'))
    await fs.writeFile(path.join(set.installRoot, 'sessions.json'), JSON.stringify({ version: 1, sessions: { sid1: { pid: 5002, startTime: '7' } } }))
    expect(await removeServiceSetDir(home, set, 1000, table({ 5002: '7' }))).toMatchObject({ removed: false, why: expect.stringMatching(/1 CLI of the set still runs \(sid1\)/) })
    await fs.writeFile(path.join(set.installRoot, 'sessions.json'), '{torn')
    expect(await removeServiceSetDir(home, set, 1000, table({}))).toMatchObject({ removed: false, why: expect.stringMatching(/registry does not read/) })
    await fs.rm(path.join(set.installRoot, 'sessions.json'))
    await followerPid(set, { pid: 5003, startTime: '8' })
    expect(await removeServiceSetDir(home, set, 1000, table({ 5003: '8' }))).toMatchObject({ removed: false, why: 'its follower still runs (pid 5003)' })
    expect(await exists(path.join(set.installRoot, 'versions', 'abc', 'daemon'))).toBe(true)
  })

  it('never the default set, and a symlink in the set\'s place is not followed', async () => {
    await expect(removeServiceSetDir(home, serviceSet('linux', home, '', { runtimeDir: '/tmp/x' }), 1000, table({}))).rejects.toThrow(/never the default/)
    const target = await fs.mkdtemp(path.join(os.tmpdir(), 'set-remove-target-'))
    try {
      await fs.mkdir(path.dirname(serviceSetBase(home, SET)), { recursive: true })
      await fs.symlink(target, serviceSetBase(home, SET))
      const set = serviceSet('linux', home, SET, { uid: 1000 })
      expect(await removeServiceSetDir(home, set, 1000, table({}))).toMatchObject({ removed: false, why: 'it is not a plain directory' })
      expect(await exists(target)).toBe(true)
    } finally { await fs.rm(target, { recursive: true, force: true }) }
  })

  it('review round 2 H1: the follower\'s pid file is read where both twins write it (<state root>/host-server)', async () => {
    for (const twin of ['daemon-standalone.ts', 'daemon-source.ts']) {
      const text = await fs.readFile(path.join(__dirname, '../../src/providers', twin), 'utf8')
      expect(text, twin).toMatch(new RegExp(`HOST_SERVER_DIR = SERVICE_MODE && DAEMON_STATE_DIR\\s*\\?\\s*path\\.join\\(DAEMON_STATE_DIR, '${HOST_SERVER_STATE_DIR}'\\)`))
      expect(text, twin).toMatch(new RegExp(`DETACHED_RUNS_DIR = path\\.join\\(SERVICE_MODE && DAEMON_STATE_DIR \\? DAEMON_STATE_DIR : DAEMON_DIR, '${DETACHED_RUNS_STATE_DIR}'\\)`))
    }
    const set = await layout()
    await followerPid(set, { pid: 6001, startTime: '3' })
    expect(await removeServiceSetDir(home, set, 1000, table({ 6001: '3' }))).toMatchObject({ removed: false, why: 'its follower still runs (pid 6001)' })
    expect(await exists(serviceSetBase(home, SET))).toBe(true)
  })

  it('review round 2 H-L4: a detached run of the set (it outlives its daemon) keeps the dir while the same process holds its pid', async () => {
    const set = await layout()
    const dir = path.join(set.installRoot, DETACHED_RUNS_STATE_DIR)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'host-exec-j1.run'), registryText({ kind: 'host-exec', id: 'j1', pid: 7001, pgid: 7001, lstart: 'Mon Nov 23 10:00:00 2026' }))
    expect(await removeServiceSetDir(home, set, 1000, table({ 7001: 'Mon Nov 23 10:00:00 2026' }))).toMatchObject({
      removed: false, why: expect.stringMatching(/1 detached run of the set still runs \(host-exec j1\)/),
    })
    // The pid now held by another process: the run is gone, the dir goes.
    expect(await removeServiceSetDir(home, set, 1000, table({ 7001: 'Tue Nov 24 09:00:00 2026' }))).toMatchObject({ removed: true })
  })

  it('review round 2 H-L3: the unit\'s own runtime dir (its WALNUT_DAEMON_DIR) is the one checked and removed', async () => {
    const id = [...Array(16)].map(() => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')
    const set = await layout(id)
    // The unit pinned the /tmp fallback (a home that read longer when it was installed); the set computes R/rt now.
    const pinned = `/tmp/open-walnut-set-1000-${id}`
    await fs.mkdir(pinned, { recursive: true })
    try {
      await fs.writeFile(path.join(pinned, 'daemon.pid'), '8001\n')
      expect(await removeServiceSetDir(home, set, 1000, { ...table({ 8001: '1' }), unitRuntimeDir: pinned })).toMatchObject({ removed: false, why: 'its daemon still runs (pid 8001)' })
      expect(await removeServiceSetDir(home, set, 1000, { ...table({}), unitRuntimeDir: pinned })).toMatchObject({ removed: true })
      expect(await exists(pinned)).toBe(false)
    } finally { await fs.rm(pinned, { recursive: true, force: true }) }
  })
})
