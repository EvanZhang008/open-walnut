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
    expect(await afterServiceUninstall({ home, uid: 1000, platform: 'linux', set: def, unitConfig: null, say })).toBe(null)
    expect(await readSetOwner(def.installRoot)).toBe(null)
    expect(fs.existsSync(path.join(def.installRoot, SET_OWNER_FILE))).toBe(false)
    expect(fs.existsSync(path.join(def.installRoot, LAUNCHER_SCRIPT_NAME))).toBe(false)
    expect(fs.existsSync(path.join(def.installRoot, LAUNCHER_DIR_NAME))).toBe(false)
    expect(fs.readFileSync(path.join(def.installRoot, 'boot-setup'), 'utf8')).toMatch(/result=removed/)
    // An older Walnut installs a plain default (no claim, no mode) and its daemon serves it.
    fs.writeFileSync(path.join(runtime, SERVES_FILE), JSON.stringify({ version: 'v', twin: 'binary', capabilities: [], walnuts: { [walnutKeyOf(OLD_HOME)]: Date.now() } }))
    expect((await choose()).set.id).toBe('aaaaaaaaaaaaaaaa')
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
})
