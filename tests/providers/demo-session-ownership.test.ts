// The demo server's own-session record (src/providers/demo-session-ownership.ts): read and write
// against a real file in a scratch data home, never the account's own.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
import { readDemoOwnership, writeDemoOwnership, type DemoOwnership } from '../../src/providers/demo-session-ownership.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-demo-ownership'))

const SID = 'aaaaaaaa-0000-4000-8000-000000000001'
const SID2 = 'bbbbbbbb-0000-4000-8000-000000000002'
const SID3 = 'cccccccc-0000-4000-8000-000000000003'
const ADAPTER = JSON.stringify(['node', 'adapter-a.mjs'])
const local = (...parts: string[]) => ['__local__', ...parts].join('\u0000')

let root: string
let home: string
let other: string
const fileOf = (h: string) => path.join(h, 'local', 'demo-session-ownership.json')
const record = (h: string, extra: Partial<Record<keyof DemoOwnership, unknown>> = {}) => ({
  v: 1,
  home: h,
  own: [local(SID)],
  threads: [local(ADAPTER, 'thread-1')],
  adapters: [[local('rt-1'), ADAPTER]],
  ...extra,
})
function plant(h: string, value: unknown): void {
  fs.mkdirSync(path.dirname(fileOf(h)), { recursive: true })
  fs.writeFileSync(fileOf(h), typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 })
}

beforeAll(() => {
  // Every path this file touches lives under the temp dir, never the account's HOME.
  expect(fs.realpathSync(os.tmpdir())).not.toBe(fs.realpathSync(os.homedir()))
})

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-demo-ownership-'))
  home = path.join(root, 'home-a')
  other = path.join(root, 'home-b')
  fs.mkdirSync(home)
  fs.mkdirSync(other)
  vi.stubEnv('HOME', path.join(root, 'account-home'))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('readDemoOwnership', () => {
  it('a missing file reads as an empty record for this home', async () => {
    expect(await readDemoOwnership(home)).toEqual({ v: 1, home, own: [], threads: [], adapters: [] })
    expect(fs.existsSync(path.join(home, 'local'))).toBe(false)
  })

  it('reads back exactly what a write stored', async () => {
    const value = record(home) as DemoOwnership
    await writeDemoOwnership(value)
    expect(await readDemoOwnership(home)).toEqual(value)
  })

  it('refuses a record of another version or another home', async () => {
    for (const bad of [record(home, { v: 2 }), record(home, { v: '1' }), record(home, { home: other }), record(home, { home: undefined })]) {
      plant(home, bad)
      await expect(readDemoOwnership(home)).rejects.toThrow(/invalid/)
    }
  })

  it('refuses any key that is not a local session, in every list', async () => {
    const remote = ['devbox', SID].join('\u0000')
    for (const bad of [
      record(home, { own: [remote] }),
      record(home, { own: [local(SID), SID2] }), // a bare id with no host
      record(home, { own: [`__local__${SID}`] }), // host prefix without the separator
      record(home, { threads: [['devbox', ADAPTER, 'thread-1'].join('\u0000')] }),
      record(home, { adapters: [[['devbox', 'rt-1'].join('\u0000'), ADAPTER]] }),
    ]) {
      plant(home, bad)
      await expect(readDemoOwnership(home)).rejects.toThrow(/invalid/)
    }
  })

  it('refuses a record of the wrong shape', async () => {
    for (const bad of [
      record(home, { own: local(SID) }),
      record(home, { own: [42] }),
      record(home, { own: undefined }),
      record(home, { threads: undefined }),
      record(home, { threads: [null] }),
      record(home, { adapters: undefined }),
      record(home, { adapters: [local('rt-1')] }),
      record(home, { adapters: [[local('rt-1')]] }),
      record(home, { adapters: [[local('rt-1'), ADAPTER, 'extra']] }),
      record(home, { adapters: [[local('rt-1'), 7]] }),
      { v: 1, home },
    ]) {
      plant(home, bad)
      await expect(readDemoOwnership(home)).rejects.toThrow(/invalid/)
    }
    for (const bad of ['', '{', 'not json']) {
      plant(home, bad)
      await expect(readDemoOwnership(home)).rejects.toThrow(SyntaxError)
    }
    plant(home, 'null')
    await expect(readDemoOwnership(home)).rejects.toThrow()
  })

  it('refuses a key with a missing or extra part where an own session or runtime belongs', async () => {
    for (const bad of [
      record(home, { own: ['__local__\u0000'] }), // host with no id
      record(home, { own: [local(ADAPTER, 'thread-1')] }), // a thread key in the own list
      record(home, { threads: ['__local__\u0000'] }),
      record(home, { threads: [local('thread-1')] }),
      record(home, { threads: [local('', 'thread-1')] }),
      record(home, { threads: [local(ADAPTER, '')] }),
      record(home, { threads: [local(ADAPTER, 'thread-1', 'extra')] }),
      record(home, { adapters: [['__local__\u0000', ADAPTER]] }),
      record(home, { adapters: [[local('rt-1', 'extra'), ADAPTER]] }),
    ]) {
      plant(home, bad)
      await expect(readDemoOwnership(home)).rejects.toThrow(/invalid/)
    }
  })

  // O_NOFOLLOW: the open itself fails on a symlink, so it never reads as missing (empty).
  const symlinkRefusal = async (h: string) => {
    const error = await readDemoOwnership(h).then(() => null, (e: NodeJS.ErrnoException) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error?.code).toBe('ELOOP')
  }

  it.skipIf(process.platform === 'win32')('refuses a symlink, also one to a valid record', async () => {
    const target = path.join(root, 'elsewhere.json')
    fs.writeFileSync(target, JSON.stringify(record(home)), { mode: 0o600 })
    fs.mkdirSync(path.join(home, 'local'), { recursive: true })
    fs.symlinkSync(target, fileOf(home))
    await symlinkRefusal(home)
  })

  it.skipIf(process.platform === 'win32')('refuses a dangling symlink instead of reading it as empty', async () => {
    fs.mkdirSync(path.join(home, 'local'), { recursive: true })
    fs.symlinkSync(path.join(root, 'missing.json'), fileOf(home))
    await symlinkRefusal(home)
  })

  it('refuses a directory in the record\'s place', async () => {
    fs.mkdirSync(fileOf(home), { recursive: true })
    await expect(readDemoOwnership(home)).rejects.toThrow(/not owned by this account/)
  })

  it.skipIf(typeof process.getuid !== 'function')('refuses a record another account owns', async () => {
    plant(home, record(home))
    const uid = fs.lstatSync(fileOf(home)).uid
    vi.spyOn(process, 'getuid').mockReturnValue(uid + 1)
    await expect(readDemoOwnership(home)).rejects.toThrow(/not owned by this account/)
  })

  it('never reads another home\'s record, also when its file was copied in', async () => {
    await writeDemoOwnership(record(other) as DemoOwnership)
    expect(await readDemoOwnership(home)).toEqual({ v: 1, home, own: [], threads: [], adapters: [] })
    // A copied data home carries the source's file, which names the source's home.
    fs.mkdirSync(path.join(home, 'local'), { recursive: true })
    fs.copyFileSync(fileOf(other), fileOf(home))
    await expect(readDemoOwnership(home)).rejects.toThrow(/invalid/)
    expect((await readDemoOwnership(other)).home).toBe(other)
  })
})

