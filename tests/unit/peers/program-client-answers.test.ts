/**
 * A program that reads an op's answer as data gets it whole on every host, the same as on the Mac
 * (2026-11-23, apr-kCUkpVWwmbBH: `walnut approve --single-use` on a remote host read approval_request's
 * answer shaped for an agent, found no single-use envelope in its cut detail, and withdrew the ask as
 * "not made as a single-use approval"; the Git push it guarded never ran).
 *
 * The class: an op's answer is shaped for an agent (ops/answer.ts) only when its client prints it to
 * one. Over a host's gateway the client names itself, so every tools.call a client sends names its
 * client, and a program names PROGRAM_CLIENT; both gateways (capability-router.ts, backup-gateway.ts)
 * shape nothing for it. On the Mac a program calls executeOp with no forAgent.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { PROGRAM_CLIENT, answerSize, isToolClient } from '../../../src/lib/tool-answer-size.js'
import { agentAnswer, agentSurfaceOf } from '../../../src/ops/answer.js'

const ROOT = path.resolve(__dirname, '../../..')
const SRC = path.join(ROOT, 'src')

/** The clients a sender may name: the two agent surfaces and a program. */
const CLIENTS = new Set([`'cli'`, `'mcp'`, `'${PROGRAM_CLIENT}'`, 'PROGRAM_CLIENT'])

/** In wn-cli.ts, the functions whose answer is printed to the agent; any other sender there is a program. */
const WN_CLI_PRINTERS = new Set(['callHostDaemonTool', 'runWalnutCli', 'runMcpCli'])

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

interface Sender { file: string; line: number; fn: string; clients: Array<string | null> }

function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression
  return e
}

/** 'tools.call' in any quotes, also as `'tools.call' as const`. */
const isToolsCall = (n: ts.Node | undefined): boolean => {
  if (!n) return false
  const e = ts.isExpression(n) ? unwrap(n) : n
  return ts.isStringLiteralLike(e) && e.text === 'tools.call'
}

/** Calls that take a tools.call's arguments and send nothing over a gateway, each with why. */
const NOT_SENT: Record<string, string> = {
  // offline-host-core.ts: a message held while the server is away is replayed by the Mac through the op itself.
  holdWrite: 'replayed by the Mac through the op itself, never over a gateway',
}

function calleeName(c: ts.CallExpression): string {
  const e = unwrap(c.expression)
  return ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : ''
}

/** The object literals an expression can be (each branch of a conditional), or null for one that is not a literal. */
function objectsOf(e: ts.Expression | undefined): ts.ObjectLiteralExpression[] | null {
  if (!e) return null
  const u = unwrap(e)
  if (ts.isObjectLiteralExpression(u)) return [u]
  if (ts.isConditionalExpression(u)) {
    const a = objectsOf(u.whenTrue)
    const b = objectsOf(u.whenFalse)
    return a && b ? [...a, ...b] : null
  }
  return null
}

function prop(o: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | undefined {
  return o.properties.find((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && ts.isIdentifier(p.name) && p.name.text === name)
}

/** The client an op call's arguments name, as written (`'cli'`, `PROGRAM_CLIENT`), or null. */
function clientOf(o: ts.ObjectLiteralExpression, sf: ts.SourceFile): string | null {
  const p = prop(o, 'client')
  if (!p) return null
  return ts.isPropertyAssignment(p) ? p.initializer.getText(sf) : p.name.getText(sf)
}

/** A tools.call's arguments always carry the op's own: `args` or `argsFile`, written out or spread in. */
const isCallArgs = (o: ts.ObjectLiteralExpression): boolean =>
  !!prop(o, 'name') && (!!prop(o, 'args') || !!prop(o, 'argsFile') || o.properties.some((p) => ts.isSpreadAssignment(p)))

function enclosingFn(n: ts.Node): ts.Node | undefined {
  for (let p = n.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return p
  return undefined
}

/** The outermost named function around a node (wn-cli's commands are top-level functions). */
function fnName(fn: ts.Node | undefined): string {
  let name = '(top level)'
  for (let p = fn; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name) name = p.name.text
    else if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && name === '(top level)') name = p.name.text
  }
  return name
}

const EQUALITY = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken])
/** 'tools.call' compared with (`x === 'tools.call'`), not chosen. */
const compared = (n: ts.Node): boolean => !!n.parent && ts.isBinaryExpression(n.parent) && EQUALITY.has(n.parent.operatorToken.kind)

