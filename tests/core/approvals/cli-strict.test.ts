/**
 * `walnut approve --single-use` and the ask-then-resume flow (--request-only / --approval):
 * the CLI checks the record itself (its digest, the envelope, that a person approved it, its
 * expiry), spends it once with approval_consume, and never exits 0 on a record it cannot check.
 * The person's answer is a tap on any device they are signed in on (2026-11-21): no key, no
 * signature. The server is a scripted io.call.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { APPROVE_EXIT, parseApproveArgv, runApprove, type ApproveArgs, type OpCallResult } from '../../../src/core/approvals/cli-core.js'
import { loadToken, removeToken, saveToken, sha256Hex, sweepTokens } from '../../../src/core/approvals/cli-token.js'
import { approvalDigest } from '../../../src/core/approvals/digest.js'

const DETAIL = 'kubectl apply -f prod.yaml\ncluster: prod-1\n'
const requester = { host: 'devbox', taskId: 't-1', sessionId: 's-1' }
const nonceA = 'a'.repeat(64)
const nonceB = 'b'.repeat(64)

type Rec = Record<string, any>

function envelope(over: Rec = {}): string {
  return JSON.stringify({ version: 'walnut-single-use-v1', sessionId: requester.sessionId, taskId: requester.taskId,
    host: requester.host, nonce: nonceA, context: DETAIL, ...over })
}

function withDigest(rec: Rec): Rec {
  return { ...rec, digest: approvalDigest({ id: rec.id, mode: rec.mode, createdAt: rec.createdAt, expiresAt: rec.expiresAt,
    host: rec.requester.host, taskId: rec.requester.taskId, what: rec.what, detail: rec.detail }) }
}

function pendingRec(over: Rec = {}): Rec {
  const createdAt = new Date().toISOString()
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString()
  return withDigest({ id: 'apr-abc_1', what: 'Deploy prod', detail: envelope(), mode: 'tap', createdAt, expiresAt,
    requester, status: 'pending', singleUse: true, ...over })
}

/** A person's tap, on the phone unless said otherwise. */
function approved(rec: Rec, device: Rec = { name: 'iPhone', kind: 'iphone' }): Rec {
  return { ...rec, status: 'approved', answer: { decision: 'approve', at: new Date().toISOString(), mode: 'tap', device } }
}

interface Fake { asked?: Rec; answered: Rec | (() => Rec); consume?: OpCallResult }

function server(f: Fake) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const asked = f.asked ?? pendingRec()
  const call = async (name: string, args: Record<string, unknown>): Promise<OpCallResult> => {
    calls.push({ name, args })
    const answered = typeof f.answered === 'function' ? f.answered() : f.answered
    if (name === 'approval_request') return { ok: true, result: { approval: asked, waitToken: 'tok-secret' } }
    if (name === 'approval_wait') return { ok: true, result: { approval: answered, used: false } }
    if (name === 'approval_consume') return f.consume ?? { ok: true, result: { approval: { ...answered, consumedAt: new Date().toISOString() }, used: true, outcome: 'used once' } }
    if (name === 'approval_cancel') return { ok: true, result: { approval: { ...asked, status: 'canceled' } } }
    return { ok: false, status: 400, code: 'unknown', message: name }
  }
  return { calls, call, names: () => calls.map((c) => c.name) }
}

let dir: string
let outs: string[]
let says: string[]
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approve-strict-'))
  outs = []
  says = []
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const io = (call: (n: string, a: Record<string, unknown>) => Promise<OpCallResult>, extra: Rec = {}) =>
  ({ call, say: (l: string) => { says.push(l) }, out: (l: string) => { outs.push(l) }, sleep: async () => undefined, tokenDir: dir, ...extra })

const strict: ApproveArgs = { what: 'Deploy prod', detail: DETAIL, timeoutMs: 300_000, json: true, singleUse: true }

