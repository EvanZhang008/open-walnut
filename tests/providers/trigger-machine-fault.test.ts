/**
 * A trigger check that failed because of the machine (a full disk, no server, a host's link down)
 * is told apart from one whose script failed, by the answers its `walnut` calls got, never by the
 * words of an error (trigger-check-core.ts machineFaultOf).
 *
 * 2026-11-16 11:36Z: the Mac's data disk reached 99%, the API answered 507, and nine triggers'
 * checks failed at once; each woke its task's session and counted toward the five failures that
 * stop a trigger. Covered here:
 * - every machine fault kind has an answer that produces it, and a new kind with none fails
 *   (the class guard);
 * - the answers the server's own producers send (the disk guard's 507, the link failure answer,
 *   the needs-leader refusal) go through the real executor and gateway relay and come out as
 *   their kind; a route's own 503 and every other failure stay the script's;
 * - a run remembers the fault of its last answer (a later real answer clears it), after its
 *   release too, and only its own;
 * - a machine fault leaves the trigger's count, cursor and unseen items alone, so the next good
 *   check reports what came in meanwhile.
 */
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

vi.mock('../../src/core/disk-watermark.js', () => ({
  isDiskWriteBlocked: () => true,
  getDiskWatermarkState: () => ({ usedPct: 99 }),
}))

import {
  API_CODE_FAULT, CHECK_FAULT_OP, GATEWAY_CODE_FAULT, MACHINE_FAULT_KINDS, applyCheckError, applyCheckOutcome, applyMachineFault,
  apiAnswerFault, checkGatewayCall, createCheckCallers, decideCheck, emptyHostState, isMachineFaultKind, machineFaultOf, opOutcomeFault,
  type MachineFaultKind, type TriggerDef,
} from '../../src/providers/trigger-check-core.js'
import { gatewayApiAnswerOf, gatewayErrorReplyFields, type GatewayResponse } from '../../src/providers/gateway-core.js'
import { handleGatewayCapability } from '../../src/core/peers/capability-router.js'
import { PeerThrottle } from '../../src/core/peers/peer-throttle.js'
import { diskGuardMiddleware } from '../../src/web/middleware/disk-guard.js'
import { linkFailureAnswer } from '../../src/web/middleware/link-failure-answer.js'
import { LINK_FAILURE_KINDS, markLinkFailure } from '../../src/providers/link-failure.js'
import { needsLeaderBody } from '../../src/core/replication/needs-leader.js'

const fail = (code: string, api?: { status: number; code?: string }): GatewayResponse =>
  ({ ok: false, error: { code: code as never, message: 'x', ...(api ? { api } : {}) } })

/** One answer per kind that the kind comes from. A new kind fails the guard below until it has one. */
const PRODUCES: Record<MachineFaultKind, GatewayResponse[]> = {
  disk_full: [fail('internal', { status: 507, code: 'disk_full' }), fail('internal', { status: 507 })],
  server_away: [fail('hub_unreachable'), fail('internal', { status: 503, code: 'needs_leader' }), fail('internal', { status: 503, code: 'primary_unreachable' })],
  host_offline: [
    fail('internal', { status: 503, code: 'host_reconnecting' }), fail('internal', { status: 504, code: 'host_no_answer' }),
    fail('internal', { status: 503, code: 'bridge_offline' }),
  ],
}

/** The script's own trouble: never a machine fault. */
const SCRIPT_ERRORS: Array<[string, unknown]> = [
  ['an ok answer', { ok: true, result: {} }],
  ['the op refused, no status', fail('internal')],
  ['a bad request', fail('bad_request', { status: 400, code: 'bad_request' })],
  ['throttled', fail('throttled')],
  ['one slow op (hub_timeout)', fail('hub_timeout')],
  ['not found', fail('internal', { status: 404, code: 'not_found' })],
  ['a server bug', fail('internal', { status: 500 })],
  ['a route\'s own 503', fail('internal', { status: 503, code: 'vault_not_here' })],
  ['a 503 with no code', fail('internal', { status: 503 })],
  ['a link code at a status no link failure answers with', fail('internal', { status: 400, code: 'host_reconnecting' })],
  ['an unknown gateway code', fail('made_up_code')],
  ['garbage', 'not an answer'],
  ['null', null],
]

