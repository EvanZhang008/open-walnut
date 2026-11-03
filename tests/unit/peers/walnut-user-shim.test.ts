/**
 * Regression: the user-PATH `walnut` shim must never exec a sibling copy of
 * itself. Two copies get installed (~/.local/bin AND ~/bin); the first
 * version's PATH scan only excluded the invoking copy's own directory, so
 * copy A exec'd copy B, B exec'd A, and every `walnut` call on a host with
 * both dirs hung in an infinite exec loop (caught live 2026-08-23 by the
 * rename verification session). The scan now skips any candidate carrying
 * the shim marker.
 *
 * The shim text is extracted from the deployed node twin (daemon-source.ts
 * template) and RUN as real /bin/sh, covering four scenarios: sibling shims
 * with a real CLI later in PATH, no real CLI (daemon fallback), invocation
 * via the second copy, and nothing to fall back to (exit 6).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { guardedPath } from '../../setup/exec-guard.js'

const ROOT = path.resolve(__dirname, '../../..')

/** Extract userWalnutShimText() from the node twin template and evaluate it. */
function walnutShimText(prodDir = '/tmp/open-walnut'): string {
  const src = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-source.ts'), 'utf-8')
  const start = src.indexOf('const DAEMON_SOURCE = `')
  expect(start).toBeGreaterThan(-1)
  const body = src.slice(src.indexOf('`', start) + 1, src.lastIndexOf('`'))
  // eslint-disable-next-line no-eval
  const twin = eval('`' + body + '`') as string
  const fnStart = twin.indexOf('function userWalnutShimText()')
  expect(fnStart).toBeGreaterThan(-1)
  const fnEnd = twin.indexOf('\n}', fnStart)
  const fnSrc = twin.slice(fnStart, fnEnd + 2)
  // The function references PROD_DAEMON_DIR, USER_WALNUT_SHIM_MARKER and USER_WALNUT_SHIM_TAG.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const make = new Function(
    'PROD_DAEMON_DIR', 'USER_WALNUT_SHIM_MARKER', 'USER_WALNUT_SHIM_TAG',
    fnSrc + '\nreturn userWalnutShimText();',
  ) as (prodDir: string, marker: string, tag: string) => string
  return make(prodDir, 'walnut-user-shim v1', 'walnut-user-shim')
}

let tmp: string
let A: string   // first shim copy dir
let B: string   // second shim copy dir
let REAL: string
let DAEMON: string

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-shim-loop-'))
  A = path.join(tmp, 'a'); B = path.join(tmp, 'b')
  REAL = path.join(tmp, 'real'); DAEMON = path.join(tmp, 'daemon')
  for (const d of [A, B, REAL, path.join(DAEMON, 'bin')]) fs.mkdirSync(d, { recursive: true })
  const shim = walnutShimText()
  expect(shim).toContain('walnut-user-shim v1')
  for (const d of [A, B]) fs.writeFileSync(path.join(d, 'walnut'), shim, { mode: 0o755 })
  fs.writeFileSync(path.join(REAL, 'walnut'), '#!/bin/sh\necho REAL-CLI "$@"\n', { mode: 0o755 })
  fs.writeFileSync(path.join(DAEMON, 'bin', 'walnut'), '#!/bin/sh\necho GATEWAY-SHIM "$@"\n', { mode: 0o755 })
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function run(entryDir: string, pathDirs: string[], daemonDir: string): { out: string; code: number | null } {
  const r = spawnSync(path.join(entryDir, 'walnut'), ['hello'], {
    env: { PATH: [...pathDirs, '/usr/bin', '/bin'].join(':'), WALNUT_DAEMON_DIR: daemonDir },
    encoding: 'utf-8',
    timeout: 10_000, // the loop bug hung forever — a timeout here IS the failure signal
  })
  return { out: (r.stdout ?? '') + (r.stderr ?? ''), code: r.status }
}

