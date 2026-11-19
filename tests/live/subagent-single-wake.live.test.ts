/**
 * LIVE: a background subagent that waits on its own background commands wakes the session that
 * started it once, by its final report (src/providers/subagent-wait-hook.ts).
 *
 * The real Claude Code CLI, in the long-running stream-json mode Walnut runs it in, with the
 * session's own hooks. The caller launches one background subagent told to do what the subagent
 * of task mulhj6ie did on 2026-11-19 (start a background command, end its run right away, twice).
 * Every caller turn the CLI starts for a task-notification ends in a `result` whose
 * `origin.kind` is `task-notification`; more than one of those while that one subagent runs is
 * the bug (without the hook: 3, two "is waiting on its own background work" notes and the report).
 *
 * Costs a few model calls. Run where `claude` is signed in:
 *   WALNUT_LIVE_TEST=1 WALNUT_LIVE_SUBAGENT_WAKE=1 bun --bun vitest run --config vitest.live.config.ts \
 *     tests/live/subagent-single-wake.live.test.ts
 * WALNUT_LIVE_CLAUDE_BIN names another CLI binary; WALNUT_LIVE_CLAUDE_MODEL the model (sonnet).
 */
import { describe, it, expect, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sessionSettingsHooks } from '../../src/providers/session-settings-hooks.js'

const GATED = !!process.env.WALNUT_LIVE_SUBAGENT_WAKE
const CLAUDE = process.env.WALNUT_LIVE_CLAUDE_BIN || 'claude'
const MODEL = process.env.WALNUT_LIVE_CLAUDE_MODEL || 'sonnet'
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-wake-'))
afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }))

const PROMPT = 'Launch ONE subagent with the Agent tool, run_in_background true, subagent_type general-purpose, '
  + "description 'probe wait', and this exact prompt: \"Do these steps in order. Step 1: run the Bash command "
  + '`sleep 30; echo PROBE-ONE` with run_in_background true. Step 2: end your turn right away saying only that you wait for it. '
  + 'When it has finished, step 3: run `sleep 30; echo PROBE-TWO` with run_in_background true and again end your turn right away saying you wait. '
  + 'When that has finished, give your final report: the two lines the commands printed." '
  + 'After launching it, end your turn. Whenever you are told about the subagent, reply with one short line; '
  + 'when its final report with PROBE-TWO arrives, reply FINAL-SEEN.'

type Result = { origin?: string; text: string }

/** Runs the caller until it saw the final report (or 6 minutes), and returns its turn results. */
function runCaller(settings: object, tmp: string): Promise<Result[]> {
  return new Promise((resolve, reject) => {
    const cwd = fs.mkdtempSync(path.join(DIR, 'run-'))
    const child = spawn(CLAUDE, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--model', MODEL, '--permission-mode', 'bypassPermissions', '--settings', JSON.stringify(settings)], { cwd, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, TMPDIR: tmp } })
    const results: Result[] = []
    let buf = ''
    const close = () => { try { child.stdin.end() } catch { /* already closed */ } }
    const deadline = setTimeout(close, 6 * 60_000)
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
        let e: { type?: string; result?: string; origin?: { kind?: string } }
        try { e = JSON.parse(line) } catch { continue }
        if (e.type !== 'result') continue
        results.push({ origin: e.origin?.kind, text: String(e.result ?? '') })
        // A late notification after the report would still be counted: wait a little before closing.
        if (String(e.result ?? '').includes('FINAL-SEEN')) setTimeout(close, 20_000)
      }
    })
    child.on('error', reject)
    child.on('exit', () => { clearTimeout(deadline); resolve(results) })
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: PROMPT } }) + '\n')
  })
}

describe.skipIf(!GATED)('a subagent waiting on its own background commands (live CLI)', () => {
  it('wakes its caller once, by its final report', async () => {
    // WALNUT_SUBAGENT_WAIT=0 runs it without the hook, to see it fail (three wakes).
    const tmp = fs.mkdtempSync(path.join(DIR, 'tmp-'))
    const results = await runCaller({ hooks: sessionSettingsHooks({ WALNUT_SUBAGENT_WAIT: process.env.WALNUT_SUBAGENT_WAIT ?? '' }, {}) }, tmp)
    const wakes = results.filter((r) => r.origin === 'task-notification')
    expect(results.some((r) => r.text.includes('FINAL-SEEN')), JSON.stringify(results)).toBe(true)
    expect(wakes.length, `caller turns started by a task-notification: ${JSON.stringify(wakes)}`).toBe(1)
    // The hook asked, rather than the model waiting on its own: it kept the ids it asked about.
    const held = fs.readdirSync(tmp).filter((d) => d.startsWith('walnut-subagent-wait-')).flatMap((d) => fs.readdirSync(path.join(tmp, d)))
    expect(held.length, 'the hook never held the subagent').toBe(1)
  }, 7 * 60_000)
})