describe('machine fault kinds (class guard)', () => {
  it('every kind has an answer that produces it, and every answer produces its kind', () => {
    for (const kind of MACHINE_FAULT_KINDS) {
      expect(PRODUCES[kind], `no answer produces "${kind}": add its source to machineFaultOf and an answer here`).toBeDefined()
      expect(PRODUCES[kind].length).toBeGreaterThan(0)
      for (const resp of PRODUCES[kind]) expect(machineFaultOf(resp), JSON.stringify(resp)).toBe(kind)
    }
    expect(Object.keys(PRODUCES).sort()).toEqual([...MACHINE_FAULT_KINDS].sort())
  })

  it('every mapping names a known kind, and every kind is reachable from one', () => {
    const named = [...Object.values(GATEWAY_CODE_FAULT).filter((k): k is MachineFaultKind => k !== null), ...Object.values(API_CODE_FAULT), apiAnswerFault(507, undefined)!]
    for (const kind of named) expect(isMachineFaultKind(kind), kind).toBe(true)
    for (const kind of MACHINE_FAULT_KINDS) expect(named, `nothing maps to "${kind}"`).toContain(kind)
  })

  it.each(SCRIPT_ERRORS)('%s is the script\'s, not the machine\'s', (_label, resp) => {
    expect(machineFaultOf(resp)).toBeNull()
  })

  it('reads only the structured fields, never the words', () => {
    // The incident's own words, with no status beside them: an older server's answer stays the script's.
    expect(machineFaultOf({ ok: false, error: { code: 'internal', message: 'Walnut API error (507): Data disk is critically full (99% used)' } })).toBeNull()
  })
})

describe('the server\'s own answers come out as their kind', () => {
  /** What the real producer answers, as a fetch Response the executor reads. */
  function produced(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }
  async function viaRelay(answer: Response): Promise<GatewayResponse> {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer)
    try {
      const out = await handleGatewayCapability('tools.call', 'external',
        { name: 'trigger_template_check', args: { template: 'mail:new-mail', params: {}, input: { state: null, lastFireAt: null, now: new Date(0).toISOString() } } },
        'devbox', { throttle: new PeerThrottle(), cloudMode: false })
      // The reply the server's relay sends (gateway-result), over the wire, and what the daemon builds from it.
      if (out.ok) return out
      const reply = JSON.parse(JSON.stringify(gatewayErrorReplyFields(out.error))) as Record<string, unknown>
      const api = gatewayApiAnswerOf(reply.api)
      return { ok: false, error: { code: reply.errorCode as never, message: String(reply.error), ...(api ? { api } : {}) } }
    } finally { fetcher.mockRestore() }
  }

  it('the disk guard\'s 507 is disk_full', async () => {
    let status = 0
    let body: unknown
    const res = { status(s: number) { status = s; return this }, json(b: unknown) { body = b; return this } }
    diskGuardMiddleware({ method: 'POST', path: '/v1/trigger-templates/mail%3Anew-mail/check' } as never, res as never, () => { throw new Error('the guard let a write through') })
    expect(status).toBe(507)
    const resp = await viaRelay(produced(status, body))
    expect(resp).toMatchObject({ ok: false, error: { code: 'internal', api: { status: 507, code: 'disk_full' } } })
    expect(machineFaultOf(resp)).toBe('disk_full')
  })

  it.each([...LINK_FAILURE_KINDS])('a host link failure (%s) is host_offline, for a read and for a write', async (kind) => {
    for (const method of ['GET', 'POST']) {
      const a = linkFailureAnswer(markLinkFailure(new Error('link'), kind), method)!
      expect(a).not.toBeNull()
      const resp = await viaRelay(produced(a.status, { error: a.message, code: a.code }))
      expect(machineFaultOf(resp), `${kind} ${method} → ${a.status} ${a.code}`).toBe('host_offline')
    }
  })

  it('the needs-leader refusal is server_away', async () => {
    const resp = await viaRelay(produced(503, needsLeaderBody('a write needs the leader')))
    expect(machineFaultOf(resp)).toBe('server_away')
  })

  it('a route\'s own refusal and a server bug stay the script\'s', async () => {
    expect(machineFaultOf(await viaRelay(produced(503, { error: 'Passwords are kept on your Mac.', code: 'vault_not_here' })))).toBeNull()
    expect(machineFaultOf(await viaRelay(produced(500, { error: 'boom' })))).toBeNull()
    expect(machineFaultOf(await viaRelay(produced(400, { error: { code: 'bad_request', message: 'bad params' } })))).toBeNull()
  })

  it('a relay reply\'s api is read only in its own shape', () => {
    expect(gatewayApiAnswerOf({ status: 507, code: 'disk_full' })).toEqual({ status: 507, code: 'disk_full' })
    expect(gatewayApiAnswerOf({ status: 503, code: 'Not A Code!' })).toEqual({ status: 503 })
    for (const bad of [null, 'x', { status: '507' }, { status: 99 }, { status: 600 }, { status: 507.5 }]) expect(gatewayApiAnswerOf(bad)).toBeUndefined()
  })
})