describe('parsing the strict flags', () => {
  it('reads them, with a 5 minute default; an older script\'s --signing-key and --biometric change nothing', () => {
    expect(parseApproveArgv(['Deploy', '--single-use', '--detail', 'd.txt', '--why', 'ship the fix'])).toEqual({
      ok: true, what: 'Deploy', timeoutMs: 300_000, detailFrom: 'd.txt', json: false, why: 'ship the fix', singleUse: true,
    })
    expect(parseApproveArgv(['Deploy', '--single-use', '--biometric', '--signing-key', 'k.pem', '--signing-key=b.pem', '--detail', 'd.txt', '--why', 'ship the fix']))
      .toEqual(parseApproveArgv(['Deploy', '--single-use', '--detail', 'd.txt', '--why', 'ship the fix']))
    expect(parseApproveArgv(['x', '--request-only'])).toMatchObject({ ok: true, requestOnly: true })
    expect(parseApproveArgv(['x', '--approval=apr-Ab3_x-9'])).toMatchObject({ ok: true, approvalId: 'apr-Ab3_x-9' })
  })

  it('refuses a strict ask it cannot honour', () => {
    expect(parseApproveArgv(['x', '--single-use'])).toMatchObject({ ok: false, error: expect.stringContaining('--detail') })
    expect(parseApproveArgv(['x', '--single-use', '--detail', 'd', '--timeout', '10m'])).toMatchObject({ ok: false })
    expect(parseApproveArgv(['x', '--signing-key', 'k'])).toMatchObject({ ok: false })
    expect(parseApproveArgv(['x', '--single-use', '--detail', 'd', '--signing-key'])).toMatchObject({ ok: false })
    expect(parseApproveArgv(['x', '--request-only', '--approval', 'apr-1'])).toMatchObject({ ok: false })
    expect(parseApproveArgv(['x', '--approval', '../apr-1'])).toMatchObject({ ok: false })
    expect(parseApproveArgv(['x', '--approval', 'apr-../x'])).toMatchObject({ ok: false })
    expect(parseApproveArgv(['x', '--why', 'two\nlines'])).toMatchObject({ ok: false })
  })
})

describe('single-use: wait, check, consume', () => {
  it('a tap from any signed-in device is consumed once and prints {approval, used:true}', async () => {
    for (const device of [{ name: 'iPhone', kind: 'iphone' }, { name: 'Mac', kind: 'mac-app' }, { name: 'Web console', kind: 'web' }]) {
      outs = []
      const rec = pendingRec()
      const s = server({ asked: rec, answered: approved(rec, device) })
      expect(await runApprove(strict, io(s.call))).toBe(APPROVE_EXIT.approved)
      expect(s.names()).toEqual(['approval_request', 'approval_wait', 'approval_consume'])
      expect(s.calls[0].args).toMatchObject({ single_use: true, detail: DETAIL })
      for (const k of ['mode', 'signing_key_id', 'signing_key_ids']) expect(s.calls[0].args).not.toHaveProperty(k)
      expect(s.calls[2].args).toEqual({ id: 'apr-abc_1', token: 'tok-secret', digest: rec.digest, detail: DETAIL })
      expect(outs).toHaveLength(1)
      const printed = JSON.parse(outs[0])
      expect(Object.keys(printed).sort()).toEqual(['approval', 'used'])
      expect(printed.used).toBe(true)
      expect(printed.approval.id).toBe('apr-abc_1')
    }
  })

  it('an older Walnut\'s record (Face ID, pinned keys) approved with a tap is checked by its own digest and consumed', async () => {
    const rec = pendingRec({ mode: 'biometric', signingKeyIds: ['ak-dcb776df2641b2ff', 'ak-e71d5e306b094f97'] })
    const s = server({ asked: rec, answered: approved(rec) })
    expect(await runApprove(strict, io(s.call))).toBe(APPROVE_EXIT.approved)
    expect(s.names()).toEqual(['approval_request', 'approval_wait', 'approval_consume'])
  })

  it('passes --why only when given', async () => {
    const s = server({ answered: approved(pendingRec()) })
    await runApprove({ ...strict, why: 'hotfix' }, io(s.call))
    expect(s.calls[0].args.why).toBe('hotfix')
    const t = server({ answered: approved(pendingRec()) })
    await runApprove(strict, io(t.call))
    expect('why' in t.calls[0].args).toBe(false)
  })

  const refused: Array<[string, () => Rec]> = [
    ['a tampered what (digest mismatch)', () => ({ ...approved(pendingRec()), what: 'Deploy staging' })],
    ['an envelope around other detail', () => approved(withDigest({ ...pendingRec(), detail: envelope({ context: 'rm -rf /' }) }))],
    ['an envelope that names another session', () => approved(withDigest({ ...pendingRec(), detail: envelope({ sessionId: 's-other' }) }))],
    ['a record that is not single-use', () => approved(pendingRec({ singleUse: false }))],
    ['the switch\'s own go-ahead, not a person', () => approved(pendingRec(), { name: 'Approvals off', kind: 'setting' })],
    ['an approved status with a deny answer', () => ({ ...approved(pendingRec()), answer: { decision: 'deny', at: 'now', mode: 'tap', device: { name: 'x', kind: 'web' } } })],
  ]
  for (const [name, answered] of refused) {
    it(`exits 3 and never consumes on ${name}`, async () => {
      const s = server({ answered })
      expect(await runApprove(strict, io(s.call))).toBe(APPROVE_EXIT.error)
      expect(s.names()).not.toContain('approval_consume')
      expect(outs).toEqual([])
    })
  }

  it('exits 3 on an answer that expired by the time it is checked', async () => {
    const rec = approved(pendingRec())
    const s = server({ answered: rec })
    const late = Date.parse(rec.expiresAt) + 1
    expect(await runApprove(strict, io(s.call, { now: () => late }))).toBe(APPROVE_EXIT.error)
    expect(s.names()).not.toContain('approval_consume')
  })

  it('a consume refused with 409 is exit 3, not 2', async () => {
    const s = server({ answered: approved(pendingRec()), consume: { ok: false, status: 409, code: 'approval_used', message: 'used' } })
    expect(await runApprove(strict, io(s.call))).toBe(APPROVE_EXIT.error)
    expect(outs).toEqual([])
  })

  it('a consume whose answer was lost is exit 3, with no retry', async () => {
    const s = server({ answered: approved(pendingRec()), consume: { ok: false, message: 'hub_timeout' } })
    expect(await runApprove(strict, io(s.call))).toBe(APPROVE_EXIT.error)
    expect(s.names().filter((n) => n === 'approval_consume')).toHaveLength(1)
  })

  it('denied is 1 and prints {approval, used:false}; expired is 2', async () => {
    const s = server({ answered: { ...pendingRec(), status: 'denied', answer: { decision: 'deny', mode: 'tap', at: 'now' } } })
    expect(await runApprove(strict, io(s.call))).toBe(APPROVE_EXIT.denied)
    expect(JSON.parse(outs[0])).toMatchObject({ used: false, approval: { status: 'denied' } })
    const e = server({ answered: { ...pendingRec(), status: 'expired' } })
    expect(await runApprove(strict, io(e.call))).toBe(APPROVE_EXIT.timeout)
  })

  it('a Walnut that did not make it single-use is withdrawn and exits 3', async () => {
    const plain = withDigest({ ...pendingRec(), singleUse: undefined, detail: DETAIL })
    const s = server({ asked: plain, answered: plain })
    expect(await runApprove(strict, io(s.call))).toBe(APPROVE_EXIT.error)
    expect(s.names()).toEqual(['approval_request', 'approval_cancel'])
  })
})