describe('writeDemoOwnership', () => {
  it('writes atomically with mode 600 and leaves no temp file', async () => {
    await writeDemoOwnership(record(home) as DemoOwnership)
    const stat = fs.statSync(fileOf(home))
    expect(stat.isFile()).toBe(true)
    if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(path.join(home, 'local'))).toEqual(['demo-session-ownership.json'])
  })

  it('tightens a looser file it replaces to mode 600', async () => {
    plant(home, record(home))
    fs.chmodSync(fileOf(home), 0o644)
    await writeDemoOwnership(record(home, { own: [local(SID2)] }) as DemoOwnership)
    if (process.platform !== 'win32') expect(fs.statSync(fileOf(home)).mode & 0o777).toBe(0o600)
    expect((await readDemoOwnership(home)).own).toEqual([local(SID2)])
  })

  it('writes one at a time in call order, each the value as it was when called', async () => {
    const value = record(home, { own: [local(SID)] }) as DemoOwnership
    const first = writeDemoOwnership(value)
    value.own.push(local(SID2))
    const second = writeDemoOwnership(value)
    // A change after the last call is not written: each write took its own snapshot.
    value.own.push(local(SID3))
    value.adapters.length = 0
    await Promise.all([first, second])
    const stored = await readDemoOwnership(home)
    expect(stored.own).toEqual([local(SID), local(SID2)])
    expect(stored.adapters).toEqual([[local('rt-1'), ADAPTER]])
  })

  it('many concurrent writes end on the last call', async () => {
    const all = Array.from({ length: 12 }, (_, i) =>
      writeDemoOwnership(record(home, { own: [local(`s-${i}`)] }) as DemoOwnership))
    await Promise.all(all)
    expect((await readDemoOwnership(home)).own).toEqual([local('s-11')])
    expect(fs.readdirSync(path.join(home, 'local'))).toEqual(['demo-session-ownership.json'])
  })

  it('a failed write rejects without stopping the writes after it', async () => {
    // `local` is a file here, so the record's directory cannot be made.
    const broken = path.join(root, 'broken-home')
    fs.mkdirSync(broken)
    fs.writeFileSync(path.join(broken, 'local'), 'not a directory')
    const bad = writeDemoOwnership(record(broken) as DemoOwnership)
    const good = writeDemoOwnership(record(home) as DemoOwnership)
    await expect(bad).rejects.toThrow()
    await expect(good).resolves.toBeUndefined()
    expect(await readDemoOwnership(home)).toEqual(record(home))
  })

  it('writes each record into its own home only', async () => {
    await writeDemoOwnership(record(home, { own: [local(SID)] }) as DemoOwnership)
    await writeDemoOwnership(record(other, { own: [local(SID2)] }) as DemoOwnership)
    expect((await readDemoOwnership(home)).own).toEqual([local(SID)])
    expect((await readDemoOwnership(other)).own).toEqual([local(SID2)])
  })
})
