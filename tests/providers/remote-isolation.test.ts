/**
 * A test server's own corner of every remote host (src/providers/remote-isolation.ts):
 * the decision, the layout and start env, the guard in front of every removal, the
 * identity check on a daemon's hello, and the two shell scripts that touch the host
 * (the isolated dir probe and the retire script), both EXECUTED under /bin/sh.
 *
 * MACHINE SAFETY: every isolated root uses a key made for this run (a random data
 * dir), so `/tmp/open-walnut-test-<key>` is this file's alone and removed after it;
 * HOME is a temp dir; the real /tmp/open-walnut is only looked at (its listing and
 * mtime before and after), never written. The "daemons" are children of this test.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { execFile, execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ISOLATED_TMP_PREFIX, buildIsolatedRetireScript, daemonIdentityVerdict, describeIsolationRefusal, isOwnIsolatedRoot,
  isolatedDaemonEnv, isolatedLayout, isolatedProbeOpts, isolationKey, remoteIsolationFor, resolveIsolatedRoot,
  testServerRemoteTermRoot, ownRootGuardSh, buildStaleIsolatedRootSweepScript, type RemoteIsolation,
} from '../../src/providers/remote-isolation.js'
import { buildBunInstallScript } from '../../src/providers/remote-runtime.js'
import { buildDaemonDirProbeScript, chooseDaemonDir, parseDaemonDirProbe } from '../../src/providers/remote-daemon-dir.js'
import { isProdDaemonDir } from '../../src/providers/ephemeral-replica-host.js'
import { classifyHostConnectError } from '../../src/core/sessions/host-connect-hint.js'
import { guardedPath } from '../setup/exec-guard.js'
import { testBun } from '../helpers/bun-runtime.js'

const BUN: string | undefined = testBun()

const ON = { WALNUT_EPHEMERAL_REMOTE_HOSTS: '1' }
const cleanup: string[] = []
const children: ChildProcess[] = []
afterEach(() => {
  for (const c of children.splice(0)) { try { c.kill('SIGKILL') } catch { /* gone */ } }
  for (const d of cleanup.splice(0)) {
    try { fs.chmodSync(d, 0o700) } catch { /* absent */ }
    fs.rmSync(d, { recursive: true, force: true })
  }
})

function freshHome(): string {
  return `/data/walnut-test-${crypto.randomBytes(8).toString('hex')}`
}
function isolated(home = freshHome(), env: NodeJS.ProcessEnv = ON): Extract<RemoteIsolation, { mode: 'isolated' }> {
  const iso = remoteIsolationFor({ hostKey: 'devbox', env, ephemeral: true, link: 'ssh', home })
  if (iso.mode !== 'isolated') throw new Error(`expected isolated, got ${JSON.stringify(iso)}`)
  return iso
}
function tempDir(prefix: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  cleanup.push(d)
  return d
}
/** Matches a production dir: `/tmp/open-walnut` or `.cache/open-walnut` not followed by `-test`. */
const PROD_PATH = /\/tmp\/open-walnut(?![-\w])|\.cache\/open-walnut(?![-\w])/

