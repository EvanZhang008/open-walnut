/**
 * No test runs the machine's real `claude`, `ssh`, `scp` or `sftp`.
 *
 * Loaded FIRST in every vitest worker of the mock tiers (the first setupFile of
 * every config except vitest.live.config.ts, the one tier that runs real tools;
 * ratchet: tests/setup/exec-guard-ratchet.test.ts), before any test module.
 *
 * What it protects (2026-10-03)
 * -----------------------------
 * A gate run that put refusing shims on PATH counted 59 `claude` and 230 `ssh`
 * calls from one e2e tier. Without the shims those were the developer's real
 * tools: a test spawned `claude` from PATH (a model turn with the user's
 * credentials), another ran `ssh -fN alice@devbox.example.com`, two read the real
 * ~/.ssh/config and opened real ControlMaster links, and a daemon a test started
 * respawned a session as a bare `claude`, which its own PATH resolved. A shim on
 * the worker's PATH alone does not reach that last one: a session daemon puts its
 * login shell's PATH (and /usr/bin/ssh) ahead of the PATH it inherited.
 *
 * How
 * ---
 * 1. PATH starts with tests/setup/exec-guard-bin, whose four scripts never run the
 *    real tool: they print who called, append a line to this worker's guard log,
 *    and exit like a missing claude (127) or a failed ssh (255).
 * 2. HOME is a fake home per worker, with an empty ~/.ssh/config and a neutral git
 *    identity; variables that point past HOME at the user's own config (ZDOTDIR,
 *    XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL, CLAUDE_CONFIG_DIR, SSH_AUTH_SOCK) are
 *    removed, so nothing resolves a real host or sources a real shell rc.
 * 3. WALNUT_TEST_EXEC_GUARD names the bin dir. A session daemon a test starts keeps
 *    the inherited PATH, guard included, at the front of its own PATH
 *    (host-runtime-core.ts computeDaemonPath), so its bare `claude` lands here too;
 *    one given a pinned PATH without the guard (a host with no claude) gets only
 *    that, nothing of the machine's. A readiness check (host.preflight, here or
 *    in a daemon) reads the guard's claude as not installed, as CI has none, so a
 *    probe runs nothing; a session start still runs it, and fails its test.
 * 4. Every guard hit FAILS the test it happened in (afterEach) or the file
 *    (afterAll), naming the test that started the process and the command, even
 *    when the code under test swallowed the exit code. global-setup.ts reports,
 *    at teardown, the hits no check read (a background dial that outlived its
 *    test) and those from a process that lost the test env (a shared log).
 *
 * A test that needs a fake `claude` or `ssh` puts its own dir in front of the
 * guard: `PATH: guardedPath([fakeBin])`. Replacing PATH with a literal drops the
 * guard, which is why the ratchet counts those.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isMainThread } from 'node:worker_threads'
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest'
import {
  EXEC_GUARD_BIN, EXEC_GUARD_HOME_PREFIX, EXEC_GUARD_LOG, EXEC_GUARD_OFFSET_FILE, EXEC_GUARD_RUN_FILE, REAL_CONFIG_VARS,
  formatHit, guardedPath, makeFakeHome, parseHit, type ExecGuardHit,
} from './exec-guard-core.js'

export { EXEC_GUARD_BIN, guardedPath, type ExecGuardHit } from './exec-guard-core.js'

interface ExecGuardState {
  home: string
  log: string
  offset: number
}

// One state per worker, kept on globalThis: setupFiles run again for every test
// file, and the home, the log and the read offset must survive that.
const STATE_KEY = Symbol.for('open-walnut.test.exec-guard')
const holder = globalThis as unknown as Record<symbol, ExecGuardState | undefined>

function install(): ExecGuardState {
  const existing = holder[STATE_KEY]
  if (existing) return existing
  const home = path.join(os.tmpdir(), `${EXEC_GUARD_HOME_PREFIX}${process.pid}`)
  makeFakeHome(home)
  const log = path.join(home, EXEC_GUARD_LOG)
  fs.writeFileSync(log, '', { flag: 'a' })
  // The runner (a fork's parent, a thread's own process) reports what no check
  // here read (global-setup.ts).
  fs.writeFileSync(path.join(home, EXEC_GUARD_RUN_FILE), String(isMainThread ? process.ppid : process.pid))
  fs.writeFileSync(path.join(home, EXEC_GUARD_OFFSET_FILE), '0')
  // A real bun (and only bun) keeps being found: the twin tests look for it
  // under ~/.bun, and the fake home has none.
  const realBun = path.join(os.homedir(), '.bun')
  if (!process.env.BUN_INSTALL && fs.existsSync(path.join(realBun, 'bin', 'bun'))) process.env.BUN_INSTALL = realBun
  for (const k of REAL_CONFIG_VARS) delete process.env[k]
  process.env.HOME = home
  process.env.PATH = guardedPath()
  process.env.WALNUT_TEST_EXEC_GUARD = EXEC_GUARD_BIN
  process.env.WALNUT_TEST_EXEC_GUARD_LOG = log
  const state: ExecGuardState = { home, log, offset: 0 }
  process.on('exit', () => {
    try {
      // Unread hits stay for the runner, which reports them and then sweeps the home.
      if (fs.statSync(log).size > state.offset) return
      fs.rmSync(home, { recursive: true, force: true })
    } catch { /* global-setup sweeps it */ }
  })
  holder[STATE_KEY] = state
  return state
}

