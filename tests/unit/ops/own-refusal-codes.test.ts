/**
 * A refusal the op executor writes itself (before any request goes out) reaches every client under
 * its own code: the CLI's error code (tool-call-output.ts), the MCP text, and real use's count of
 * failed calls from what sessions read (usage-watch/normalize.ts toolErrorCode).
 *
 * 2026-11-24: the failed-call report counted 68 failures in a day as `bad_request`, the hub's
 * catch-all for an op's own refusal; most were reply-language refusals whose code only the hub's own
 * record kept. Each member of the class is checked through executeOp, and a ratchet keeps a new one
 * from writing its code bare.
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BAD_INPUT_CODE, LOCAL_ONLY_CODE, SHORTENED_TEXT_CODE, badInput, ownRefusal, reworded } from '../../../src/ops/own-refusal.js'
import { executeOp } from '../../../src/ops/index.js'
import { handleGatewayCapability } from '../../../src/core/peers/capability-router.js'
import { PeerThrottle } from '../../../src/core/peers/peer-throttle.js'
import { hostOrigin } from '../../../src/lib/caller-origin.js'
import { cutMark } from '../../../src/ops/answer.js'
import { gatewayFailureCode, opFailureCode } from '../../../src/providers/tool-call-output.js'
import { toolErrorCode } from '../../../src/core/usage-watch/normalize.js'
import { REPLY_LANGUAGE_CODE } from '../../../src/ops/reply-language-gate.js'

/** The code each client names for a failed op answer with this message (the hub's catch-all around it). */
function clientCodes(message: string, hubCode: 'bad_request' | 'internal') {
  const cli = gatewayFailureCode(hubCode, message)
  return {
    cli,
    cliRead: toolErrorCode(JSON.stringify({ ok: false, error: { code: cli, message } })),
    mcpRead: toolErrorCode(`walnut: ${hubCode}: ${message}`),
  }
}