describe('remoteIsolationFor: who gets what', () => {
  const base = { hostKey: 'devbox', env: ON, ephemeral: true, link: 'ssh', home: '/data/x' }
  it('a real server and the local host share the host daemon as always', () => {
    expect(remoteIsolationFor({ ...base, ephemeral: false })).toEqual({ mode: 'shared' })
    expect(remoteIsolationFor({ ...base, hostKey: '__local__' })).toEqual({ mode: 'shared' })
    expect(remoteIsolationFor({ ...base, link: 'local' })).toEqual({ mode: 'shared' })
  })
  it('a test server without the opt-in stays off every remote host', () => {
    expect(remoteIsolationFor({ ...base, env: {} })).toEqual({ mode: 'off', reason: 'remote-hosts-off' })
  })
  it('a host not reached over ssh stays off (its daemon is the host\'s own service); the cloud box attaches', () => {
    expect(remoteIsolationFor({ ...base, link: 'net' })).toEqual({ mode: 'off', reason: 'not-ssh' })
    expect(remoteIsolationFor({ ...base, link: 'direct-url' })).toEqual({ mode: 'off', reason: 'not-ssh' })
    expect(remoteIsolationFor({ ...base, link: 'cloud-tunnel' })).toEqual({ mode: 'attach' })
  })
  it('an ssh host gets a root named by the test server\'s key, /tmp first then $HOME/.cache', () => {
    const iso = isolated('/data/x')
    const key = isolationKey('/data/x')
    expect(key).toMatch(/^[0-9a-f]{16}$/)
    expect(iso).toEqual({ mode: 'isolated', key, roots: [`/tmp/open-walnut-test-${key}`, `$HOME/.cache/open-walnut-test/${key}`], replica: false })
    // Two test servers never share one.
    expect(isolated('/data/y').key).not.toBe(key)
  })
  it('the replica check\'s host is the same isolation rooted at its named dir', () => {
    const env = { ...ON, WALNUT_EPHEMERAL_REPLICA_HOST: 'devbox', WALNUT_EPHEMERAL_REPLICA_DIR: '/tmp/wp14-run/', WALNUT_HOST_SERVER_ROOT: '/tmp/wp14-run/host' }
    expect(isolated('/data/x', env)).toMatchObject({ roots: ['/tmp/wp14-run'], replica: true })
    const prod = remoteIsolationFor({ ...base, env: { ...env, WALNUT_EPHEMERAL_REPLICA_DIR: '/tmp/open-walnut' } })
    expect(prod).toMatchObject({ mode: 'off', reason: 'prod-dir' })
  })
  it('every refusal reads as the ephemeral hint, so the connect error says what to do', () => {
    for (const reason of ['remote-hosts-off', 'not-ssh', 'prod-dir'] as const) {
      const msg = describeIsolationRefusal('devbox', reason, '/tmp/open-walnut')
      expect(msg.startsWith('ephemeral server: ')).toBe(true)
      expect(classifyHostConnectError(msg, 'devbox').kind).toBe('ephemeral')
    }
  })
})

describe('the layout and the start env: every dir under the root', () => {
  it('names only dirs under the root, none a production dir', () => {
    const root = '/tmp/open-walnut-test-0123456789abcdef'
    const l = isolatedLayout(root)
    for (const d of Object.values(l)) {
      expect(d === root || d.startsWith(root + '/')).toBe(true)
      expect(isProdDaemonDir(d)).toBe(false)
    }
    const env = isolatedDaemonEnv(root, '0123456789abcdef')
    for (const [k, v] of Object.entries(env)) {
      if (k === 'WALNUT_DAEMON_ISOLATED_FOR' || k === 'WALNUT_DAEMON_ORPHAN_EXIT_MS') continue
      expect(v.startsWith(root + '/'), k).toBe(true)
    }
    expect(Object.keys(env).sort()).toEqual([
      'BUN_RUNTIME_TRANSPILER_CACHE_PATH', 'WALNUT_DAEMON_DIR', 'WALNUT_DAEMON_ISOLATED_FOR', 'WALNUT_DAEMON_ORPHAN_EXIT_MS', 'WALNUT_INSTALL_HOME',
      'WALNUT_RUNTIME_DIR', 'WALNUT_SECRETS_DIR_ROOT', 'WALNUT_STREAMS_DIR', 'WALNUT_TASK_DIR_ROOT', 'WALNUT_WORKTREES_ROOT',
    ])
  })
  it('the $HOME root resolves only once the host\'s home is known', () => {
    expect(resolveIsolatedRoot('$HOME/.cache/open-walnut-test/k', null)).toBeNull()
    expect(resolveIsolatedRoot('$HOME/.cache/open-walnut-test/k', 'relative')).toBeNull()
    expect(resolveIsolatedRoot('$HOME/.cache/open-walnut-test/k', '/home/u/')).toBe('/home/u/.cache/open-walnut-test/k')
    expect(resolveIsolatedRoot('/tmp/open-walnut-test-k', null)).toBe('/tmp/open-walnut-test-k')
  })
  it('terminals of a test server live under its /tmp root; a real server has none', () => {
    const home = freshHome()
    expect(testServerRemoteTermRoot(false, home)).toBeNull()
    expect(testServerRemoteTermRoot(true, home)!.termDir).toBe(`${ISOLATED_TMP_PREFIX}${isolationKey(home)}/term`)
  })
})

