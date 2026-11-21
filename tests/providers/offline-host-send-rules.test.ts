/**
 * The host daemon's own answer to a session's message runs the server's send rules
 * (core/sessions/send-rules.ts createSendRules, inlined into daemon-source.ts as text), not a copy:
 * wake=false honoured (a note that asks nothing opens no request; one that also asks is refused),
 * a lead's deadline as the server sets it, and a quiet note left to the server while it answers.
 * Review round 2, N3: the daemon ignored wake and gave a lead 6 h, not 12 h.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupJournalDirs, gatewayCall, JHOME, journalHost, journalTmpDir, jslice, SID_A, TASK_A, TASK_B } from '../helpers/offline-journal-harness.js'
import { createSendRules, type SendRuleInput } from '../../src/core/sessions/send-rules.js'
import type { HostSlice } from '../../src/providers/offline-host-core.js'

const T0 = Date.parse('2026-11-20T12:00:00Z')
const H = 3_600_000

afterEach(() => cleanupJournalDirs())

function host(slice: HostSlice = jslice()) {
  const delivered: string[] = []
  const h = journalHost(journalTmpDir(), { now: T0 }, { deliver: async (sid) => { delivered.push(sid); return { ok: true } } })
  h.host.configure(slice)
  return { ...h, delivered }
}

type Answer = { ok: true; result: Record<string, unknown> } | { ok: false; error: { code: string; message: string } }
const rowOf = (h: ReturnType<typeof host>, r: Answer) => {
  expect(r.ok).toBe(true)
  const id = (r as { result: Record<string, unknown> }).result.requestId as string | undefined
  return id ? h.host.journal.state(JHOME).rows[id] as { deadlineAt: number } | undefined : undefined
}
const leadSlice = () => jslice({
  tasks: jslice().tasks.map((t) => (t.id === TASK_B ? { ...t, org_role: 'lead' } : t)),
})

describe('the daemon\'s away send runs the server\'s rules', () => {
  it('a note that asks nothing (wake false) is delivered and opens no request', async () => {
    const h = host()
    const r = await gatewayCall(h.host, SID_A, 'task_send', { to: TASK_B, text: 'fyi', wake: false }) as Answer
    expect(r).toMatchObject({ ok: true, result: { delivery: 'queued' } })
    expect((r as { result: Record<string, unknown> }).result.requestId).toBeUndefined()
    expect(h.delivered).toHaveLength(1)
    expect(Object.keys(h.host.journal.state(JHOME).rows)).toEqual([])
  })

  it('wake false that also asks for a reply is refused with the server\'s words, nothing delivered', async () => {
    const h = host()
    const r = await gatewayCall(h.host, SID_A, 'task_send', { to: TASK_B, text: 'fyi', wake: false, expect_reply: true }) as Answer
    expect(r).toMatchObject({ ok: false, error: { code: 'bad_request', message: createSendRules().wakeFalseConflict({ wake: false, expectReply: true })!.message } })
    expect(h.delivered).toEqual([])
  })

  it('a forced wake false note asks as any message does', async () => {
    const h = host()
    const r = await gatewayCall(h.host, SID_A, 'task_send', { to: TASK_B, text: 'fyi', wake: false, force: true }) as Answer
    expect(rowOf(h, r)?.deadlineAt).toBe(T0 + 6 * H)
  })

  it('a message to a lead gets a lead\'s deadline: 12 h by default, 2 h when asked', async () => {
    const h = host(leadSlice())
    expect(rowOf(h, await gatewayCall(h.host, SID_A, 'task_send', { to: TASK_B, text: 'plan the round' }) as Answer)?.deadlineAt).toBe(T0 + 12 * H)
    expect(rowOf(h, await gatewayCall(h.host, SID_A, 'task_send', { to: TASK_B, text: 'plan the next round', expect_reply: true }) as Answer)?.deadlineAt).toBe(T0 + 2 * H)
  })

  it('a message to a plain task keeps the send deadlines: 6 h by default, 1 h when asked, a named one bounded', async () => {
    const h = host()
    expect(rowOf(h, await gatewayCall(h.host, SID_A, 'task_send', { to: TASK_B, text: 'build it' }) as Answer)?.deadlineAt).toBe(T0 + 6 * H)
    expect(rowOf(h, await gatewayCall(h.host, SID_A, 'task_send', { to: TASK_B, text: 'build it again', expect_reply: true }) as Answer)?.deadlineAt).toBe(T0 + 1 * H)
    expect(rowOf(h, await gatewayCall(h.host, SID_A, 'task_send', { to: TASK_B, text: 'and once more', reply_timeout: 5 }) as Answer)?.deadlineAt).toBe(T0 + 60_000)
  })

  it('a note up to its own leader reports: no request', async () => {
    const h = host()
    const r = await gatewayCall(h.host, 'bbbbbbbb-2222-4222-8222-222222222222', 'task_send', { to: TASK_A, text: 'done' }) as Answer
    expect(rowOf(h, r)).toBeUndefined()
  })
})

describe('while the server answers, a quiet note is the server\'s', () => {
  it('handleLocal leaves a wake false note (and one that also asks) to the server, and takes a plain one', async () => {
    const h = journalHost(journalTmpDir(), { now: T0 })
    const { createOfflineHost } = await import('../../src/providers/offline-host-core.js')
    const local = createOfflineHost({ ...h.deps, pendingPrompt: () => null })
    local.configure(jslice())
    const send = (args: Record<string, unknown>) => local.handleLocal(JHOME, SID_A, 'tools.call', { name: 'task_send', args: { to: TASK_B, ...args } })
    expect(await send({ text: 'fyi', wake: false })).toBeNull()
    expect(await send({ text: 'fyi too', wake: false, expect_reply: true })).toBeNull()
    expect(await send({ text: 'a real one' })).toMatchObject({ ok: true, result: { delivery: 'queued', via: 'host' } })
  })
})

describe('send rules: one self-contained copy the daemon inlines', () => {
  const rebuild = <T>(fn: T): T => new Function('"use strict"; return ' + String(fn))() as T

  it('the factory rebuilt from its text answers a table of inputs as the module does', () => {
    const mod = createSendRules()
    const copy = rebuild(createSendRules)()
    const inputs: SendRuleInput[] = []
    for (const expectReply of [undefined, true, false]) for (const wake of [undefined, true, false]) for (const force of [undefined, true]) {
      for (const handsOn of [undefined, { id: 'rq-aaaaaa' }]) {
        inputs.push({ ...(expectReply !== undefined ? { expectReply } : {}), ...(wake !== undefined ? { wake } : {}), ...(force ? { force } : {}), ...(handsOn ? { handsOn } : {}) })
      }
    }
    for (const input of inputs) {
      for (const goesUp of [false, true]) {
        expect(copy.asksReply(input, goesUp)).toBe(mod.asksReply(input, goesUp))
        expect(copy.opensRequest(input, goesUp)).toBe(mod.opensRequest(input, goesUp))
      }
      expect(copy.wakeFalseConflict(input)).toEqual(mod.wakeFalseConflict(input))
      expect(copy.holdsQuietly(input)).toBe(mod.holdsQuietly(input))
    }
    for (const kind of ['send', 'lead', 'start'] as const) for (const implicit of [false, true]) for (const secs of [undefined, 5, 7200.7, 10 ** 9, Number.NaN]) {
      expect(copy.clampReplyTimeoutSecs(secs, implicit, kind)).toBe(mod.clampReplyTimeoutSecs(secs, implicit, kind))
    }
    expect(copy.clampReplyTimeoutSecs(undefined, true, 'lead')).toBe(12 * 3600)
  })

  it('send-rules.ts imports nothing at runtime, and the daemon source inlines it', () => {
    const root = path.resolve(import.meta.dirname, '..', '..')
    const src = fs.readFileSync(path.join(root, 'src/core/sessions/send-rules.ts'), 'utf8')
    expect(src.split('\n').filter((l) => /^import\s/.test(l) && !/^import type\s/.test(l))).toEqual([])
    const twin = fs.readFileSync(path.join(root, 'src/providers/daemon-source.ts'), 'utf8')
    expect(twin).toContain("['__CREATE_SEND_RULES__', createSendRules.toString()]")
    expect(twin).toContain('rules: (__CREATE_SEND_RULES__)(),')
    expect(fs.readFileSync(path.join(root, 'src/providers/daemon-standalone.ts'), 'utf8')).toContain('rules: createSendRules(),')
  })
})
