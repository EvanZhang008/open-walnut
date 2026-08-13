/**
 * Tests for the native-module ABI preflight.
 *
 * Incident: `better-sqlite3` is a classic (non-N-API) addon compiled against a
 * single Node ABI. The desktop launcher picks the newest Node it can find, the
 * shell used a `mise.toml` pin, and `npm install` compiled for whichever Node
 * happened to be active — three independent choices that silently drifted apart.
 * When they disagreed the task store couldn't open and the server exited with an
 * opaque "task store prewarm failed; refusing to listen" in ~2s, which the
 * desktop app then misreported as "ports are all in use".
 *
 * Contract:
 *   1. Module loads → return true, and do NOT shell out to npm.
 *   2. ABI mismatch → rebuild, and on success return true.
 *   3. A failure that is NOT an ABI mismatch must not trigger a rebuild
 *      (recompiling fixes nothing and costs a minute of startup).
 *   4. Never throws / never exits — a failed repair returns false and lets the
 *      more specific downstream error surface. Same rule as the daemon guard.
 *   5. The rebuild announcement contains the marker the desktop launcher greps
 *      for to extend its startup deadline, so a slow compile isn't killed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks: logging + child_process ──

const logged: Array<{ level: string, msg: string, ctx?: unknown }> = []
vi.mock('../../src/logging/index.js', () => ({
  log: {
    web: {
      info: (msg: string, ctx?: unknown) => { logged.push({ level: 'info', msg, ctx }) },
      warn: (msg: string, ctx?: unknown) => { logged.push({ level: 'warn', msg, ctx }) },
      error: (msg: string, ctx?: unknown) => { logged.push({ level: 'error', msg, ctx }) },
      debug: (msg: string, ctx?: unknown) => { logged.push({ level: 'debug', msg, ctx }) },
    },
  },
}))

const spawnCalls: Array<{ cmd: string, args: string[] }> = []
const spawnState = { status: 0 as number | null }
vi.mock('node:child_process', () => ({
  spawnSync: (cmd: string, args: string[]) => {
    spawnCalls.push({ cmd, args })
    return { status: spawnState.status }
  },
}))

// `probe()` loads the real addon, which we can't break from a test. Drive it
// through a controllable fake require instead: createRequire is what the module
// under test uses to resolve, load, and locate the module.
const requireState = {
  // How many times the module has been "loaded"; lets a test make the first
  // load fail and a post-rebuild load succeed.
  failures: [] as Array<Error | null>,
  calls: 0,
}

vi.mock('node:module', () => ({
  createRequire: () => {
    const fn = ((_name: string) => {
      const idx = requireState.calls++
      const err = requireState.failures[idx] ?? null
      if (err) throw err
      // Shape the module under test expects: `new Database(':memory:').close()`
      return class FakeDatabase {
        close() { /* no-op */ }
      }
    }) as unknown as NodeJS.Require
    fn.resolve = ((_n: string) => '/repo/node_modules/better-sqlite3/package.json') as NodeJS.RequireResolve
    fn.cache = {}
    return fn
  },
}))

function abiError(): Error {
  return new Error(
    "The module '/repo/node_modules/better-sqlite3/build/Release/better_sqlite3.node'\n"
    + 'was compiled against a different Node.js version using\n'
    + 'NODE_MODULE_VERSION 137. This version of Node.js requires\n'
    + 'NODE_MODULE_VERSION 127.',
  )
}

async function loadSubject() {
  vi.resetModules()
  return await import('../../src/core/native-abi-preflight.js')
}

describe('native ABI preflight', () => {
  beforeEach(() => {
    logged.length = 0
    spawnCalls.length = 0
    spawnState.status = 0
    requireState.failures = []
    requireState.calls = 0
  })

  it('returns true and never shells out when the module already loads', async () => {
    const { ensureNativeModulesLoadable } = await loadSubject()
    expect(ensureNativeModulesLoadable()).toBe(true)
    expect(spawnCalls).toHaveLength(0)
  })

  it('rebuilds on an ABI mismatch and returns true when the rebuild fixes it', async () => {
    requireState.failures = [abiError()]  // first load fails, post-rebuild load succeeds
    const { ensureNativeModulesLoadable } = await loadSubject()

    expect(ensureNativeModulesLoadable()).toBe(true)
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0].cmd).toBe('npm')
    expect(spawnCalls[0].args).toEqual(['rebuild', 'better-sqlite3'])
  })

  it('does NOT rebuild when the failure is not an ABI mismatch', async () => {
    requireState.failures = [new Error('SQLITE_CANTOPEN: unable to open database file')]
    const { ensureNativeModulesLoadable } = await loadSubject()

    expect(ensureNativeModulesLoadable()).toBe(false)
    expect(spawnCalls).toHaveLength(0)
    expect(logged.some(l => l.level === 'error' && /not an ABI mismatch/.test(l.msg))).toBe(true)
  })

  it('returns false (never throws) when the rebuild fails', async () => {
    requireState.failures = [abiError()]
    spawnState.status = 1
    const { ensureNativeModulesLoadable } = await loadSubject()

    expect(() => ensureNativeModulesLoadable()).not.toThrow()
    expect(spawnCalls).toHaveLength(1)
    expect(logged.some(l => l.level === 'error' && /rebuild failed/.test(l.msg))).toBe(true)
  })

  it('returns false when the module still fails after a successful rebuild', async () => {
    // Both the initial probe and the post-rebuild probe fail.
    requireState.failures = [abiError(), abiError()]
    const { ensureNativeModulesLoadable } = await loadSubject()

    expect(ensureNativeModulesLoadable()).toBe(false)
    expect(logged.some(l => l.level === 'error' && /still fails to load/.test(l.msg))).toBe(true)
  })

  it('announces the rebuild with the marker the desktop launcher greps for', async () => {
    requireState.failures = [abiError()]
    const printed: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      printed.push(a.map(String).join(' '))
    })

    const { ensureNativeModulesLoadable } = await loadSubject()
    ensureNativeModulesLoadable()
    spy.mockRestore()

    // Keep in sync with REBUILD_MARKER in desktop/main.swift.
    expect(printed.join('\n')).toContain('rebuilding native module')
  })
})
