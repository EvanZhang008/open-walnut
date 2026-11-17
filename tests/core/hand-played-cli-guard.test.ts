/**
 * A test that plays a session's CLI by hand keeps the server's runner off the queue.
 *
 * Such a test takes the queued rows itself (`markNextProcessing`, `removeProcessed`) while the
 * server it starts also runs: every send through a route woke the runner, which took the same rows
 * and ran a turn on the stand-in CLI (tests/setup/claude-stand-in.ts). Which one got there first
 * hung on the spawn's speed, so the same test read Working where the answered ask waits on a slow
 * Mac, and an empty queue on a fast CI runner (2026-11-16, tests/e2e/ask-answer-withdraw.test.ts).
 *
 * The class: a test file that calls `markNextProcessing` and starts a server or an app. It mocks
 * `markProcessing` (the runner's only way to take a row), or is listed here with what closes the
 * runner out instead.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')

const RUNNER_CLOSED_OTHERWISE: Record<string, string> = {
  'tests/e2e/demo-admission.test.ts': 'demoAdmissionClosed() makes markProcessing return no row',
}

function handPlayedWithServer(): string[] {
  return execFileSync('git', ['grep', '-l', 'markNextProcessing', '--', 'tests'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean)
    .filter((f) => f !== 'tests/core/hand-played-cli-guard.test.ts')
    .filter((f) => /startServer|createApp|supertest/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')))
}

describe('a test that plays the CLI by hand', () => {
  it('finds them', () => {
    expect(handPlayedWithServer()).toContain('tests/e2e/ask-answer-withdraw.test.ts')
  })

  it('keeps the server runner off the queue it plays', () => {
    const open = handPlayedWithServer()
      .filter((f) => !RUNNER_CLOSED_OTHERWISE[f])
      .filter((f) => !/\bmarkProcessing:\s/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')))
    expect(open, 'mock markProcessing in its vi.mock of the queue (see tests/e2e/ask-answer-withdraw.test.ts)').toEqual([])
  })

  it('lists only files that still need it', () => {
    for (const f of Object.keys(RUNNER_CLOSED_OTHERWISE)) expect(handPlayedWithServer(), f).toContain(f)
  })
})
