/**
 * What a session daemon in the home dir leaves in /tmp/open-walnut for a release from before its
 * files moved there (daemon-older-release-door.ts). 2026-11-26, rehearsed against the published
 * 0.6.37: started after a newer build had run from the home dir, it started its daemon in
 * /tmp/open-walnut with an empty registry, removed the stdin FIFOs of the sessions that still ran
 * and adopted their CLIs by pid: those sessions never took a line again.
 *
 * MACHINE SAFETY: every path is inside a mkdtemp dir; the real /tmp/open-walnut is never named.
 * The lock is taken on that temp dir's own port.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { linkRegistryForOlderReleases, ownSharedDir, servesOlderReleases } from '../../src/providers/daemon-older-release-door.js'
import net from 'node:net'
import { acquireDaemonInstanceLock, daemonLockPort, DAEMON_LOCK_HOST, DAEMON_LOCK_MAGIC, readDaemonInstanceHolder, readDaemonInstanceOwner } from '../../src/providers/daemon-instance-lock.js'
import { DAEMON_STATE_MARKERS, chooseLocalDaemonDir, realDaemonDirDeps, SHARED_DAEMON_DIR } from '../../src/lib/daemon-dir.js'
import { serverImagesDir } from '../../src/providers/daemon-fs-write.js'

const uid = process.getuid?.() ?? 0
const BOOT = Date.now() - 3600_000
let dir = ''
let shared = ''
let registry = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'older-door-'))
  shared = path.join(dir, 'shared')
  registry = path.join(dir, 'home', 'sessions.json')
  fs.mkdirSync(shared)
  fs.mkdirSync(path.dirname(registry))
  fs.writeFileSync(registry, '{"version":1,"sessions":{"s1":{"pid":4242}}}')
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('servesOlderReleases: only the account\'s own production daemon in its home dir', () => {
  const at = (over: Partial<Parameters<typeof servesOlderReleases>[0]> = {}) =>
    servesOlderReleases({ daemonDir: '/home/me/.cache/open-walnut', accountHome: '/home/me', serviceMode: false, platform: 'linux', resolve: path.resolve, ...over })

  it('the home dir of the passwd home, however it is spelled', () => {
    expect(at()).toBe(true)
    expect(at({ daemonDir: '/home/me/.cache/open-walnut/' })).toBe(true)
    expect(at({ platform: 'darwin', accountHome: '/Users/me', daemonDir: '/Users/me/.cache/open-walnut' })).toBe(true)
  })

  it('never the shared dir itself, a test or demo daemon under a faked HOME, an isolated dir, a login service, or an account with no home', () => {
    expect(at({ daemonDir: '/tmp/open-walnut' })).toBe(false)
    expect(at({ daemonDir: '/tmp/fake-home/.cache/open-walnut' })).toBe(false)
    expect(at({ daemonDir: '/tmp/walnut-test-x' })).toBe(false)
    expect(at({ serviceMode: true })).toBe(false)
    expect(at({ accountHome: null })).toBe(false)
    expect(at({ platform: 'win32' })).toBe(false)
  })
})

describe('ownSharedDir', () => {
  const own = (over: Partial<Parameters<typeof ownSharedDir>[0]> = {}) => ownSharedDir({ fs, sharedDir: shared, uid, mayCreate: true, ...over })

  it('a real directory of this user', () => {
    expect(own()).toBe(true)
    expect(own({ uid: uid + 1 })).toBe(false)
  })

  it('makes a dir that is not there, owner only, unless told not to', () => {
    fs.rmSync(shared, { recursive: true })
    expect(own({ mayCreate: false })).toBe(false)
    expect(fs.existsSync(shared)).toBe(false)
    expect(own()).toBe(true)
    expect(fs.statSync(shared).mode & 0o777).toBe(0o700)
  })

  it('never a symlink or a file in its place', () => {
    fs.rmSync(shared, { recursive: true })
    fs.mkdirSync(path.join(dir, 'real'))
    fs.symlinkSync(path.join(dir, 'real'), shared)
    expect(own()).toBe(false)
    fs.rmSync(shared)
    fs.writeFileSync(shared, 'x')
    expect(own()).toBe(false)
  })
})

describe('linkRegistryForOlderReleases', () => {
  const link = (over: Partial<Parameters<typeof linkRegistryForOlderReleases>[0]> = {}) =>
    linkRegistryForOlderReleases({ fs, sharedDir: shared, registryFile: registry, pid: 4242, bootMs: BOOT, ...over })
  const at = () => path.join(shared, 'sessions.json')

  it('leaves a link an older daemon reads the registry through, and keeps it', () => {
    expect(link()).toBe('linked')
    expect(fs.lstatSync(at()).isSymbolicLink()).toBe(true)
    expect(JSON.parse(fs.readFileSync(at(), 'utf8')).sessions.s1.pid).toBe(4242)
    expect(link()).toBe('kept')
    expect(fs.readdirSync(shared)).toEqual(['sessions.json'])
  })

  it('an older daemon writes its own registry over the link (a rename), and that file is then left alone', () => {
    link()
    fs.writeFileSync(at() + '.tmp', '{"version":1,"sessions":{}}')
    fs.renameSync(at() + '.tmp', at())
    expect(fs.lstatSync(at()).isFile()).toBe(true)
    expect(link()).toBe('skipped')
    expect(fs.readFileSync(at(), 'utf8')).toBe('{"version":1,"sessions":{}}')
    // The home registry was never written through.
    expect(JSON.parse(fs.readFileSync(registry, 'utf8')).sessions.s1.pid).toBe(4242)
  })

  it('a link to somewhere else is pointed at this registry', () => {
    fs.symlinkSync(path.join(dir, 'elsewhere.json'), at())
    expect(link()).toBe('linked')
    expect(fs.readlinkSync(at())).toBe(registry)
  })

  it('a registry from before this machine booted is replaced; one written since, or with no boot time, is not', () => {
    fs.writeFileSync(at(), 'old')
    expect(link()).toBe('skipped')
    fs.utimesSync(at(), new Date(BOOT - 3600_000), new Date(BOOT - 3600_000))
    expect(link({ bootMs: null })).toBe('skipped')
    expect(link()).toBe('linked')
    expect(fs.readlinkSync(at())).toBe(registry)
  })

  it('a dir at the name is left alone', () => {
    fs.mkdirSync(at())
    expect(link()).toBe('skipped')
  })

  // The link must never read as "a daemon ran in the shared dir": that would move the daemon back there at the next start.
  it('the dir rule does not count the link, whichever marker name it has', () => {
    const map = (p: string) => (p === SHARED_DAEMON_DIR || p.startsWith(SHARED_DAEMON_DIR + '/') ? shared + p.slice(SHARED_DAEMON_DIR.length) : p)
    const deps = { ...realDaemonDirDeps, lstat: (p: string) => realDaemonDirDeps.lstat(map(p)), readFile: (p: string) => realDaemonDirDeps.readFile(map(p)), bootTimeMs: () => BOOT, dirProblem: () => null }
    const home = path.join(dir, 'h')
    link()
    for (const name of DAEMON_STATE_MARKERS.filter((n) => n !== 'sessions.json')) fs.symlinkSync(registry, path.join(shared, name))
    expect(chooseLocalDaemonDir({ HOME: home }, deps).dir).toBe(path.join(home, '.cache', 'open-walnut'))
  })
})

describe('the shared dir\'s instance lock, held by the home daemon', () => {
  it('a daemon that starts in the shared dir finds an owner there and is handed its port', async () => {
    const homeDir = path.dirname(registry)
    const held = await acquireDaemonInstanceLock({ runtimeDir: shared, uid, pid: process.pid, instanceId: 'd-home-1', daemonDir: homeDir })
    expect(held.kind).toBe('owner')
    if (held.kind !== 'owner') return
    try {
      held.publish(41234)
      // What every published daemon does first in its dir: it would print this port and exit.
      const second = await acquireDaemonInstanceLock({ runtimeDir: shared, uid, pid: process.pid, instanceId: 'd-older-2' })
      expect(second).toMatchObject({ kind: 'existing', owner: { instanceId: 'd-home-1', wsPort: 41234, pid: process.pid, daemonDir: homeDir } })
      // A release that does not know `daemonDir` reads a plain owner of the dir: the banner's other fields are as ever.
      const raw = await new Promise<string>((resolve, reject) => {
        const socket = net.createConnection({ host: DAEMON_LOCK_HOST, port: daemonLockPort(uid, fs.realpathSync(shared)) })
        let text = ''
        socket.on('data', (d) => { text += String(d) })
        socket.on('end', () => resolve(text))
        socket.on('error', reject)
      })
      expect(JSON.parse(raw)).toMatchObject({ magic: DAEMON_LOCK_MAGIC, uid, dir: fs.realpathSync(shared), pid: process.pid, instanceId: 'd-home-1', wsPort: 41234 })
      // 2026-11-26 review: this build's own tools read the lock to find the dir's daemon (to stop it, to
      // write its door files back, to hand a service over). A holder whose own dir is another one is none.
      expect(await readDaemonInstanceOwner({ runtimeDir: shared, uid })).toBeNull()
      // ... while the two that only refuse a start there still see who holds it.
      expect(await readDaemonInstanceHolder({ runtimeDir: shared, uid })).toMatchObject({ instanceId: 'd-home-1', daemonDir: homeDir })
    } finally {
      await held.release()
    }
    // A plain owner of the dir is still found.
    const plain = await acquireDaemonInstanceLock({ runtimeDir: shared, uid, pid: process.pid, instanceId: 'd-plain-3' })
    expect(plain.kind).toBe('owner')
    if (plain.kind === 'owner') {
      expect(await readDaemonInstanceOwner({ runtimeDir: shared, uid })).toMatchObject({ instanceId: 'd-plain-3' })
      await plain.release()
    }
    // After the home daemon stopped the dir is free: the older daemon starts, and reads the link.
    const after = await acquireDaemonInstanceLock({ runtimeDir: shared, uid, pid: process.pid, instanceId: 'd-older-2' })
    expect(after.kind).toBe('owner')
    if (after.kind === 'owner') await after.release()
  })
})

// The class of the 2026-11-26 review finding: code of this build that meets the shared dir's lock
// held by the home daemon and takes it for that dir's own daemon (it wrote the home daemon's door
// files into the shared dir, and `--stop` there stopped the home daemon).
describe('this build never takes a holder from another dir for the dir\'s daemon', () => {
  const SRC = path.resolve(__dirname, '../../src')
  const files = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : e.name.endsWith('.ts') ? [path.join(d, e.name)] : []))
  const sources = files(SRC).map((f) => ({ rel: path.relative(SRC, f), text: fs.readFileSync(f, 'utf8') })).filter((f) => f.rel !== 'providers/daemon-instance-lock.ts')

  it('only the daemon takes the lock, and it checks whose daemon holds it before anything else', () => {
    expect(sources.filter((f) => f.text.includes('acquireDaemonInstanceLock(')).map((f) => f.rel)).toEqual(['providers/daemon-standalone.ts'])
    const daemon = sources.find((f) => f.rel === 'providers/daemon-standalone.ts')!.text
    const existing = daemon.indexOf("if (lock.kind === 'existing') {")
    expect(existing).toBeGreaterThan(0)
    const refusal = daemon.indexOf('if (lock.owner.daemonDir) throw', existing)
    expect(refusal).toBeGreaterThan(existing)
    for (const later of ['writeBackDoorFiles({', "return { kind: 'existing'"]) expect(daemon.indexOf(later, existing), later).toBeGreaterThan(refusal)
  })

  it('everything else finds a dir\'s daemon through readDaemonInstanceOwner, which names no such holder', () => {
    // A new way to read the lock (the banner, the port) outside the lock module would see the holder raw.
    const raw = sources.filter((f) => /parseDaemonLockBanner\(|daemonLockPort\(|probeExistingOwner\(/.test(f.text)).map((f) => f.rel)
    expect(raw).toEqual([])
    // readDaemonInstanceHolder does name it: only for the two that refuse a start or say why none came.
    const holders = sources.filter((f) => f.text.includes('readDaemonInstanceHolder(')).map((f) => f.rel).sort()
    expect(holders).toEqual(['binary/service-entry.ts', 'providers/local-daemon.ts'])
    for (const rel of holders) expect(sources.find((f) => f.rel === rel)!.text, rel).toMatch(/owner\.daemonDir \?|if \(owner\.daemonDir\)/)
  })
})

describe('serverImagesDir: a daemon no server started still names the server\'s pictures dir', () => {
  const at = (over: Partial<Parameters<typeof serverImagesDir>[0]> = {}) =>
    serverImagesDir({ env: {}, daemonDir: '/home/me/.cache/open-walnut', homeDaemonDir: '/home/me/.cache/open-walnut', sharedDir: '/tmp/open-walnut', ownsShared: () => true, ...over })

  it('the dir the server named wins', () => {
    expect(at({ env: { WALNUT_DAEMON_IMAGES_DIR: '/x/images/' } })).toBe('/x/images')
  })

  it('a home daemon named none: the shared dir\'s, when that dir is this user\'s own; else its own', () => {
    expect(at()).toBe('/tmp/open-walnut/images')
    expect(at({ ownsShared: () => false })).toBe('/home/me/.cache/open-walnut/images')
  })

  it('a daemon in the shared dir or an isolated one keeps its own, as before', () => {
    expect(at({ daemonDir: '/tmp/open-walnut' })).toBe('/tmp/open-walnut/images')
    expect(at({ daemonDir: '/tmp/walnut-test-x' })).toBe('/tmp/walnut-test-x/images')
  })
})