describe('ask now, wait later', () => {
  it('--request-only saves a 0600 token file, prints the id and exits 4', async () => {
    const s = server({ answered: pendingRec() })
    expect(await runApprove({ ...strict, json: false, requestOnly: true }, io(s.call))).toBe(APPROVE_EXIT.pending)
    expect(s.names()).toEqual(['approval_request'])
    expect(outs).toEqual(['apr-abc_1'])
    expect(says.some((l) => l.includes('--approval apr-abc_1'))).toBe(true)
    const file = path.join(dir, 'apr-abc_1.json')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(saved).toMatchObject({ id: 'apr-abc_1', waitToken: 'tok-secret', what: 'Deploy prod', detail: DETAIL,
      detailSha256: sha256Hex(DETAIL), singleUse: true, envelope: envelope() })
    expect(saved).not.toHaveProperty('signingKeyId')
    expect(fs.readdirSync(dir)).toEqual(['apr-abc_1.json'])
  })

  it('--request-only with --json prints {id, status:"pending"}', async () => {
    const s = server({ answered: pendingRec() })
    expect(await runApprove({ ...strict, requestOnly: true }, io(s.call))).toBe(APPROVE_EXIT.pending)
    expect(JSON.parse(outs[0])).toEqual({ id: 'apr-abc_1', status: 'pending' })
  })

  it('--approval resumes the saved ask, consumes it and deletes the file', async () => {
    const ask = server({ answered: pendingRec() })
    await runApprove({ ...strict, requestOnly: true }, io(ask.call))
    outs = []
    const s = server({ answered: approved(pendingRec()) })
    expect(await runApprove({ ...strict, approvalId: 'apr-abc_1' }, io(s.call))).toBe(APPROVE_EXIT.approved)
    expect(s.names()).toEqual(['approval_wait', 'approval_consume'])
    expect(s.calls[0].args).toMatchObject({ id: 'apr-abc_1', token: 'tok-secret' })
    expect(JSON.parse(outs[0]).used).toBe(true)
    expect(fs.existsSync(path.join(dir, 'apr-abc_1.json'))).toBe(false)
  })

  it('--approval for a plain ask waits like before and deletes the file once decided', async () => {
    const plain = { id: 'apr-p1', status: 'pending', what: 'Restart', mode: 'tap', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }
    const call = async (name: string): Promise<OpCallResult> => name === 'approval_request'
      ? { ok: true, result: { approval: plain, waitToken: 't' } }
      : { ok: true, result: { approval: { ...plain, status: 'denied', answer: { decision: 'deny', mode: 'tap', at: 'now' } } } }
    const base: ApproveArgs = { what: 'Restart', timeoutMs: 60_000, json: false }
    expect(await runApprove({ ...base, requestOnly: true }, io(call))).toBe(APPROVE_EXIT.pending)
    expect(await runApprove({ ...base, approvalId: 'apr-p1' }, io(call))).toBe(APPROVE_EXIT.denied)
    expect(fs.existsSync(path.join(dir, 'apr-p1.json'))).toBe(false)
  })

  it('--approval with no saved file is exit 3 and asks nothing', async () => {
    const s = server({ answered: approved(pendingRec()) })
    expect(await runApprove({ ...strict, approvalId: 'apr-none' }, io(s.call))).toBe(APPROVE_EXIT.error)
    expect(s.calls).toEqual([])
    expect(says.join('\n')).toContain('no saved request apr-none on this machine')
  })

  it('--approval with a changed detail or what is exit 3', async () => {
    await runApprove({ ...strict, requestOnly: true }, io(server({ answered: pendingRec() }).call))
    const s = server({ answered: approved(pendingRec()) })
    expect(await runApprove({ ...strict, detail: DETAIL + ' ', approvalId: 'apr-abc_1' }, io(s.call))).toBe(APPROVE_EXIT.error)
    expect(await runApprove({ ...strict, what: 'Deploy staging', approvalId: 'apr-abc_1' }, io(s.call))).toBe(APPROVE_EXIT.error)
    expect(s.calls).toEqual([])
    expect(says.join('\n')).toContain('the request changed since it was asked')
  })

  it('--approval refuses a record whose nonce is not the saved one', async () => {
    await runApprove({ ...strict, requestOnly: true }, io(server({ answered: pendingRec() }).call))
    const swapped = approved(withDigest({ ...pendingRec(), detail: envelope({ nonce: nonceB }) }))
    const s = server({ answered: swapped })
    expect(await runApprove({ ...strict, approvalId: 'apr-abc_1' }, io(s.call))).toBe(APPROVE_EXIT.error)
    expect(s.names()).not.toContain('approval_consume')
  })

  it('a token file an older CLI saved (with its pinned key) still resumes', async () => {
    await runApprove({ ...strict, requestOnly: true }, io(server({ answered: pendingRec() }).call))
    const file = path.join(dir, 'apr-abc_1.json')
    const old = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...old, signingKeyId: 'ak-dcb776df2641b2ff', signingKeyPath: '/keys/phone.pem' }), { mode: 0o600 })
    const s = server({ answered: approved(pendingRec()) })
    expect(await runApprove({ ...strict, approvalId: 'apr-abc_1' }, io(s.call))).toBe(APPROVE_EXIT.approved)
  })
})

describe('the token file', () => {
  const saved = { id: 'apr-t1', waitToken: 'w', what: 'x', detailSha256: sha256Hex(undefined), singleUse: false, createdAt: 'c', expiresAt: 'e' }

  it('refuses an id with path characters', () => {
    expect(() => saveToken({ ...saved, id: '../apr-t1' }, dir)).toThrow()
    expect(() => saveToken({ ...saved, id: 'apr-../../x' }, dir)).toThrow()
    expect(() => loadToken('../x', dir)).toThrow()
    expect(() => removeToken('apr-a/b', dir)).not.toThrow()
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('round-trips, and the sweep removes files older than a day', () => {
    saveToken(saved, dir)
    expect(loadToken('apr-t1', dir)).toEqual(saved)
    const old = (Date.now() - 25 * 3_600_000) / 1000
    fs.utimesSync(path.join(dir, 'apr-t1.json'), old, old)
    saveToken({ ...saved, id: 'apr-t2' }, dir)
    expect(sweepTokens(dir)).toBe(1)
    expect(fs.readdirSync(dir)).toEqual(['apr-t2.json'])
    removeToken('apr-t2', dir)
    expect(loadToken('apr-t2', dir)).toBeUndefined()
  })
})