describe('a check run remembers its own fault', () => {
  it('its last answer\'s fault, still readable after its release; other runs and ended runs untouched', () => {
    let n = 0
    const callers = createCheckCallers(() => `t${++n}`)
    const a = callers.mint({ kind: 'armed', id: 'trg-a' })
    const b = callers.mint({ kind: 'armed', id: 'trg-b' })
    callers.noteAnswer(a.sid, { ok: true, result: {} })
    expect(a.fault()).toBeUndefined()
    callers.noteAnswer(a.sid, PRODUCES.server_away[0])
    callers.noteAnswer(a.sid, PRODUCES.disk_full[0])
    expect(a.fault()).toBe('disk_full')
    // A call that worked after it: whatever fails next is the script's own (a `|| true` that went on).
    callers.noteAnswer(a.sid, { ok: true, result: {} })
    expect(a.fault()).toBeUndefined()
    callers.noteAnswer(a.sid, PRODUCES.disk_full[0])
    expect(b.fault()).toBeUndefined()
    a.release()
    expect(a.fault()).toBe('disk_full')
    // A child the run left behind: its answer is nobody's now.
    callers.noteAnswer(a.sid, PRODUCES.host_offline[0])
    callers.noteAnswer('trigger-check:not-a-run', PRODUCES.disk_full[0])
    callers.noteAnswer(undefined, PRODUCES.disk_full[0])
    expect(b.fault()).toBeUndefined()
    expect(callers.resolve(a.sid)).toBeNull()
    expect(callers.resolve(b.sid)).toEqual({ kind: 'armed', id: 'trg-b' })
  })
})

