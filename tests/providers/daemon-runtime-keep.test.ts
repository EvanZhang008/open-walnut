/**
 * keepRuntimeFiles (daemon-core.ts), on a real temp dir: the temp cleanup (macOS after 3 days,
 * systemd-tmpfiles after 10) removes a running daemon's own files from /tmp/open-walnut, and
 * the next server or join sees no daemon there (2026-11-02: a Mac whose Walnut had run 26 days
 * had lost daemon.pid, daemon.port and sessions.json). The daemon runs it every hour.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DAEMON_LOG_KEEP_MS, DAEMON_PICTURE_KEEP_MS, keepRuntimeFiles, linkRegistryForOlderReleases, pruneDaemonScratch, RUNTIME_KEEP_MS } from '../../src/providers/daemon-core.js'
import { DAEMON_STATE_MARKERS, chooseLocalDaemonDir, realDaemonDirDeps, SHARED_DAEMON_DIR } from '../../src/lib/daemon-dir.js'

let dir = ''
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-keep-')) })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const OLD = new Date('2026-10-01T00:00:00Z')
const NOW = new Date('2026-11-02T08:00:00Z')

function keep(pid = 4242) {
  let persisted = 0
  const f = (n: string) => path.join(dir, n)
  const restored = keepRuntimeFiles({
    fs, pid, pidFile: f('daemon.pid'),
    files: [{ file: f('daemon.port'), text: '41234' }, { file: f('daemon.pid'), text: String(pid) }, { file: f('daemon.version'), text: 'v1' }],
    touch: [f('daemon.owner'), f('bridge.json')],
    touchDirs: [{ dir: f('bin'), match: /^walnut/ }, { dir, match: /\.(cjs|mjs|js)$|^daemon-(darwin|linux)-[a-z0-9-]+$|^dtach-/ }],
    registryFile: f('sessions.json'),
    persistRegistry: () => { persisted++; fs.writeFileSync(f('sessions.json'), '{"version":1,"sessions":{}}') },
    now: NOW,
  })
  return { restored: restored.map((p) => path.basename(p)), persisted }
}

describe('keepRuntimeFiles', () => {
  it('writes back what the cleanup removed, the registry by its own writer', () => {
    const r = keep()
    expect(r.restored).toEqual(['daemon.port', 'daemon.pid', 'daemon.version', 'sessions.json'])
    expect(r.persisted).toBe(1)
    expect(fs.readFileSync(path.join(dir, 'daemon.port'), 'utf8')).toBe('41234')
    expect(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8')).toBe('4242')
    // Dated like the stamp it freshens: a daemon.pid newer than daemon.stamp reads as an earlier
    // daemon's stamp (daemon-live-sh.ts w_stamp; review A3b S34-M1).
    expect(fs.statSync(path.join(dir, 'daemon.pid')).mtimeMs).toBe(NOW.getTime())
  })

  it('freshens the times of files that are there, so a cleanup by age never finds them old', () => {
    for (const n of ['daemon.port', 'daemon.pid', 'daemon.version', 'sessions.json']) {
      fs.writeFileSync(path.join(dir, n), n === 'daemon.pid' ? '4242' : 'x')
      fs.utimesSync(path.join(dir, n), OLD, OLD)
    }
    expect(keep()).toEqual({ restored: [], persisted: 0 })
    for (const n of ['daemon.port', 'daemon.pid', 'daemon.version', 'sessions.json']) {
      const st = fs.statSync(path.join(dir, n))
      expect(st.mtimeMs).toBe(NOW.getTime())
      expect(st.atimeMs).toBe(NOW.getTime())
    }
    expect(fs.readFileSync(path.join(dir, 'daemon.port'), 'utf8')).toBe('x')
  })

  it('freshens the files that are only read (shim, daemon copy, sidecars, bridge.json), never the logs', () => {
    fs.mkdirSync(path.join(dir, 'bin'))
    fs.mkdirSync(path.join(dir, 'images'))
    const read = ['bin/walnut', 'bin/walnut-core', 'net-core.cjs', 'daemon-fallback.cjs', 'daemon-darwin-arm64', 'dtach-darwin-arm64', 'bridge.json', 'daemon.owner']
    // The server prunes its logs by age (src/logging/logger.ts), and old daemons' logs age out.
    const aging = ['open-walnut-2026-10-01.log', 'daemon-d-123-ab12.log', 'images/a.png', 'acp-busy.json']
    for (const n of [...read, ...aging]) { fs.writeFileSync(path.join(dir, n), 'x'); fs.utimesSync(path.join(dir, n), OLD, OLD) }
    keep()
    for (const n of read) expect(fs.statSync(path.join(dir, n)).mtimeMs, n).toBe(NOW.getTime())
    for (const n of aging) expect(fs.statSync(path.join(dir, n)).mtimeMs, n).toBe(OLD.getTime())
  })

  it('never writes over another daemon that took the dir', () => {
    fs.writeFileSync(path.join(dir, 'daemon.pid'), '777')
    fs.writeFileSync(path.join(dir, 'bridge.json'), 'x')
    fs.utimesSync(path.join(dir, 'bridge.json'), OLD, OLD)
    expect(keep()).toEqual({ restored: [], persisted: 0 })
    expect(fs.existsSync(path.join(dir, 'daemon.port'))).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8')).toBe('777')
    // Nor touches its files: they are that daemon's to keep.
    expect(fs.statSync(path.join(dir, 'bridge.json')).mtimeMs).toBe(OLD.getTime())
  })

  it('a dir that is gone is left alone, and nothing throws', () => {
    fs.rmSync(dir, { recursive: true, force: true })
    expect(() => keep()).not.toThrow()
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('the daemon runs it, every RUNTIME_KEEP_MS, well inside the shortest cleanup age', () => {
    expect(RUNTIME_KEEP_MS).toBeLessThanOrEqual(6 * 3600_000)
    const standalone = fs.readFileSync(path.join(__dirname, '../../src/providers/daemon-standalone.ts'), 'utf8')
    expect(standalone).toContain(': RUNTIME_KEEP_MS)\n  runtimeKeepTimer.unref?.()')
    expect(standalone).toContain('if (runtimeKeepTimer) { try { clearInterval(runtimeKeepTimer) } catch {} runtimeKeepTimer = null }')
    expect(standalone).toContain('const restored = keepRuntimeFiles({')
  })
})

// The daemon's dir is in the home since 2026-11-26 (src/lib/daemon-dir.ts): no temp cleanup ages
// its scratch there, so the daemon does, on the same clock.
describe('pruneDaemonScratch', () => {
  const DAY = 24 * 3600_000
  const now = NOW.getTime()
  function put(rel: string, ageMs: number, readAgoMs = ageMs): string {
    const file = path.join(dir, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'x')
    fs.utimesSync(file, new Date(now - readAgoMs), new Date(now - ageMs))
    return file
  }
  const prune = (ownLogs: string[] = []) => pruneDaemonScratch({ fs, dir, ownLogs, now }).map((p) => path.relative(path.dirname(dir), p)).sort()
  const base = () => path.basename(dir)

  it('removes the logs of daemons that are gone once they are old, never this daemon\'s own', () => {
    put('daemon-d-100-aaaa1111.log', DAEMON_LOG_KEEP_MS + DAY)
    put('daemon-exit-d-100-aaaa1111.log', DAEMON_LOG_KEEP_MS + DAY)
    put('daemon-d-200-bbbb2222.log', DAEMON_LOG_KEEP_MS - DAY)
    const own = put('daemon-d-300-cccc3333.log', DAEMON_LOG_KEEP_MS + 30 * DAY)
    expect(prune([own])).toEqual([`${base()}/daemon-d-100-aaaa1111.log`, `${base()}/daemon-exit-d-100-aaaa1111.log`])
    expect(fs.existsSync(own)).toBe(true)
  })

  it('removes pictures nobody read or wrote for the keep time, in images/ and <dir>-images/, at any depth', () => {
    put('images/old.png', DAEMON_PICTURE_KEEP_MS + DAY)
    put('images/remote/host/old.jpg', DAEMON_PICTURE_KEEP_MS + DAY)
    put('images/new.png', DAY)
    // Written long ago, read yesterday: still in use.
    put('images/read.png', DAEMON_PICTURE_KEEP_MS + DAY, DAY)
    const sibling = `${dir}-images`
    try {
      fs.mkdirSync(sibling)
      fs.writeFileSync(path.join(sibling, 'up.png'), 'x')
      fs.utimesSync(path.join(sibling, 'up.png'), new Date(now - DAEMON_PICTURE_KEEP_MS - DAY), new Date(now - DAEMON_PICTURE_KEEP_MS - DAY))
      expect(prune()).toEqual([`${base()}-images/up.png`, `${base()}/images/old.png`, `${base()}/images/remote/host/old.jpg`])
      expect(fs.existsSync(path.join(dir, 'images', 'remote', 'host'))).toBe(true)
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true })
    }
  })

  // The class: anything a daemon or a later server needs, however old, is never this function's to remove.
  it('removes nothing else, however old: the daemon\'s own files, state, programs, the server\'s logs, a symlinked dir', () => {
    const ANCIENT = 400 * DAY
    const keepers = [
      'daemon.port', 'daemon.pid', 'daemon.instance', 'daemon.version', 'daemon.owner', 'daemon.stamp', 'daemon.serves.json', 'sessions.json', 'bridge.json',
      'bin/walnut', 'daemon-linux-x64', 'daemon.cjs', 'net-core.cjs', 'trigger-state/t1.json', 'resume-records/r.json', 'plugin-jobs/j.json',
      'host-exec/hx.log', 'detached/run.json', 'turn-snapshots/s.json', 'changes-checkpoints/c.json', 'open-walnut-2026-01-01.log', 'daemon-stderr.log',
      'daemon-notes.log', 'pastes/p.txt',
    ]
    for (const k of keepers) put(k, ANCIENT)
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-keep-out-'))
    try {
      fs.writeFileSync(path.join(outside, 'victim.png'), 'x')
      fs.utimesSync(path.join(outside, 'victim.png'), new Date(now - ANCIENT), new Date(now - ANCIENT))
      fs.mkdirSync(path.join(dir, 'images'), { recursive: true })
      fs.symlinkSync(outside, path.join(dir, 'images', 'link'))
      fs.symlinkSync(path.join(outside, 'victim.png'), path.join(dir, 'images', 'file-link.png'))
      expect(prune()).toEqual([])
      for (const k of keepers) expect(fs.existsSync(path.join(dir, k)), k).toBe(true)
      expect(fs.existsSync(path.join(outside, 'victim.png'))).toBe(true)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('a dir with no images, or no dir at all, removes nothing and does not throw', () => {
    expect(prune()).toEqual([])
    expect(pruneDaemonScratch({ fs, dir: path.join(dir, 'missing'), ownLogs: [], now })).toEqual([])
  })
})

/**
 * A release from before the daemon's files left /tmp/open-walnut reads `sessions.json` there
 * (2026-11-26: after a downgrade it found none, and the sessions that still ran never took a line
 * again). A daemon in the home dir leaves the name there as a link to its registry.
 */