describe('user-PATH walnut shim: sibling copies never exec each other', () => {
  it('the bun twin (daemon-standalone.ts) carries the same sibling-skip line', () => {
    const standalone = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-standalone.ts'), 'utf-8')
    expect(standalone).toContain(`'  grep -q "' + USER_WALNUT_SHIM_TAG + '" "$d/walnut" 2>/dev/null && continue\\n'`)
  })

  it('two sibling shims pass through to the real CLI later in PATH', () => {
    const r = run(A, [A, B, REAL], DAEMON)
    expect(r.out).toContain('REAL-CLI hello')
    expect(r.code).toBe(0)
  })

  it('invoked via the SECOND copy it still reaches the real CLI (the loop case)', () => {
    const r = run(B, [B, A, REAL], DAEMON)
    expect(r.out).toContain('REAL-CLI hello')
    expect(r.code).toBe(0)
  })

  it('with no real CLI it falls back to the daemon gateway shim', () => {
    const r = run(A, [A, B], DAEMON)
    expect(r.out).toContain('GATEWAY-SHIM hello')
    expect(r.code).toBe(0)
  })

  it('with nothing to fall back to it exits 6 with a walnut-prefixed error', () => {
    const r = run(A, [A, B], path.join(tmp, 'nonexistent'))
    expect(r.out).toContain('walnut: no Walnut daemon on this host')
    expect(r.code).toBe(6)
  })
})

/**
 * No WALNUT_DAEMON_DIR (a hand-started terminal): the shim picks between
 * /tmp/open-walnut and ~/.cache/open-walnut (where a connect moves the daemon
 * when /tmp is unusable), the dir whose daemon is ALIVE first, and exports it,
 * so walnut talks to that daemon's socket and not /tmp's stale one.
 */
describe('user-PATH walnut shim: which daemon dir, with no env', () => {
  let box: string
  let prod: string
  let home: string
  let cache: string
  let shimDir: string

  beforeAll(() => {
    box = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-shim-dirs-'))
    prod = path.join(box, 'tmp-open-walnut')
    home = path.join(box, 'home')
    cache = path.join(home, '.cache', 'open-walnut')
    shimDir = path.join(box, 'shim')
    fs.mkdirSync(shimDir, { recursive: true })
    fs.writeFileSync(path.join(shimDir, 'walnut'), walnutShimText(prod), { mode: 0o755 })
  })
  afterAll(() => fs.rmSync(box, { recursive: true, force: true }))

  function gateway(dir: string, livePid: number | null): void {
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'bin', 'walnut'), `#!/bin/sh\necho "GATEWAY ${path.basename(path.dirname(dir))} dir=$WALNUT_DAEMON_DIR $*"\n`, { mode: 0o755 })
    if (livePid) fs.writeFileSync(path.join(dir, 'daemon.pid'), String(livePid))
    else fs.rmSync(path.join(dir, 'daemon.pid'), { force: true })
  }
  function runNoEnv(env: Record<string, string> = {}): { out: string; code: number | null } {
    const r = spawnSync(path.join(shimDir, 'walnut'), ['hello'], {
      env: { PATH: `${shimDir}:/usr/bin:/bin`, HOME: home, ...env }, encoding: 'utf-8', timeout: 10_000,
    })
    return { out: (r.stdout ?? '') + (r.stderr ?? ''), code: r.status }
  }

  it('a stale /tmp shim loses to a live daemon in ~/.cache, and the dir is exported', () => {
    gateway(prod, null)
    gateway(cache, process.pid)
    const r = runNoEnv()
    expect(r.out.trim()).toBe(`GATEWAY .cache dir=${cache} hello`)
    expect(r.code).toBe(0)
  })

  it('a live /tmp daemon wins; with neither alive, /tmp comes first', () => {
    gateway(prod, process.pid)
    expect(runNoEnv().out).toContain(`dir=${prod} hello`)
    gateway(prod, null)
    gateway(cache, null)
    expect(runNoEnv().out).toContain(`dir=${prod} hello`)
  })

  it('WALNUT_DAEMON_DIR, when set, is the only dir tried', () => {
    gateway(cache, process.pid)
    const r = runNoEnv({ WALNUT_DAEMON_DIR: path.join(box, 'nowhere') })
    expect(r.out).toContain('walnut: no Walnut daemon on this host')
    expect(r.code).toBe(6)
  })

  it('the bun twin carries the same dir choice', () => {
    const standalone = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-standalone.ts'), 'utf-8')
    expect(standalone).toContain(`'  if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then found=$d; break; fi\\n'`)
    expect(standalone).toContain(`'if [ -n "$found" ]; then WALNUT_DAEMON_DIR=$found; export WALNUT_DAEMON_DIR; exec "$found/bin/walnut" "$@"; fi\\n'`)
  })
})

