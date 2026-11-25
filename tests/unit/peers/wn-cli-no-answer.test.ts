/**
 * The in-session CLI (wn-cli.ts) keeps a call no Walnut answered and tells the hub with the
 * session's next call that gets through (lib/no-answer-report.ts).
 *
 * 2026-11-24 audit: a `walnut tools call host_copy` that the daemon answered `hub_unreachable`
 * during a deploy restart (exit 1, "Walnut server not running") was in the session's transcript
 * and not in `usage_watch errors`: the session hook reads a result only while the server reads the
 * session live. Each CLI run is its own process here, against a stand-in gateway socket.
 *
 * MACHINE SAFETY: the socket and the spool are under a temp dir; the only processes are the CLIs
 * this file starts, each ended when it answers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const REPO = path.resolve(__dirname, '../../..')
const SID = 'probe-sid-no-answer'
let root = ''
let runnerFile = ''

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wnna-'))
  runnerFile = path.join(root, 'runner.ts')
  fs.writeFileSync(runnerFile, `import { runWalnutCli } from ${JSON.stringify(path.join(REPO, 'src/providers/wn-cli.ts'))}\n`
    + 'process.exit(await runWalnutCli(process.argv.slice(2)))\n')
})
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }) })

/** A stand-in gateway: answers each request line with `answer(line)`, and keeps every line. */
async function gateway(answer: (line: Record<string, unknown>) => unknown): Promise<{ dir: string; sock: string; lines: Array<Record<string, unknown>>; close: () => void }> {
  const dir = fs.mkdtempSync(path.join(root, 'g'))
  const sock = path.join(dir, 'agent-gateway.sock')
  const lines: Array<Record<string, unknown>> = []
  const server = net.createServer((c) => {
    let buf = ''
    c.on('data', (d) => {
      buf += d.toString('utf-8')
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      const line = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>
      lines.push(line)
      c.write(JSON.stringify(answer(line)) + '\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(sock, () => resolve()))
  fs.chmodSync(sock, 0o600)
  return { dir, sock, lines, close: () => server.close() }
}

function run(argv: string[], sock: string, dir: string): Promise<number | null> {
  const env: NodeJS.ProcessEnv = { ...process.env, WALNUT_DAEMON_DIR: dir, WALNUT_AGENT_SOCKET: sock, WALNUT_SESSION_ID: SID, WALNUT_CLI_WAIT_MS: '2000', WALNUT_OP_RECORD: '0' }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runnerFile, ...argv], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.resume()
    child.stderr.resume()
    child.on('close', (code) => resolve(code))
  })
}

const opOf = (l: Record<string, unknown>) => ((l.req ?? l) as { op?: string }).op
const argsOf = (l: Record<string, unknown>) => (((l.req ?? l) as { args?: Record<string, unknown> }).args ?? {})

describe('the CLI tells its calls no Walnut answered', () => {
  it('a hub_unreachable call is kept, and the next call that works tells it once', async () => {
    let up = false
    const gw = await gateway((l) => {
      if (opOf(l) === 'tools.list') return { ok: true, result: { recorded: true, no_answer: 1 } }
      return up ? { ok: true, result: { id: 'x' } } : { ok: false, error: { code: 'hub_unreachable', message: 'Walnut server not running at http://127.0.0.1:3456/api/v1' } }
    })
    try {
      expect(await run(['tools', 'call', 'host_copy', '{"from":"/a","to":"/b"}'], gw.sock, gw.dir)).not.toBe(0)
      const spool = path.join(gw.dir, 'no-answer', `${SID}.ndjson`)
      expect(fs.existsSync(spool)).toBe(true)
      expect(gw.lines.filter((l) => opOf(l) === 'tools.list')).toEqual([])
      up = true
      expect(await run(['tools', 'call', 'task_get', '{"id":"x"}'], gw.sock, gw.dir)).toBe(0)
      const reports = gw.lines.filter((l) => opOf(l) === 'tools.list').map((l) => argsOf(l).report)
      expect(reports).toEqual([{ no_answer: [{ op: 'host_copy', code: 'hub_unreachable', client: 'cli', ms: expect.any(Number) }] }])
      expect(fs.existsSync(spool)).toBe(false)
      // Told once.
      expect(await run(['tools', 'call', 'task_get', '{"id":"x"}'], gw.sock, gw.dir)).toBe(0)
      expect(gw.lines.filter((l) => opOf(l) === 'tools.list')).toHaveLength(1)
    } finally { gw.close() }
  }, 60_000)

  it('an op\'s own refusal is no no-answer: nothing kept', async () => {
    const gw = await gateway(() => ({ ok: false, error: { code: 'bad_request', message: 'Invalid arguments for task_get: id: Required' } }))
    try {
      await run(['tools', 'call', 'task_get', '{}'], gw.sock, gw.dir)
      expect(fs.existsSync(path.join(gw.dir, 'no-answer', `${SID}.ndjson`))).toBe(false)
    } finally { gw.close() }
  }, 60_000)

  // 2026-11-25 audit: a report the host daemon answered with its offline catalog was taken as told.
  it('a report the daemon answered for an away server stays kept, and goes once the server takes it', async () => {
    let calls = 0
    let back = false
    const gw = await gateway((l) => {
      if (opOf(l) === 'tools.list') return back ? { ok: true, result: { recorded: true, no_answer: 1 } } : { ok: true, result: { ops: [], offline: true } }
      calls++
      if (calls === 1) return { ok: false, error: { code: 'hub_unreachable', message: 'daemon is shutting down', detail: { stopping: true } } }
      // The second call is answered from the daemon's own copy: no sign the hub is back, it tells nothing.
      return calls === 2 ? { ok: true, result: { offline: true, id: 'x' } } : { ok: true, result: { id: 'x' } }
    })
    try {
      await run(['tools', 'call', 'task_send', '{"to":"x","message":"y"}'], gw.sock, gw.dir)
      const spool = path.join(gw.dir, 'no-answer', `${SID}.ndjson`)
      expect(await run(['tools', 'call', 'task_get', '{"id":"x"}'], gw.sock, gw.dir)).toBe(0)
      expect(gw.lines.filter((l) => opOf(l) === 'tools.list')).toHaveLength(0)
      // The third is the hub's, but the report is answered by the daemon for an away hub: kept.
      expect(await run(['tools', 'call', 'task_get', '{"id":"x"}'], gw.sock, gw.dir)).toBe(0)
      expect(gw.lines.filter((l) => opOf(l) === 'tools.list')).toHaveLength(1)
      expect(fs.existsSync(spool)).toBe(true)
      back = true
      expect(await run(['tools', 'call', 'task_get', '{"id":"x"}'], gw.sock, gw.dir)).toBe(0)
      const reports = gw.lines.filter((l) => opOf(l) === 'tools.list').map((l) => argsOf(l).report)
      expect(reports[1]).toEqual({ no_answer: [{ op: 'task_send', code: 'hub_unreachable', client: 'cli', ms: expect.any(Number) }] })
      expect(fs.existsSync(spool)).toBe(false)
    } finally { gw.close() }
  }, 60_000)

  it('a failure the session\'s MCP server kept is told by its next CLI call that gets through', async () => {
    const gw = await gateway((l) => (opOf(l) === 'tools.list' ? { ok: true, result: { recorded: true, no_answer: 1 } } : { ok: true, result: { id: 'x' } }))
    try {
      const { spoolNoAnswer } = await import('../../../src/lib/no-answer-report.js')
      fs.mkdirSync(path.join(gw.dir, 'no-answer'), { mode: 0o700 })
      spoolNoAnswer(path.join(gw.dir, 'no-answer', `${SID}.ndjson`), 'task_get', 'no_daemon', 'mcp')
      expect(await run(['tools', 'call', 'task_get', '{"id":"x"}'], gw.sock, gw.dir)).toBe(0)
      const reports = gw.lines.filter((l) => opOf(l) === 'tools.list').map((l) => argsOf(l).report)
      expect(reports).toEqual([{ no_answer: [{ op: 'task_get', code: 'no_daemon', client: 'mcp', ms: expect.any(Number) }] }])
    } finally { gw.close() }
  }, 60_000)
})