describe('bun running the isolated daemon, for real', () => {
  it.skipIf(!BUN)('keeps its transpiler cache under the root\'s home, never in HOME', () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-iso-bun-home-')))
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-iso-bun-root-')))
    try {
      // Bun caches a transpiled file over 50 KB, as it does daemon.cjs.
      const script = path.join(root, 'daemon.cjs')
      fs.writeFileSync(script, Array.from({ length: 6000 }, (_, i) => `exports.f${i} = function () { return ${i} }`).join('\n') + '\nconsole.log("ran")\n')
      const env = isolatedDaemonEnv(root, '0123456789abcdef')
      const out = execFileSync(BUN!, [script], { encoding: 'utf-8', env: { PATH: guardedPath([], '/usr/bin:/bin'), HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: env.BUN_RUNTIME_TRANSPILER_CACHE_PATH } })
      expect(out.trim()).toBe('ran')
      expect(fs.readdirSync(env.BUN_RUNTIME_TRANSPILER_CACHE_PATH).some((f) => f.endsWith('.pile'))).toBe(true)
      expect(fs.readdirSync(home)).toEqual([])
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('isOwnIsolatedRoot: the one check before any removal', () => {
  const iso = isolated('/data/x')
  const k = iso.key
  it.each([
    [`/tmp/open-walnut-test-${k}`, true],
    [`/tmp/open-walnut-test-${k}/`, true],
    [`/home/u/.cache/open-walnut-test/${k}`, true],
    ['/tmp/open-walnut', false],
    ['/home/u/.cache/open-walnut', false],
    ['/tmp', false],
    ['/', false],
    [`/tmp/open-walnut-test-${k}/..`, false],
    [`/tmp/open-walnut-test-${k}/../open-walnut`, false],
    [`/tmp/open-walnut-test-ffffffffffffffff`, false],
    [`tmp/open-walnut-test-${k}`, false],
    [`/tmp/open-walnut-test-${k}\nrm`, false],
  ])('%j → %s', (root, own) => {
    expect(isOwnIsolatedRoot(root, iso)).toBe(own)
  })
  it('nothing is ever own for a shared, attached or refused connection', () => {
    for (const other of [{ mode: 'shared' }, { mode: 'attach' }, { mode: 'off', reason: 'remote-hosts-off' }] as RemoteIsolation[]) {
      expect(isOwnIsolatedRoot(`/tmp/open-walnut-test-${k}`, other)).toBe(false)
    }
  })
  it('the replica check owns exactly its named dir', () => {
    const env = { ...ON, WALNUT_EPHEMERAL_REPLICA_HOST: 'devbox', WALNUT_EPHEMERAL_REPLICA_DIR: '/tmp/wp14-run', WALNUT_HOST_SERVER_ROOT: '/tmp/wp14-run/host' }
    const rep = isolated('/data/x', env)
    expect(isOwnIsolatedRoot('/tmp/wp14-run', rep)).toBe(true)
    expect(isOwnIsolatedRoot('/tmp/wp14-other', rep)).toBe(false)
    expect(isOwnIsolatedRoot(`/tmp/open-walnut-test-${k}`, rep)).toBe(false)
  })
})

describe('daemonIdentityVerdict: a daemon must say which Walnut it serves', () => {
  const want = { key: 'aaaaaaaaaaaaaaaa', daemonDir: '/tmp/open-walnut-test-aaaaaaaaaaaaaaaa/daemon' }
  it('a test server accepts only its own daemon in its own dir', () => {
    expect(daemonIdentityVerdict({ isolatedFor: want.key, dir: want.daemonDir }, want)).toEqual({ ok: true })
    expect(daemonIdentityVerdict({ isolatedFor: want.key, dir: want.daemonDir + '/' }, want)).toEqual({ ok: true })
  })
  it.each([
    ['a production daemon (no key, any dir)', { dir: '/tmp/open-walnut' }],
    ['an older daemon that says nothing', {}],
    ['another test server\'s daemon', { isolatedFor: 'bbbbbbbbbbbbbbbb', dir: want.daemonDir }],
    ['its key from another dir', { isolatedFor: want.key, dir: '/tmp/open-walnut' }],
    ['its key with no dir said', { isolatedFor: want.key }],
  ])('a test server refuses %s', (_label, hello) => {
    expect(daemonIdentityVerdict(hello as Record<string, unknown>, want).ok).toBe(false)
  })
  it('a production server refuses a test server\'s daemon and takes an older one', () => {
    expect(daemonIdentityVerdict({ isolatedFor: want.key, dir: want.daemonDir }, null).ok).toBe(false)
    expect(daemonIdentityVerdict({ dir: '/tmp/open-walnut' }, null)).toEqual({ ok: true })
    expect(daemonIdentityVerdict({}, null)).toEqual({ ok: true })
  })
})

describe('the isolated dir probe, run for real', () => {
  function runProbe(iso: Extract<RemoteIsolation, { mode: 'isolated' }>, home: string) {
    const script = buildDaemonDirProbeScript(isolatedProbeOpts(iso))
    const raw = execFileSync('/bin/sh', ['-s'], { input: script, encoding: 'utf-8', env: { PATH: guardedPath([], '/usr/bin:/bin'), HOME: home } })
    const probe = parseDaemonDirProbe(raw)
    expect(probe).not.toBeNull()
    return { script, probe: probe! }
  }
  function prodState(): string {
    const d = '/tmp/open-walnut'
    if (!fs.existsSync(d)) return 'absent'
    try { return `${fs.statSync(d).mtimeMs} ${fs.readdirSync(d).sort().join(',')}` } catch { return 'unreadable' }
  }

  it('names no production dir in its text', () => {
    const iso = isolated()
    expect(buildDaemonDirProbeScript(isolatedProbeOpts(iso))).not.toMatch(PROD_PATH)
  })

  it('makes its own root on /tmp and leaves /tmp/open-walnut exactly as it was', () => {
    const iso = isolated()
    const home = tempDir('walnut-iso-home-')
    cleanup.push(iso.roots[0])
    const before = prodState()
    const { probe } = runProbe(iso, home)
    expect(probe.tmp).toMatchObject({ path: `${iso.roots[0]}/daemon`, status: 'ok', live: false })
    expect(chooseDaemonDir(probe)).toMatchObject({ path: `${iso.roots[0]}/daemon`, fallback: false })
    expect(prodState()).toBe(before)
    expect(fs.statSync(iso.roots[0]).mode & 0o777).toBe(0o700)
    expect(fs.readdirSync(`${iso.roots[0]}/daemon`)).toEqual([])
    // Nothing in HOME either: the cache dir is made only when /tmp cannot take it.
    expect(fs.readdirSync(home)).toEqual([])
  })

  it('refuses a root someone planted as a symlink, and falls back to its own cache dir in HOME', () => {
    const iso = isolated()
    const home = tempDir('walnut-iso-home-')
    const elsewhere = tempDir('walnut-iso-planted-')
    fs.symlinkSync(elsewhere, iso.roots[0])
    cleanup.push(iso.roots[0])
    const { probe } = runProbe(iso, home)
    expect(probe.tmp.status).toBe('not-owned')
    expect(fs.readdirSync(elsewhere)).toEqual([])
    const cache = path.join(home, '.cache', 'open-walnut-test', iso.key, 'daemon')
    expect(probe.cache).toMatchObject({ path: cache, status: 'ok' })
    expect(chooseDaemonDir(probe)).toMatchObject({ path: cache, fallback: true })
    expect(fs.existsSync(path.join(home, '.cache', 'open-walnut'))).toBe(false)
  })
})

describe('every script this file sends to a host parses under each shell a host may have', () => {
  // A host's /bin/sh may be dash, bash in POSIX mode, or macOS's bash 3.2, whose
  // parser ends a `$( ... )` at the `)` of a case pattern inside it (2026-11-11:
  // the retire script exited 2 on the Mac). Every shell present here is asked.
  const shells = ['/bin/sh', '/bin/bash', '/bin/dash', '/usr/bin/dash'].filter((s) => fs.existsSync(s))
  const iso = isolated()
  const root = iso.roots[0]
  const scripts: Record<string, string> = {
    'retire': buildIsolatedRetireScript(root, { alsoRemove: iso.roots }),
    'retire, keep the root': buildIsolatedRetireScript(root, { remove: false }),
    'stale root sweep': buildStaleIsolatedRootSweepScript('0123456789abcdef'),
    'isolated dir probe': buildDaemonDirProbeScript(isolatedProbeOpts(iso)),
  }
  for (const [name, script] of Object.entries(scripts)) {
    it(name, () => {
      for (const sh of shells) {
        const r = spawnSync(sh, ['-n'], { input: script, encoding: 'utf-8' })
        expect({ sh, code: r.status, err: r.stderr }).toEqual({ sh, code: 0, err: '' })
      }
    })
  }
})

describe('the retire script, run for real', () => {
  function root(): string {
    const r = path.join(tempDir('walnut-iso-retire-'), 'root')
    fs.mkdirSync(path.join(r, 'daemon'), { recursive: true })
    fs.writeFileSync(path.join(r, 'daemon', 'daemon.log'), 'x')
    return r
  }
  /** Async: a blocked event loop would leave the stopped stand-in an unreaped zombie that still "runs". */
  function retire(r: string, opts: Parameters<typeof buildIsolatedRetireScript>[1] = {}): Promise<{ code: number; out: string }> {
    return new Promise((resolve) => {
      const c = execFile('/bin/sh', ['-s'], { encoding: 'utf-8', env: { PATH: guardedPath([], '/usr/bin:/bin') } }, (err, stdout) => {
        resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, out: stdout })
      })
      c.stdin!.end(buildIsolatedRetireScript(r, opts))
    })
  }
  function standIn(args: string[]): ChildProcess {
    // `; true` keeps sh from exec'ing sleep, so the command line stays the one given.
    const c = spawn('/bin/sh', ['-c', 'sleep 600; true', ...args], { stdio: 'ignore' })
    children.push(c)
    return c
  }
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

  it('with no daemon there, removes the root (and its images dir)', async () => {
    const r = root()
    fs.mkdirSync(`${r}/daemon-images`)
    expect(await retire(r)).toMatchObject({ code: 0, out: expect.stringContaining('walnut-isolated-retired') })
    expect(fs.existsSync(r)).toBe(false)
    expect(fs.existsSync(`${r}/daemon-images`)).toBe(false)
  })

  it('a pid that is not that dir\'s daemon is never signalled, and the root stays', async () => {
    const r = root()
    const other = standIn([])
    fs.writeFileSync(`${r}/daemon/daemon.pid`, String(other.pid))
    expect((await retire(r)).code).not.toBe(0)
    expect(alive(other.pid!)).toBe(true)
    expect(fs.existsSync(`${r}/daemon/daemon.log`)).toBe(true)
  })

  it('stops that dir\'s daemon, then removes the root and the other own root', async () => {
    const r = root()
    const other = path.join(path.dirname(r), 'other-root')
    fs.mkdirSync(other)
    const daemon = standIn([`${r}/daemon/daemon.cjs`, '--start'])
    fs.writeFileSync(`${r}/daemon/daemon.pid`, String(daemon.pid))
    const exited = new Promise((resolve) => daemon.once('exit', resolve))
    expect((await retire(r, { alsoRemove: [other] })).code).toBe(0)
    await exited
    expect(fs.existsSync(r)).toBe(false)
    expect(fs.existsSync(other)).toBe(false)
  })

  it('keeps the root when asked to (the replica check\'s dir)', async () => {
    const r = root()
    expect((await retire(r, { remove: false })).code).toBe(0)
    expect(fs.existsSync(`${r}/daemon/daemon.log`)).toBe(true)
  })

  it('never follows a symlinked root', async () => {
    const target = tempDir('walnut-iso-target-')
    fs.writeFileSync(path.join(target, 'keep'), 'x')
    const link = path.join(tempDir('walnut-iso-link-'), 'root')
    fs.symlinkSync(target, link)
    expect(await retire(link)).toMatchObject({ code: 1, out: expect.stringContaining('walnut-isolated-not-owned') })
    expect(fs.readFileSync(path.join(target, 'keep'), 'utf8')).toBe('x')
  })
})

describe('the bun install of an isolated daemon, run for real', () => {
  it('pipes the installer into bash under the isolated HOME (never into mkdir), and reports its status', () => {
    const scratch = tempDir('walnut-iso-bun-')
    const bin = path.join(scratch, 'bin')
    fs.mkdirSync(bin)
    const installer = 'echo "installer ran HOME=$HOME BUN_INSTALL=$BUN_INSTALL" > "$HOME/ran"; exit 0'
    fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\nprintf '%s\\n' '${installer}'\n`, { mode: 0o755 })
    const own = path.join(scratch, 'root', 'home')
    const realHome = path.join(scratch, 'real-home')
    fs.mkdirSync(realHome)
    const out = execFileSync('/bin/sh', ['-s'], {
      input: buildBunInstallScript(path.join(scratch, 'install.log'), 'https://bun.example/install', { installHome: own }),
      encoding: 'utf-8', env: { PATH: guardedPath([bin], '/usr/bin:/bin'), HOME: realHome },
    })
    expect(out).toMatch(/^install_rc=0$/m)
    expect(fs.readFileSync(path.join(own, 'ran'), 'utf8').trim()).toBe(`installer ran HOME=${own} BUN_INSTALL=${own}/.bun`)
    expect(fs.readdirSync(realHome)).toEqual([])
  })
})

describe('ownRootGuardSh', () => {
  const run = (script: string) => { try { execFileSync('/bin/sh', ['-c', script], { encoding: 'utf-8' }); return 0 } catch (e) { return (e as { status: number }).status } }
  it('makes a missing root 0700 with create, and passes an own root', () => {
    const r = path.join(tempDir('walnut-iso-guard-'), 'root')
    expect(run(`${ownRootGuardSh(r)}; echo ok`)).toBe(0)
    expect(fs.existsSync(r)).toBe(false)
    expect(run(`${ownRootGuardSh(r, { create: true })}; echo ok`)).toBe(0)
    expect(fs.statSync(r).mode & 0o777).toBe(0o700)
  })
  it('stops the script on a symlink or a file in its place', () => {
    const d = tempDir('walnut-iso-guard-')
    fs.symlinkSync(d, path.join(d, 'link'))
    fs.writeFileSync(path.join(d, 'file'), 'x')
    for (const r of [path.join(d, 'link'), path.join(d, 'file')]) {
      expect(run(`${ownRootGuardSh(r, { create: true })}; touch ${d}/after`)).toBe(97)
    }
    expect(fs.existsSync(path.join(d, 'after'))).toBe(false)
  })
})

describe('the stale test root sweep, run for real', () => {
  it('removes only gone test servers\' roots this user owns, untouched for long enough', async () => {
    const home = tempDir('walnut-iso-sweep-home-')
    const cache = path.join(home, '.cache', 'open-walnut-test')
    const mk = (name: string, ageMin: number) => {
      const r = path.join(cache, name)
      fs.mkdirSync(path.join(r, 'daemon'), { recursive: true })
      const t = new Date(Date.now() - ageMin * 60_000)
      fs.utimesSync(r, t, t)
      return r
    }
    const own = 'a'.repeat(16)
    const stale = mk('b'.repeat(16), 200)
    const fresh = mk('c'.repeat(16), 10)
    const mine = mk(own, 200)
    const notKey = mk('claude', 200)
    const liveDaemon = mk('d'.repeat(16), 200)
    const liveTerm = mk('e'.repeat(16), 200)
    const elsewhere = tempDir('walnut-iso-sweep-target-')
    fs.symlinkSync(elsewhere, path.join(cache, 'f'.repeat(16)))
    fs.utimesSync(liveDaemon, new Date(Date.now() - 200 * 60_000), new Date(Date.now() - 200 * 60_000))
    const daemon = spawn('/bin/sh', ['-c', 'sleep 600; true', `${liveDaemon}/daemon/daemon.cjs`, '--start'], { stdio: 'ignore' })
    const term = spawn('/bin/sh', ['-c', 'sleep 600; true'], { stdio: 'ignore' })
    children.push(daemon, term)
    fs.writeFileSync(`${liveDaemon}/daemon/daemon.pid`, String(daemon.pid))
    fs.mkdirSync(`${liveTerm}/term`)
    fs.writeFileSync(`${liveTerm}/term/s1.pid`, String(term.pid))
    for (const r of [liveDaemon, liveTerm]) { const t = new Date(Date.now() - 200 * 60_000); fs.utimesSync(r, t, t) }
    const out = await new Promise<string>((resolve, reject) => {
      const c = execFile('/bin/sh', ['-s'], { encoding: 'utf-8', env: { PATH: guardedPath([], '/usr/bin:/bin'), HOME: home } }, (err, stdout) => err ? reject(err) : resolve(stdout))
      c.stdin!.end(buildStaleIsolatedRootSweepScript(own))
    })
    expect(out).toMatch(/walnut-sweep-done/)
    expect(fs.existsSync(stale)).toBe(false)
    for (const kept of [fresh, mine, notKey, liveDaemon, liveTerm, elsewhere]) expect(fs.existsSync(kept), kept).toBe(true)
    expect(fs.lstatSync(path.join(cache, 'f'.repeat(16))).isSymbolicLink()).toBe(true)
  })
})