export const execGuardState = install()

// What a test file runs while it is imported (a probe at module scope) carries its name too.
process.env.WALNUT_TEST_EXEC_GUARD_TAG = `${testFile() || 'a test file'} (import)`

/** The hits written since the last read, consumed. */
export function takeExecGuardHits(): ExecGuardHit[] {
  let text = ''
  try {
    const fd = fs.openSync(execGuardState.log, 'r')
    try {
      const size = fs.fstatSync(fd).size
      if (size <= execGuardState.offset) return []
      const buf = Buffer.alloc(size - execGuardState.offset)
      fs.readSync(fd, buf, 0, buf.length, execGuardState.offset)
      text = buf.toString('utf8')
    } finally { fs.closeSync(fd) }
  } catch {
    return []
  }
  // Only whole lines: a shim mid-append finishes its line before the next read.
  const end = text.lastIndexOf('\n')
  if (end < 0) return []
  execGuardState.offset += Buffer.byteLength(text.slice(0, end + 1))
  fs.writeFileSync(path.join(execGuardState.home, EXEC_GUARD_OFFSET_FILE), String(execGuardState.offset))
  return text.slice(0, end).split('\n').map(parseHit).filter((h): h is ExecGuardHit => h !== null)
}

function testFile(): string {
  try {
    const { testPath } = expect.getState()
    return testPath ? path.relative(process.cwd(), testPath) : ''
  } catch {
    return ''
  }
}

function currentTest(): string {
  try {
    return [testFile(), expect.getState().currentTestName].filter(Boolean).join(' > ')
  } catch {
    return ''
  }
}

/** Throw once for every hit not yet reported. */
export function failOnExecGuardHits(when: string): void {
  const hits = takeExecGuardHits()
  if (hits.length === 0) return
  throw new Error(
    `[exec-guard] ${hits.length} call(s) to a real claude/ssh/scp/sftp were refused ${when}. ` +
    'Tests use the repo mocks (the mock CLI, MockDaemon, a fake ssh on guardedPath()):\n' +
    hits.map(formatHit).join('\n'),
  )
}

function tag(): void {
  process.env.WALNUT_TEST_EXEC_GUARD_TAG = currentTest() || 'a test file hook'
}

beforeAll(() => {
  failOnExecGuardHits('before this file\'s tests started (while it was imported, or left over from an earlier file)')
  process.env.WALNUT_TEST_EXEC_GUARD_TAG = `${testFile() || 'a test file'} (file hooks)`
})
beforeEach(tag)
afterEach(() => failOnExecGuardHits(`during this test (${currentTest()})`))
afterAll(() => failOnExecGuardHits('in this file\'s hooks'))