describe('linkRegistryForOlderReleases', () => {
  const uid = process.getuid?.() ?? 0
  const BOOT = Date.now() - 3600_000
  let shared = ''
  let registry = ''
  beforeEach(() => {
    shared = path.join(dir, 'shared')
    registry = path.join(dir, 'home', 'sessions.json')
    fs.mkdirSync(shared)
    fs.mkdirSync(path.dirname(registry))
    fs.writeFileSync(registry, '{"version":1,"sessions":{"s1":{"pid":4242}}}')
  })
  const link = (over: Partial<Parameters<typeof linkRegistryForOlderReleases>[0]> = {}) =>
    linkRegistryForOlderReleases({ fs, sharedDir: shared, registryFile: registry, uid, pid: 4242, bootMs: BOOT, ...over })
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

  it('a registry from before this machine booted is replaced; without a boot time it is not', () => {
    fs.writeFileSync(at(), 'old')
    fs.utimesSync(at(), new Date(BOOT - 3600_000), new Date(BOOT - 3600_000))
    expect(link({ bootMs: null })).toBe('skipped')
    expect(link()).toBe('linked')
    expect(fs.readlinkSync(at())).toBe(registry)
  })

  it('never makes the shared dir, and never writes into one that is not this user\'s real dir', () => {
    fs.rmSync(shared, { recursive: true })
    expect(link()).toBe('skipped')
    expect(fs.existsSync(shared)).toBe(false)
    fs.mkdirSync(shared)
    expect(link({ uid: uid + 1 })).toBe('skipped')
    fs.rmSync(shared, { recursive: true })
    fs.mkdirSync(path.join(dir, 'real'))
    fs.symlinkSync(path.join(dir, 'real'), shared)
    expect(link()).toBe('skipped')
    expect(fs.readdirSync(path.join(dir, 'real'))).toEqual([])
    fs.rmSync(shared)
    fs.mkdirSync(shared)
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
