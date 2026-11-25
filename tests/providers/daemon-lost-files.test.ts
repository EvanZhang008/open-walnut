/**
 * A live daemon whose door files were removed under it is found through its instance lock and
 * its files written back (daemon-lost-files.ts), never over a file that names something else.
 * Pure: a temp dir and a fake lock owner and hello.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DOOR_FILE_NAMES, doorFilesMissing, recoverLostDaemonFiles, writeBackDoorFiles } from '../../src/providers/daemon-lost-files.js'
import type { DaemonLockOwnerInfo } from '../../src/providers/daemon-instance-lock.js'

let dir = ''
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = '' })

const owner: DaemonLockOwnerInfo = { uid: 501, dir: '/x', pid: 95069, instanceId: 'inst-a', wsPort: 23676 }
const asOwner = async (port: number) => (port === owner.wsPort ? owner.instanceId : null)
const read = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8')

function tmp(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-lost-files-'))
  return dir
}

describe('writeBackDoorFiles', () => {
  it('writes back every missing door file of the owner that answers as itself, the pid file last', async () => {
    tmp()
    const order: string[] = []
    const spy = { ...fs, writeFileSync: ((file: string, data: string, o: fs.WriteFileOptions) => { order.push(path.basename(file)); fs.writeFileSync(file, data, o) }) as typeof fs.writeFileSync }
    expect(await writeBackDoorFiles({ dir, owner, hello: asOwner, fs: spy })).toEqual({ pid: 95069, port: 23676, instanceId: 'inst-a' })
    expect(order).toEqual([...DOOR_FILE_NAMES])
    expect(order.at(-1)).toBe('daemon.pid')
    expect(read('daemon.port')).toBe('23676')
    expect(read('daemon.instance')).toBe('inst-a')
    expect(read('daemon.pid')).toBe('95069')
    expect(fs.statSync(path.join(dir, 'daemon.pid')).mode & 0o777).toBe(0o600)
    expect(doorFilesMissing(dir)).toBe(false)
  })

  it('keeps a surviving file that says the same and writes only the missing ones', async () => {
    tmp()
    fs.writeFileSync(path.join(dir, 'daemon.instance'), 'inst-a\n')
    expect(await writeBackDoorFiles({ dir, owner, hello: asOwner })).not.toBeNull()
    expect(read('daemon.instance')).toBe('inst-a\n')
    expect(read('daemon.pid')).toBe('95069')
  })

  it('never writes over a file that names another daemon, and then writes no pid file', async () => {
    tmp()
    fs.writeFileSync(path.join(dir, 'daemon.port'), '1')
    expect(await writeBackDoorFiles({ dir, owner, hello: asOwner })).toBeNull()
    expect(read('daemon.port')).toBe('1')
    expect(fs.existsSync(path.join(dir, 'daemon.pid'))).toBe(false)
  })

  it('writes nothing when a later survivor names another daemon (the pid file), even where files are missing', async () => {
    tmp()
    fs.writeFileSync(path.join(dir, 'daemon.pid'), '4242')
    expect(await writeBackDoorFiles({ dir, owner, hello: asOwner })).toBeNull()
    expect(fs.existsSync(path.join(dir, 'daemon.port'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'daemon.instance'))).toBe(false)
    expect(read('daemon.pid')).toBe('4242')
  })

  it('writes nothing when the port does not answer as the lock instance', async () => {
    for (const hello of [async () => null, async () => 'inst-other', async () => { throw new Error('refused') }]) {
      tmp()
      expect(await writeBackDoorFiles({ dir, owner, hello })).toBeNull()
      expect(DOOR_FILE_NAMES.some((n) => fs.existsSync(path.join(dir, n)))).toBe(false)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes nothing for no owner, one still starting, one with no pid of its own, or nothing missing', async () => {
    for (const o of [null, { ...owner, wsPort: null }, { ...owner, pid: 1 }, { ...owner, instanceId: '' }, { ...owner, inProcess: true as const }]) {
      tmp()
      let asked = false
      expect(await writeBackDoorFiles({ dir, owner: o, hello: async (p) => { asked = true; return asOwner(p) } })).toBeNull()
      expect(DOOR_FILE_NAMES.some((n) => fs.existsSync(path.join(dir, n)))).toBe(false)
      if (o?.inProcess) expect(asked).toBe(false)
      fs.rmSync(dir, { recursive: true, force: true })
    }
    tmp()
    for (const n of DOOR_FILE_NAMES) fs.writeFileSync(path.join(dir, n), 'other')
    expect(await writeBackDoorFiles({ dir, owner, hello: asOwner })).toBeNull()
    expect(read('daemon.pid')).toBe('other')
  })
})

describe('recoverLostDaemonFiles', () => {
  it('reads the lock only when a door file is missing', async () => {
    tmp()
    let reads = 0
    const readOwner = async () => { reads++; return owner }
    for (const n of DOOR_FILE_NAMES) fs.writeFileSync(path.join(dir, n), 'x')
    expect(await recoverLostDaemonFiles({ dir, uid: 501, hello: asOwner, readOwner })).toBeNull()
    expect(reads).toBe(0)
    fs.rmSync(path.join(dir, 'daemon.pid'))
    // The survivors name something else: nothing is written.
    expect(await recoverLostDaemonFiles({ dir, uid: 501, hello: asOwner, readOwner })).toBeNull()
    expect(reads).toBe(1)
    for (const n of DOOR_FILE_NAMES) fs.rmSync(path.join(dir, n), { force: true })
    expect((await recoverLostDaemonFiles({ dir, uid: 501, hello: asOwner, readOwner }))?.pid).toBe(95069)
    expect(reads).toBe(2)
  })
})

/**
 * The class: whoever decides "no daemon runs here" from the door files starts one, and that one
 * yields to the running daemon's lock. Two doors cover every starter, and this pins both:
 *   - the place a starting daemon yields (the only taker of the instance lock) writes the files back;
 *   - the two processes that look before they start (the server, the join) ask first, the server
 *     before it decides whether the daemon runs in its own process (tests/providers/daemon-lost-files-e2e.test.ts
 *     runs each with a real session).
 * A new taker of the lock, or one of these three losing its call, fails here.
 */
