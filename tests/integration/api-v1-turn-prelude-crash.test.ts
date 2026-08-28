/**
 * A turn that dies in its PRELUDE must not swallow the user's message.
 *
 * The prelude is everything between "the turn was accepted" and the eager
 * persist: lazy imports, the console-agent profile, the history read, the image
 * rewrite. It used to run outside any try/catch, so a throw there escaped the
 * queue callback entirely — the eager persist never ran, the error handler never
 * ran, and the user's words were simply gone. On the phone that looked like a
 * bubble you typed, an error underneath it, and nothing left after a refresh.
 * (Observed 2026-08-27 23:03 on a relayed turn: the conversation file held 134
 * bytes and an empty `entries` array.)
 *
 * The crash here is real, not mocked: the conversation's store file is corrupted
 * on disk, so the prelude's history read throws for genuine reasons. No model is
 * ever called — the failure lands before the engine branch, which is the window
 * under test.
 *
 * Note what this injection also proves, and what it therefore asserts: when the
 * STORE is the thing that broke, the rescue's own write cannot succeed either.
 * There is no disk left to rescue onto, so the contract in that case is (a) the
 * turn still terminates instead of hanging, and (b) the user's text is preserved
 * in the log rather than nowhere. The disk-write half of the rescue is covered by
 * unit tests over `addUserMessage({ onlyIfTurnAbsent })`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')

const BOOT = `
import { startServer } from ${JSON.stringify(path.join(REPO_ROOT, 'src/web/server.ts'))}
const server = await startServer({ port: 0, dev: true })
const addr = server.address()
process.stdout.write('WALNUT_PORT=' + (typeof addr === 'object' && addr ? addr.port : addr) + '\\n')
`

let proc: ChildProcess
let origin: string
let home: string
/** Everything the server printed, so the test can assert on its log lines. */
let serverLog = ''

beforeAll(async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-prelude-'))
  home = path.join(base, 'home')
  await fsp.mkdir(home, { recursive: true })
  const scriptPath = path.join(base, 'boot.mts')
  await fsp.writeFile(scriptPath, BOOT)

  proc = spawn(TSX, [scriptPath], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      OPEN_WALNUT_HOME: home,
      // Keep the box's own subsystems out of it: no vitest home-guard, no daemons.
      VITEST: '',
      VITEST_WORKER_ID: '',
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server did not report a port in 90s\n${serverLog.slice(-3000)}`)),
      90_000,
    )
    const onData = (d: unknown) => {
      serverLog += String(d)
      const m = serverLog.match(/WALNUT_PORT=(\d+)/)
      if (m) { clearTimeout(timer); resolve(Number(m[1])) }
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`server exited ${code}\n${serverLog.slice(-3000)}`))
    })
  })
  origin = `http://127.0.0.1:${port}`
}, 120_000)

afterAll(() => { proc?.kill('SIGTERM') })

/** Wait until the server log contains `needle` (or give up). */
async function waitForLog(needle: string, ms = 30_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (serverLog.includes(needle)) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

describe('api-v1 turn — a prelude crash never loses the user message silently', () => {
  it('terminates the turn and preserves the text when the store is what broke', async () => {
    const created = await fetch(`${origin}/api/v1/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'general', title: 'prelude crash' }),
    })
    expect(created.status).toBeLessThan(300)
    const conversationId = ((await created.json()) as { id: string }).id
    expect(conversationId).toBeTruthy()

    // Corrupt the store the turn is about to read. Non-empty and unparseable, so
    // readJsonFile throws rather than falling back (it deliberately refuses a
    // fallback for a corrupt file — that would re-persist over real data).
    const storeFile = path.join(home, 'conversations', 'general', `${conversationId}.json`)
    await fsp.writeFile(storeFile, '{ this is not json', 'utf-8')

    const TEXT = 'THESE WORDS MUST SURVIVE A PRELUDE CRASH'
    const sent = await fetch(`${origin}/api/v1/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: TEXT, agentId: 'general' }),
    })
    // Accepted — the turn runs in the background, as it always did.
    expect(sent.status).toBe(202)

    // 1. The prelude's failure is REPORTED, with a stack. Before the fix this
    //    throw escaped the queue callback and produced no handled error at all.
    expect(
      await waitForLog('api-v1 turn failed before it started'),
      `no prelude-failure log line; tail:\n${serverLog.slice(-4000)}`,
    ).toBe(true)

    // 2. The user's text is preserved. The store is the broken thing here, so
    //    the rescue's own write cannot land — and the words go to the log
    //    instead of vanishing entirely.
    expect(
      await waitForLog(TEXT),
      `the user's text reached neither disk nor log; tail:\n${serverLog.slice(-4000)}`,
    ).toBe(true)

    // 3. The turn released its queue slot, so the agent is not wedged: a second
    //    turn on a HEALTHY conversation still answers the POST.
    const second = await fetch(`${origin}/api/v1/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'general', title: 'after the crash' }),
    })
    expect(second.status).toBeLessThan(300)
  }, 90_000)
})
