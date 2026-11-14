/**
 * A router handing one item outside its area (src/core/router/cross-route.ts): asked once, frozen
 * at the ask, claimed once, sent once. Real RouterStore and real handoff-approval file under this
 * test's temp home; the approvals store, task store, source cache, receiver and send are fakes.
 * No model, no network. All names are invented.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { approvalDigest } from '../../src/core/approvals/digest.js'
import type { CreateInput } from '../../src/core/approvals/store.js'
import type { ApprovalRecord } from '../../src/core/approvals/types.js'
import type { RouterAreasFile } from '../../src/core/router/areas.js'
import { crossRouteItem, needsHandoff, CROSS_ROUTE_TITLE, type CrossRouteDeps, type CrossRouteInput } from '../../src/core/router/cross-route.js'
import { isRouterDelivery } from '../../src/core/router/delivery-scope.js'
import { ownedClaimedHandoff, type HandoffDeps } from '../../src/core/router/handoff-approval.js'
import { RouterError } from '../../src/core/router/service.js'
import { RouteLockBusyError, withLedgerRouteLock } from '../../src/core/router/route-lock.js'
import { routerAreaProfile } from '../../src/core/router/session-policy.js'
import { RouterStore, routerKey, routerMessageId } from '../../src/core/router/store.js'
import type { RouterSource } from '../../src/core/router/types.js'
import type { SessionRecord, Task } from '../../src/core/types.js'

const SHARED = 'desk@marina.example.invalid'
const ITEM: RouterSource = { kind: 'mail', account: SHARED, message: 'INBOX:1:10', version: 'fixture-delivery-1' }
const ITEM_2: RouterSource = { kind: 'mail', account: SHARED, message: 'INBOX:1:12', version: 'fixture-delivery-2' }
const NOW = Date.parse('2026-11-07T10:00:00.000Z')

let home: string
let store: RouterStore
let areas: RouterAreasFile
let tasks: Map<string, Partial<Task>>
let body: string
let sessionsByTask: Map<string, SessionRecord[]>
let recs: Map<string, ApprovalRecord>
let created: CreateInput[]
let waits: number
let failWait: boolean
let handoff: HandoffDeps
let deps: CrossRouteDeps & { getTask: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn>; resolve: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; emit: ReturnType<typeof vi.fn> }

const task = (id: string, extra: Partial<Task> = {}): Partial<Task> => ({ id, title: `Task ${id}`, phase: 'IN_PROGRESS', source: 'local', ...extra })
const input = (extra: Partial<CrossRouteInput> = {}): CrossRouteInput => ({
  source: { ...ITEM }, targetTaskId: 'task-w-worker', byTaskId: 'task-p-router',
  brief: 'Please check the dock invoice.', reason: 'The invoice is work, not personal.', ...extra,
})
const code = async (p: Promise<unknown>): Promise<string> => p.then(() => 'resolved', (e: { code?: string }) => e.code ?? String(e))
const answer = (id: string, decision: 'approve' | 'deny'): void => {
  const rec = recs.get(id)!
  rec.status = decision === 'approve' ? 'approved' : 'denied'
  rec.answer = { decision, at: new Date(NOW).toISOString(), mode: 'tap', device: { name: 'phone', kind: 'iphone' } }
}
async function askAndAnswer(decision?: 'approve' | 'deny', extra: Partial<CrossRouteInput> = {}): Promise<string> {
  const asked = await crossRouteItem(input(extra), deps)
  if (asked.status !== 'needs_approval') throw new Error('expected an ask')
  if (decision) answer(asked.approval.approvalId, decision)
  return asked.approval.approvalId
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'router-cross-route-'))
  store = new RouterStore(home, 'personal')
  areas = {
    version: 1,
    areas: [
      { id: 'personal', name: 'Personal', host: '__local__', taskIds: ['task-p-router', 'task-p-worker'], sources: [{ kind: 'mail', account: SHARED }] },
      { id: 'work', name: 'Work', host: '__local__', taskIds: ['task-w-router', 'task-w-worker'], sources: [] },
    ],
    routers: [{ taskId: 'task-p-router', areaId: 'personal', paused: false }, { taskId: 'task-w-router', areaId: 'work', paused: false }],
    items: [{ source: { ...ITEM }, areaId: 'personal' }, { source: { ...ITEM_2 }, areaId: 'personal' }],
  }
  tasks = new Map([
    ['task-p-router', task('task-p-router', { org_role: 'router', router_area_id: 'personal', router_paused: false, title: 'Personal router' })],
    ['task-w-router', task('task-w-router', { org_role: 'router', router_area_id: 'work', router_paused: false })],
    ['task-p-worker', task('task-p-worker', { router_area_id: 'personal' })],
    ['task-w-worker', task('task-w-worker', { router_area_id: 'work', title: 'Accounts desk' })],
    ['task-loose', task('task-loose')],
    ['task-main', task('task-main', { org_role: 'main' })],
  ])
  body = 'Cached body v1'
  sessionsByTask = new Map([['task-w-worker', [{ claudeSessionId: 'sid-w-worker', taskId: 'task-w-worker', archived: false, lastActiveAt: '',
    host: '__local__', profile: routerAreaProfile('work', 'work') } as unknown as SessionRecord]]])
  recs = new Map(); created = []; waits = 0; failWait = false
  handoff = {
    home, now: () => NOW, activeKeyCount: async () => 0,
    livePendingIds: async () => new Set([...recs.values()].filter((r) => r.status === 'pending').map((r) => r.id)),
    createApproval: async (i) => {
      created.push(i)
      const id = `apr-${created.length}`
      const createdAt = new Date(NOW).toISOString()
      const expiresAt = new Date(NOW + (i.timeoutMs ?? 600_000)).toISOString()
      const rec: ApprovalRecord = {
        id, what: i.what, detail: i.detail, mode: i.mode, requester: i.requester, createdAt, expiresAt, status: 'pending', waitTokenHash: 'h',
        ...(i.guard ? { guard: i.guard } : {}),
        digest: approvalDigest({ id, mode: i.mode, createdAt, expiresAt, host: i.requester.host, taskId: i.requester.taskId, what: i.what, detail: i.detail }),
      }
      recs.set(id, rec)
      const { waitTokenHash: _h, ...view } = rec
      return { approval: structuredClone(view), waitToken: `token-${id}` }
    },
    getApproval: async (id) => structuredClone(recs.get(id)),
    waitApproval: async (id, token) => {
      waits++
      if (failWait) throw new Error('approvals store unreachable')
      const rec = recs.get(id)!
      if (token !== `token-${id}`) throw new Error('bad token')
      if (rec.status !== 'approved' || rec.consumedAt) return { approval: structuredClone(rec), used: false }
      rec.consumedAt = new Date(NOW).toISOString()
      return { approval: structuredClone(rec), used: true }
    },
    cancelApproval: async (id) => { const rec = recs.get(id); if (rec?.status === 'pending') rec.status = 'canceled' },
  }
  deps = {
    areas: async () => structuredClone(areas), store, handoff, sessions: async (id) => sessionsByTask.get(id) ?? [],
    getTask: vi.fn(async (id: string) => { const t = tasks.get(id); if (!t) throw new Error(`No task found matching ${id}`); return structuredClone(t) as Task }),
    resolve: vi.fn(async (source: RouterSource) => ({ source: { ...source }, key: routerKey(source), sender: 'pat@acme.example.invalid', subject: 'Invoice 7' })),
    read: vi.fn(async (source: RouterSource) => ({
      item: { source: { ...source }, key: routerKey(source), sender: 'pat@acme.example.invalid', subject: 'Invoice 7' },
      body: { text: body }, bodyAvailable: true, attachments: [{ filename: 'invoice.pdf', mimeType: 'application/pdf', bytes: 1200 }], attachmentsAvailable: false as const,
    })),
    prepareTarget: async () => 'sid-w-worker',
    send: vi.fn(async (i: { to?: string; messageId?: string }) => ({ scoped: isRouterDelivery(i.to!, i.messageId) })),
    emit: vi.fn(),
  }
})

afterEach(async () => {
  await store.dispose()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('crossRouteItem', () => {
  it('asks once for the same handoff and writes no ledger row while it is pending', async () => {
    const a = await crossRouteItem(input(), deps)
    const b = await crossRouteItem(input(), deps)
    expect(a).toEqual(b)
    expect(a.status).toBe('needs_approval')
    expect(created).toHaveLength(1)
    expect(created[0].what).toContain('Accounts desk')
    expect(created[0].requester.taskTitle).toBe('Personal router')
    const id = a.status === 'needs_approval' ? a.approval.approvalId : ''
    const again = await crossRouteItem(input({ approvalId: id }), deps)
    expect(again).toEqual({ status: 'needs_approval', approval: { approvalId: id, digest: expect.any(String), status: 'pending' } })
    expect(await store.getSource(ITEM)).toBeUndefined()
    expect(deps.send).not.toHaveBeenCalled()
    expect(waits).toBe(0)
  })

  it('a no sends nothing and claims nothing', async () => {
    const id = await askAndAnswer('deny')
    expect(await code(crossRouteItem(input({ approvalId: id }), deps))).toBe('denied')
    expect(await store.getSource(ITEM)).toBeUndefined()
    expect(deps.send).not.toHaveBeenCalled()
  })

  it('a target that moved scope or completed after the ask is refused before any claim', async () => {
    const id = await askAndAnswer('approve')
    areas.areas[1].taskIds = ['task-w-router']
    tasks.get('task-w-worker')!.router_area_id = undefined
    expect(await code(crossRouteItem(input({ approvalId: id }), deps))).toBe('handoff_changed')
    tasks.get('task-w-worker')!.router_area_id = 'work'
    areas.areas[1].taskIds.push('task-w-worker')
    tasks.get('task-w-worker')!.phase = 'COMPLETE'
    expect(await code(crossRouteItem(input({ approvalId: id }), deps))).toBe('target_unavailable')
    expect(await store.getSource(ITEM)).toBeUndefined()
    expect(deps.send).not.toHaveBeenCalled()
    expect(waits).toBe(0)
  })

  it('the last live gate before the send settles failed when the target moved after the claim', async () => {
    const id = await askAndAnswer('approve')
    deps.emit.mockImplementation((_s, route: { status: string }) => {
      if (route.status === 'routing') { areas.areas[1].taskIds = ['task-w-router']; tasks.get('task-w-worker')!.router_area_id = undefined }
    })
    const out = await crossRouteItem(input({ approvalId: id }), deps)
    expect(out).toMatchObject({ status: 'receipt', fresh: true, route: { status: 'failed' } })
    expect(deps.send).not.toHaveBeenCalled()
  })

  it('a yes delivers once under the ledger message id, inside the router delivery scope', async () => {
    const id = await askAndAnswer('approve')
    const out = await crossRouteItem(input({ approvalId: id }), deps)
    expect(out).toMatchObject({ status: 'receipt', fresh: true, route: { status: 'routed', taskId: 'task-w-worker', byTaskId: 'task-p-router' } })
    const mid = routerMessageId('personal', routerKey(ITEM), 'task-w-worker')
    expect(deps.send).toHaveBeenCalledTimes(1)
    const sent = deps.send.mock.calls[0][0]
    expect(sent).toMatchObject({ to: 'sid-w-worker', messageId: mid, title: CROSS_ROUTE_TITLE, expectReply: false, source: 'api-agent', callerLabel: 'Router' })
    expect(sent.callerSid).toBeUndefined()
    expect(await deps.send.mock.results[0].value).toEqual({ scoped: true })
    expect(waits).toBe(1)
    const repeat = await crossRouteItem(input({ approvalId: id }), deps)
    expect(repeat).toMatchObject({ status: 'receipt', fresh: false, route: { status: 'routed' } })
    expect(deps.send).toHaveBeenCalledTimes(1)
    expect(waits).toBe(1)
  })

  it('two parallel uses of one yes deliver once', async () => {
    const id = await askAndAnswer('approve')
    const both = await Promise.all([crossRouteItem(input({ approvalId: id }), deps), crossRouteItem(input({ approvalId: id }), deps)])
    expect(both.filter((r) => r.status === 'receipt' && r.fresh)).toHaveLength(1)
    expect(deps.send).toHaveBeenCalledTimes(1)
    expect(waits).toBe(1)
  })

  it('an existing receipt is returned without an ask or a cache read', async () => {
    await store.claim({ source: { ...ITEM }, key: routerKey(ITEM), sender: 's', subject: 'x' }, { status: 'not_routed', reason: 'Spam.' })
    const out = await crossRouteItem(input(), deps)
    expect(out).toMatchObject({ status: 'receipt', fresh: false, route: { status: 'not_routed' } })
    expect(created).toHaveLength(0)
    expect(deps.read).not.toHaveBeenCalled()
  })

  it('an uncertain send stays unknown and is never sent again', async () => {
    deps.send.mockRejectedValueOnce(new Error('socket closed'))
    const id = await askAndAnswer('approve')
    expect(await crossRouteItem(input({ approvalId: id }), deps)).toMatchObject({ route: { status: 'unknown' }, fresh: true })
    expect(await crossRouteItem(input({ approvalId: id }), deps)).toMatchObject({ route: { status: 'unknown' }, fresh: false })
    expect(await crossRouteItem(input(), deps)).toMatchObject({ status: 'receipt', fresh: false })
    expect(deps.send).toHaveBeenCalledTimes(1)
  })

  it('a refused send settles failed; a failed approval use settles failed and sends nothing', async () => {
    deps.send.mockRejectedValueOnce(new RouterError('receiver_not_isolated', 'no'))
    const id = await askAndAnswer('approve')
    expect(await crossRouteItem(input({ approvalId: id }), deps)).toMatchObject({ route: { status: 'failed' }, fresh: true })
    expect(await crossRouteItem(input({ approvalId: id }), deps)).toMatchObject({ fresh: false })
    expect(deps.send).toHaveBeenCalledTimes(1)

    failWait = true
    const id2 = await askAndAnswer('approve', { source: { ...ITEM_2 } })
    expect(await crossRouteItem(input({ source: { ...ITEM_2 }, approvalId: id2 }), deps)).toMatchObject({ route: { status: 'failed' }, fresh: true })
    expect(deps.send).toHaveBeenCalledTimes(1)
  })

  it('sends the body frozen at the ask, not the cache as it is now, marked untrusted', async () => {
    const id = await askAndAnswer('approve')
    body = 'Cached body v2 changed later'
    await crossRouteItem(input({ approvalId: id }), deps)
    const text: string = deps.send.mock.calls[0][0].text
    expect(text).toContain('Cached body v1')
    expect(text).not.toContain('v2')
    expect(text).toContain('Please check the dock invoice.')
    expect(text).toContain('invoice.pdf')
    expect(text).toMatch(/untrusted/)
    expect(text).toMatch(/no authorization/)
  })

  it('another router is refused before any lookup; another item\'s approval reads no content and changes nothing', async () => {
    const getSource = vi.spyOn(store, 'getSource')
    expect(await code(crossRouteItem(input({ byTaskId: 'task-w-router' }), deps))).toBe('area_forbidden')
    expect(deps.getTask).not.toHaveBeenCalled()
    expect(getSource).not.toHaveBeenCalled()
    expect(deps.read).not.toHaveBeenCalled()
    expect(deps.resolve).not.toHaveBeenCalled()
    const id = await askAndAnswer('approve')
    deps.read.mockClear()
    expect(await code(crossRouteItem(input({ source: { ...ITEM_2 }, approvalId: id }), deps))).toBe('handoff_changed')
    expect(deps.read).not.toHaveBeenCalled()
    expect(await store.getSource(ITEM_2)).toBeUndefined()
    expect(await store.getSource(ITEM)).toBeUndefined()
    expect(recs.get(id)!.consumedAt).toBeUndefined()
    expect(waits).toBe(0)
    expect(deps.send).not.toHaveBeenCalled()
  })

  it('a repeat after delivery returns the receipt without a target lookup, even once the receiver completed, was renamed or deleted', async () => {
    const id = await askAndAnswer('approve')
    expect(await crossRouteItem(input({ approvalId: id }), deps)).toMatchObject({ fresh: true, route: { status: 'routed' } })
    const repeat = async (extra: Partial<CrossRouteInput> = {}) => {
      deps.getTask.mockClear(); deps.read.mockClear(); deps.resolve.mockClear()
      expect(await crossRouteItem(input(extra), deps)).toMatchObject({ status: 'receipt', fresh: false, route: { status: 'routed', taskId: 'task-w-worker' } })
      expect(deps.getTask.mock.calls.map((c) => c[0])).toEqual(['task-p-router'])
      expect(deps.read).not.toHaveBeenCalled()
      expect(deps.resolve).not.toHaveBeenCalled()
    }
    tasks.get('task-w-worker')!.phase = 'COMPLETE'
    await repeat({ approvalId: id })
    await repeat()
    tasks.get('task-w-worker')!.title = 'Renamed desk'
    await repeat({ approvalId: id })
    tasks.delete('task-w-worker')
    await repeat({ approvalId: id })
    await repeat()
    expect(deps.send).toHaveBeenCalledTimes(1)
    expect(waits).toBe(1)
    expect(created).toHaveLength(1)
  })

  it('a moved copy of a delivered item binds to its receipt and is never read for or sent again', async () => {
    const MOVED_A: RouterSource = { ...ITEM, message: 'Archive:7:10' }
    const MOVED_B: RouterSource = { ...ITEM, message: 'Archive:7:11' }
    areas.items.push({ source: { ...MOVED_A }, areaId: 'personal' }, { source: { ...MOVED_B }, areaId: 'personal' })
    const canonical = routerKey(ITEM)
    const keyOf = (src: RouterSource) => src.message.startsWith('Archive:') ? canonical : routerKey(src)
    const meta = { sender: 'pat@acme.example.invalid', subject: 'Invoice 7' }
    deps.resolve.mockImplementation(async (src: RouterSource) => ({ source: { ...src }, key: keyOf(src), ...meta }))
    deps.read.mockImplementation(async (src: RouterSource) => ({ item: { source: { ...src }, key: keyOf(src), ...meta },
      body: { text: body }, bodyAvailable: true, attachments: [], attachmentsAvailable: false as const }))
    const id = await askAndAnswer('approve')
    expect(await crossRouteItem(input({ approvalId: id }), deps)).toMatchObject({ fresh: true, route: { status: 'routed' } })
    const same = { status: 'receipt', fresh: false, route: { status: 'routed', key: canonical, taskId: 'task-w-worker' } }
    expect(await crossRouteItem(input({ source: { ...MOVED_A }, approvalId: id }), deps)).toMatchObject(same)
    expect(await crossRouteItem(input({ source: { ...MOVED_B } }), deps)).toMatchObject(same)
    expect((await store.getSource(MOVED_A))?.key).toBe(canonical)
    expect((await store.getSource(MOVED_B))?.key).toBe(canonical)
    deps.read.mockClear(); deps.resolve.mockClear()
    expect(await crossRouteItem(input({ source: { ...MOVED_A } }), deps)).toMatchObject(same)
    expect(await crossRouteItem(input({ source: { ...MOVED_B }, approvalId: id }), deps)).toMatchObject(same)
    expect(deps.read).not.toHaveBeenCalled()
    expect(deps.resolve).not.toHaveBeenCalled()
    expect(deps.send).toHaveBeenCalledTimes(1)
    expect(waits).toBe(1)
    expect(created).toHaveLength(1)
    // The alias names the ledger row only: the approved body stays readable for the asked source alone.
    expect(await ownedClaimedHandoff(MOVED_A, 'task-w-worker', handoff)).toBeUndefined()
    expect(await ownedClaimedHandoff(ITEM, 'task-w-worker', handoff)).toBeDefined()
  })

  it('refuses same-area work, Main and routers as targets', async () => {
    expect(await code(crossRouteItem(input({ targetTaskId: 'task-p-worker' }), deps))).toBe('same_area')
    expect(await code(crossRouteItem(input({ targetTaskId: 'task-main' }), deps))).toBe('router_loop')
    expect(await code(crossRouteItem(input({ targetTaskId: 'task-w-router' }), deps))).toBe('router_loop')
    expect(created).toHaveLength(0)
  })

  it('a yes landing right after the peek is not used by that call; only the next call, a ledger winner, uses it', async () => {
    const id = await askAndAnswer()
    const read = handoff.getApproval!
    let flip = true
    handoff.getApproval = async (aid) => { const rec = await read(aid); if (flip) { flip = false; answer(aid, 'approve') } return rec }
    expect(await crossRouteItem(input({ approvalId: id }), deps)).toMatchObject({ status: 'needs_approval', approval: { approvalId: id, status: 'pending' } })
    expect(waits).toBe(0)
    expect(await store.getSource(ITEM)).toBeUndefined()
    let rowAtUse: unknown
    const wait = handoff.waitApproval!
    handoff.waitApproval = async (...a) => { rowAtUse = await store.getSource(ITEM); return wait(...a) }
    expect(await crossRouteItem(input({ approvalId: id }), deps)).toMatchObject({ fresh: true, route: { status: 'routed' } })
    expect(rowAtUse).toMatchObject({ status: 'routing', taskId: 'task-w-worker' })
    expect(waits).toBe(1)
  })

  it('canceled and missing approvals refuse without a ledger row or a use', async () => {
    const id = await askAndAnswer()
    recs.get(id)!.status = 'canceled'
    expect(await code(crossRouteItem(input({ approvalId: id }), deps))).toBe('canceled')
    recs.delete(id)
    expect(await code(crossRouteItem(input({ approvalId: id }), deps))).toBe('approval_missing')
    expect(await store.getSource(ITEM)).toBeUndefined()
    expect(waits).toBe(0)
  })

  it('a target renamed after the use refuses at the last gate and sends nothing', async () => {
    const id = await askAndAnswer('approve')
    deps.emit.mockImplementation((_s, route: { status: string }) => { if (route.status === 'routing') tasks.get('task-w-worker')!.title = 'Renamed desk' })
    expect(await crossRouteItem(input({ approvalId: id }), deps)).toMatchObject({ fresh: true, route: { status: 'failed', error: expect.stringContaining('name changed') } })
    expect(deps.send).not.toHaveBeenCalled()
  })

  it('needsHandoff: clean same-area work routes directly, other areas and unscoped work take the yes', async () => {
    expect(await needsHandoff(ITEM, 'task-p-worker', deps)).toBe(false)
    expect(await needsHandoff(ITEM, 'task-w-worker', deps)).toBe(true)
    expect(await needsHandoff(ITEM, 'task-loose', deps)).toBe(true)
    sessionsByTask.set('task-loose', [{ claudeSessionId: 'sid-loose-full', taskId: 'task-loose', archived: false, lastActiveAt: '' } as unknown as SessionRecord])
    expect(await needsHandoff(ITEM, 'task-loose', deps)).toBe(true)
    expect(await code(needsHandoff(ITEM, 'task-gone', deps))).toBe('target_unavailable')
    expect(await code(needsHandoff(ITEM, 'task-main', deps))).toBe('router_loop')
    expect(await code(needsHandoff(ITEM, 'task-p-router', deps))).toBe('router_loop')
    tasks.get('task-p-worker')!.router_area_id = 'work'
    expect(await code(needsHandoff(ITEM, 'task-p-worker', deps))).toBe('target_scope')
    expect(await code(needsHandoff({ ...ITEM, message: 'INBOX:1:99' }, 'task-w-worker', deps))).toBe('area_unassigned')
  })

  it('a task marked for an area with history outside its isolated profile is refused in any area, before any ask', async () => {
    const full = (sid: string, taskId: string) => ({ claudeSessionId: sid, taskId, archived: false, lastActiveAt: '' }) as unknown as SessionRecord
    sessionsByTask.set('task-p-worker', [full('sid-p-full', 'task-p-worker')])
    sessionsByTask.set('task-w-worker', [full('sid-w-full', 'task-w-worker'),
      { claudeSessionId: 'sid-w-iso', taskId: 'task-w-worker', archived: false, lastActiveAt: '', host: '__local__', profile: routerAreaProfile('work', 'work') } as unknown as SessionRecord])
    expect(await code(needsHandoff(ITEM, 'task-p-worker', deps))).toBe('history_not_isolated')
    expect(await code(crossRouteItem(input({ targetTaskId: 'task-p-worker' }), deps))).toBe('history_not_isolated')
    expect(await code(crossRouteItem(input(), deps))).toBe('history_not_isolated')
    tasks.get('task-p-worker')!.session_id = 'sid-never-recorded'
    sessionsByTask.set('task-p-worker', [])
    expect(await code(needsHandoff(ITEM, 'task-p-worker', deps))).toBe('history_not_isolated')
    expect(created).toHaveLength(0)
  })

  it('an unscoped legacy full-tool VP takes the exact yes and receives in its own session', async () => {
    tasks.set('task-vp', task('task-vp', { org_role: 'lead', org_name: 'Ops VP', session_id: 'sid-vp' }))
    sessionsByTask.set('task-vp', [{ claudeSessionId: 'sid-vp', taskId: 'task-vp', archived: false, lastActiveAt: '' } as unknown as SessionRecord])
    const prod: CrossRouteDeps = { ...deps, prepareTarget: undefined, startSession: vi.fn() }
    const id = await askAndAnswer('approve', { targetTaskId: 'task-vp' })
    expect(created[0].what).toContain('Ops VP')
    expect(await crossRouteItem(input({ targetTaskId: 'task-vp', approvalId: id }), prod)).toMatchObject({ route: { status: 'routed' } })
    expect(deps.send.mock.calls[0][0].to).toBe('sid-vp')
    expect(prod.startSession).not.toHaveBeenCalled()
  })

  it('production receiver: starts one only when none exists, and refuses an area profile for unscoped work', async () => {
    let records: SessionRecord[] = []
    const startSession = vi.fn(async () => { records = [{ claudeSessionId: 'sid-loose', taskId: 'task-loose', archived: false, lastActiveAt: '', profile: { areaId: 'personal' } } as unknown as SessionRecord] })
    const prod: CrossRouteDeps = { ...deps, prepareTarget: undefined, sessions: async () => records, startSession }
    const id = await askAndAnswer('approve', { targetTaskId: 'task-loose' })
    const out = await crossRouteItem(input({ targetTaskId: 'task-loose', approvalId: id }), prod)
    expect(startSession).toHaveBeenCalledWith({ taskIdPrefix: 'task-loose', source: 'api-agent', idle: true, awaitStart: true, expectReply: false })
    expect(out).toMatchObject({ route: { status: 'failed', error: expect.stringContaining('not in the target') } })
    expect(deps.send).not.toHaveBeenCalled()

    records = [{ claudeSessionId: 'sid-loose-2', taskId: 'task-loose', archived: false, lastActiveAt: '' } as unknown as SessionRecord]
    const id2 = await askAndAnswer('approve', { targetTaskId: 'task-loose', source: { ...ITEM_2 } })
    await crossRouteItem(input({ targetTaskId: 'task-loose', source: { ...ITEM_2 }, approvalId: id2 }), prod)
    expect(startSession).toHaveBeenCalledTimes(1)
    expect(deps.send.mock.calls[0][0].to).toBe('sid-loose-2')
  })
})

describe('crossRouteItem under the area route lock', () => {
  function holder() {
    let release!: () => void
    let holding!: () => void
    const held = new Promise<void>((resolve) => { holding = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    return { held, release: () => release(), work: async () => { holding(); await gate } }
  }

  it('an approved handoff waiting for a rollback reads the router again and claims nothing once it is paused', async () => {
    const id = await askAndAnswer('approve')
    const rollback = holder()
    const held = withLedgerRouteLock(store, rollback.work)
    await rollback.held
    const handoff = crossRouteItem(input({ approvalId: id }), deps).then(() => 'handed', (e: { code?: string }) => e.code)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(deps.resolve).not.toHaveBeenCalled()
    areas.routers[0].paused = true
    tasks.get('task-p-router')!.router_paused = true
    rollback.release()
    await held
    expect(await handoff).toBe('area_forbidden')
    expect(await store.getSource(ITEM)).toBeUndefined()
    expect(await store.hasRouterDecisions()).toBe(false)
    expect(deps.send).not.toHaveBeenCalled()
  })

  it('holds the lock from the gate through the send and settle', async () => {
    const id = await askAndAnswer('approve')
    const probes: string[] = []
    deps.send.mockImplementation(async () => {
      probes.push(await withLedgerRouteLock(store, async () => 'free', { timeoutMs: 30 }).catch((e) => e instanceof RouteLockBusyError ? 'held' : String(e)))
      return { ok: true }
    })
    expect(await crossRouteItem(input({ approvalId: id }), deps)).toMatchObject({ status: 'receipt', fresh: true, route: { status: 'routed' } })
    expect(probes).toEqual(['held'])
  })
})

describe('crossRouteItem: a fresh handoff looks again after every wait', () => {
  it('a change while the receiver is prepared refuses, with the yes unspent', async () => {
    deps.prepareTarget = async () => { areas.areas[1].taskIds = ['task-w-router']; tasks.get('task-w-worker')!.router_area_id = undefined; return 'sid-w-worker' }
    const id = await askAndAnswer('approve')
    expect(await crossRouteItem(input({ approvalId: id }), deps)).toMatchObject({ fresh: true, route: { status: 'failed', error: expect.stringContaining('changed') } })
    expect(deps.send).not.toHaveBeenCalled()
    expect(waits).toBe(0)
  })

  it('a prepared receiver outside the target\'s scope is refused before the yes is used', async () => {
    deps.prepareTarget = async () => 'sid-elsewhere'
    const id = await askAndAnswer('approve')
    expect(await crossRouteItem(input({ approvalId: id }), deps)).toMatchObject({ route: { status: 'failed', error: expect.stringContaining('not in the target') } })
    expect(deps.send).not.toHaveBeenCalled()
    expect(waits).toBe(0)
  })
})

describe('crossRouteItem: a person\'s explicit retry', () => {
  const notReadyOnce = () => vi.fn().mockRejectedValueOnce(new RouterError('receiver_not_ready', 'not ready')).mockResolvedValue('sid-w-worker')

  it('refuses a missing, uncertain, in-flight or delivered row and a changed target or reason', async () => {
    const ITEM_3: RouterSource = { kind: 'mail', account: SHARED, message: 'INBOX:1:13', version: 'fixture-delivery-3' }
    areas.items.push({ source: { ...ITEM_3 }, areaId: 'personal' })
    expect(await code(crossRouteItem(input({ retry: true }), deps))).toBe('retry_not_safe')
    deps.send.mockRejectedValueOnce(new Error('socket closed'))
    const id = await askAndAnswer('approve')
    expect(await crossRouteItem(input({ approvalId: id }), deps)).toMatchObject({ route: { status: 'unknown' } })
    expect(await code(crossRouteItem(input({ retry: true, approvalId: id }), deps))).toBe('retry_not_safe')
    const id2 = await askAndAnswer('approve', { source: { ...ITEM_2 } })
    expect(await crossRouteItem(input({ source: { ...ITEM_2 }, approvalId: id2 }), deps)).toMatchObject({ route: { status: 'routed' } })
    expect(await code(crossRouteItem(input({ source: { ...ITEM_2 }, retry: true }), deps))).toBe('retry_not_safe')
    await store.claim({ source: { ...ITEM_3 }, key: routerKey(ITEM_3), sender: 's', subject: 'x' },
      { status: 'routing', taskId: 'task-w-worker', reason: input().reason, byTaskId: 'task-p-router' })
    expect(await code(crossRouteItem(input({ source: { ...ITEM_3 }, retry: true }), deps))).toBe('retry_not_safe')
    expect(deps.send).toHaveBeenCalledTimes(2)
  })

  it('a receiver that was not ready leaves the yes unspent; the retry uses it once under the same message id', async () => {
    deps.prepareTarget = notReadyOnce()
    const id = await askAndAnswer('approve')
    expect(await crossRouteItem(input({ approvalId: id }), deps)).toMatchObject({ fresh: true, route: { status: 'failed' } })
    expect(waits).toBe(0)
    expect(await crossRouteItem(input({ approvalId: id }), deps)).toMatchObject({ fresh: false, route: { status: 'failed' } })
    expect(deps.send).not.toHaveBeenCalled()
    expect(await code(crossRouteItem(input({ retry: true, reason: 'Another reason entirely.' }), deps))).toBe('retry_not_safe')
    expect(await code(crossRouteItem(input({ retry: true, targetTaskId: 'task-loose' }), deps))).toBe('retry_not_safe')
    expect(await crossRouteItem(input({ retry: true }), deps)).toMatchObject({ fresh: true, route: { status: 'routed' } })
    expect(waits).toBe(1)
    expect(created).toHaveLength(1)
    expect(deps.send).toHaveBeenCalledTimes(1)
    expect(deps.send.mock.calls[0][0].messageId).toBe(routerMessageId('personal', routerKey(ITEM), 'task-w-worker'))
    expect(await code(crossRouteItem(input({ retry: true }), deps))).toBe('retry_not_safe')
  })

  it('a used yes is retried from its proven frozen payload, never used or asked again', async () => {
    deps.send.mockRejectedValueOnce(new RouterError('queue_full', 'full'))
    const id = await askAndAnswer('approve')
    expect(await crossRouteItem(input({ approvalId: id }), deps)).toMatchObject({ route: { status: 'failed' } })
    expect(waits).toBe(1)
    body = 'Cached body v2 changed later'
    expect(await crossRouteItem(input({ retry: true, approvalId: id }), deps)).toMatchObject({ fresh: true, route: { status: 'routed' } })
    expect(waits).toBe(1)
    expect(created).toHaveLength(1)
    expect(deps.send).toHaveBeenCalledTimes(2)
    expect(deps.send.mock.calls[1][0].messageId).toBe(deps.send.mock.calls[0][0].messageId)
    expect(deps.send.mock.calls[1][0].text).toContain('Cached body v1')
    expect(deps.send.mock.calls[1][0].text).not.toContain('v2')
  })

  it('a taken approval with no proof of its use needs repair, not a resend', async () => {
    failWait = true
    const id = await askAndAnswer('approve')
    expect(await crossRouteItem(input({ approvalId: id }), deps)).toMatchObject({ route: { status: 'failed' } })
    failWait = false
    expect(await code(crossRouteItem(input({ retry: true }), deps))).toBe('repair_needed')
    expect(await code(crossRouteItem(input({ retry: true, approvalId: id }), deps))).toBe('repair_needed')
    expect((await store.getSource(ITEM))?.status).toBe('failed')
    expect(deps.send).not.toHaveBeenCalled()
  })

  it('a retry after a rename refuses before the row moves', async () => {
    deps.prepareTarget = notReadyOnce()
    const id = await askAndAnswer('approve')
    await crossRouteItem(input({ approvalId: id }), deps)
    tasks.get('task-w-worker')!.title = 'Renamed desk'
    expect(await code(crossRouteItem(input({ retry: true }), deps))).toBe('handoff_changed')
    expect((await store.getSource(ITEM))?.status).toBe('failed')
    expect(deps.send).not.toHaveBeenCalled()
    expect(waits).toBe(0)
  })

  it('two parallel retries deliver once', async () => {
    deps.prepareTarget = notReadyOnce()
    const id = await askAndAnswer('approve')
    await crossRouteItem(input({ approvalId: id }), deps)
    const both = await Promise.allSettled([crossRouteItem(input({ retry: true }), deps), crossRouteItem(input({ retry: true, approvalId: id }), deps)])
    expect(both.filter((r) => r.status === 'fulfilled' && r.value.status === 'receipt' && r.value.fresh)).toHaveLength(1)
    expect(both.filter((r) => r.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: 'retry_not_safe' }) })])
    expect((await store.getSource(ITEM))?.status).toBe('routed')
    expect(deps.send).toHaveBeenCalledTimes(1)
    expect(waits).toBe(1)
  })
})

describe('crossRouteItem with a confirmed routing rule', () => {
  it('freezes the rule at the ask and carries it onto the receipt, the receiver\'s text and the route view', async () => {
    const id = await askAndAnswer('approve', { ruleId: 'dock-invoices' })
    expect(created[0].detail).toContain('Routing rule: dock-invoices')
    const out = await crossRouteItem(input({ approvalId: id, ruleId: 'dock-invoices' }), deps)
    expect(out).toMatchObject({ status: 'receipt', fresh: true, route: { status: 'routed', ruleId: 'dock-invoices' } })
    expect(await store.getSource(ITEM)).toMatchObject({ ruleId: 'dock-invoices' })
    expect(deps.send.mock.calls[0][0].text).toContain('Routing rule: dock-invoices')
    const views = deps.emit.mock.calls.map((call) => call[1] as { status: string; ruleId?: string })
    expect(views.map((v) => v.status)).toEqual(['routing', 'routed'])
    expect(views.every((v) => v.ruleId === 'dock-invoices')).toBe(true)
  })

  it('a yes is used only with the rule it was asked with, never a rule checked later', async () => {
    const id = await askAndAnswer('approve', { ruleId: 'dock-invoices' })
    expect(await code(crossRouteItem(input({ approvalId: id, ruleId: 'dock-other' }), deps))).toBe('handoff_changed')
    expect(await code(crossRouteItem(input({ approvalId: id }), deps))).toBe('handoff_changed')
    expect(await store.getSource(ITEM)).toBeUndefined()
    expect(deps.send).not.toHaveBeenCalled()
    expect(waits).toBe(0)
    expect(await crossRouteItem(input({ approvalId: id, ruleId: 'dock-invoices' }), deps)).toMatchObject({ route: { status: 'routed', ruleId: 'dock-invoices' } })
  })

  it('an ask made with no rule stays usable with no rule, and never takes one on later', async () => {
    const id = await askAndAnswer('approve')
    expect(await code(crossRouteItem(input({ approvalId: id, ruleId: 'dock-invoices' }), deps))).toBe('handoff_changed')
    const out = await crossRouteItem(input({ approvalId: id }), deps)
    expect(out).toMatchObject({ status: 'receipt', route: { status: 'routed' } })
    expect(out.status === 'receipt' && out.route).not.toHaveProperty('ruleId')
    expect(deps.send.mock.calls[0][0].text).not.toContain('Routing rule')
  })

  it('a retry keeps the rule of the failed handoff', async () => {
    deps.send.mockRejectedValueOnce(new RouterError('receiver_not_isolated', 'no'))
    const id = await askAndAnswer('approve', { ruleId: 'dock-invoices' })
    expect(await crossRouteItem(input({ approvalId: id, ruleId: 'dock-invoices' }), deps)).toMatchObject({ route: { status: 'failed' } })
    expect(await code(crossRouteItem(input({ retry: true, ruleId: 'dock-other' }), deps))).toBe('retry_not_safe')
    expect(await code(crossRouteItem(input({ retry: true }), deps))).toBe('retry_not_safe')
    expect(deps.send).toHaveBeenCalledTimes(1)
  })

  it('refuses a rule id that is not one before any ask', async () => {
    expect(await code(crossRouteItem(input({ ruleId: ' x' }), deps))).toBe('bad_rule')
    expect(created).toHaveLength(0)
  })
})