describe('a fault the check\'s own CLI met over HTTP', () => {
  it('the executor\'s outcome names its fault by status, code and transport', () => {
    expect(opOutcomeFault({ ok: false, status: 507, code: 'disk_full' })).toBe('disk_full')
    expect(opOutcomeFault({ ok: false, unreachable: true })).toBe('server_away')
    // A lost answer is one slow op as often as a stuck server: the check's own to hear about.
    expect(opOutcomeFault({ ok: false, lost: true } as never)).toBeNull()
    expect(opOutcomeFault({ ok: false, status: 503, code: 'host_reconnecting' })).toBe('host_offline')
    expect(opOutcomeFault({ ok: false, status: 404, code: 'not_found' })).toBeNull()
    expect(opOutcomeFault({ ok: false })).toBeNull()
    expect(opOutcomeFault({ ok: true, status: 507 })).toBeNull()
  })

  it('its report is answered by the daemon, never relayed, and marks only a known kind', () => {
    const caller = { kind: 'armed' as const, id: 'trg-a' }
    expect(checkGatewayCall('tools.call', { name: CHECK_FAULT_OP, args: { kind: 'disk_full' } }, caller)).toEqual({ local: true, fault: 'disk_full' })
    expect(checkGatewayCall('tools.call', { name: CHECK_FAULT_OP, args: { kind: 'nonsense' } }, caller)).toEqual({ local: true })
    expect(checkGatewayCall('tools.call', { name: CHECK_FAULT_OP, args: { kind: null } }, caller)).toEqual({ local: true, fault: null })
    expect(checkGatewayCall('tools.call', { name: CHECK_FAULT_OP }, null)).toEqual({ local: true })
    const callers = createCheckCallers(() => 'x')
    const run = callers.mint(caller)
    callers.noteFault(run.sid, 'host_offline')
    expect(run.fault()).toBe('host_offline')
    callers.noteFault(run.sid, 'bogus' as never)
    expect(run.fault()).toBe('host_offline')
    // A later HTTP call that got a real answer clears it.
    callers.noteFault(run.sid, null)
    expect(run.fault()).toBeUndefined()
  })
})

describe('a machine fault loses nothing', () => {
  const def: TriggerDef = { id: 'trg-mail', name: 'Mail', everyMs: 60_000, check: { run: 'true' } } as TriggerDef

  it('no strike, no cursor move, and the next good check reports what came in meanwhile', () => {
    const t0 = Date.UTC(2026, 10, 16, 11, 0)
    const state = emptyHostState(t0)
    // A good check sees one mail and moves the cursor.
    const first = applyCheckOutcome(state, { fire: true, items: [{ id: 'm1', title: 'one' }], state: { cursor: 1 }, hasState: true } as never,
      decideCheck(def, { fire: true, items: [{ id: 'm1', title: 'one' }] } as never, state, t0), t0, 10)
    expect(first?.items.map((i) => i.id)).toEqual(['m1'])
    const seenBefore = JSON.stringify(state.seen)

    // Ten failed checks the machine caused: nothing counted, nothing moved.
    for (let i = 1; i <= 10; i++) applyMachineFault(state, t0 + i * 60_000)
    expect(state.consecutiveErrors).toBe(0)
    expect(state.state).toEqual({ cursor: 1 })
    expect(JSON.stringify(state.seen)).toBe(seenBefore)
    expect(state.lastRunAtMs).toBe(t0 + 10 * 60_000)

    // Back: the mail that came while the disk was full fires.
    const back = t0 + 11 * 60_000
    const output = { fire: true, items: [{ id: 'm1', title: 'one' }, { id: 'm2', title: 'two' }], state: { cursor: 2 }, hasState: true } as never
    const fire = applyCheckOutcome(state, output, decideCheck(def, output, state, back), back, 10)
    expect(fire?.items.map((i) => i.id)).toEqual(['m2'])
  })

  it('a script error still counts', () => {
    const state = emptyHostState(0)
    applyCheckError(state, 1)
    applyMachineFault(state, 2)
    applyCheckError(state, 3)
    expect(state.consecutiveErrors).toBe(2)
  })
})

describe('every server that answers a host relays the API\'s answer', () => {
  it('the Mac\'s relay and the companion\'s build their error reply with gatewayErrorReplyFields', () => {
    const root = path.resolve(__dirname, '../..')
    for (const file of ['src/providers/daemon-connection.ts', 'src/core/leader/backup-gateway.ts']) {
      const src = fs.readFileSync(path.join(root, file), 'utf8')
      expect(src, file).toContain('gatewayErrorReplyFields(')
      // A hand-built reply would drop `api` again.
      expect(src, file).not.toMatch(/error:\s*(outcome\.error|out)\.message,\s*errorCode:/)
    }
  })
})
