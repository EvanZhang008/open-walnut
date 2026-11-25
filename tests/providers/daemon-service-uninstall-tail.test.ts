/**
 * What a successful `walnut daemon uninstall` removes after the service itself
 * (src/providers/daemon-service-uninstall-tail.ts): the launcher's files, the mode, the boot-setup
 * marker, and per set the claim on the default's place (review round 2, H-L2) or the set's own dir,
 * read at the runtime dir the removed unit named (H-L3). Real files in a temp home; nothing runs.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { afterServiceUninstall } from '../../src/providers/daemon-service-uninstall-tail.js'
import { chooseServiceSet, readSetOwner, SET_OWNER_FILE } from '../../src/providers/service-set-choice.js'
import { serviceSet, serviceSetBase } from '../../src/providers/service-set.js'
import { LAUNCHER_DIR_NAME, LAUNCHER_SCRIPT_NAME } from '../../src/providers/service-launcher-script.js'
import { SERVES_FILE, walnutKeyOf } from '../../src/providers/daemon-shared.js'
import { HOST_SERVER_STATE_DIR } from '../../src/providers/daemon-service-state-move.js'

const A = 'aaaaaaaaaaaaaaaa00000000000000aa'
const OLD_HOME = '/home/u/.open-walnut-old'
let home = ''
let runtime = ''
const said: string[] = []
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-uninstall-tail-'))
  runtime = path.join(home, 'rt-default')
  fs.mkdirSync(runtime)
  said.length = 0
})
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })
const say = (line: string) => { said.push(line) }
const none = { isAlive: () => false, startTimeOf: () => null, psStartOf: async () => null }

describe('afterServiceUninstall', () => {
  it('review round 2 H-L2: a default uninstall removes the claim on the default\'s place, so a returning Walnut never takes back a default an older Walnut installed meanwhile', async () => {
    const choose = () => chooseServiceSet({ platform: 'linux', home, walnutId: A, serveHome: path.join(home, 'data-a'), defaultRuntimeDir: runtime, uid: 1000, claim: true })
    expect((await choose()).claimed).toBe(true)
    const def = serviceSet('linux', home, '', { runtimeDir: runtime })
    fs.writeFileSync(path.join(def.installRoot, LAUNCHER_SCRIPT_NAME), '#!/bin/sh\n')
    fs.mkdirSync(path.join(def.installRoot, LAUNCHER_DIR_NAME))
    expect(await afterServiceUninstall({ home, uid: 1000, platform: 'linux', set: def, unitConfig: '[Service]\nExecStart=/x\n', say })).toBe(null)
    expect(await readSetOwner(def.installRoot)).toBe(null)
    expect(fs.existsSync(path.join(def.installRoot, SET_OWNER_FILE))).toBe(false)
    expect(fs.existsSync(path.join(def.installRoot, LAUNCHER_SCRIPT_NAME))).toBe(false)
    expect(fs.existsSync(path.join(def.installRoot, LAUNCHER_DIR_NAME))).toBe(false)
    expect(fs.readFileSync(path.join(def.installRoot, 'boot-setup'), 'utf8')).toMatch(/result=removed/)
    // An older Walnut installs a plain default (no claim, no mode) and its daemon serves it.
    fs.writeFileSync(path.join(runtime, SERVES_FILE), JSON.stringify({ version: 'v', twin: 'binary', capabilities: [], walnuts: { [walnutKeyOf(OLD_HOME)]: Date.now() } }))
    expect((await choose()).set.id).toBe('aaaaaaaaaaaaaaaa')
  })

  it('review round 3 L-H3: an uninstall that removed no service config (another scope\'s service runs) keeps the claim on the default\'s place', async () => {
    const choose = () => chooseServiceSet({ platform: 'linux', home, walnutId: A, serveHome: path.join(home, 'data-a'), defaultRuntimeDir: runtime, uid: 1000, claim: true })
    expect((await choose()).claimed).toBe(true)
    const def = serviceSet('linux', home, '', { runtimeDir: runtime })
    const claim = await readSetOwner(def.installRoot)
    expect(claim).not.toBe(null)
    expect(await afterServiceUninstall({ home, uid: 1000, platform: 'linux', set: def, unitConfig: null, say })).toBe(null)
    expect(await readSetOwner(def.installRoot)).toEqual(claim)
    expect(said).toEqual([])
  })

  it('review round 2 H-L3: a set\'s dir is judged at the runtime dir the removed unit pinned, and that dir goes with it', async () => {
    const id = [...Array(16)].map(() => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')
    const set = serviceSet('linux', home, id, { uid: 1000 })
    fs.mkdirSync(path.join(set.installRoot, 'versions'), { recursive: true })
    const pinned = `/tmp/open-walnut-set-1000-${id}`
    fs.mkdirSync(pinned, { recursive: true })
    try {
      fs.writeFileSync(path.join(pinned, 'daemon.pid'), '9001\n')
      const unitConfig = `[Service]\nEnvironment=WALNUT_DAEMON_DIR=${pinned}\nEnvironment=WALNUT_DAEMON_STATE_DIR=${set.installRoot}\n`
      const alive = { ...none, isAlive: (pid: number) => pid === 9001, startTimeOf: () => '1' }
      expect(await afterServiceUninstall({ home, uid: 1000, platform: 'linux', set, unitConfig, say, removeDeps: alive }))
        .toMatchObject({ removed: false, why: 'its daemon still runs (pid 9001)' })
      expect(said.join('')).toMatch(/kept the service set's dir/)
      expect(await afterServiceUninstall({ home, uid: 1000, platform: 'linux', set, unitConfig, say, removeDeps: none })).toMatchObject({ removed: true })
      expect(fs.existsSync(serviceSetBase(home, id))).toBe(false)
      expect(fs.existsSync(pinned)).toBe(false)
    } finally { fs.rmSync(pinned, { recursive: true, force: true }) }
  })
  it('drill r9: a follower a daemon in its two-program fallback started is stopped before the set\'s dir is judged, so it never runs on with no parent', async () => {
    const id = 'f0f0f0f0f0f0f0f0'
    const set = serviceSet('darwin', home, id, { uid: 501 })
    const followers = path.join(set.installRoot, HOST_SERVER_STATE_DIR)
    fs.mkdirSync(followers, { recursive: true })
    const pidFile = path.join(followers, 'server-leader-a.pid')
    fs.writeFileSync(pidFile, JSON.stringify({ pid: 4242, startTime: 's' }))
    fs.writeFileSync(path.join(followers, 'server-leader-a.json'), '{}')
    const asked: string[][] = []
    // Alive until its stop: the pid file is the follower's word that it runs.
    const removeDeps = { ...none, isAlive: (pid: number) => pid === 4242 && fs.existsSync(pidFile), startTimeOf: () => 's' }
    const stopFollowers = async (files: string[]) => { asked.push(files); for (const f of files) fs.rmSync(f); return true }
    expect(await afterServiceUninstall({ home, uid: 501, platform: 'darwin', set, unitConfig: null, say, removeDeps, stopFollowers }))
      .toMatchObject({ removed: true })
    expect(asked).toEqual([[pidFile]])
    expect(fs.existsSync(serviceSetBase(home, id))).toBe(false)
  })

  it('drill r9: a follower that may still run keeps its pid file and the set\'s dir, and says so', async () => {
    const id = 'e0e0e0e0e0e0e0e0'
    const set = serviceSet('darwin', home, id, { uid: 501 })
    const followers = path.join(set.installRoot, HOST_SERVER_STATE_DIR)
    fs.mkdirSync(followers, { recursive: true })
    fs.writeFileSync(path.join(followers, 'server-leader-a.pid'), JSON.stringify({ pid: 4243, startTime: 's' }))
    const removeDeps = { ...none, isAlive: (pid: number) => pid === 4243, startTimeOf: () => 's' }
    expect(await afterServiceUninstall({ home, uid: 501, platform: 'darwin', set, unitConfig: null, say, removeDeps, stopFollowers: async () => false }))
      .toMatchObject({ removed: false, why: 'its follower still runs (pid 4243)' })
    expect(said.join('')).toMatch(/a follower of the service may still run/)
  })

  it('a service with no follower pid files asks no stop', async () => {
    const def = serviceSet('linux', home, '', { runtimeDir: runtime })
    let asked = 0
    await afterServiceUninstall({ home, uid: 1000, platform: 'linux', set: def, unitConfig: null, say, stopFollowers: async () => { asked += 1; return true } })
    expect(asked).toBe(0)
  })
})