/** The one place a client builds a tools.call line (src/providers/gateway-request.ts). */
const BUILDERS = new Set(['toolsCallLine', 'toolsCallLineWithin'])

/** `{ ...args, ...more }`: arguments handed on as they came, named by whoever built them. */
const passThrough = (e: ts.Expression): boolean =>
  ts.isObjectLiteralExpression(e) && !prop(e, 'name') && e.properties.length > 0 && e.properties.every((p) => ts.isSpreadAssignment(p))

/** The initializer of the variable an identifier names, in the functions around it. */
function declarationOf(id: ts.Identifier): ts.Expression | undefined {
  for (let fn = enclosingFn(id); fn; fn = enclosingFn(fn)) {
    let found: ts.Expression | undefined
    const look = (e: ts.Node) => {
      if (found) return
      if (ts.isVariableDeclaration(e) && ts.isIdentifier(e.name) && e.name.text === id.text && e.initializer) found = e.initializer
      else ts.forEachChild(e, look)
    }
    look(fn)
    if (found) return found
  }
  return undefined
}

/** The call arguments an expression builds (each branch, nested), or null when it builds none. */
function callArgsIn(e: ts.Expression): ts.ObjectLiteralExpression[] | null {
  const built: ts.ObjectLiteralExpression[] = []
  const collect = (n: ts.Node) => {
    if (ts.isObjectLiteralExpression(n) && isCallArgs(n)) built.push(n)
    ts.forEachChild(n, collect)
  }
  collect(e)
  return built.length ? built : null
}

