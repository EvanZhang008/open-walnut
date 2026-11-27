/**
 * A trigger check's `walnut tools call` that Walnut refused as written reaches the check's daemon,
 * which relays it as the check's (providers/check-call-report.ts), whatever the op.
 *
 * 2026-11-27: only the task-only host ops went through the daemon, so a check's refused call of any
 * other op (task_list with a key it does not take) was run by the full CLI in its own process and
 * heard by no one. Covered, with the real clients spawned as a check runs them:
 *   - the full CLI (src/cli.ts): its own refusal of the arguments, of bad JSON, and the API's 400;
 *     nothing for a 404, outside a check, or inside a session;
 *   - the gateway shim (wn-cli.ts): its own refusal of bad JSON; nothing extra for a call the daemon
 *     relayed and the server refused (the server tells that one itself).
 *
 * MACHINE SAFETY: the socket and the HTTP server are this test's own, on a temp path and port 0.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { CHECK_CALL_REFUSED_OP, PERMANENT_REFUSAL_CODES, refusedAsWritten } from '../../src/providers/check-call-report.js'
import { CHECK_FAULT_OP } from '../../src/providers/trigger-check-core.js'
import { testBun } from '../helpers/bun-runtime.js'

const ROOT = path.resolve(__dirname, '../..')
let dir = ''
const closers: Array<() => void> = []

afterEach(() => {
  for (const c of closers.splice(0)) c()
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = ''
})

/** A daemon's gateway socket that records every line; a relayed call gets `answer`, a report ok. */
async function fakeDaemon(answer: Record<string, unknown> = { ok: true, result: {} }): Promise<{ socket: string; lines: Array<Record<string, any>> }> {
  dir = fs.mkdtempSync('/tmp/wcr-')
  const socket = path.join(dir, 'g.sock')
  const lines: Array<Record<string, any>> = []
  const server = net.createServer((c) => {
    let buf = ''
    c.on('data', (d) => {
      buf += d
      if (!buf.includes('\n')) return
      const line = JSON.parse(buf.split('\n')[0]!)
      lines.push(line)
      const report = line.args?.name === CHECK_CALL_REFUSED_OP || line.args?.name === CHECK_FAULT_OP
      c.end(JSON.stringify(report ? { ok: true, result: {} } : answer) + '\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  closers.push(() => server.close())
  return { socket, lines }
}

/** An API that answers every request with this status and body. */
async function api(status: number, body: unknown): Promise<string> {
  const server = http.createServer((_req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => server.close())
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`
}

const TOKEN = 'trigger-check:abc'
const checkEnv = (socket: string): NodeJS.ProcessEnv => ({ WALNUT_CHECK_TOKEN: TOKEN, WALNUT_CHECK_SOCKET: socket })

/** Run a client as a check runs it: its own HOME, the check's env, no terminal. */
async function run(bun: string, entry: string[], env: NodeJS.ProcessEnv): Promise<number | null> {
  const home = path.join(dir, 'home')
  return new Promise<number | null>((resolve) => {
    const p = spawn(bun, entry, {
      env: { PATH: process.env.PATH, HOME: home, OPEN_WALNUT_HOME: path.join(home, '.open-walnut'), ...env },
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    p.on('close', resolve)
  })
}

const reports = (lines: Array<Record<string, any>>) => lines.filter((l) => l.args?.name === CHECK_CALL_REFUSED_OP)

describe('what counts as refused as written', () => {
  it('arguments the op refused, the API\'s 400, 413 or 422, a 403 for what the caller is; never a designed answer or a fault', () => {
    expect(refusedAsWritten({ ok: false, invalidArgs: true })).toBe(true)
    for (const status of [400, 413, 422]) expect(refusedAsWritten({ ok: false, status })).toBe(true)
    for (const code of PERMANENT_REFUSAL_CODES) expect(refusedAsWritten({ ok: false, status: 403, code })).toBe(true)
    // A 403 that may pass (a grant still asked, a task that is not open yet) is an answer a check waits through.
    expect(refusedAsWritten({ ok: false, status: 403, code: 'grant_needed' })).toBe(false)
    for (const status of [401, 403, 404, 409, 429, 500, 503, 507]) expect(refusedAsWritten({ ok: false, status })).toBe(false)
    expect(refusedAsWritten({ ok: false })).toBe(false)
    expect(refusedAsWritten({ ok: true, invalidArgs: true })).toBe(false)
  })
})

describe('the full CLI in a check', () => {
  const cli = [path.join(ROOT, 'src/cli.ts'), 'tools', 'call']

  it('its own refusal of an op\'s arguments, and of bad JSON, reach the daemon with Walnut\'s words', async () => {
    const bun = testBun()
    if (!bun) return
    const d = await fakeDaemon()
    // A server that would answer: nothing must reach it, the CLI refuses first.
    const base = await api(200, { tasks: [] })
    expect(await run(bun, [...cli, 'task_list', '{"bogus_key":1}'], { ...checkEnv(d.socket), OPEN_WALNUT_API_URL: base })).not.toBe(0)
    expect(await run(bun, [...cli, 'task_list', '{"q": "x"'], { ...checkEnv(d.socket), OPEN_WALNUT_API_URL: base })).not.toBe(0)
    expect(reports(d.lines).map((l) => ({ sid: l.sid, waitMs: l.waitMs, op: l.args.args.op }))).toEqual([
      { sid: TOKEN, waitMs: 0, op: 'task_list' }, { sid: TOKEN, waitMs: 0, op: 'task_list' },
    ])
    expect(reports(d.lines)[0]!.args.args.message).toContain('bogus_key')
    expect(reports(d.lines)[1]!.args.args.message).toMatch(/json/i)
    expect(d.lines).toHaveLength(2)
  }, 90_000)

  it('the API\'s 400 is told; its 404, a call outside a check and one inside a session are not', async () => {
    const bun = testBun()
    if (!bun) return
    const d = await fakeDaemon()
    const bad = await api(400, { error: { code: 'bad_input', message: 'id is not a task id' } })
    expect(await run(bun, [...cli, 'task_get', '{"id":"t-1"}'], { ...checkEnv(d.socket), OPEN_WALNUT_API_URL: bad })).not.toBe(0)
    expect(reports(d.lines).map((l) => l.args.args)).toEqual([{ op: 'task_get', message: expect.stringContaining('id is not a task id') }])
    const missing = await api(404, { error: { code: 'not_found', message: 'no such task' } })
    await run(bun, [...cli, 'task_get', '{"id":"t-2"}'], { ...checkEnv(d.socket), OPEN_WALNUT_API_URL: missing })
    await run(bun, [...cli, 'task_list', '{"bogus_key":1}'], { OPEN_WALNUT_API_URL: missing })
    await run(bun, [...cli, 'task_list', '{"bogus_key":1}'], { ...checkEnv(d.socket), WALNUT_SESSION_ID: 'a-session', OPEN_WALNUT_API_URL: missing })
    expect(reports(d.lines)).toHaveLength(1)
  }, 90_000)
})

describe('an op the full CLI does not know, in a check', () => {
  it('goes to the check\'s daemon as the check\'s call (a plugin\'s op), with no report of its own', async () => {
    const bun = testBun()
    if (!bun) return
    const d = await fakeDaemon({ ok: true, result: { done: true } })
    const code = await run(bun, [path.join(ROOT, 'src/cli.ts'), 'tools', 'call', 'acme_plugin_op', '{"a":1}'], checkEnv(d.socket))
    expect(code).toBe(0)
    expect(d.lines.map((l) => ({ sid: l.sid, name: l.args?.name, args: l.args?.args }))).toEqual([{ sid: TOKEN, name: 'acme_plugin_op', args: { a: 1 } }])
  }, 90_000)
})

describe('the gateway shim in a check', () => {
  it('its own refusal of bad JSON is told; a call the daemon relayed is the server\'s to tell', async () => {
    const bun = testBun()
    if (!bun) return
    // The relayed call is refused by "the server" (this fake daemon's answer).
    const d = await fakeDaemon({ ok: false, error: { code: 'bad_request', message: 'Invalid arguments for task_list: (root): Unrecognized key: "bogus_key"' } })
    const entry = path.join(dir, 'shim.ts')
    fs.writeFileSync(entry, `import { runWalnutCli } from ${JSON.stringify(path.join(ROOT, 'src/providers/wn-cli.ts'))}\nprocess.exit(await runWalnutCli(process.argv.slice(2)))\n`)
    expect(await run(bun, [entry, 'tools', 'call', 'task_list', '{"q": "x"'], checkEnv(d.socket))).not.toBe(0)
    expect(reports(d.lines).map((l) => ({ sid: l.sid, op: l.args.args.op }))).toEqual([{ sid: TOKEN, op: 'task_list' }])
    expect(await run(bun, [entry, 'tools', 'call', 'task_list', '{"bogus_key":1}'], checkEnv(d.socket))).not.toBe(0)
    // The call itself went to the daemon, and no report followed it.
    expect(d.lines.map((l) => l.args?.name)).toEqual([CHECK_CALL_REFUSED_OP, 'task_list'])
  }, 90_000)
})