describe('an executor refusal is read by its code everywhere', () => {
  it('the opening carries the code for the CLI, the MCP text and the failed-call count', () => {
    for (const code of [LOCAL_ONLY_CODE, SHORTENED_TEXT_CODE, REPLY_LANGUAGE_CODE]) {
      const r = ownRefusal(code, 'Nothing ran.', {})
      expect(r).toMatchObject({ ok: false, code })
      expect(opFailureCode(r.message)).toBe(code)
      for (const hub of ['bad_request', 'internal'] as const) expect(clientCodes(r.message, hub)).toEqual({ cli: code, cliRead: code, mcpRead: code })
    }
  })

  it('local_only: an op a host may not run', async () => {
    const r = await executeOp('health_status', {}, { origin: hostOrigin('remote-dev') })
    expect(r).toMatchObject({ ok: false, status: 403, code: LOCAL_ONLY_CODE })
    expect(r.ok ? null : clientCodes(r.message, 'internal').cli).toBe(LOCAL_ONLY_CODE)
  })

  it('shortened_text: a shortened read written back', async () => {
    const r = await executeOp('task_note_write', { id: 'mtaskaaa-0001', content: `Kept part.\n${cutMark(4_000)}` }, { origin: hostOrigin('remote-dev'), apiBase: 'http://127.0.0.1:9/api' })
    expect(r).toMatchObject({ ok: false, invalidArgs: true, code: SHORTENED_TEXT_CODE })
    expect(r.ok ? null : clientCodes(r.message, 'bad_request')).toEqual({ cli: SHORTENED_TEXT_CODE, cliRead: SHORTENED_TEXT_CODE, mcpRead: SHORTENED_TEXT_CODE })
  })

  it('local_only: the hub\'s gateway refusing a host an op of this Mac only', async () => {
    const r = await handleGatewayCapability('tools.call', '5f1c2a77-0b2e-4d43-9c55-2f6ad3e0c1ab', { name: 'health_status', args: {}, client: 'cli' }, 'remote-dev', { throttle: new PeerThrottle(), cloudMode: false })
    expect(r.ok).toBe(false)
    if (r.ok) return
    // The code older CLIs read stays; the API's answer and the message name the refusal.
    expect(r.error).toMatchObject({ code: 'bad_request', api: { status: 403, code: LOCAL_ONLY_CODE } })
    expect(clientCodes(r.error.message, 'bad_request')).toEqual({ cli: LOCAL_ONLY_CODE, cliRead: LOCAL_ONLY_CODE, mcpRead: LOCAL_ONLY_CODE })
  })

  it('shortened_text: an `api` write and a board_set of a shortened read', async () => {
    const cut = `Kept part.\n${cutMark(4_000)}`
    const viaApi = await executeOp('api', { method: 'PUT', path: '/api/tasks/mtaskaaa-0001/note', body: { content: cut } }, { origin: hostOrigin('remote-dev'), apiBase: 'http://127.0.0.1:9/api' })
    expect(viaApi).toMatchObject({ ok: false, invalidArgs: true, code: SHORTENED_TEXT_CODE })
    expect(viaApi.ok ? null : clientCodes(viaApi.message, 'bad_request').cli).toBe(SHORTENED_TEXT_CODE)
    const page = '<p>One part.</p>\n[Walnut: this is part of a longer document, 9000 more characters]'
    const board = await executeOp('board_set', { task: 'mtaskaaa-0001', html: page }, { origin: hostOrigin('remote-dev'), apiBase: 'http://127.0.0.1:9/api' })
    expect(board).toMatchObject({ ok: false, invalidArgs: true, code: SHORTENED_TEXT_CODE })
  })

  it('ratchet: every failure the executor writes is a known kind or names its code', () => {
    const src = fs.readFileSync(new URL('../../../src/ops/executor.ts', import.meta.url), 'utf8')
    // Each failure literal (`ok: false,` outside a type or a comment) with what follows it: up to the
    // next one, at most 400 characters.
    const code = src.split('\n').filter((l) => !/^\s*(?:\*|\/\/|\/\*)/.test(l)).join('\n')
    const starts = [...code.matchAll(/\bok: false,/g)].map((m) => m.index!)
    const literals = starts.map((at, i) => code.slice(at, Math.min(at + 400, starts[i + 1] ?? Infinity)))
    // A known kind: a bad argument (Invalid arguments, Unknown op), no answer (Walnut request ...,
    // the server not running), the API's own answer, or a message the op itself gave (its result's,
    // its throw's): each already names what it is. Anything else is a refusal of the executor's own.
    // A handler's refusal it came to with no server answering is answered as unreachable, in its own words.
    const known = /message: `Invalid arguments for|message: `Unknown op:|notRunningMessage\(|message: `Walnut request|API_ERROR_OPENING|^ok: false, message, result|message: err instanceof Error|message: own\.message, code: own\.code|message: own\.words, unreachable: true|\$\{outcome\.message\}/
    expect(literals.length).toBeGreaterThan(10)
    expect(literals.filter((l) => !known.test(l))).toEqual([])
  })

  it('ratchet: a handler op refuses under a code (badInput, OwnRefusalError); a bare Error is a fault on this list', () => {
    // A bare `throw new Error` in an op's handler reaches every client as `internal` and real use as
    // a thrown error, the server's own fault. What a handler refuses (an argument, an id that names
    // nothing, a state) throws badInput(...) or an OwnRefusalError with its code. Only an answer of
    // Walnut's own that came back broken, or an op defined wrong, stays a bare Error, listed here
    // with its count: a new one fails this test until it is a coded refusal or is added with why.
    const FAULTS: Record<string, number> = {
      'core.ts': 2, // a note reference resolved with no path; note_read: an answer of the API that is not a note
      'executor.ts': 1, // a path argument left out: caught there and answered as invalid arguments
      'human-action-policy.ts': 1, // the server has no listening address
      'registry.ts': 3, // an op defined wrong, at start
      'task-execution.ts': 1, // a start answered with no task
      'task-lifecycle.ts': 1, // a task read answered with no id
      'tasks.ts': 2, // a task read or a create answered with no task
      'work.ts': 3, // a task or transcript read answered incomplete
    }
    const dir = new URL('../../../src/ops/', import.meta.url)
    const says = /Walnut API error \(|nothing (?:was|is) (?:written|sent|run|changed|stored|saved)|nothing ran|refused|shortened|part of a longer document|conflict:|changed since you read it/i
    const found: Record<string, number> = {}
    const refusals: string[] = []
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const src = fs.readFileSync(new URL(f, dir), 'utf8')
      const bare = [...src.matchAll(/throw (?:new )?Error\(/g)]
      if (bare.length) found[f] = bare.length
      // A listed fault never words itself as a refusal.
      for (const m of bare) {
        const after = src.slice(m.index! + m[0].length, m.index! + m[0].length + 400)
        const statement = after.slice(0, Math.max(0, after.indexOf(')\n')) || after.length)
        if (says.test(statement)) refusals.push(`${f}:${src.slice(0, m.index!).split('\n').length}`)
      }
    }
    expect(found).toEqual(FAULTS)
    expect(refusals).toEqual([])
  })

  it('a board op of a caller with no task: bad_input only when the server answered so; a server that did not answer is not the caller\'s', async () => {
    const { resolveBoardTask } = await import('../../../src/ops/boards.js')
    const failing = (status: number) => async () => { throw Object.assign(new Error(`HTTP ${status}`), { status }) }
    await expect(resolveBoardTask({}, failing(404) as never)).rejects.toMatchObject({ code: BAD_INPUT_CODE })
    await expect(resolveBoardTask({}, (async () => ({})) as never)).rejects.toMatchObject({ code: BAD_INPUT_CODE })
    const down = await resolveBoardTask({}, failing(503) as never).then(() => null, (e: unknown) => e as { code?: string; status?: number })
    expect(down).toMatchObject({ status: 503 })
    expect(down?.code).not.toBe(BAD_INPUT_CODE)
  })

  it('bad_input: a handler refusing its arguments is a bad argument everywhere, never a thrown error', async () => {
    const { failureClass } = await import('../../../src/core/usage-watch/normalize.js')
    // 2026-11-25: merge_into with another field was a bare Error, four `internal` failures in a day.
    const r = await executeOp('thread_update', { task: 'mtaskaaa-0001', id: 'th-0123456789ab', merge_into: 'th-ba9876543210', state: 'working' }, { origin: hostOrigin('remote-dev'), apiBase: 'http://127.0.0.1:9/api' })
    expect(r).toMatchObject({ ok: false, invalidArgs: true, code: BAD_INPUT_CODE })
    if (r.ok) return
    expect(r.message).toContain('merge_into goes alone')
    expect(r.message).toContain('thread_update {"id":"th-0123456789ab","merge_into":"th-ba9876543210"}')
    expect(failureClass(r as never)).toEqual({ cls: 'bad_args', code: BAD_INPUT_CODE })
    expect(clientCodes(r.message, 'bad_request')).toEqual({ cli: BAD_INPUT_CODE, cliRead: BAD_INPUT_CODE, mcpRead: BAD_INPUT_CODE })
    // An argument that says nothing to change: the same class on another op.
    const none = await executeOp('task_update', { id: 'mtaskaaa-0001' }, { origin: hostOrigin('remote-dev'), apiBase: 'http://127.0.0.1:9/api' })
    expect(none).toMatchObject({ ok: false, invalidArgs: true, code: BAD_INPUT_CODE })
  })

  it('a plugin op that refuses with a status and a code reads that code; its bare Error is still a fault', async () => {
    const { failureClass } = await import('../../../src/core/usage-watch/normalize.js')
    const { definePluginOp } = await import('../../../src/ops/index.js')
    const { z } = await import('zod')
    // What a plugin's handler throws (src/lib/coded-refusal.ts): any error with a status and a code.
    const op = definePluginOp('garden-plugin', {
      name: 'garden_plugin_water', title: 'Water a bed', description: 'Waters one bed of the garden.',
      input: { bed: z.string() },
      handler: async (args) => {
        if (args.bed === 'closed') throw Object.assign(new Error('That bed is closed for the winter'), { status: 409, code: 'bed_closed' })
        if (args.bed === '') throw Object.assign(new Error('Name a bed'), { status: 400, code: 'bad_input' })
        throw new Error('the pump did not start')
      },
      tags: { readonly: true, remote: 'allow' },
    })
    try {
      const opts = { origin: hostOrigin('remote-dev'), apiBase: 'http://127.0.0.1:9' }
      const closed = await executeOp('garden_plugin_water', { bed: 'closed' }, opts)
      expect(closed).toMatchObject({ ok: false, status: 409, code: 'bed_closed' })
      if (closed.ok) return
      expect(closed.message).toContain('That bed is closed for the winter')
      expect(failureClass(closed as never)).toEqual({ cls: 'refused', code: 'bed_closed' })
      expect(clientCodes(closed.message, 'internal')).toEqual({ cli: 'bed_closed', cliRead: 'bed_closed', mcpRead: 'bed_closed' })
      const unnamed = await executeOp('garden_plugin_water', { bed: '' }, opts)
      expect(unnamed).toMatchObject({ ok: false, invalidArgs: true, code: BAD_INPUT_CODE })
      expect(failureClass(unnamed as never)).toEqual({ cls: 'bad_args', code: BAD_INPUT_CODE })
      const fault = await executeOp('garden_plugin_water', { bed: 'north' }, opts)
      expect(failureClass(fault as never)).toEqual({ cls: 'error', code: 'thrown' })
    } finally { await op.dispose() }
  })

  it('ratchet: a file that registers a plugin\'s ops holds no bare Error but the listed ones', () => {
    // The plugins this repository ships (the store, the examples, the built-in integrations): a
    // handler there refuses with a status and a code. A new bare Error fails until it is one.
    const LISTED: Record<string, [number, string]> = {
      'plugin-store/walnut-rhythm/src/server/ops.ts': [1, 'a replica\'s refusal: changed with the plugin\'s next build (its built file is committed)'],
      'src/integrations/calendar/index.ts': [1, 'a helper\'s own error text passed on: Walnut cannot tell whose it is'],
    }
    const root = new URL('../../../', import.meta.url)
    const walk = (dir: URL, out: string[] = []): string[] => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'dist') continue
        const at = new URL(e.name + (e.isDirectory() ? '/' : ''), dir)
        if (e.isDirectory()) walk(at, out)
        else if (/\.(?:ts|mjs|js)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(at.pathname)
      }
      return out
    }
    const files = ['plugin-store/', 'examples/plugins/', 'src/integrations/'].flatMap((d) => walk(new URL(d, root)))
    const found: Record<string, number> = {}
    let registering = 0
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8')
      if (!/\bregistry\.op\(/.test(src)) continue
      registering += 1
      const n = [...src.matchAll(/throw (?:new )?Error\(/g)].length
      if (n) found[file.slice(root.pathname.length)] = n
    }
    expect(registering).toBeGreaterThanOrEqual(5)
    expect(found).toEqual(Object.fromEntries(Object.entries(LISTED).map(([file, [n]]) => [file, n])))
  })

  it('a reworded refusal keeps its class, code and status', () => {
    class Coded extends Error { constructor(message: string, readonly status: number, readonly code: string) { super(message) } }
    const copy = reworded(new Coded('refused', 409, 'own_session'), 'refused (already applied: model)')
    expect(copy).toBeInstanceOf(Coded)
    expect(copy).toMatchObject({ message: 'refused (already applied: model)', status: 409, code: 'own_session' })
    // A refusal of an op's own keeps its code; its words alone follow the new message.
    expect(reworded(badInput('pass id'), 'pass id (see the list)')).toMatchObject({ code: BAD_INPUT_CODE, words: 'pass id (see the list)', extra: { invalidArgs: true } })
  })

  it('own_session and a memory write conflict: a 409 under its code, never a thrown error', async () => {
    const { failureClass } = await import('../../../src/core/usage-watch/normalize.js')
    const { OwnRefusalError } = await import('../../../src/ops/own-refusal.js')
    const e = new OwnRefusalError('own_session', 'A session cannot stop itself', { status: 409 })
    expect(opFailureCode(e.message)).toBe('own_session')
    expect(failureClass({ ok: false, message: e.message, code: e.code, ...e.extra } as never)).toEqual({ cls: 'refused', code: 'own_session' })
  })
})
