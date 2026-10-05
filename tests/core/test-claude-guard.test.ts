/**
 * No test reaches the machine's real `claude` (src/core/test-claude-guard.ts).
 *
 * What matters: inside a vitest worker, a session on a daemon the test did not
 * hand over is told to run the harness's mock CLI, a daemon the test owns keeps
 * `claude`, and the server-side resolver answers "not installed" for the
 * worker's own env while an explicit env still resolves.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  NO_TEST_CLAUDE, claudeFallbackCommand, isTestScratchPath, isVitestWorker, realClaudeBlocked, testRunnerClaude,
} from '../../src/core/test-claude-guard.js'
import { resolveClaudeCliExecutable } from '../../src/core/claude-cli-detect.js'
import { createSessionManager } from '../../src/providers/session-manager.js'

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** The argv RemoteSessionManager would send in its daemon `start` command. */
function startCommandOf(manager: unknown): string {
  return (manager as { cliCommand: string }).cliCommand
}

describe('the guard itself', () => {
  it('holds in a vitest worker and nowhere else', () => {
    expect(isVitestWorker()).toBe(true)
    expect(realClaudeBlocked({ VITEST: 'true' })).toBe(true)
    expect(realClaudeBlocked({ VITEST_WORKER_ID: '1' })).toBe(true)
    expect(realClaudeBlocked({})).toBe(false)
    expect(realClaudeBlocked({ NODE_ENV: 'production' })).toBe(false)
  })

  it('the live tier lifts it', () => {
    expect(realClaudeBlocked({ VITEST: 'true', WALNUT_TEST_REAL_CLAUDE: '1' })).toBe(false)
    expect(testRunnerClaude({ VITEST: 'true', WALNUT_TEST_REAL_CLAUDE: '1' })).toBeNull()
    expect(claudeFallbackCommand({ VITEST: 'true', WALNUT_TEST_REAL_CLAUDE: '1' })).toBe('claude')
  })

  it('names the stand-in, or a path that does not exist when there is none', () => {
    expect(testRunnerClaude({ VITEST: 'true', WALNUT_TEST_CLAUDE_BIN: '/x/claude' })).toBe('/x/claude')
    expect(testRunnerClaude({ VITEST: 'true' })).toBe(NO_TEST_CLAUDE)
    expect(fs.existsSync(NO_TEST_CLAUDE)).toBe(false)
    expect(path.basename(NO_TEST_CLAUDE)).toBe('claude')
    expect(testRunnerClaude({})).toBeNull()
    expect(claudeFallbackCommand({ VITEST: 'true' })).toBe(NO_TEST_CLAUDE)
    expect(claudeFallbackCommand({})).toBe('claude')
  })
})

describe('the harness stand-in (tests/setup/claude-stand-in.ts)', () => {
  it('is named in this worker and runs the mock CLI', () => {
    const bin = process.env.WALNUT_TEST_CLAUDE_BIN!
    expect(bin).toBeTruthy()
    expect(path.basename(bin)).toBe('claude')
    fs.accessSync(bin, fs.constants.X_OK)
    expect(fs.readFileSync(bin, 'utf8')).toContain('tests/providers/mock-claude.mjs')
    // One turn through it, the way a daemon spawn would start it.
    const out = execFileSync(bin, ['-p', '--output-format', 'stream-json', '--verbose', 'hello'], {
      encoding: 'utf8', timeout: 30_000, env: { ...process.env, PATH: '/usr/bin:/bin' },
    })
    expect(out).toContain('"type":"result"')
  })
})

describe('sessions', () => {
  it('a daemon the test did not hand over runs the stand-in', () => {
    // The local daemon is not running here, so name its url the way startServer would.
    const remote = createSessionManager('t-guard-remote', 'some-host', { host: 'example.invalid' } as never)
    expect(startCommandOf(remote)).toBe(process.env.WALNUT_TEST_CLAUDE_BIN)
  })

  it('a daemon the test owns keeps `claude`', () => {
    const local = createSessionManager('t-guard-owned', undefined, undefined, undefined, undefined, 'ws://127.0.0.1:1')
    expect(startCommandOf(local)).toBe('claude')
    const remote = createSessionManager('t-guard-owned-remote', 'some-host', { host: 'example.invalid' } as never, undefined, undefined, 'ws://127.0.0.1:1')
    expect(startCommandOf(remote)).toBe('claude')
  })
})

describe('server-side CLI resolution', () => {
  it('never finds the developer\'s real install from the worker env, as in CI', () => {
    expect(resolveClaudeCliExecutable()).toBeNull()
    expect(resolveClaudeCliExecutable({ ...process.env })).toBeNull()
    // Even a real-looking install dir on PATH, outside the temp dir.
    expect(resolveClaudeCliExecutable({ ...process.env, PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin' })).toBeNull()
  })

  it('finds a fake claude a test put in a temp dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-guard-fake-'))
    tmpDirs.push(dir)
    fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    expect(resolveClaudeCliExecutable({ ...process.env, PATH: dir })).toBe(path.join(dir, 'claude'))
    expect(isTestScratchPath(dir)).toBe(true)
    // A real home, not os.homedir(): the worker's HOME is a fake one in the temp dir.
    expect(isTestScratchPath('/Users/someone')).toBe(false)
    expect(isTestScratchPath('/home/someone')).toBe(false)
    expect(isTestScratchPath('/usr/local/bin')).toBe(false)
  })

  it('still resolves an explicit env', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-guard-'))
    tmpDirs.push(dir)
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    expect(resolveClaudeCliExecutable({ HOME: dir, PATH: bin })).toBe(path.join(bin, 'claude'))
  })
})
