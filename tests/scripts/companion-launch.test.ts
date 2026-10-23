/**
 * scripts/cloud/companion-launch.mjs: the launcher systemd runs on the cloud
 * companion (docs/plan/walnut-companion-unified-replica.md, stage 1).
 *
 * The REAL launcher runs as a child process against a temp dir: a fake base
 * tree and fake app/<id> trees whose dist/cli.js is a tiny server that records
 * what it was started with (argv, cwd, env) and the signals it got, then exits,
 * waits, confirms a trial, or ignores signals, as its FAKE_* env says (the
 * launcher passes its env on). Nothing here signals a process the test did not
 * start itself, and afterEach reaps every one that is still alive.
 */
import { describe, expect, it, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..')
const LAUNCHER = path.join(REPO_ROOT, 'scripts', 'cloud', 'companion-launch.mjs')
const ARGS = ['web', '--port', '3456']
/** A ceiling on every fake server's life, so nothing outlives a broken cleanup for long. */
const MAX_LIFE_MS = 30_000

/** The fake server; `TREE` names the tree it was written into. */
function fakeServer(tree: string): string {
  return `const TREE = ${JSON.stringify(tree)}
const fs = require('node:fs')
const path = require('node:path')
const env = process.env
const record = (event, extra) => fs.appendFileSync(env.FAKE_RECORD,
  JSON.stringify({ event, tree: TREE, pid: process.pid, ...extra }) + '\\n')
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    record('signal', { signal: sig })
    if (env.FAKE_IGNORE_SIGNALS === '1') return
    process.removeAllListeners(sig)
    process.kill(process.pid, sig)
  })
}
const keys = ['WALNUT_COMPANION_LAUNCHER', 'WALNUT_COMPANION_BUILD', 'WALNUT_COMPANION_TRIAL', 'FAKE_PASS_THROUGH']
record('start', {
  argv: process.argv.slice(2), cwd: process.cwd(), env: Object.fromEntries(keys.map((k) => [k, env[k] ?? null])),
  execPath: process.execPath, bun: process.versions.bun ?? null,
})
if (env.FAKE_CONFIRM === '1') {
  const state = path.join(env.WALNUT_COMPANION_ROOT, 'companion')
  fs.writeFileSync(path.join(state, 'current'), env.WALNUT_COMPANION_BUILD + '\\n')
  fs.rmSync(path.join(state, 'trial'), { force: true })
  fs.rmSync(path.join(state, 'attempts'), { force: true })
}
const code = Number(env.FAKE_EXIT || 0)
setTimeout(() => { record('exit', { code }); process.exit(code) }, Math.min(Number(env.FAKE_LIFE_MS || 0), ${MAX_LIFE_MS}))
`
}

interface Rec {
  event: 'start' | 'signal' | 'exit'
  tree: string
  pid: number
  argv?: string[]
  cwd?: string
  env?: Record<string, string | null>
  execPath?: string
  bun?: string | null
  signal?: string
  code?: number
}

/** The runtime this suite (and so the launcher it starts) runs on. */
const HERE_RUNTIME = process.versions.bun ? 'bun' : 'node'
const OTHER_RUNTIME = HERE_RUNTIME === 'bun' ? 'node' : 'bun'

interface TreeOpts { ready?: boolean; cli?: boolean; runtime?: string | null; file?: boolean }

interface Fixture {
  dir: string
  root: string
  base: string
  recordFile: string
  /**
   * Writes a tree with the fake server; `ready: false` leaves out .ready, `cli: false` dist/cli.js.
   * An app's `.runtime` (the runtime the box smoke-booted it on) is this suite's own unless
   * `runtime` names another, or is null (a box from before the record wrote none); `file`
   * adds a `walnut` beside dist/, as a build of the compiled file has.
   */
  tree(dir: string, label: string, opts?: TreeOpts): string
  app(id: string, opts?: TreeOpts): string
  write(name: string, text: string): void
  read(name: string): string | null
  records(): Rec[]
}

const tempDirs: string[] = []
const launchers: ChildProcess[] = []
const others: ChildProcess[] = []
const fixtures: Fixture[] = []

const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch { return false }
}
/** SIGKILL for a pid this test started (directly, or through a launcher it started). */
function reap(pid: number | undefined): void {
  if (!pid || pid <= 1 || pid === process.pid || !isAlive(pid)) return
  try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
}

