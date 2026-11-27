/**
 * Every way into a host daemon's gateway builds its request line in one place
 * (src/providers/gateway-request.ts), and a `tools.call` there names how long the daemon
 * may hold it for a server, unless the caller chose not to wait on purpose.
 *
 * 2026-11-23: a session's task_create through `walnut mcp-server` failed with
 * hub_unreachable 13 s after a deploy restarted the Walnut server, while the same call
 * through `walnut tools call` waits up to 90 s for the server: the CLI built its line with a
 * wait, the MCP server built its own line with none. This file fails when a new client
 * builds a line of its own, or when a call goes without a wait from a place not listed here.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  GATEWAY_ANSWER_SLACK_MS, MCP_CALL_WAIT_MS, WALNUT_CLI_TIMEOUT_MS, cliWaitMs, gatewayListLine, mcpWaitMs, toolsCallLine, toolsCallLineWithin, waitNoticeText,
  type GatewayLine,
} from '../../src/providers/gateway-request.js'
import { GATEWAY_MIN_RELAY_MS, GATEWAY_WAIT_MAX_MS, gatewayCallPlan, parseGatewayLine } from '../../src/providers/gateway-core.js'
import { mcpGatewayRequest } from '../../src/providers/wn-cli.js'

const ROOT = path.resolve(__dirname, '../..')
const BUILDER = 'src/providers/gateway-request.ts'

function srcFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name)
    if (e.isDirectory()) out.push(...srcFiles(rel))
    else if (/\.(ts|mts|js|mjs|cjs)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(rel)
  }
  return out
}
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** A gateway request line written out by hand: `{ v: 1, op ... }`, or an op name of the gateway as a value. */
const LINE_LITERAL = /\bv\s*:\s*1\s*,\s*op\b|\bop\s*:\s*['"]tools\.(?:call|list)['"]|"op"\s*:\s*"tools\.(?:call|list)"/

/**
 * Files that may hold such a literal, and why. Anything else that writes a gateway line
 * goes through the builder.
 */
const LITERAL_ALLOWED: Record<string, string> = {
  // Parses a line the daemon received; builds none.
  'src/providers/gateway-core.ts': 'parseGatewayLine, the receiving side',
  // A plugin job's process writes its own line, and the daemon answers a plugin job's call on
  // its own path, which keeps its own deadline and wait (sendPluginJobGatewayRequest,
  // followerGateway.routeJob) and reads no waitMs. Checked below: the day that path reads one,
  // the harness should name it.
  'src/providers/plugin-job-harness.ts': 'a plugin job writes its own line; its daemon path reads no waitMs',
}

/** The calls that do not wait for a server, on purpose: file -> enclosing function -> why. */
const NO_WAIT: Record<string, Record<string, string>> = {
  'src/providers/wn-cli.ts': {
    callHostDaemonTool: "the Mac's own CLI: with no server it goes its HTTP way at once",
    runTriggerCheckViaGateway: 'a check that meets no server is a quiet run that keeps its cursor',
    recordCardedCall: 'display data only; must not hold the CLI exit',
  },
  'src/providers/check-call-report.ts': {
    tellCheckDaemon: 'a check\'s report: a fault the daemon answers itself, a refused call never queued for a server that is away',
  },
}

/** The top-level arguments of the call that opens at `open` (the index of its `(`). */
function callArgs(src: string, open: number): string[] {
  const args: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = open + 1
  for (let i = open; i < src.length; i++) {
    const ch = src[i]!
    if (quote) {
      if (ch === '\\') { i++; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }
    if (ch === '(' || ch === '{' || ch === '[') depth++
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--
      if (depth === 0) { args.push(src.slice(start, i).trim()); return args }
    } else if (ch === ',' && depth === 1) { args.push(src.slice(start, i).trim()); start = i + 1 }
  }
  throw new Error('unclosed call')
}

/** The name of the function a source position sits in (the nearest `function name(` before it). */
function enclosingFunction(src: string, at: number): string {
  const before = src.slice(0, at)
  const all = [...before.matchAll(/\bfunction\s+([A-Za-z0-9_$]+)\s*[(<]/g)]
  return all.length ? all[all.length - 1]![1]! : '(top level)'
}

describe('every gateway line comes from the shared builder', () => {
  const files = [...srcFiles('src'), ...srcFiles('scripts').filter((f) => !f.includes('/leak-scan/'))]

  it('no file outside the builder writes a request line by hand', () => {
    const offenders: string[] = []
    for (const rel of files) {
      if (rel === BUILDER || LITERAL_ALLOWED[rel]) continue
      const lines = read(rel).split('\n')
      // A comment that shows the shape of a line is no line.
      lines.forEach((line, i) => { if (LINE_LITERAL.test(line) && !/^\s*(\*|\/\/|\/\*)/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 140)}`) })
    }
    expect(offenders, 'build the line with toolsCallLine / gatewayListLine (src/providers/gateway-request.ts)').toEqual([])
  })

  it('the transport takes a built line, never a bare request', () => {
    const cli = read('src/providers/wn-cli.ts')
    expect(cli).toMatch(/function requestOverSocket\(\s*socketPath: string,\s*line: GatewayLine,/)
    expect(cli).toMatch(/function requestRidingRestart\(\s*socketPath: string,\s*line: GatewayLine,/)
  })

  it('every tools call names a wait, except the listed ones that chose none', () => {
    const noWait: Record<string, string[]> = {}
    let calls = 0
    for (const rel of files) {
      if (rel === BUILDER) continue
      const src = read(rel)
      // A call answered within what is left (toolsCallLineWithin) names its own wait: the builder's rule.
      calls += [...src.matchAll(/\btoolsCallLineWithin\(/g)].filter((m) => !/import\s*\{[^}]*$/.test(src.slice(Math.max(0, m.index! - 400), m.index!))).length
      for (const m of src.matchAll(/\btoolsCallLine\(/g)) {
        // An import or a type mention is no call.
        if (/import\s*\{[^}]*$/.test(src.slice(Math.max(0, m.index! - 400), m.index!))) continue
        calls++
        const args = callArgs(src, m.index! + 'toolsCallLine'.length)
        expect(args.length, `${rel}: toolsCallLine(sid, args, wait, timeoutMs?)`).toBeGreaterThanOrEqual(3)
        if (args[2] === "'none'") (noWait[rel] ??= []).push(enclosingFunction(src, m.index!))
      }
    }
    expect(calls).toBeGreaterThanOrEqual(10)
    const expected = Object.fromEntries(Object.entries(NO_WAIT).map(([f, fns]) => [f, Object.keys(fns).sort()]))
    for (const f of Object.keys(noWait)) noWait[f]!.sort()
    expect(noWait).toEqual(expected)
  })

  it("the plugin job harness's reason still holds: the daemon's plugin job path reads no waitMs", () => {
    const calls = [...read('src/providers/daemon-standalone.ts').matchAll(/sendPluginJobGatewayRequest\(\w+, req\.op, req\.args, [^\n]*/g)].map((m) => m[0])
    expect(calls.length).toBeGreaterThanOrEqual(1)
    for (const c of calls) expect(c, 'a plugin job call now has a plan; give plugin-job-harness.ts a wait').not.toMatch(/gatewayCallPlan|waitMs/)
    expect(read('src/providers/plugin-job-harness.ts')).not.toMatch(/waitMs/)
  })
})

describe('the builder', () => {
  it('a tools call names its wait, clamped as the daemon clamps it, and its socket stays open past it', () => {
    const line = toolsCallLine('sid-1', { name: 'task_create', args: { title: 'x' } }, 60_000)
    expect(line.req).toEqual({ v: 1, op: 'tools.call', sid: 'sid-1', args: { name: 'task_create', args: { title: 'x' } }, waitMs: 60_000 })
    expect(line.timeoutMs).toBe(60_000 + GATEWAY_ANSWER_SLACK_MS)
    for (const [asked, sent] of [[1, GATEWAY_MIN_RELAY_MS], [0, GATEWAY_MIN_RELAY_MS], [Number.NaN, GATEWAY_MIN_RELAY_MS], [10 ** 9, GATEWAY_WAIT_MAX_MS], [12_345.7, 12_345]]) {
      const l = toolsCallLine('s', {}, asked)
      expect(l.req.waitMs).toBe(sent)
      // The daemon's plan for it ends where the line says: the socket outlives it.
      const plan = gatewayCallPlan(l.req.waitMs, 20_000, 0)
      expect(plan).toEqual({ deadline: sent, waits: true })
      expect(l.timeoutMs).toBeGreaterThan(plan.deadline)
    }
  })

  it("'none' goes on the line as waitMs 0: the daemon never holds it, not even for a server that is starting", () => {
    const line = toolsCallLine('s', { name: 'task_send' }, 'none')
    expect(line.req).toEqual({ v: 1, op: 'tools.call', sid: 's', args: { name: 'task_send' }, waitMs: 0 })
    expect(line.timeoutMs).toBe(WALNUT_CLI_TIMEOUT_MS)
    const parsed = parseGatewayLine(JSON.stringify(line.req))
    expect(parsed.ok && parsed.request.waitMs).toBe(0)
    expect(gatewayCallPlan(0, 20_000, 0)).toEqual({ deadline: 20_000, waits: false, never: true })
    expect(toolsCallLine('s', {}, 'none', 2_000).timeoutMs).toBe(2_000)
  })

  it('a call answered within what is left waits only within it, and for none with less than a relay left', () => {
    const ample = toolsCallLineWithin('s', { name: 'op_result' }, 40_000)
    expect(ample.req.waitMs).toBe(40_000)
    expect(ample.timeoutMs).toBe(40_000 + GATEWAY_ANSWER_SLACK_MS)
    expect(toolsCallLineWithin('s', {}, 200_000, 90_000).req.waitMs).toBe(90_000)
    expect(toolsCallLineWithin('s', {}, 20_000, 90_000).req.waitMs).toBe(20_000)
    expect(toolsCallLineWithin('s', {}, GATEWAY_MIN_RELAY_MS).req.waitMs).toBe(GATEWAY_MIN_RELAY_MS)
    for (const left of [GATEWAY_MIN_RELAY_MS - 1, 2_000, 1, 0, -5, Number.NaN]) {
      const short = toolsCallLineWithin('s', {}, left)
      expect(short.req.waitMs, String(left)).toBe(0)
      expect(short.timeoutMs, String(left)).toBe(Math.max(1, Number.isFinite(left) ? left : 0))
    }
  })

  it('a list waits for nothing', () => {
    expect(gatewayListLine('tools.list', 's', { schemas: true })).toEqual({ req: { v: 1, op: 'tools.list', sid: 's', args: { schemas: true } }, timeoutMs: WALNUT_CLI_TIMEOUT_MS })
    expect(gatewayListLine('tools.list', 's', {}, 15_000).timeoutMs).toBe(15_000)
  })

  it('every line a newer daemon reads keeps its wait through the parse', () => {
    const parsed = parseGatewayLine(JSON.stringify(toolsCallLine('s', { name: 'x' }, 45_000).req))
    expect(parsed.ok && parsed.request.waitMs).toBe(45_000)
  })

  it("the CLI keeps its 90 s, the MCP server waits 60 s, each set by its own env (tests), never past the daemon's cap", () => {
    expect(cliWaitMs({})).toBe(90_000)
    expect(cliWaitMs({ WALNUT_CLI_WAIT_MS: '30000' })).toBe(30_000)
    expect(mcpWaitMs({})).toBe(MCP_CALL_WAIT_MS)
    expect(MCP_CALL_WAIT_MS).toBe(60_000)
    expect(mcpWaitMs({ WALNUT_MCP_WAIT_MS: '15000' })).toBe(15_000)
    expect(mcpWaitMs({ WALNUT_MCP_WAIT_MS: '999999999' })).toBe(GATEWAY_WAIT_MAX_MS)
    for (const bad of ['', '0', '-5', 'abc']) expect(mcpWaitMs({ WALNUT_MCP_WAIT_MS: bad })).toBe(MCP_CALL_WAIT_MS)
    expect(waitNoticeText(60_000)).toBe('no answer yet; this call waits up to 60s')
  })
})

describe("the MCP server's way to the gateway (wn-cli.ts mcpGatewayRequest)", () => {
  function capture(env: NodeJS.ProcessEnv = {}) {
    const sent: GatewayLine[] = []
    const request = mcpGatewayRequest('/tmp/x/agent-gateway.sock', 'sess-1', async (_p, line) => { sent.push(line); return { ok: true, result: {} } }, env)
    return { sent, request }
  }

  it('a call waits for a server as long as the MCP wait, a list waits for nothing', async () => {
    const { sent, request } = capture()
    await request('tools.call', { name: 'task_create', args: { title: 'x' }, callId: 'oc-1', client: 'mcp' })
    await request('tools.list', { schemas: true }, 15_000)
    expect(sent[0]!.req).toMatchObject({ op: 'tools.call', sid: 'sess-1', waitMs: MCP_CALL_WAIT_MS })
    expect(sent[0]!.timeoutMs).toBe(MCP_CALL_WAIT_MS + GATEWAY_ANSWER_SLACK_MS)
    expect(sent[1]!.req).toEqual({ v: 1, op: 'tools.list', sid: 'sess-1', args: { schemas: true } })
    expect(sent[1]!.timeoutMs).toBe(15_000)
  })

  it('a time the handler names (a lost call followed) bounds the call; a test run rides the call', async () => {
    const { sent, request } = capture({ WALNUT_TEST_RUN: 'probe-1', WALNUT_MCP_WAIT_MS: '20000' })
    await request('tools.call', { name: 'op_result', args: {} }, 12_000)
    await request('tools.call', { name: 'task_get', args: {} })
    await request('tools.call', { name: 'op_result', args: {} }, 3_000)
    expect(sent[0]!.req.waitMs).toBe(12_000)
    expect(sent[0]!.req.args).toMatchObject({ testRun: 'probe-1' })
    expect(sent[1]!.req.waitMs).toBe(20_000)
    // Less left than a relay: no wait, and the socket ends with what is left.
    expect(sent[2]!.req.waitMs).toBe(0)
    expect(sent[2]!.timeoutMs).toBe(3_000)
  })
})