/** Every gateway tools.call a source file sends, with the client each of its argument objects names. */
function sendersIn(file: string): Sender[] {
  const text = fs.readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const out: Sender[] = []
  const add = (at: ts.Node, objects: ts.ObjectLiteralExpression[] | null) => {
    const fn = enclosingFn(at)
    out.push({
      file: path.relative(ROOT, file), line: sf.getLineAndCharacterOfPosition(at.getStart(sf)).line + 1, fn: fnName(fn),
      clients: objects ? objects.map((o) => clientOf(o, sf)) : [null],
    })
  }
  const visit = (n: ts.Node) => {
    // A frame: { v: 1, op: 'tools.call', sid, args: {...} }.
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === 'op' && isToolsCall(n.initializer) && ts.isObjectLiteralExpression(n.parent)) {
      const a = prop(n.parent, 'args')
      add(n, a && ts.isPropertyAssignment(a) ? objectsOf(a.initializer) : null)
    }
    // A helper's call: request('tools.call', {...}), gateway(socket, sid, 'tools.call', {...}).
    if (ts.isCallExpression(n)) {
      const i = n.arguments.findIndex((a) => isToolsCall(a))
      if (i >= 0 && !Object.hasOwn(NOT_SENT, calleeName(n))) add(n, objectsOf(n.arguments[i + 1]))
    }
    // The shared builder (gateway-request.ts): toolsCallLine(sid, args, wait), toolsCallLineWithin(sid, args, left).
    if (ts.isCallExpression(n) && BUILDERS.has(calleeName(n)) && n.arguments[1]) {
      const given = unwrap(n.arguments[1])
      if (ts.isIdentifier(given)) {
        // Built beside it (`const args = ...`), else a parameter: the caller that built it is checked where it did.
        const made = declarationOf(given)
        if (made) add(n, callArgsIn(made))
      } else if (!passThrough(given)) add(n, objectsOf(given))
    }
    // The op chosen into a variable (`const op = ... 'tools.call' ...`): the arguments built beside it.
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'op' && n.initializer) {
      let named = false
      const find = (e: ts.Node) => { if (isToolsCall(e) && !compared(e)) named = true; else ts.forEachChild(e, find) }
      find(n.initializer)
      const fn = enclosingFn(n)
      if (named && fn) {
        const built: ts.ObjectLiteralExpression[] = []
        const collect = (e: ts.Node) => {
          if (ts.isObjectLiteralExpression(e) && isCallArgs(e)) built.push(e)
          ts.forEachChild(e, collect)
        }
        const argsInit = (e: ts.Node) => {
          if (ts.isVariableDeclaration(e) && ts.isIdentifier(e.name) && e.name.text === 'args' && e.initializer) collect(e.initializer)
          ts.forEachChild(e, argsInit)
        }
        argsInit(fn)
        add(n, built.length ? built : null)
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

/** The JS twin's `walnut` (daemon-source.ts, text inside a template): each `op = 'tools.call';` and the `args = {...};` it sends. */
function twinSenders(): Sender[] {
  const rel = 'src/providers/daemon-source.ts'
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  const out: Sender[] = []
  const marks = [...text.matchAll(/\bop = 'tools\.call';/g)].map((m) => m.index!)
  marks.forEach((at, k) => {
    // Up to the next choice of op, or the frame that sends it.
    const end = Math.min(marks[k + 1] ?? text.length, text.indexOf('var sockPath', at) >>> 0)
    const span = text.slice(at, end)
    // Only a call's arguments (the op and its own: isCallArgs); `args = {}` and `{ name }` are a tools.list's.
    const objects = [...span.matchAll(/\bargs = (\{[\s\S]*?\});/g)].map((m) => m[1]).filter((o) => /\bname:/.test(o) && /\bargs(File)?:/.test(o))
    out.push({
      file: rel, line: text.slice(0, at).split('\n').length, fn: 'daemon-source walnut',
      clients: objects.length ? objects.map((o) => /\bclient: ('[a-z]+')/.exec(o)?.[1] ?? null) : [null],
    })
  })
  // A frame written out in the twin ({ v: 1, op: 'tools.call', sid: sid, args: { ... } }) names its client on its line.
  for (const m of text.matchAll(/\bop: ['"]tools\.call['"][^\n]*/g)) {
    out.push({ file: rel, line: text.slice(0, m.index).split('\n').length, fn: 'daemon-source frame', clients: [/\bclient: ('[a-z]+')/.exec(m[0])?.[1] ?? null] })
  }
  return out
}

const senders = walk(SRC)
  .filter((f) => fs.readFileSync(f, 'utf8').includes('tools.call') && !f.endsWith('daemon-source.ts'))
  .flatMap(sendersIn)
  .concat(twinSenders())

describe('every gateway tools.call names its client', () => {
  it('finds the senders it guards (wn-cli, its JS twin, the MCP server, plugin jobs, a check\'s fault report)', () => {
    const files = new Set(senders.map((s) => s.file))
    for (const f of ['src/providers/wn-cli.ts', 'src/providers/daemon-source.ts', 'src/providers/walnut-mcp-stdio.ts', 'src/providers/plugin-job-harness.ts', 'src/commands/tools-daemon-fallback.ts']) expect([...files]).toContain(f)
    expect(senders.length).toBeGreaterThanOrEqual(14)
  })

  it('each one names cli, mcp or a program, never none (a program left nameless reads a cut answer)', () => {
    const nameless = senders.filter((s) => s.clients.some((c) => c === null || !CLIENTS.has(c)))
      .map((s) => `${s.file}:${s.line} (${s.fn}): ${JSON.stringify(s.clients)}`)
    expect(nameless, 'name the client: PROGRAM_CLIENT when the code reads the answer, \'cli\' or \'mcp\' when it prints it to an agent').toEqual([])
  })

  it('in wn-cli.ts every sender but the print paths is a program: approve, pass, browser, wait, trigger-check', () => {
    const wn = senders.filter((s) => s.file === 'src/providers/wn-cli.ts')
    const programs = wn.filter((s) => !WN_CLI_PRINTERS.has(s.fn))
    expect(programs.map((s) => s.fn)).toEqual(expect.arrayContaining(['gatewayOpCall', 'runWait', 'runWaitMany', 'recordCardedCall', 'runTriggerCheckViaGateway']))
    for (const s of programs) expect(s.clients, `${s.file}:${s.line} (${s.fn})`).toEqual(s.clients.map(() => 'PROGRAM_CLIENT'))
    // Every shared loop goes through gatewayOpCall, the program sender.
    const text = fs.readFileSync(path.join(ROOT, 'src/providers/wn-cli.ts'), 'utf8')
    const loops = [...text.matchAll(/^async function (run[A-Za-z]+ViaGateway)\(/gm)].map((m) => m[1])
    expect(loops).toEqual(expect.arrayContaining(['runPassViaGateway', 'runBrowserViaGateway', 'runApproveViaGateway']))
    for (const loop of loops.filter((l) => l !== 'runTriggerCheckViaGateway')) {
      const body = text.slice(text.indexOf(`async function ${loop}(`), text.indexOf('\n}\n', text.indexOf(`async function ${loop}(`)))
      expect(body, loop).toContain('gatewayOpCall(')
    }
  })

  it('the JS twin\'s wait is a program and its tools call and guide print', () => {
    const twin = senders.filter((s) => s.file === 'src/providers/daemon-source.ts').flatMap((s) => s.clients)
    expect(twin).toEqual(expect.arrayContaining([`'program'`, `'cli'`]))
  })
})

describe('on the Mac a program reads executeOp whole', () => {
  it('only the print paths pass forAgent (src/commands)', () => {
    const dir = path.join(SRC, 'commands')
    const shaping = walk(dir).filter((f) => /\bforAgent\b/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f)).sort()
    expect(shaping).toEqual(['src/commands/guide.ts', 'src/commands/tools.ts'])
  })
})

describe('the gateways shape nothing for a program', () => {
  it('agentSurfaceOf: a program none; an agent its surface; a client naming none the CLI\'s', () => {
    expect(agentSurfaceOf(PROGRAM_CLIENT)).toBeUndefined()
    expect(agentSurfaceOf('mcp')).toBe('mcp')
    expect(agentSurfaceOf('cli')).toBe('cli')
    expect(agentSurfaceOf(undefined)).toBe('cli')
  })

  it('the Mac\'s gateway runs a program\'s call with no forAgent, an agent\'s with its surface', async () => {
    vi.resetModules()
    const seen: unknown[] = []
    vi.doMock('../../../src/ops/index.js', async (orig) => {
      const real = await orig<typeof import('../../../src/ops/index.js')>()
      return { ...real, executeOp: async (_n: string, _a: unknown, o: { forAgent?: unknown }) => { seen.push(o.forAgent); return { ok: true, result: {} } } }
    })
    try {
      const { handleGatewayCapability } = await import('../../../src/core/peers/capability-router.js')
      const { PeerThrottle } = await import('../../../src/core/peers/peer-throttle.js')
      const sid = 'a1b2c3d4-1111-2222-3333-444455556666'
      for (const client of [PROGRAM_CLIENT, 'cli', 'mcp', undefined]) {
        const r = await handleGatewayCapability('tools.call', sid, { name: 'task_get', args: { id: 'abc' }, ...(client ? { client } : {}) }, 'devbox', { throttle: new PeerThrottle(), cloudMode: false })
        expect(r, String(client)).toMatchObject({ ok: true })
      }
      expect(seen).toEqual([undefined, 'cli', 'mcp', 'cli'])
    } finally {
      vi.doUnmock('../../../src/ops/index.js')
      vi.resetModules()
    }
  })

  it('a program\'s whole answer is never counted as over an agent\'s limit', () => {
    expect(isToolClient(PROGRAM_CLIENT)).toBe(true)
    expect(answerSize({ text: 'x'.repeat(100_000) }, PROGRAM_CLIENT)).toMatchObject({ overLimit: false })
  })
})

describe('why: the approve loop cannot check a single-use ask from a cut answer', () => {
  it('approval_request\'s answer shaped for an agent loses the envelope the loop checks', async () => {
    const { getOp } = await import('../../../src/ops/index.js')
    // What cli-core.ts reads from the detail: the envelope's own context.
    const envelopeOf = (d: unknown): { context?: string } | null => { try { return typeof d === 'string' ? JSON.parse(d) : null } catch { return null } }
    // The sizes of apr-kCUkpVWwmbBH's record: a Git gate's context of about 950 characters, a summary and a why.
    const context = JSON.stringify({ repo: '/work/repo', argv: ['git', 'push', 'origin', 'main'], sha: 'ab'.repeat(20), refs: 'refs/heads/main '.repeat(50) })
    const detail = JSON.stringify({ version: 'walnut-single-use-v1', sessionId: 's-1', taskId: 't-1', host: 'devbox', nonce: 'a'.repeat(64), context,
      why: 'Push the Slack fix the task made to its own branch, as the user asked.', context_summary: 'One push of one commit. '.repeat(15) })
    expect(detail.length).toBeGreaterThan(1_500)
    const whole = { approval: { id: 'apr-1', status: 'pending', what: 'Allow one Git push?', mode: 'tap', singleUse: true, detail, digest: 'd'.repeat(64),
      requester: { host: 'devbox', taskId: 't-1', sessionId: 's-1' }, createdAt: 'a', expiresAt: 'b' }, waitToken: 'tok' }
    const shaped = agentAnswer(getOp('approval_request')!, {}, whole, false, 'cli') as { approval?: { detail?: string } }
    expect(envelopeOf(whole.approval.detail)?.context).toBe(context)
    expect(envelopeOf(shaped.approval?.detail)).toBeNull()
  })
})
