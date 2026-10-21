/**
 * `walnut trigger-check` in the daemon's own CLI (src/providers/wn-cli.ts): the
 * stored command of a plugin trigger template on a host with no installed
 * Walnut CLI. It is one gateway `tools.call trigger_template_check`, answered as
 * the one JSON line a check ends with. Driven as a real child process against a
 * fake gateway socket, with the trigger input on stdin as the daemon writes it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { parseWalnutCliArgs } from '../../../src/providers/wn-cli.js'
import {
  TEMPLATE_WAIT_GRACE_MS, classifyTemplateGateway, classifyTemplateHttp, templateCheckEnv, templateCheckGap,
  templateCheckInput, templateCheckReplyMs,
} from '../../../src/providers/trigger-check-core.js'

const REPO = path.resolve(import.meta.dirname, '../../..')
const TSX = path.join(REPO, 'node_modules/.bin/tsx')
const RUNNER = "import('./src/providers/wn-cli.ts').then((m) => m.runWalnutCli(process.argv.slice(1))).then((c) => process.exit(c))"

let dir = ''
let socketPath = ''
let server: net.Server
const requests: Array<Record<string, any>> = []

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-trigger-check-'))
  socketPath = path.join(dir, 'gw.sock')
  server = net.createServer((sock) => {
    let buf = ''
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf-8')
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      const req = JSON.parse(buf.slice(0, nl))
      requests.push(req)
      const template = req.args?.args?.template
      const reply = template === 'demo:down'
        ? { ok: false, error: { code: 'hub_unreachable', message: 'no hub connection' } }
        : template === 'demo:gone'
          ? { ok: false, error: { code: 'internal', message: 'Walnut API error (not_found): no trigger template "demo:gone"' } }
          : template === 'demo:bad'
            ? { ok: false, error: { code: 'internal', message: 'Walnut API error (plugin_error): Demo check failed: boom' } }
            : { ok: true, result: { fire: true, items: [{ id: 'm1', title: 'hello' }], state: { cursor: 2 } } }
      sock.end(JSON.stringify(reply) + '\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(dir, { recursive: true, force: true })
})

function run(args: string[], stdin: string, env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(TSX, ['-e', RUNNER, 'trigger-check', ...args], {
      cwd: REPO,
      env: { ...process.env, WALNUT_AGENT_SOCKET: socketPath, WALNUT_SESSION_ID: '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(stdin)
  })
}

describe('walnut trigger-check (daemon CLI)', () => {
  it('parses a template and its params, and refuses a missing template', () => {
    expect(parseWalnutCliArgs(['trigger-check', 'mail:new-mail', '{"from":"a"}']))
      .toEqual({ kind: 'trigger-check', template: 'mail:new-mail', paramsJson: '{"from":"a"}' })
    expect(parseWalnutCliArgs(['trigger-check', 'mail:new-mail']))
      .toEqual({ kind: 'trigger-check', template: 'mail:new-mail', paramsJson: undefined })
    expect(parseWalnutCliArgs(['trigger-check']).kind).toBe('usage-error')
  })

  it('sends the trigger input through the gateway and prints one contract line', async () => {
    const r = await run(['demo:ok', '{"channel":"C1"}'], JSON.stringify({ state: { cursor: 1 }, lastFireAt: null, now: '2026-10-21T00:00:00Z' }))
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout.trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(r.stdout)).toEqual({ fire: true, items: [{ id: 'm1', title: 'hello' }], state: { cursor: 2 } })
    expect(requests.at(-1)).toMatchObject({
      v: 1, op: 'tools.call', sid: 'external',
      args: {
        name: 'trigger_template_check',
        args: { template: 'demo:ok', params: { channel: 'C1' }, input: { state: { cursor: 1 }, lastFireAt: null, now: '2026-10-21T00:00:00Z' } },
      },
    })
  }, 60_000)

  it('a hub it cannot reach is a quiet run that keeps the cursor and says since when', async () => {
    const down = await run(['demo:down'], JSON.stringify({ state: { cursor: 7 } }))
    expect(down.code, down.stderr).toBe(0)
    const out = JSON.parse(down.stdout)
    expect(out).toMatchObject({ fire: false, state: { __walnutPending: { reason: 'no hub connection' }, state: { cursor: 7 } } })
    // The next run hands the plugin its own cursor, not the bookkeeping.
    const back = await run(['demo:ok'], JSON.stringify({ state: out.state }))
    expect(back.code, back.stderr).toBe(0)
    expect(requests.at(-1)?.args?.args?.input?.state).toEqual({ cursor: 7 })
    const noSocket = await run(['demo:ok'], JSON.stringify({ state: null }), { WALNUT_AGENT_SOCKET: path.join(dir, 'missing.sock') })
    expect(noSocket.code, noSocket.stderr).toBe(0)
    expect(JSON.parse(noSocket.stdout)).toMatchObject({ fire: false, state: { state: null } })
  }, 60_000)

  it('a template not loaded yet waits; past its grace it is an error', async () => {
    const r = await run(['demo:gone'], JSON.stringify({ state: { cursor: 1 } }))
    expect(r.code, r.stderr).toBe(0)
    const since = new Date(Date.now() - TEMPLATE_WAIT_GRACE_MS.missing - 60_000).toISOString()
    const late = await run(['demo:gone'], JSON.stringify({ state: { __walnutPending: { since, reason: 'x' }, state: { cursor: 1 } } }))
    expect(late.code).toBe(1)
    expect(late.stdout).toBe('')
    expect(late.stderr).toMatch(/has not run for \d+ minutes: .*no trigger template/)
  }, 60_000)

  it('a plugin failure is an error the trigger reports at once', async () => {
    const r = await run(['demo:bad'], '{}')
    expect(r.code).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('boom')
  }, 60_000)
})

describe('trigger-check answers shared by both CLIs', () => {
  it('reads a failure the same way over HTTP and over the gateway', () => {
    expect(classifyTemplateHttp(503, 'unavailable')).toBe('unreachable')
    expect(classifyTemplateHttp(502, '')).toBe('unreachable')
    expect(classifyTemplateHttp(502, 'plugin_error')).toBe('error')
    expect(classifyTemplateHttp(404, 'not_found')).toBe('missing')
    expect(classifyTemplateHttp(404, '')).toBe('error')
    expect(classifyTemplateHttp(400, 'bad_request')).toBe('error')
    expect(classifyTemplateGateway('hub_timeout', '')).toBe('unreachable')
    expect(classifyTemplateGateway('internal', 'Walnut API error (unavailable): away')).toBe('unreachable')
    expect(classifyTemplateGateway('internal', 'Walnut server not running at http://x')).toBe('unreachable')
    expect(classifyTemplateGateway('internal', 'Walnut API error (not_found): no trigger template')).toBe('missing')
    expect(classifyTemplateGateway('internal', 'Walnut API error (forbidden): only on this Mac')).toBe('error')
  })

  it('keeps the first since across gaps, and turns into an error after the grace', () => {
    const t = Date.parse('2026-10-21T10:00:00Z')
    const first = templateCheckGap(templateCheckInput('{"state":{"c":1}}', ''), 'unreachable', 'down', t)
    expect('line' in first && JSON.parse(first.line)).toEqual({
      fire: false, state: { __walnutPending: { since: '2026-10-21T10:00:00.000Z', reason: 'down' }, state: { c: 1 } },
    })
    const again = templateCheckInput(JSON.stringify({ state: JSON.parse((first as { line: string }).line).state }), '')
    expect(again.state).toEqual({ c: 1 })
    const still = templateCheckGap(again, 'unreachable', 'down', t + 60 * 60_000)
    expect('line' in still && JSON.parse(still.line).state.__walnutPending.since).toBe('2026-10-21T10:00:00.000Z')
    expect(templateCheckGap(again, 'unreachable', 'down', t + TEMPLATE_WAIT_GRACE_MS.unreachable + 60_000))
      .toEqual({ error: expect.stringMatching(/^this check has not run for \d+ minutes: down$/) })
  })

  it('puts the daemon\'s own walnut first only for a template command, and budgets from process start', () => {
    const env = { ...process.env }
    expect(templateCheckEnv("walnut trigger-check mail:new-mail '{}'", env, '/d/bin').PATH).toBe(`/d/bin:${env.PATH}`)
    expect(templateCheckEnv('bash check.sh', env, '/d/bin').PATH).toBe(env.PATH)
    expect(templateCheckEnv("walnut trigger-check mail:new-mail '{}'", env, undefined).PATH).toBe(env.PATH)
    expect(templateCheckReplyMs(0)).toBe(27_000)
    expect(templateCheckReplyMs(4_000)).toBe(23_000)
    expect(templateCheckReplyMs(60_000)).toBe(5_000)
    expect(Number.isInteger(templateCheckReplyMs(1234.567))).toBe(true)
  })
})
