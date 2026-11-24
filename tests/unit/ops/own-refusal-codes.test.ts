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
import { LOCAL_ONLY_CODE, SHORTENED_TEXT_CODE, ownRefusal } from '../../../src/ops/own-refusal.js'
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
    const known = /message: `Invalid arguments for|message: `Unknown op:|notRunningMessage\(|message: `Walnut request|API_ERROR_OPENING|^ok: false, message, result|message: err instanceof Error|\$\{outcome\.message\}/
    expect(literals.length).toBeGreaterThan(10)
    expect(literals.filter((l) => !known.test(l))).toEqual([])
  })

  it('ratchet: a handler op refuses a shortened read under its code, never with a bare Error', () => {
    const dir = new URL('../../../src/ops/', import.meta.url)
    const bare = fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).flatMap((f) =>
      fs.readFileSync(new URL(f, dir), 'utf8').split('\n').map((line, i) => ({ at: `${f}:${i + 1}`, line })))
      .filter(({ line }) => /throw new Error\(/.test(line) && /refused|shortened|part of a longer document/i.test(line))
      .map(({ at }) => at)
    expect(bare).toEqual([])
  })
})