/** The bun twin's userWalnutShimText(), evaluated the same way (its TS annotation dropped). */
function standaloneShimText(prodDir: string): string {
  const src = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-standalone.ts'), 'utf-8')
  const fnStart = src.indexOf('function userWalnutShimText(): string {')
  expect(fnStart).toBeGreaterThan(-1)
  const fnSrc = src.slice(fnStart, src.indexOf('\n}', fnStart) + 2).replace('userWalnutShimText(): string {', 'userWalnutShimText() {')
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const make = new Function(
    'PROD_DAEMON_DIR', 'USER_WALNUT_SHIM_MARKER', 'USER_WALNUT_SHIM_TAG',
    fnSrc + '\nreturn userWalnutShimText();',
  ) as (prodDir: string, marker: string, tag: string) => string
  return make(prodDir, 'walnut-user-shim v1', 'walnut-user-shim')
}

/**
 * The daemon is being replaced (2026-11-03: 6 s on a dev box with no bin/walnut):
 * the stopping daemon left `<dir>/restarting` (daemon-restart-mark.ts), and while
 * that is fresh the shim waits for the next daemon's bin/walnut instead of
 * failing. Without a fresh mark it fails at once, as before.
 */
for (const [twin, text] of [['node twin', walnutShimText], ['bun twin', standaloneShimText]] as const) {
  describe(`user-PATH walnut shim: a daemon restarting, ${twin}`, () => {
    let box: string
    let prod: string
    let home: string
    let shimDir: string

    beforeAll(() => {
      box = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-shim-restart-'))
      prod = path.join(box, 'tmp-open-walnut')
      home = path.join(box, 'home')
      shimDir = path.join(box, 'shim')
      for (const d of [prod, home, shimDir]) fs.mkdirSync(d, { recursive: true })
      fs.writeFileSync(path.join(shimDir, 'walnut'), text(prod), { mode: 0o755 })
    })
    afterAll(() => fs.rmSync(box, { recursive: true, force: true }))

    function mark(dir: string, agoSecs: number | string): void {
      const v = typeof agoSecs === 'string' ? agoSecs : String(Math.floor(Date.now() / 1000) - agoSecs)
      fs.writeFileSync(path.join(dir, 'restarting'), v)
    }
    function daemonDir(name: string): string {
      const d = path.join(box, name)
      fs.rmSync(d, { recursive: true, force: true })
      fs.mkdirSync(path.join(d, 'bin'), { recursive: true })
      return d
    }
    function nextDaemon(dir: string): void {
      fs.writeFileSync(path.join(dir, 'bin', 'walnut'), '#!/bin/sh\necho "NEXT dir=$WALNUT_DAEMON_DIR $*"\n', { mode: 0o755 })
    }
    /** The shim, run async so a test can write the next daemon's bin/walnut while it waits. */
    function start(env: Record<string, string>): Promise<{ out: string; err: string; code: number | null; ms: number }> {
      const t0 = Date.now()
      return new Promise((resolve) => {
        const child = spawn(path.join(shimDir, 'walnut'), ['hello'], { env: { PATH: guardedPath([shimDir], '/usr/bin:/bin'), HOME: home, ...env } })
        let out = ''
        let err = ''
        child.stdout.on('data', (c) => { out += c })
        child.stderr.on('data', (c) => { err += c })
        const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
        child.on('close', (code) => { clearTimeout(timer); resolve({ out, err, code, ms: Date.now() - t0 }) })
      })
    }
    const WAIT = 'walnut: the Walnut daemon on this host is restarting; waiting for the next one (up to 45s)'

    it('WALNUT_DAEMON_DIR with a fresh mark: waits, then runs the next daemon, telling once', async () => {
      const dir = daemonDir('env-fresh')
      mark(dir, 0)
      const run = start({ WALNUT_DAEMON_DIR: dir })
      await new Promise((r) => setTimeout(r, 1_200))
      nextDaemon(dir)
      const r = await run
      expect(r.out.trim()).toBe(`NEXT dir=${dir} hello`)
      expect(r.code).toBe(0)
      // stderr is a pipe, as for an agent: the wait is silent.
      expect(r.err).not.toContain(WAIT)
      expect(r.ms).toBeGreaterThanOrEqual(1_000)
    }, 30_000)

    it.runIf(process.platform === 'linux')('on a terminal it says once that it waits', async () => {
      const dir = daemonDir('env-tty')
      mark(dir, 0)
      const t0 = Date.now()
      const run = new Promise<{ out: string; code: number | null }>((resolve) => {
        // util-linux `script` gives the shim a terminal; stdout and stderr both land in `out`.
        const child = spawn('script', ['-qec', `'${path.join(shimDir, 'walnut')}' hello`, '/dev/null'], {
          env: { PATH: guardedPath([shimDir], '/usr/bin:/bin'), HOME: home, WALNUT_DAEMON_DIR: dir },
        })
        let out = ''
        child.stdout.on('data', (c) => { out += c })
        child.on('close', (code) => resolve({ out, code }))
      })
      await new Promise((r) => setTimeout(r, 1_200))
      nextDaemon(dir)
      const r = await run
      expect(r.code).toBe(0)
      const lines = r.out.replace(/\r/g, '').split('\n')
      expect(lines.filter((l) => l === WAIT)).toHaveLength(1)
      expect(lines).toContain(`NEXT dir=${dir} hello`)
      expect(Date.now() - t0).toBeGreaterThanOrEqual(1_000)
    }, 30_000)

    it('a stale, garbled or absent mark fails at once with the old message', async () => {
      // '08' and a leading-zero second read as octal in sh arithmetic and once killed the shim.
      for (const m of [60, 'abc', null, '08', '0' + String(Math.floor(Date.now() / 1000)), '1'.repeat(13)] as const) {
        const dir = daemonDir('env-stale')
        if (m !== null) mark(dir, m)
        const r = await start({ WALNUT_DAEMON_DIR: dir })
        expect(r.code).toBe(6)
        expect(r.err).toContain('walnut: no Walnut daemon on this host')
        expect(r.err).not.toContain('restarting')
        expect(r.ms).toBeLessThan(1_500)
      }
    }, 30_000)

    it('a fresh mark and no successor: it waits only until the mark is 45s old, then fails', async () => {
      const dir = daemonDir('env-none')
      mark(dir, 43)
      const r = await start({ WALNUT_DAEMON_DIR: dir })
      expect(r.code).toBe(6)
      expect(r.err).not.toContain(WAIT)
      expect(r.err).toContain('walnut: no Walnut daemon on this host')
      expect(r.ms).toBeGreaterThanOrEqual(1_000)
      expect(r.ms).toBeLessThan(6_000)
    }, 30_000)

    it('a mark through a symlink is not trusted: it fails at once', async () => {
      const dir = daemonDir('env-link')
      const real = path.join(box, 'real-mark')
      fs.writeFileSync(real, String(Math.floor(Date.now() / 1000)))
      fs.symlinkSync(real, path.join(dir, 'restarting'))
      const r = await start({ WALNUT_DAEMON_DIR: dir })
      expect(r.code).toBe(6)
      expect(r.err).not.toContain('restarting')
      expect(r.ms).toBeLessThan(1_500)
    }, 30_000)

    it('no WALNUT_DAEMON_DIR: a dead daemon elsewhere does not win over the production dir restarting', async () => {
      const cache = path.join(home, '.cache', 'open-walnut')
      fs.mkdirSync(path.join(cache, 'bin'), { recursive: true })
      fs.writeFileSync(path.join(cache, 'bin', 'walnut'), '#!/bin/sh\necho "DEAD dir=$WALNUT_DAEMON_DIR $*"\n', { mode: 0o755 })
      fs.rmSync(path.join(prod, 'bin'), { recursive: true, force: true })
      fs.mkdirSync(path.join(prod, 'bin'), { recursive: true })
      mark(prod, 1)
      const run = start({})
      await new Promise((r) => setTimeout(r, 1_200))
      nextDaemon(prod)
      const r = await run
      expect(r.out.trim()).toBe(`NEXT dir=${prod} hello`)
      fs.rmSync(path.join(prod, 'restarting'), { force: true })
      fs.rmSync(cache, { recursive: true, force: true })
    }, 30_000)

    it('no WALNUT_DAEMON_DIR: the production dir restarting is waited for, and exported', async () => {
      fs.rmSync(path.join(prod, 'bin'), { recursive: true, force: true })
      fs.mkdirSync(path.join(prod, 'bin'), { recursive: true })
      mark(prod, 1)
      const run = start({})
      await new Promise((r) => setTimeout(r, 1_200))
      nextDaemon(prod)
      const r = await run
      expect(r.out.trim()).toBe(`NEXT dir=${prod} hello`)
      expect(r.code).toBe(0)
      fs.rmSync(path.join(prod, 'restarting'), { force: true })
    }, 30_000)
  })
}
