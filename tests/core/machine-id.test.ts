/**
 * This machine's stable id (src/core/machine-id.ts, the rule in src/providers/machine-id-core.ts):
 * made once under the account's home, never rewritten, seeded from the data dir's older id, a
 * broken file replaced only while it holds no valid id, and two processes that make it at once
 * agree on one.
 *
 * MACHINE SAFETY: every home is a temp dir (setMachineIdHomeForTest), the data dir is the test's
 * WALNUT_HOME (mocked constants); nothing reads the real ~/.local/state.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'
import { bunRuntime } from '../helpers/bun-runtime.js'

vi.mock('../../src/constants.js', () => createMockConstants('machine-id'))

import { WALNUT_HOME } from '../../src/constants.js'
import { legacyMachineIdFile, machineIdFile, readMachineId, readMachineIdSync, setMachineIdHomeForTest } from '../../src/core/machine-id.js'
import { machineIdOf, type MachineIdIo } from '../../src/providers/machine-id-core.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-machine-id-')))
let home = ''
let n = 0
const ID = /^[0-9a-f]{32}$/

beforeEach(() => {
  home = path.join(root, `home-${n++}`)
  fs.mkdirSync(home)
  setMachineIdHomeForTest(home)
  fs.rmSync(legacyMachineIdFile(), { force: true })
})
afterEach(() => {
  setMachineIdHomeForTest(null)
  delete process.env.XDG_STATE_HOME
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

describe('the stable machine id', () => {
  it('is made once in ~/.local/state/open-walnut/machine-id (file 0600, dir 0700), then read back', async () => {
    const id = await readMachineId()
    expect(id).toMatch(ID)
    const file = path.join(home, '.local', 'state', 'open-walnut', 'machine-id')
    expect(machineIdFile()).toBe(file)
    expect(fs.readFileSync(file, 'utf8')).toBe(`${id}\n`)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
    expect(fs.readdirSync(path.dirname(file))).toEqual(['machine-id'])
    // A process that starts later (nothing remembered) reads the same id; nothing rewrote it.
    const before = fs.statSync(file).mtimeMs
    setMachineIdHomeForTest(home)
    expect(await readMachineId()).toBe(id)
    expect(readMachineIdSync()).toBe(id)
    expect(fs.statSync(file).mtimeMs).toBe(before)
  })

  it('is never under XDG_STATE_HOME: a shell that sets it reads the same id as the login service', async () => {
    const id = await readMachineId()
    process.env.XDG_STATE_HOME = path.join(home, 'elsewhere')
    setMachineIdHomeForTest(home)
    expect(await readMachineId()).toBe(id)
    expect(fs.existsSync(path.join(home, 'elsewhere'))).toBe(false)
  })

  it('a missing file is seeded from the data dir\'s older id (the update stores\' key), which is left as it was', async () => {
    fs.mkdirSync(path.dirname(legacyMachineIdFile()), { recursive: true })
    fs.writeFileSync(legacyMachineIdFile(), `${'d'.repeat(32)}\n`)
    expect(legacyMachineIdFile()).toBe(path.join(WALNUT_HOME, 'local', 'machine-id'))
    expect(await readMachineId()).toBe('d'.repeat(32))
    expect(fs.readFileSync(machineIdFile(), 'utf8').trim()).toBe('d'.repeat(32))
    expect(fs.readFileSync(legacyMachineIdFile(), 'utf8').trim()).toBe('d'.repeat(32))
    // Once made, the older file no longer counts.
    fs.writeFileSync(legacyMachineIdFile(), `${'e'.repeat(32)}\n`)
    setMachineIdHomeForTest(home)
    expect(await readMachineId()).toBe('d'.repeat(32))
  })

  it('an older id that is not one is no seed: a random id is made', async () => {
    fs.mkdirSync(path.dirname(legacyMachineIdFile()), { recursive: true })
    fs.writeFileSync(legacyMachineIdFile(), 'not an id\n')
    const id = await readMachineId()
    expect(id).toMatch(ID)
    expect(id).not.toBe('not an id')
  })

  it('a file that holds no valid id is replaced whole by a new one, and that one stays', async () => {
    const file = machineIdFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'garbage')
    const id = await readMachineId()
    expect(id).toMatch(ID)
    expect(fs.readFileSync(file, 'utf8')).toBe(`${id}\n`)
    expect(fs.readdirSync(path.dirname(file))).toEqual(['machine-id'])
    setMachineIdHomeForTest(home)
    expect(await readMachineId()).toBe(id)
  })

  it('an id another process put in place first wins, also over a broken file', () => {
    const files = new Map<string, string>()
    const theirs = '1'.repeat(32)
    let made = 0
    const io = (onLink: () => void): MachineIdIo => ({
      home: '/h', dataHome: null, join: (...p) => p.join('/'), log: () => {},
      randomHex: () => (made++).toString(16).padStart(32, 'a'),
      fs: {
        readFileSync: (p) => { const t = files.get(p); if (t === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return t },
        mkdirSync: () => undefined,
        writeFileSync: (p, d) => { files.set(p, d) },
        // Another process got there between our read and our link.
        linkSync: (_a, b) => { onLink(); if (files.has(b)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); files.set(b, files.get(_a)!) },
        renameSync: (a, b) => { files.set(b, files.get(a)!); files.delete(a) },
        rmSync: (p) => { files.delete(p) },
      },
    })
    const file = '/h/.local/state/open-walnut/machine-id'
    expect(machineIdOf(io(() => files.set(file, `${theirs}\n`)))).toBe(theirs)
    expect(files.get(file)).toBe(`${theirs}\n`)
    expect([...files.keys()]).toEqual([file])
    // A broken file, made valid by another process meanwhile: theirs stays.
    files.set(file, 'broken')
    expect(machineIdOf(io(() => files.set(file, `${theirs}\n`)))).toBe(theirs)
    expect([...files.keys()]).toEqual([file])
  })

  it('many processes that make it at once agree on one id, whole on disk', async () => {
    // The id file used to be made with O_EXCL and written in a second step, so a process that met
    // it in between read it empty and put its own id over it (2026-11-04 review 5).
    const script = path.join(root, 'make.ts')
    fs.writeFileSync(script, [
      `import { machineIdOf } from ${JSON.stringify(path.resolve(import.meta.dirname, '../../src/providers/machine-id-core.ts'))}`,
      "import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'",
      // `nolink`: a file system without hard links (FUSE, exFAT), where linkSync fails.
      'const noLink = { ...fs, linkSync: () => { throw Object.assign(new Error("ENOTSUP"), { code: "ENOTSUP" }) } }',
      'process.stdout.write(machineIdOf({ home: process.argv[2], dataHome: null, fs: process.argv[3] === "nolink" ? noLink : fs, join: path.join, randomHex: () => crypto.randomBytes(16).toString("hex"), log: () => {} }))',
    ].join('\n'))
    const { spawn } = await import('node:child_process')
    const runtime = bunRuntime()
    // Rounds 0-2 with hard links, 3-5 without (finding 8: two renames there left two ids in one boot).
    for (let round = 0; round < 6; round++) {
      const shared = path.join(root, `race-${round}`)
      const ids = await Promise.all(Array.from({ length: 8 }, () => new Promise<string>((resolve, reject) => {
        const p = spawn(runtime, [script, shared, round < 3 ? 'link' : 'nolink'], { stdio: ['ignore', 'pipe', 'inherit'] })
        let out = ''
        p.stdout.on('data', (c) => { out += c })
        p.on('exit', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}`))))
      })))
      expect(new Set(ids).size).toBe(1)
      expect(ids[0]).toMatch(ID)
      const dir = path.join(shared, '.local', 'state', 'open-walnut')
      expect(fs.readFileSync(path.join(dir, 'machine-id'), 'utf8')).toBe(`${ids[0]}\n`)
      expect(fs.readdirSync(dir)).toEqual(['machine-id'])
    }
  }, 90_000)

  describe('on a file system without hard links', () => {
    const file = '/h/.local/state/open-walnut/machine-id'
    const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    const noLinkIo = (files: Map<string, string>, beforeCreate: () => void = () => {}): MachineIdIo => {
      let made = 0
      return {
        home: '/h', dataHome: null, join: (...p) => p.join('/'), log: () => {},
        randomHex: () => (made++).toString(16).padStart(32, 'a'),
        fs: {
          readFileSync: (p) => { const t = files.get(p); if (t === undefined) throw enoent(); return t },
          mkdirSync: () => undefined,
          writeFileSync: (p, d, opts) => {
            if (opts.flag === 'wx') {
              beforeCreate()
              if (files.has(p)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
            }
            files.set(p, d)
          },
          linkSync: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) },
          renameSync: () => { throw new Error('a rename here could put a second id over the first') },
          rmSync: (p) => { files.delete(p) },
        },
      }
    }

    it('the id is made with an exclusive create, whole, and its temp file goes', () => {
      const files = new Map<string, string>()
      const id = machineIdOf(noLinkIo(files))
      expect(id).toMatch(ID)
      expect(files.get(file)).toBe(`${id}\n`)
      expect([...files.keys()]).toEqual([file])
    })

    it('an id another process created first wins; nothing is put over it', () => {
      const files = new Map<string, string>()
      const theirs = '2'.repeat(32)
      expect(machineIdOf(noLinkIo(files, () => files.set(file, `${theirs}\n`)))).toBe(theirs)
      expect(files.get(file)).toBe(`${theirs}\n`)
      expect([...files.keys()]).toEqual([file])
    })

    it('a file another process has opened but not written yet is waited out, then read', () => {
      const files = new Map<string, string>()
      const theirs = '3'.repeat(32)
      let reads = 0
      const io = noLinkIo(files, () => files.set(file, ''))
      const read = io.fs.readFileSync
      // Their write lands after a few of our reads.
      io.fs.readFileSync = (p, enc) => { if (p === file && files.get(file) === '' && ++reads > 3) files.set(file, `${theirs}\n`); return read(p, enc) }
      expect(machineIdOf(io)).toBe(theirs)
      expect(files.get(file)).toBe(`${theirs}\n`)
    })
  })

  it('a missing file is seeded from the data dir it serves first, then from the default data dir', () => {
    const files = new Map<string, string>([
      ['/data/local/machine-id', `${'4'.repeat(32)}\n`],
      ['/h/.open-walnut/local/machine-id', `${'5'.repeat(32)}\n`],
    ])
    const io = (dataHome: string | null): MachineIdIo => ({
      home: '/h', dataHome, join: (...p) => p.join('/'), log: () => {}, randomHex: () => 'b'.repeat(32),
      fs: {
        readFileSync: (p) => { const t = files.get(p); if (t === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return t },
        mkdirSync: () => undefined,
        writeFileSync: (p, d) => { files.set(p, d) },
        linkSync: (a, b) => { files.set(b, files.get(a)!) },
        renameSync: () => {},
        rmSync: (p) => { files.delete(p) },
      },
    })
    expect(machineIdOf(io('/data'))).toBe('4'.repeat(32))
    files.delete('/h/.local/state/open-walnut/machine-id')
    expect(machineIdOf(io(null))).toBe('5'.repeat(32))
  })
})