afterEach(() => {
  for (const c of [...launchers.splice(0), ...others.splice(0)]) {
    if (c.exitCode === null && c.signalCode === null) reap(c.pid)
  }
  for (const fx of fixtures.splice(0)) for (const r of fx.records()) reap(r.pid)
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

function makeFixture(): Fixture {
  // realpath: the server's process.cwd() is the resolved path (/var -> /private/var on macOS).
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-launch-')))
  tempDirs.push(dir)
  const root = path.join(dir, 'host')
  const recordFile = path.join(dir, 'records.jsonl')
  const state = (name: string) => path.join(root, 'companion', name)
  const fx: Fixture = {
    dir,
    root,
    base: path.join(dir, 'base'),
    recordFile,
    tree(treeDir, label, opts = {}) {
      fs.mkdirSync(path.join(treeDir, 'dist'), { recursive: true })
      // A tmp dir has no package.json above it, but pin CommonJS anyway.
      fs.writeFileSync(path.join(treeDir, 'package.json'), '{"type":"commonjs"}\n')
      if (opts.cli !== false) fs.writeFileSync(path.join(treeDir, 'dist', 'cli.js'), fakeServer(label))
      if (opts.ready !== false) fs.writeFileSync(path.join(treeDir, '.ready'), '')
      if (opts.file) fs.writeFileSync(path.join(treeDir, 'walnut'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      return treeDir
    },
    app(id, opts = {}) {
      const dir = fx.tree(path.join(root, 'app', id), id, opts)
      const runtime = opts.runtime === undefined ? HERE_RUNTIME : opts.runtime
      if (runtime !== null) fs.writeFileSync(path.join(dir, '.runtime'), `${runtime}\n`)
      return dir
    },
    write(name, text) {
      fs.mkdirSync(path.dirname(state(name)), { recursive: true })
      fs.writeFileSync(state(name), text)
    },
    read(name) {
      try { return fs.readFileSync(state(name), 'utf-8') } catch { return null }
    },
    records() {
      try {
        return fs.readFileSync(recordFile, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Rec)
      } catch { return [] }
    },
  }
  fx.tree(fx.base, 'base', { ready: false })
  fs.mkdirSync(path.join(root, 'companion'), { recursive: true })
  fixtures.push(fx)
  return fx
}

/** The test's own env, minus anything a launcher or fake server reads. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('WALNUT_COMPANION_') && !k.startsWith('FAKE_')) env[k] = v
  }
  return env
}

interface Launch {
  child: ChildProcess
  stdout: () => string
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

function launch(fx: Fixture, env: NodeJS.ProcessEnv = {}): Launch {
  const child = spawn(process.execPath, [LAUNCHER, ...ARGS], {
    env: {
      ...cleanEnv(),
      WALNUT_COMPANION_ROOT: fx.root,
      WALNUT_COMPANION_BASE: fx.base,
      FAKE_RECORD: fx.recordFile,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  launchers.push(child)
  let out = ''
  child.stdout!.setEncoding('utf-8').on('data', (s: string) => { out += s })
  child.stderr!.setEncoding('utf-8').on('data', (s: string) => { out += s })
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`launcher did not exit in time:\n${out}`)), 20_000)
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
  })
  return { child, stdout: () => out, done }
}

async function waitFor<T>(what: string, fn: () => T | undefined | null | false, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

const starts = (fx: Fixture) => fx.records().filter((r) => r.event === 'start')
const only = <T>(list: T[]): T => {
  expect(list).toHaveLength(1)
  return list[0]
}

describe('which tree the launcher runs', () => {
  it('runs the base tree when nothing is installed, with the launcher env and its own argv', async () => {
    const fx = makeFixture()
    const run = launch(fx)
    expect(await run.done).toEqual({ code: 0, signal: null })
    const start = only(starts(fx))
    expect(start).toMatchObject({ tree: 'base', argv: ARGS, cwd: fx.base })
    expect(start.env).toEqual({
      WALNUT_COMPANION_LAUNCHER: '1',
      WALNUT_COMPANION_BUILD: 'base',
      WALNUT_COMPANION_TRIAL: null,
      FAKE_PASS_THROUGH: null,
    })
    expect(fx.read('server.pid')).toBe(`${start.pid}\n`)
    // One prefixed line per decision; nothing else is printed.
    const lines = run.stdout().trim().split('\n')
    expect(lines.every((l) => l.startsWith('[companion-launch] ')), run.stdout()).toBe(true)
    expect(run.stdout()).toContain(`running the base tree ${fx.base}`)
  })

  it('runs the server on its own runtime: bun when systemd starts it on bun', async () => {
    const fx = makeFixture()
    fx.app('b1')
    fx.write('current', 'b1\n')
    // The launcher runs on this runtime (bun when the suite does), as the
    // drop-in runs it on the unit's bun; the server must get the same one.
    const run = launch(fx)
    expect((await run.done).code).toBe(0)
    const start = only(starts(fx))
    expect(fs.realpathSync(start.execPath!)).toBe(fs.realpathSync(process.execPath))
    expect(start.bun).toBe(process.versions.bun ?? null)
  })

  it('is plain JavaScript for bun: a bun shebang and node: builtins only, so it runs before any install', () => {
    const src = fs.readFileSync(LAUNCHER, 'utf-8')
    expect(src.split('\n')[0]).toBe('#!/usr/bin/env bun')
    const imports = [...src.matchAll(/^import .* from '([^']+)'$/gm)].map((m) => m[1])
    expect(imports.length).toBeGreaterThan(0)
    expect(imports.filter((s) => !s.startsWith('node:'))).toEqual([])
    // The server is started on process.execPath, never on a runtime looked up by name.
    expect(src).toMatch(/spawn\(process\.execPath, \[path\.join\(choice\.dir, 'dist', 'cli\.js'\)/)
    expect(src).not.toMatch(/spawn\('(node|bun)'/)
  })

  it('runs current when its directory is ready', async () => {
    const fx = makeFixture()
    const dir = fx.app('b1')
    fx.write('current', 'b1\n')
    const run = launch(fx)
    expect((await run.done).code).toBe(0)
    const start = only(starts(fx))
    expect(start).toMatchObject({ tree: 'b1', argv: ARGS, cwd: dir })
    expect(start.env).toMatchObject({ WALNUT_COMPANION_LAUNCHER: '1', WALNUT_COMPANION_BUILD: 'b1', WALNUT_COMPANION_TRIAL: null })
    expect(run.stdout()).toContain('running current build b1')
  })

  it.each([
    ['no .ready', { ready: false }],
    ['no dist/cli.js', { cli: false }],
  ])('skips a current that is not ready (%s) and runs the base', async (_label, opts) => {
    const fx = makeFixture()
    fx.app('b1', opts)
    fx.write('current', 'b1\n')
    const run = launch(fx)
    expect((await run.done).code).toBe(0)
    expect(only(starts(fx))).toMatchObject({ tree: 'base', env: { WALNUT_COMPANION_BUILD: 'base' } })
    expect(run.stdout()).toContain('current build b1 is not ready')
  })

  it.each(['../escape', 'a..b', '.hidden', 'has space', 'a/b', ''])(
    'treats current %j as absent: it is not a build id',
    async (id) => {
      const fx = makeFixture()
      // A ready tree wherever the bad id would lead, to prove it never runs.
      fx.tree(path.join(fx.root, 'escape'), 'escape')
      if (id && !id.includes('/') && id !== '..') fx.tree(path.join(fx.root, 'app', id), 'bad-id')
      fx.write('current', `${id}\n`)
      const run = launch(fx)
      expect((await run.done).code).toBe(0)
      expect(only(starts(fx)).tree).toBe('base')
      expect(run.stdout()).toContain(`current holds ${JSON.stringify(id)}, not a build id; treated as absent`)
    },
  )

  it('treats an invalid trial id as absent and counts nothing', async () => {
    const fx = makeFixture()
    fx.app('b1')
    fx.write('current', 'b1\n')
    fx.write('trial', '../b1\n')
    const run = launch(fx)
    expect((await run.done).code).toBe(0)
    expect(only(starts(fx))).toMatchObject({ tree: 'b1', env: { WALNUT_COMPANION_TRIAL: null } })
    expect(fx.read('attempts')).toBeNull()
    expect(run.stdout()).toContain('trial holds "../b1", not a build id; treated as absent')
  })
})

describe('the runtime a build was tried on', () => {
  it('skips a current dist tried on another runtime, runs the base tree, and keeps current for the Mac', async () => {
    const fx = makeFixture()
    fx.app('b1', { runtime: OTHER_RUNTIME })
    fx.write('current', 'b1\n')
    const run = launch(fx)
    expect((await run.done).code).toBe(0)
    expect(only(starts(fx)).tree).toBe('base')
    expect(run.stdout()).toContain(`current build b1 runs on ${OTHER_RUNTIME}, and this launcher on ${HERE_RUNTIME}; skipped`)
    // Nothing is given up or rewritten: a launcher on the other runtime (a rollback) runs it again.
    expect(fx.read('current')).toBe('b1\n')
    expect(fx.read(path.join('failed', 'b1'))).toBeNull()
  })

  it('takes a dist with no record for one a box installed and tried on node', async () => {
    const fx = makeFixture()
    fx.app('old', { runtime: null })
    fx.write('current', 'old\n')
    const run = launch(fx)
    expect((await run.done).code).toBe(0)
    if (HERE_RUNTIME === 'node') {
      expect(only(starts(fx)).tree).toBe('old')
    } else {
      // The review's case: a box whose unit setup.sh moved to bun, with a current build it got on node.
      expect(only(starts(fx)).tree).toBe('base')
      expect(run.stdout()).toContain('current build old runs on node, and this launcher on bun; skipped')
    }
  })

  it('runs a build of the walnut file under any runtime, whatever its record says', async () => {
    const fx = makeFixture()
    for (const [id, runtime] of [['f-none', null], ['f-other', OTHER_RUNTIME]] as const) {
      fx.app(id, { runtime, file: true })
      fx.write('current', `${id}\n`)
      const run = launch(fx)
      expect((await run.done).code).toBe(0)
      expect(starts(fx).at(-1)).toMatchObject({ tree: id })
      expect(run.stdout()).toContain(`running current build ${id}`)
    }
  })

  it('gives up a trial tried on another runtime, without starting it, and runs current', async () => {
    const fx = makeFixture()
    fx.app('b1')
    fx.app('t1', { runtime: OTHER_RUNTIME })
    fx.write('current', 'b1\n')
    fx.write('trial', 't1\n')
    const run = launch(fx)
    expect((await run.done).code).toBe(0)
    expect(only(starts(fx)).tree).toBe('b1')
    expect(fx.read(path.join('failed', 't1'))).toBe(`trial build was tried on ${OTHER_RUNTIME}, and this box runs its builds on ${HERE_RUNTIME}\n`)
    expect(fx.read('trial')).toBeNull()
    expect(fx.read('attempts')).toBeNull()
  })
})

describe('a trial build', () => {
  it('counts each start, and after two unconfirmed starts gives it up and runs current', async () => {
    const fx = makeFixture()
    fx.app('b1')
    const trialDir = fx.app('t1')
    fx.write('current', 'b1\n')
    fx.write('trial', 't1\n')

    for (const n of [1, 2]) {
      const run = launch(fx, { FAKE_EXIT: '3' })
      expect((await run.done).code).toBe(3)
      const start = starts(fx).at(-1)!
      expect(start).toMatchObject({ tree: 't1', cwd: trialDir })
      expect(start.env).toMatchObject({ WALNUT_COMPANION_BUILD: 't1', WALNUT_COMPANION_TRIAL: '1', WALNUT_COMPANION_LAUNCHER: '1' })
      expect(fx.read('attempts')).toBe(`${n}\n`)
      expect(run.stdout()).toContain(`trial t1: start ${n} of 2`)
    }

    const third = launch(fx)
    expect((await third.done).code).toBe(0)
    expect(starts(fx)).toHaveLength(3)
    expect(starts(fx).at(-1)).toMatchObject({ tree: 'b1', env: { WALNUT_COMPANION_BUILD: 'b1', WALNUT_COMPANION_TRIAL: null } })
    expect(fx.read(path.join('failed', 't1'))).toBe('trial did not confirm after 2 starts\n')
    expect(fx.read('trial')).toBeNull()
    expect(fx.read('attempts')).toBeNull()
    expect(fx.read('current')).toBe('b1\n')
    expect(third.stdout()).toContain('trial t1 did not confirm after 2 starts; given up')
  })

  it('gives up a trial whose build is not installed, without starting it', async () => {
    const fx = makeFixture()
    fx.write('trial', 't9\n')
    const run = launch(fx)
    expect((await run.done).code).toBe(0)
    expect(only(starts(fx)).tree).toBe('base')
    expect(fx.read(path.join('failed', 't9'))).toBe('trial build is not installed (no .ready or dist/cli.js)\n')
    expect(fx.read('trial')).toBeNull()
  })

  it('leaves a trial that confirms itself running past the deadline', async () => {
    const fx = makeFixture()
    fx.app('t1')
    fx.write('trial', 't1\n')
    const run = launch(fx, {
      FAKE_CONFIRM: '1',
      FAKE_LIFE_MS: '2500',
      WALNUT_COMPANION_TRIAL_DEADLINE_MS: '1500',
      WALNUT_COMPANION_TRIAL_POLL_MS: '100',
      WALNUT_COMPANION_KILL_GRACE_MS: '300',
    })
    expect(await run.done).toEqual({ code: 0, signal: null })
    expect(fx.records().map((r) => r.event)).toEqual(['start', 'exit'])
    expect(fx.read('current')).toBe('t1\n')
    expect(fx.read('trial')).toBeNull()
    expect(run.stdout()).toContain('trial t1 confirmed')
    expect(run.stdout()).not.toContain('did not confirm')
  })

  it.each([
    ['stops on SIGTERM', '0', false],
    ['ignores SIGTERM, so SIGKILL follows the grace', '1', true],
  ])('stops a trial that never confirms at the deadline and exits 1 (the server %s)', async (_label, ignore, killed) => {
    const fx = makeFixture()
    fx.app('t1')
    fx.write('trial', 't1\n')
    const run = launch(fx, {
      FAKE_LIFE_MS: String(MAX_LIFE_MS),
      FAKE_IGNORE_SIGNALS: ignore,
      WALNUT_COMPANION_TRIAL_DEADLINE_MS: '2000',
      WALNUT_COMPANION_TRIAL_POLL_MS: '100',
      WALNUT_COMPANION_KILL_GRACE_MS: '500',
    })
    expect(await run.done).toEqual({ code: 1, signal: null })
    const start = only(starts(fx))
    expect(fx.records().filter((r) => r.event === 'signal').map((r) => r.signal)).toEqual(['SIGTERM'])
    expect(fx.records().some((r) => r.event === 'exit')).toBe(false)
    await waitFor('the trial server to be gone', () => !isAlive(start.pid))
    expect(run.stdout()).toContain('trial t1 did not confirm within 2000 ms; sending SIGTERM')
    expect(run.stdout().includes('sending SIGKILL')).toBe(killed)
    // Still the trial, one start counted: the next launcher start counts the second.
    expect(fx.read('trial')).toBe('t1\n')
    expect(fx.read('attempts')).toBe('1\n')
  })
})

describe('the server process', () => {
  it.each([
    ['SIGTERM', 143],
    ['SIGINT', 130],
    ['SIGHUP', 129],
  ] as const)('forwards %s to the server and exits as it did (%i)', async (sig, status) => {
    const fx = makeFixture()
    const run = launch(fx, { FAKE_LIFE_MS: String(MAX_LIFE_MS) })
    const start = await waitFor('the server to start', () => starts(fx)[0])
    expect(fx.read('server.pid')).toBe(`${start.pid}\n`)
    run.child.kill(sig)
    expect(await run.done).toEqual({ code: status, signal: null })
    expect(fx.records().filter((r) => r.event === 'signal').map((r) => r.signal)).toEqual([sig])
    await waitFor('the server to be gone', () => !isAlive(start.pid))
    expect(run.stdout()).toContain(`forwarding ${sig} to the server`)
  })

  it.each([0, 7, 42])('exits with the server\'s own exit code (%i)', async (code) => {
    const fx = makeFixture()
    const run = launch(fx, { FAKE_EXIT: String(code) })
    expect(await run.done).toEqual({ code, signal: null })
  })

  it('passes its env on, but drops a WALNUT_COMPANION_TRIAL it inherited for a build that is no trial', async () => {
    const fx = makeFixture()
    fx.app('b1')
    fx.write('current', 'b1\n')
    const run = launch(fx, { WALNUT_COMPANION_TRIAL: '1', WALNUT_COMPANION_BUILD: 'stale', FAKE_PASS_THROUGH: 'kept' })
    expect((await run.done).code).toBe(0)
    expect(only(starts(fx)).env).toEqual({
      WALNUT_COMPANION_LAUNCHER: '1',
      WALNUT_COMPANION_BUILD: 'b1',
      WALNUT_COMPANION_TRIAL: null,
      FAKE_PASS_THROUGH: 'kept',
    })
  })

  it('stops a server an earlier launcher left running before it starts a new one', async () => {
    const fx = makeFixture()
    const staleTree = fx.tree(path.join(fx.dir, 'stale'), 'stale')
    const stale = spawn(process.execPath, [path.join(staleTree, 'dist', 'cli.js'), ...ARGS], {
      env: { ...cleanEnv(), FAKE_RECORD: fx.recordFile, FAKE_LIFE_MS: String(MAX_LIFE_MS) },
      stdio: 'ignore',
    })
    others.push(stale)
    const staleExit = new Promise<NodeJS.Signals | null>((resolve) => stale.on('exit', (_c, s) => resolve(s)))
    await waitFor('the stale server to start', () => starts(fx).find((r) => r.tree === 'stale'))
    fx.write('server.pid', `${stale.pid}\n`)

    const run = launch(fx, { WALNUT_COMPANION_KILL_GRACE_MS: '5000' })
    expect((await run.done).code).toBe(0)
    expect(await staleExit).toBe('SIGTERM')
    expect(fx.records().map((r) => `${r.tree}:${r.event}`)).toEqual(['stale:start', 'stale:signal', 'base:start', 'base:exit'])
    expect(run.stdout()).toContain(`a server from an earlier start (pid ${stale.pid}) is still running; sending SIGTERM`)
  })

  it.each([
    ['a sleep', 'sleep', ['30']],
    ['a process of this runtime naming cli.js but not web', process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'dist/cli.js', 'serve']],
    ['a process of this runtime naming web but not cli.js', process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'web']],
  ])('never signals a process server.pid names that is not a server (%s)', async (_label, cmd, args) => {
    const fx = makeFixture()
    const bystander = spawn(cmd, args, { stdio: 'ignore' })
    others.push(bystander)
    expect(bystander.pid).toBeGreaterThan(1)
    fx.write('server.pid', `${bystander.pid}\n`)
    const run = launch(fx, { WALNUT_COMPANION_KILL_GRACE_MS: '200' })
    expect((await run.done).code).toBe(0)
    expect(isAlive(bystander.pid!)).toBe(true)
    expect(bystander.exitCode).toBeNull()
    expect(bystander.signalCode).toBeNull()
    expect(run.stdout()).not.toContain('earlier start')
    expect(only(starts(fx)).tree).toBe('base')
  })
})
