/**
 * Regression tests for the daemon-version-drift startup guard.
 *
 * Incident: the guard returned `false` on a rebuild that could never converge
 * (the TS hash-source list and scripts/build-daemon.sh's list had drifted by a
 * single file), and the caller did `process.exit(1)` — a cosmetic guard bug
 * became a 41-restart, multi-minute total outage of the cloud companion.
 *
 * Contract now:
 *   1. Cloud REPLICA (CLOUD_MODE) skips the check entirely — it never deploys
 *      daemon binaries, so the guard protects nothing and its rebuild path
 *      needs tools the cloud box doesn't have.
 *   2. Non-convergence after a successful rebuild returns `true`
 *      (success-with-warning) and logs loudly. It must NEVER be fatal.
 *   3. The call site in src/commands/web.ts must not exit on the result.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── Mocks: constants (CLOUD_MODE + binaries dir), logging, child_process ──

const state = {
  cloudMode: false,
  binariesDir: '',
}

vi.mock('../../src/constants.js', () => ({
  get CLOUD_MODE() { return state.cloudMode },
  get DAEMON_BINARIES_DIR() { return state.binariesDir },
}))

const logged: Array<{ level: string, msg: string, ctx?: unknown }> = []
vi.mock('../../src/logging/index.js', () => ({
  log: {
    session: {
      info: (msg: string, ctx?: unknown) => { logged.push({ level: 'info', msg, ctx }) },
      warn: (msg: string, ctx?: unknown) => { logged.push({ level: 'warn', msg, ctx }) },
      error: (msg: string, ctx?: unknown) => { logged.push({ level: 'error', msg, ctx }) },
      debug: (msg: string, ctx?: unknown) => { logged.push({ level: 'debug', msg, ctx }) },
    },
  },
}))

const spawnCalls: string[][] = []
const spawnResult = { status: 0 as number | null }
vi.mock('node:child_process', () => ({
  spawnSync: (cmd: string, args: string[]) => {
    spawnCalls.push([cmd, ...args])
    return { status: spawnResult.status }
  },
}))

let tmpDir: string
let consoleErrorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-dvc-'))
  state.binariesDir = tmpDir
  state.cloudMode = false
  logged.length = 0
  spawnCalls.length = 0
  spawnResult.status = 0
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  consoleErrorSpy.mockRestore()
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
})

/** Write a `.version` sidecar for a fake arch into the mocked binaries dir. */
function writeVersion(arch: string, version: string): void {
  fs.writeFileSync(path.join(tmpDir, `${arch}.version`), version + '\n')
}

async function loadGuard() {
  return await import('../../src/providers/daemon-version-check.js')
}

describe('daemon version guard: CLOUD_MODE skip', () => {
  it('skips the whole check on a cloud replica and logs one info line', async () => {
    state.cloudMode = true
    // Deliberately plant a drifted version — a non-cloud run would rebuild.
    writeVersion('daemon-linux-x64', 'walnut-daemon-deadbeef0000')

    const { verifyDaemonBinaryVersion } = await loadGuard()
    expect(verifyDaemonBinaryVersion()).toBe(true)

    // No rebuild attempted: the cloud box has no bun and no daemons to deploy.
    expect(spawnCalls).toHaveLength(0)
    const skip = logged.filter(l => /cloud mode: skipping daemon binary version check/.test(l.msg))
    expect(skip).toHaveLength(1)
    expect(skip[0].level).toBe('info')
    // And nothing was reported as an error.
    expect(logged.filter(l => l.level === 'error')).toHaveLength(0)
  })

  it('does NOT skip when not in cloud mode (guard still runs)', async () => {
    state.cloudMode = false
    writeVersion('daemon-linux-x64', 'walnut-daemon-deadbeef0000')

    const { verifyDaemonBinaryVersion } = await loadGuard()
    verifyDaemonBinaryVersion()

    // The useful remediation (rebuild attempt) is preserved on the Mac path.
    expect(spawnCalls.some(c => c.join(' ').includes('scripts/build-daemon.sh'))).toBe(true)
  })
})