describe('everything that starts a daemon gets a running daemon\'s lost door files back', () => {
  const ROOT = path.resolve(import.meta.dirname, '../..')
  const src = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  const tsFiles = (rel: string): string[] => fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsFiles(path.join(rel, e.name)) : /\.ts$/.test(e.name) ? [path.join(rel, e.name)] : [])

  it('the only taker of the instance lock is the daemon\'s start, and it writes them back where it yields', () => {
    const takers = tsFiles('src').filter((f) => f !== 'src/providers/daemon-instance-lock.ts' && /\bacquireDaemonInstanceLock\(/.test(src(f)))
    expect(takers, 'a new taker of the daemon instance lock: where it yields to a running daemon, write that daemon\'s lost door files back (daemon-lost-files.ts), then list it here').toEqual(['src/providers/daemon-standalone.ts'])
    // The block that yields: from its `if (lock.kind === 'existing') {` to its return.
    const text = src('src/providers/daemon-standalone.ts')
    const yields = text.indexOf("return { kind: 'existing', port: String(lock.owner.wsPort) }")
    expect(yields).toBeGreaterThan(0)
    const block = text.lastIndexOf("if (lock.kind === 'existing') {", yields)
    expect(block).toBeGreaterThan(0)
    expect(text.slice(block, yields)).toMatch(/writeBackDoorFiles\(/)
  })

  it('the server asks before either way to its daemon, and the join asks before it looks', () => {
    const server = src('src/providers/local-daemon.ts')
    // First in ensureRunningOrInProcess: after it, the in-process start and the daemon program path both find the daemon by its files.
    expect(server).toMatch(/private async ensureRunningOrInProcess\(\): Promise<number> \{\n(\s+\/\/[^\n]*\n)*\s+await this\.recoverLostDaemon\(\)/)
    expect(server).toMatch(/private async recoverLostDaemon\(\)[\s\S]{0,600}recoverLostDaemonFiles\(/)
    expect(src('src/commands/net.ts')).toMatch(/export async function recoverLostDaemon\(\)[\s\S]{0,400}recoverLostDaemonFiles\(/)
  })
})
