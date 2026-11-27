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
import { DAEMON_LOG_KEEP_MS, DAEMON_PICTURE_KEEP_MS, DIR_PASS_CONCURRENCY, keepRuntimeFiles, pruneDaemonScratch, RUNTIME_KEEP_MS, type DirPassFs } from '../../src/providers/daemon-core.js'
import { createLoopBudget } from '../../src/providers/loop-budget.js'

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
  const prune = async (ownLogs: string[] = []) => (await pruneDaemonScratch({ fs: fs.promises, dir, ownLogs, now })).map((p) => path.relative(path.dirname(dir), p)).sort()
  const base = () => path.basename(dir)

  it('removes the logs of daemons that are gone once they are old, never this daemon\'s own', async () => {
    put('daemon-d-100-aaaa1111.log', DAEMON_LOG_KEEP_MS + DAY)
    put('daemon-exit-d-100-aaaa1111.log', DAEMON_LOG_KEEP_MS + DAY)
    put('daemon-d-200-bbbb2222.log', DAEMON_LOG_KEEP_MS - DAY)
    const own = put('daemon-d-300-cccc3333.log', DAEMON_LOG_KEEP_MS + 30 * DAY)
    expect(await prune([own])).toEqual([`${base()}/daemon-d-100-aaaa1111.log`, `${base()}/daemon-exit-d-100-aaaa1111.log`])
    expect(fs.existsSync(own)).toBe(true)
  })

  it('removes pictures nobody read or wrote for the keep time, in images/ and <dir>-images/, at any depth', async () => {
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
      expect(await prune()).toEqual([`${base()}-images/up.png`, `${base()}/images/old.png`, `${base()}/images/remote/host/old.jpg`])
      expect(fs.existsSync(path.join(dir, 'images', 'remote', 'host'))).toBe(true)
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true })
    }
  })

  // The class: anything a daemon or a later server needs, however old, is never this function's to remove.
  it('removes nothing else, however old: the daemon\'s own files, state, programs, the server\'s logs, a symlinked dir', async () => {
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
      expect(await prune()).toEqual([])
      for (const k of keepers) expect(fs.existsSync(path.join(dir, k)), k).toBe(true)
      expect(fs.existsSync(path.join(outside, 'victim.png'))).toBe(true)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('a symlinked images/ root is not walked', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-keep-out-'))
    try {
      fs.writeFileSync(path.join(outside, 'victim.png'), 'x')
      fs.utimesSync(path.join(outside, 'victim.png'), new Date(now - 400 * DAY), new Date(now - 400 * DAY))
      fs.symlinkSync(outside, path.join(dir, 'images'))
      expect(await prune()).toEqual([])
      expect(fs.existsSync(path.join(outside, 'victim.png'))).toBe(true)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('a dir with no images, or no dir at all, removes nothing and does not throw', async () => {
    expect(await prune()).toEqual([])
    expect(await pruneDaemonScratch({ fs: fs.promises, dir: path.join(dir, 'missing'), ownLogs: [], now })).toEqual([])
  })
})

// 2026-11-27: the prune ran on the clock with lstatSync/readdirSync over the picture tree, and the
// runtime shares the web server's loop on the Mac (experiment in_process_daemon): 1.1 to 1.8 s
// stalls every hour after each start. The class: a pass over a directory on a daemon clock never
// uses the sync fs, keeps a bounded number of calls in flight and gives the loop turns.
describe('pruneDaemonScratch never holds the loop', () => {
  const DAY = 24 * 3600_000
  const now = NOW.getTime()
  const syncThrows = () => { throw new Error('sync fs on the loop') }

  it('prunes through the async fs alone: every sync call throws', async () => {
    fs.mkdirSync(path.join(dir, 'images', 'remote'), { recursive: true })
    for (const rel of ['images/old.png', 'images/remote/old.jpg', 'daemon-d-1-aa11.log']) {
      fs.writeFileSync(path.join(dir, rel), 'x')
      fs.utimesSync(path.join(dir, rel), new Date(now - 30 * DAY), new Date(now - 30 * DAY))
    }
    const io = { readdir: fs.promises.readdir, lstat: fs.promises.lstat, unlink: fs.promises.unlink, readdirSync: syncThrows, lstatSync: syncThrows, unlinkSync: syncThrows }
    const removed = (await pruneDaemonScratch({ fs: io as unknown as DirPassFs, dir, ownLogs: [], now })).map((p) => path.relative(dir, p)).sort()
    expect(removed).toEqual(['daemon-d-1-aa11.log', 'images/old.png', 'images/remote/old.jpg'])
  })

  // An in-memory tree whose calls resolve at once: without its own yields a pass would run to its end
  // in one turn of the loop, however many files.
  function memoryTree(files: number) {
    const names = Array.from({ length: files }, (_, i) => `p${i}.png`)
    const gone = new Set<string>()
    let inFlight = 0
    let maxInFlight = 0
    const call = async <T>(v: T): Promise<T> => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await Promise.resolve(); inFlight--; return v }
    const entry = (name: string, kind: 'file' | 'dir') => ({ name, isFile: () => kind === 'file', isDirectory: () => kind === 'dir', isSymbolicLink: () => false })
    const io: DirPassFs = {
      readdir: (p) => call(p === '/d/images' ? names.filter((n) => !gone.has(n)).map((n) => entry(n, 'file')) : []),
      lstat: (p) => p === '/d/images' ? call({ mtimeMs: 0, atimeMs: 0, isFile: () => false, isDirectory: () => true })
        : p.startsWith('/d/images/') ? call({ mtimeMs: now - 30 * DAY, atimeMs: now - 30 * DAY, isFile: () => true, isDirectory: () => false })
          : Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
      unlink: (p) => { gone.add(p.slice('/d/images/'.length)); return call(undefined) },
    }
    return { io, maxInFlight: () => maxInFlight, gone }
  }

  it('gives the loop turns between bounded batches, and removes every file', async () => {
    const tree = memoryTree(2_000)
    // A clock that moves 1 ms each time the budget asks it: the 4 ms budget is spent every few batches.
    let t = 0
    const budget = createLoopBudget(4, () => t++)
    let turns = 0
    let ticking = true
    const tick = () => { turns++; if (ticking) setImmediate(tick) }
    setImmediate(tick)
    const removed = await pruneDaemonScratch({ fs: tree.io, dir: '/d', ownLogs: [], now, budget })
    ticking = false
    expect(removed).toHaveLength(2_000)
    expect(turns).toBeGreaterThan(10)
    expect(tree.maxInFlight()).toBeLessThanOrEqual(DIR_PASS_CONCURRENCY)
  })

  it('a call while a pass of the same dir runs joins it; a stop ends it before its next batch', async () => {
    const tree = memoryTree(200)
    let stop = false
    // The stop comes mid-pass, after the first files went: the pass ends before its next batch.
    const unlink = tree.io.unlink.bind(tree.io)
    let unlinked = 0
    const io = { ...tree.io, unlink: async (p: string) => { await unlink(p); if (++unlinked === 20) stop = true } }
    const first = pruneDaemonScratch({ fs: io, dir: '/d', ownLogs: [], now, aborted: () => stop })
    const second = pruneDaemonScratch({ fs: tree.io, dir: '/d', ownLogs: [], now })
    expect(second).toBe(first)
    const done = (await first).length
    expect(done).toBeGreaterThanOrEqual(20)
    expect(done).toBeLessThan(200)
    // The pass is over: the next call is a new one, and finishes the job.
    const third = pruneDaemonScratch({ fs: tree.io, dir: '/d', ownLogs: [], now })
    expect(third).not.toBe(first)
    await third
    expect(tree.gone.size).toBe(200)
  })
})