describe('daemon version guard: non-convergence is never fatal', () => {
  it('returns true (continue startup) when the rebuild still yields a different hash', async () => {
    const { verifyDaemonBinaryVersion, computeExpectedDaemonVersion } = await loadGuard()
    const expected = computeExpectedDaemonVersion()
    expect(expected).toBeTruthy()  // repo checkout — sources available

    // Simulate the incident: the rebuild "succeeds" (exit 0) but the on-disk
    // version never becomes `expected`, because the two hash-source lists
    // disagree. The mocked spawnSync is inert, so the pre- and post-rebuild
    // reads both see this stuck version — exactly the observed behavior.
    spawnResult.status = 0
    writeVersion('daemon-linux-x64', 'walnut-daemon-111111111111')

    const ok = verifyDaemonBinaryVersion()

    // The rebuild WAS attempted (useful remediation preserved)…
    expect(spawnCalls.some(c => c.join(' ').includes('scripts/build-daemon.sh'))).toBe(true)
    // …and startup continues regardless.
    expect(ok).toBe(true)

    const err = logged.filter(l =>
      l.level === 'error'
      && /cannot converge/.test(l.msg)
      && /continuing WITHOUT guard/.test(l.msg))
    expect(err).toHaveLength(1)
    // Loud on the console too, so a human deploying sees it.
    expect(consoleErrorSpy.mock.calls.flat().join('\n')).toMatch(/CANNOT CONVERGE/)
  })

  it('returns true when versions match, with no rebuild', async () => {
    const { verifyDaemonBinaryVersion, computeExpectedDaemonVersion } = await loadGuard()
    const expected = computeExpectedDaemonVersion()!
    writeVersion('daemon-linux-x64', expected)

    expect(verifyDaemonBinaryVersion()).toBe(true)
    expect(spawnCalls).toHaveLength(0)
    expect(logged.filter(l => l.level === 'error')).toHaveLength(0)
  })
})

describe('daemon version guard: no startup path can exit', () => {
  const webSrc = fs.readFileSync(
    path.resolve(import.meta.dirname, '../../src/commands/web.ts'),
    'utf-8',
  )

  it('src/commands/web.ts does not exit on verifyDaemonBinaryVersion()', () => {
    expect(webSrc).toMatch(/verifyDaemonBinaryVersion\(\)/)
    // The old shape: `if (!verifyDaemonBinaryVersion()) { process.exit(1) }`
    expect(webSrc).not.toMatch(/if\s*\(\s*!\s*verifyDaemonBinaryVersion\(\)\s*\)/)
    // Nor any exit within the 10 lines following the call.
    const idx = webSrc.indexOf('verifyDaemonBinaryVersion()')
    const after = webSrc.slice(idx, idx + 400)
    expect(after).not.toMatch(/process\.exit/)
  })

  it('the guard module itself never calls process.exit', () => {
    const guardSrc = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../src/providers/daemon-version-check.ts'),
      'utf-8',
    )
    // Comments legitimately mention the removed exit (incident context), so
    // strip block + line comments before asserting on real code.
    const code = guardSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/process\.exit/)
  })
})

describe('daemon version guard: hash source lists stay in lockstep', () => {
  it('daemon-version-check.ts and scripts/build-daemon.sh hash the same file list', () => {
    const root = path.resolve(import.meta.dirname, '../..')
    const tsSrc = fs.readFileSync(path.join(root, 'src/providers/daemon-version-check.ts'), 'utf-8')
    const shSrc = fs.readFileSync(path.join(root, 'scripts/build-daemon.sh'), 'utf-8')

    const tsBlock = tsSrc.slice(
      tsSrc.indexOf('const DAEMON_SOURCE_FILES = ['),
      tsSrc.indexOf('] as const', tsSrc.indexOf('const DAEMON_SOURCE_FILES = [')),
    )
    // Strip the // comments FIRST: the entries are explained by comments, and an
    // ordinary apostrophe in one of them ("one op's parameters") made this
    // quote-scanner read prose as file paths and fail with a diff nobody could
    // read (2026-09-01). Comments are not data.
    const tsList = [...tsBlock.replace(/\/\/[^\n]*/g, '').matchAll(/'([^']+)'/g)].map(m => m[1])

    const shBlock = shSrc.slice(
      shSrc.indexOf('SOURCES=('),
      shSrc.indexOf(')', shSrc.indexOf('SOURCES=(')),
    )
    const shList = shBlock
      .split('\n')
      .slice(1)
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith('#'))

    expect(tsList.length).toBeGreaterThan(0)
    // Identical files, identical ORDER — the hash is order-sensitive.
    expect(shList).toEqual(tsList)
  })
})
