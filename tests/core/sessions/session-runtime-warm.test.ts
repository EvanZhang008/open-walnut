/**
 * The server unpacks the compiled file's runtime tree for session-side runs at
 * boot, so the first ask after a deploy does not wait for it
 * (src/core/sessions/session-runtime-warm.ts; 2026-11-08: the first ask after a
 * deploy waited 14.6 s for its walnut MCP mount, which unpacked and pruned trees
 * before it served).
 *
 * The class: every env key that moves the tree (RUNTIME_PLACE_ENV) must be one a
 * session-side run does not carry, with the place in the source that drops it.
 * A new key in runtime-tree.ts, or a session env that starts carrying one, fails
 * here, because the warm would then fill a tree the sessions never read.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RUNTIME_MARKER, RUNTIME_PLACE_ENV, runtimeRootsFor } from '../../../src/binary/runtime-tree.js'
import { sessionRuntimeEnv, sessionRuntimeRoot, warmSessionRuntime } from '../../../src/core/sessions/session-runtime-warm.js'

const repo = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8')

/** Where the source proves a session-side run of the file has no such key. */
const DROPPED_FOR_SESSIONS: Record<(typeof RUNTIME_PLACE_ENV)[number], Array<{ file: string; proof: RegExp }>> = {
  // Every CLI the daemon starts (both twins) gets no runtime dir.
  WALNUT_RUNTIME_DIR: [
    { file: 'src/providers/daemon-standalone.ts', proof: /WALNUT_RUNTIME_DIR: undefined/ },
    { file: 'src/providers/daemon-source.ts', proof: /WALNUT_RUNTIME_DIR: undefined/ },
  ],
  // The local daemon starts with no data home of the server's, so neither do its CLIs.
  OPEN_WALNUT_HOME: [
    { file: 'src/providers/local-daemon.ts', proof: /delete env\.OPEN_WALNUT_HOME/ },
  ],
}

describe('which env keys move the runtime tree', () => {
  it('RUNTIME_PLACE_ENV is every env key runtime-tree.ts reads', () => {
    const src = read('src/binary/runtime-tree.ts')
    const read_ = new Set([...src.matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]))
    expect([...read_].sort()).toEqual([...RUNTIME_PLACE_ENV].sort())
  })

  it.each([...RUNTIME_PLACE_ENV])('a session-side run never carries %s (with the place that drops it)', (key) => {
    const proofs = DROPPED_FOR_SESSIONS[key]
    expect(proofs?.length, `${key} moves the tree: name the code that keeps it out of a session's env`).toBeGreaterThan(0)
    for (const { file, proof } of proofs) expect(read(file), `${file} no longer drops ${key}`).toMatch(proof)
  })

  it('the warm reads the tree a session-side run reads, whatever the server itself carries', () => {
    const server = { HOME: os.homedir(), WALNUT_RUNTIME_DIR: '/stage/runtime', OPEN_WALNUT_HOME: '/custom/home' }
    expect(sessionRuntimeEnv(server)).toEqual({ HOME: os.homedir() })
    expect(sessionRuntimeRoot('0.6.28-abc', server)).toBe(runtimeRootsFor({}, '0.6.28-abc')[0])
    expect(sessionRuntimeRoot('0.6.28-abc', server)).toBe(path.join(os.homedir(), '.open-walnut', 'local', 'runtime', '0.6.28-abc'))
  })
})

describe('warmSessionRuntime', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-runtime-warm-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  const ID = '0.6.28-feedface'
  const FILE = '/stage/dist-bin/walnut-darwin-arm64'
  const info = { root: `/stage/runtime/${ID}`, daemonVersion: '1', modules: {}, execId: null } as never
  // The mount names a runtime dir of its own here, so the test never touches the real data home.
  const mount = () => ({ command: FILE, args: ['/$bunfs/root/walnut', 'mcp'], env: { WALNUT_RUNTIME_DIR: dir } })

  /** A spawn that does what the file does on start (unpack, marker last) and records the call. */
  function fakeSpawn(calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }>, unpack = true) {
    return ((cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      calls.push({ cmd, args, env: opts.env })
      const child = new EventEmitter()
      setTimeout(() => {
        if (unpack) {
          const root = path.join(opts.env.WALNUT_RUNTIME_DIR!, ID)
          fs.mkdirSync(root, { recursive: true })
          fs.writeFileSync(path.join(root, RUNTIME_MARKER), `${ID}\n`)
        }
        child.emit('close', 0)
      }, 5)
      return child
    }) as never
  }

  it('runs the mount\'s own command with --version and a session-side env, and the tree is there after', async () => {
    const calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }> = []
    const env = { PATH: '/usr/bin', WALNUT_RUNTIME_DIR: '/stage/runtime', OPEN_WALNUT_HOME: '/data' }
    const out = await warmSessionRuntime({ isolated: false, info, mount: mount(), execPath: FILE, env, spawnFn: fakeSpawn(calls) })
    expect(out).toMatchObject({ state: 'warmed', root: path.join(dir, ID), code: 0 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args.slice(-2)).toEqual(['/$bunfs/root/walnut', '--version'])
    expect(calls[0]!.env.OPEN_WALNUT_HOME).toBeUndefined()
    expect(calls[0]!.env.WALNUT_RUNTIME_DIR).toBe(dir)
  })

  it('starts nothing when the tree is already complete', async () => {
    fs.mkdirSync(path.join(dir, ID), { recursive: true })
    fs.writeFileSync(path.join(dir, ID, RUNTIME_MARKER), `${ID}\n`)
    const calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }> = []
    const out = await warmSessionRuntime({ isolated: false, info, mount: mount(), execPath: FILE, env: {}, spawnFn: fakeSpawn(calls) })
    expect(out).toEqual({ state: 'ready', root: path.join(dir, ID) })
    expect(calls).toHaveLength(0)
  })

  it('reports a run that left no tree as failed', async () => {
    const calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }> = []
    const out = await warmSessionRuntime({ isolated: false, info, mount: mount(), execPath: FILE, env: {}, spawnFn: fakeSpawn(calls, false) })
    expect(out.state).toBe('failed')
  })

  it('reports a child that never started as failed', async () => {
    const spawnFn = (() => {
      const child = new EventEmitter()
      setTimeout(() => child.emit('error', new Error('spawn ENOENT')), 5)
      return child
    }) as never
    const out = await warmSessionRuntime({ isolated: false, info, mount: mount(), execPath: FILE, env: {}, spawnFn })
    expect(out).toMatchObject({ state: 'failed', error: 'spawn ENOENT' })
  })

  it.each([
    ['an isolated server', { isolated: true, info, mount: mount(), execPath: FILE }],
    ['a run that is not the compiled file', { isolated: false, info: null, mount: mount(), execPath: FILE }],
    ['a mount that runs another program', { isolated: false, info, mount: { command: 'open-walnut', args: ['mcp'] }, execPath: FILE }],
  ])('skips %s', async (_label, deps) => {
    const calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }> = []
    const out = await warmSessionRuntime({ ...deps, env: {}, spawnFn: fakeSpawn(calls) })
    expect(out.state).toBe('skipped')
    expect(calls).toHaveLength(0)
  })
})
