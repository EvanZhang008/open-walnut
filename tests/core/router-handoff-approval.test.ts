/**
 * A cross-area Router handoff asks the person once and is delivered once, with the payload
 * frozen at the ask. The approvals store is a fake here, so nothing is pushed or really approved.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { approvalDigest } from '../../src/core/approvals/digest.js'
import type { CreateInput } from '../../src/core/approvals/store.js'
import type { ApprovalRecord } from '../../src/core/approvals/types.js'
import { routerKey } from '../../src/core/router/store.js'
import {
  HANDOFF_CLAIM_GRACE_MS, claimHandoffApproval, handoffDigest as handoffDigestOf, handoffApprovalsPath, handoffSnapshotPath, ownedClaimedHandoff, peekHandoff,
  handoffAsksForSources, handoffWaitingSources, requestHandoffApproval, routerHandoffsForItem, type HandoffDeps, type HandoffIdentity, type HandoffSnapshot,
} from '../../src/core/router/handoff-approval.js'

let home: string
let clock: number
let keys: number
let recs: Map<string, ApprovalRecord>
let tokens: Map<string, string>
let created: CreateInput[]
let waits: number
let onCreate: (() => void) | undefined
let deps: HandoffDeps

const SOURCE = { kind: 'mail' as const, account: 'desk@marina.example.invalid', message: 'INBOX:1:42' }

function snapshot(extra: Partial<HandoffSnapshot> = {}): HandoffSnapshot {
  return {
    areaId: 'personal', source: { ...SOURCE }, canonicalKey: 'mail:desk:<m42@marina.example.invalid>',
    targetTaskId: 'task-work-1', targetScope: 'work', byTaskId: 'task-router-p', brief: 'Please review the invoice.',
    reason: 'The invoice is work, not personal.',
    content: {
      item: { source: { ...SOURCE }, key: 'mail:desk:<m42@marina.example.invalid>', sender: 'billing@acme.example.invalid', subject: 'Invoice 42' },
      body: { text: 'Original cached body v1' }, bodyAvailable: true, attachments: [], attachmentsAvailable: false,
    },
    ...extra,
  }
}
function editSnapshot(digest: string, edit: (s: HandoffSnapshot) => void): void {
  const file = handoffSnapshotPath(digest, home)
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  edit(saved.snapshot)
  fs.writeFileSync(file, JSON.stringify(saved))
}
const itemFor = (message: string, body: string): HandoffSnapshot => {
  const source = { ...SOURCE, message }
  const base = snapshot()
  return { ...base, source, canonicalKey: `key-${message}`, content: { ...base.content, item: { ...base.content.item, source, key: `key-${message}` }, body: { text: body } } }
}
const identity = (s: HandoffSnapshot): HandoffIdentity => { const { content: _c, ...rest } = s; return structuredClone(rest) }

function answer(id: string, decision: 'approve' | 'deny'): void {
  const rec = recs.get(id)!
  rec.status = decision === 'approve' ? 'approved' : 'denied'
  rec.answer = { decision, at: new Date(clock).toISOString(), mode: 'tap', device: { name: 'phone', kind: 'iphone' } }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-approval-'))
  clock = Date.parse('2026-11-07T10:00:00.000Z')
  keys = 0
  recs = new Map()
  tokens = new Map()
  created = []
  waits = 0
  onCreate = undefined
  deps = {
    home,
    now: () => clock,
    activeKeyCount: async () => keys,
    livePendingIds: async () => new Set([...recs.values()].filter((r) => r.status === 'pending' && Date.parse(r.expiresAt) > clock).map((r) => r.id)),
    createApproval: async (input) => {
      created.push(input)
      const id = `apr-${created.length}`
      const createdAt = new Date(clock).toISOString()
      const expiresAt = new Date(clock + (input.timeoutMs ?? 600_000)).toISOString()
      const rec: ApprovalRecord = {
        id, what: input.what, detail: input.detail, mode: input.mode, requester: input.requester, createdAt, expiresAt,
        status: 'pending', waitTokenHash: 'hidden', ...(input.guard ? { guard: input.guard } : {}), ...(input.testRun ? { testRun: input.testRun } : {}),
        digest: approvalDigest({ id, mode: input.mode, createdAt, expiresAt, host: input.requester.host, taskId: input.requester.taskId, what: input.what, detail: input.detail }),
      }
      recs.set(id, rec)
      tokens.set(id, `token-${id}`)
      onCreate?.()
      const { waitTokenHash: _h, ...view } = rec
      return { approval: structuredClone(view), waitToken: `token-${id}` }
    },
    getApproval: async (id) => {
      const rec = recs.get(id)
      if (rec?.status === 'pending' && Date.parse(rec.expiresAt) <= clock) rec.status = 'expired'
      return rec && structuredClone(rec)
    },
    // The real store's rule: the first read of a decision uses it, a quick re-read sees used: false.
    waitApproval: async (id, token) => {
      waits++
      const rec = recs.get(id)!
      if (tokens.get(id) !== token) throw Object.assign(new Error('bad token'), { code: 'bad_token' })
      if (rec.status !== 'approved' && rec.status !== 'denied') return { approval: structuredClone(rec), used: false }
      if (rec.consumedAt) return { approval: structuredClone(rec), used: false }
      rec.consumedAt = new Date(clock).toISOString()
      return { approval: structuredClone(rec), used: true }
    },
    cancelApproval: async (id) => { const rec = recs.get(id); if (rec?.status === 'pending') rec.status = 'canceled' },
  }
})

afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

const code = async (p: Promise<unknown>): Promise<string> => p.then(() => 'resolved', (e: { code?: string }) => e.code ?? String(e))

describe('router handoff approval', () => {
  it('keeps approval and frozen read authority on one version of a reused handle', async () => {
    const first = snapshot();
    first.source.version = 'first';
    first.content.item.source.version = 'first';
    first.canonicalKey = 'versioned-first';
    first.content.item.key = first.canonicalKey;
    const ticket = await requestHandoffApproval(first, {}, deps);
    answer(ticket.approvalId, 'approve');
    await claimHandoffApproval(ticket.approvalId, identity(first), deps);
    expect(await ownedClaimedHandoff(first.source, first.targetTaskId, deps)).toEqual(first);
    expect(await ownedClaimedHandoff({ ...first.source, version: 'second' }, first.targetTaskId, deps)).toBeUndefined();
    expect(await ownedClaimedHandoff({ kind: first.source.kind, account: first.source.account, message: first.source.message }, first.targetTaskId, deps)).toBeUndefined();
    const second = structuredClone(first);
    second.source.version = 'second';
    second.content.item.source.version = 'second';
    second.canonicalKey = 'versioned-second';
    second.content.item.key = second.canonicalKey;
    expect((await requestHandoffApproval(second, {}, deps)).approvalId).not.toBe(ticket.approvalId);
  });

  it('asks once for the same snapshot and shows the person exactly what goes where', async () => {
    const a = await requestHandoffApproval(snapshot(), { targetTitle: 'Accounts payable', routerTitle: 'Personal router', host: 'mac' }, deps)
    const b = await requestHandoffApproval(snapshot(), { targetTitle: 'Accounts payable', routerTitle: 'Personal router', host: 'mac' }, deps)
    expect(b).toEqual(a)
    expect(Object.keys(a).sort()).toEqual(['approvalId', 'digest', 'status'])
    expect(a.status).toBe('pending')
    expect(created).toHaveLength(1)
    const ask = created[0]
    expect(ask.guard).toBe('person')
    expect(ask.mode).toBe('tap')
    expect(ask.downgraded).toBeUndefined()
    expect(ask.requester).toEqual({ host: 'mac', taskId: 'task-router-p', taskTitle: 'Personal router' })
    for (const part of ['Accounts payable', 'task-work-1', 'target area: work', 'INBOX:1:42', 'ONE incoming item', 'Please review the invoice.', 'Original cached body v1']) {
      expect(ask.detail).toContain(part)
    }
    expect(JSON.stringify(a)).not.toContain('token-')
    expect(fs.statSync(handoffApprovalsPath(home)).mode & 0o077).toBe(0)
  })

  it('asks for Face ID or Touch ID when a device signs', async () => {
    keys = 1
    await requestHandoffApproval(snapshot(), {}, deps)
    expect(created[0].mode).toBe('biometric')
  })

  it('a different target or brief is a different ask', async () => {
    const a = await requestHandoffApproval(snapshot(), {}, deps)
    const b = await requestHandoffApproval(snapshot({ targetTaskId: 'task-work-2' }), {}, deps)
    const c = await requestHandoffApproval(snapshot({ brief: 'Pay it today.' }), {}, deps)
    expect(new Set([a.approvalId, b.approvalId, c.approvalId]).size).toBe(3)
  })

  it('cuts a long body to a marked excerpt but keeps the full payload frozen', async () => {
    const long = 'x'.repeat(80_000)
    const s = snapshot({ content: { ...snapshot().content, body: { text: long } } })
    const t = await requestHandoffApproval(s, {}, deps)
    expect(created[0].detail!.length).toBeLessThanOrEqual(32_000)
    expect(created[0].detail).toMatch(/Excerpt of the body: the first \d+ of 80000 characters\. The full body is saved with this request, sha256 [0-9a-f]{64}/)
    answer(t.approvalId, 'approve')
    const won = await claimHandoffApproval(t.approvalId, identity(s), deps)
    expect(won.status === 'claimed' && won.snapshot.content.body?.text).toBe(long)
  })

  it('pending stays pending; a deny delivers nothing and the same ask stays denied', async () => {
    const s = snapshot()
    const t = await requestHandoffApproval(s, {}, deps)
    expect(await claimHandoffApproval(t.approvalId, identity(s), deps)).toEqual({ status: 'pending', approvalId: t.approvalId, digest: t.digest })
    answer(t.approvalId, 'deny')
    expect(await code(claimHandoffApproval(t.approvalId, identity(s), deps))).toBe('denied')
    expect(await requestHandoffApproval(s, {}, deps)).toEqual({ ...t, status: 'denied' })
    expect(created).toHaveLength(1)
    expect(waits).toBe(0)
  })

  it('an unanswered ask expires, a stale yes cannot be used, and a new request asks anew', async () => {
    const s = snapshot()
    const t = await requestHandoffApproval(s, { timeoutMs: 60_000 }, deps)
    clock += 61_000
    expect(await code(claimHandoffApproval(t.approvalId, identity(s), deps))).toBe('expired')
    const again = await requestHandoffApproval(s, { timeoutMs: 60_000 }, deps)
    expect(again.approvalId).not.toBe(t.approvalId)
    answer(again.approvalId, 'approve')
    clock += HANDOFF_CLAIM_GRACE_MS + 1
    expect(await code(claimHandoffApproval(again.approvalId, identity(s), deps))).toBe('expired')
  })

  it('only the asking router, with the same item, target, brief and reason, may use it', async () => {
    const s = snapshot()
    const t = await requestHandoffApproval(s, {}, deps)
    answer(t.approvalId, 'approve')
    expect(await code(claimHandoffApproval(t.approvalId, { ...identity(s), byTaskId: 'task-router-w' }, deps))).toBe('not_owner')
    expect(await code(claimHandoffApproval(t.approvalId, { ...identity(s), source: { ...SOURCE, account: 'other@acme.example.invalid' } }, deps))).toBe('handoff_changed')
    expect(await code(claimHandoffApproval(t.approvalId, { ...identity(s), targetTaskId: 'task-work-2' }, deps))).toBe('handoff_changed')
    expect(await code(claimHandoffApproval(t.approvalId, { ...identity(s), areaId: 'work' }, deps))).toBe('handoff_changed')
    expect(await code(claimHandoffApproval(t.approvalId, { ...identity(s), brief: 'Changed brief' }, deps))).toBe('handoff_changed')
    expect(await code(claimHandoffApproval(t.approvalId, { ...identity(s), reason: 'Changed reason' }, deps))).toBe('handoff_changed')
    expect(await code(claimHandoffApproval('apr-made-up', identity(s), deps))).toBe('not_found')
    expect(await code(peekHandoff(t.approvalId, { ...identity(s), byTaskId: 'task-router-w' }, deps))).toBe('not_owner')
    expect(waits).toBe(0)
    expect((await claimHandoffApproval(t.approvalId, identity(s), deps)).status).toBe('claimed')
  })

  it('refuses an approval whose shown text changed or that lost its person guard', async () => {
    const s = snapshot()
    const t = await requestHandoffApproval(s, {}, deps)
    answer(t.approvalId, 'approve')
    recs.get(t.approvalId)!.detail = 'Something else entirely'
    expect(await code(claimHandoffApproval(t.approvalId, identity(s), deps))).toBe('approval_changed')
    const s2 = snapshot({ brief: 'Second' })
    const t2 = await requestHandoffApproval(s2, {}, deps)
    answer(t2.approvalId, 'approve')
    delete recs.get(t2.approvalId)!.guard
    expect(await code(claimHandoffApproval(t2.approvalId, identity(s2), deps))).toBe('not_person')
    expect(waits).toBe(0)
  })

  it('two claims at once: exactly one wins and the yes is used once', async () => {
    const s = snapshot()
    const t = await requestHandoffApproval(s, {}, deps)
    answer(t.approvalId, 'approve')
    const results = await Promise.allSettled([claimHandoffApproval(t.approvalId, identity(s), deps), claimHandoffApproval(t.approvalId, identity(s), deps)])
    const won = results.filter((r) => r.status === 'fulfilled' && r.value.status === 'claimed')
    const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
    expect(won).toHaveLength(1)
    expect(lost.map((r) => r.reason.code)).toEqual(['already_claimed'])
    expect(waits).toBe(1)
  })

  it('a lost response never sends twice, and a used:false read is never a go', async () => {
    const s = snapshot()
    const t = await requestHandoffApproval(s, {}, deps)
    answer(t.approvalId, 'approve')
    expect((await claimHandoffApproval(t.approvalId, identity(s), deps)).status).toBe('claimed')
    expect(await code(claimHandoffApproval(t.approvalId, identity(s), deps))).toBe('already_claimed')
    expect((await peekHandoff(t.approvalId, identity(s), deps)).state).toBe('claimed')
    // After a claim, continuing needs a new approval, never the old one.
    const next = await requestHandoffApproval(s, {}, deps)
    expect(next.approvalId).not.toBe(t.approvalId)
    expect(next.status).toBe('pending')

    const s2 = snapshot({ brief: 'Other' })
    const t2 = await requestHandoffApproval(s2, {}, deps)
    answer(t2.approvalId, 'approve')
    deps.waitApproval = async (id) => ({ approval: structuredClone(recs.get(id)!), used: false })
    expect(await code(claimHandoffApproval(t2.approvalId, identity(s2), deps))).toBe('approval_used')
    // Fail closed: claimed but undelivered stays unusable, and its receiver reads nothing.
    expect(await code(claimHandoffApproval(t2.approvalId, identity(s2), deps))).toBe('already_claimed')
    expect((await routerHandoffsForItem(SOURCE, 'task-router-p', deps)).find((h) => h.approvalId === t2.approvalId)?.status).toBe('claim_incomplete')
  })

  it('a canceled ask or a yes already used elsewhere delivers nothing', async () => {
    const s = snapshot()
    const t = await requestHandoffApproval(s, {}, deps)
    recs.get(t.approvalId)!.status = 'canceled'
    expect(await code(claimHandoffApproval(t.approvalId, identity(s), deps))).toBe('canceled')
    const s2 = snapshot({ brief: 'Other' })
    const t2 = await requestHandoffApproval(s2, {}, deps)
    answer(t2.approvalId, 'approve')
    recs.get(t2.approvalId)!.consumedAt = new Date(clock).toISOString()
    expect(await code(claimHandoffApproval(t2.approvalId, identity(s2), deps))).toBe('approval_used')
    expect(waits).toBe(0)
  })

  it('the frozen body wins over the caller object and the cache changing later', async () => {
    const s = snapshot()
    const t = await requestHandoffApproval(s, {}, deps)
    s.content.body = { text: 'Cache rewritten v2' }
    expect((await peekHandoff(t.approvalId, identity(s), deps)).snapshot.content.body?.text).toBe('Original cached body v1')
    answer(t.approvalId, 'approve')
    const won = await claimHandoffApproval(t.approvalId, identity(s), deps)
    expect(won.status === 'claimed' && won.snapshot.content.body?.text).toBe('Original cached body v1')
    expect((await ownedClaimedHandoff(SOURCE, 'task-work-1', deps))?.content.body?.text).toBe('Original cached body v1')
    expect(await ownedClaimedHandoff({ ...SOURCE, account: 'other@acme.example.invalid' }, 'task-work-1', deps)).toBeUndefined()
    expect(await ownedClaimedHandoff({ ...SOURCE, message: 'INBOX:1:43' }, 'task-work-1', deps)).toBeUndefined()
    expect(await ownedClaimedHandoff(SOURCE, 'task-work-2', deps)).toBeUndefined()
  })

  it('an unclaimed handoff is not readable as delivered, and a tampered payload is refused', async () => {
    const s = snapshot()
    const t = await requestHandoffApproval(s, {}, deps)
    expect(await ownedClaimedHandoff(SOURCE, 'task-work-1', deps)).toBeUndefined()
    editSnapshot(t.digest, (snap) => { snap.content.body = { text: 'Injected' } })
    answer(t.approvalId, 'approve')
    expect(await code(claimHandoffApproval(t.approvalId, identity(s), deps))).toBe('payload_changed')
  })

  it('an approval whose payload could not be saved is withdrawn', async () => {
    // The ask is made, then the file cannot be written: nothing approvable may stay open.
    onCreate = () => fs.mkdirSync(path.join(handoffApprovalsPath(home), 'blocker'), { recursive: true })
    expect(await code(requestHandoffApproval(snapshot(), {}, deps))).not.toBe('resolved')
    expect(recs.get('apr-1')?.status).toBe('canceled')
  })

  it('the receiver reads only a consumed handoff whose approval still checks out', async () => {
    const s = snapshot()
    const t = await requestHandoffApproval(s, {}, deps)
    answer(t.approvalId, 'approve')
    deps.waitApproval = async (id) => ({ approval: structuredClone(recs.get(id)!), used: false })
    await code(claimHandoffApproval(t.approvalId, identity(s), deps))
    expect(await ownedClaimedHandoff(SOURCE, 'task-work-1', deps)).toBeUndefined()
  })

  it('a renamed target or a target moved to another area needs a new ask', async () => {
    const s = snapshot()
    const t = await requestHandoffApproval(s, { targetTitle: 'Accounts payable' }, deps)
    const renamed = await requestHandoffApproval(s, { targetTitle: 'Payroll' }, deps)
    expect(renamed.approvalId).not.toBe(t.approvalId)
    answer(t.approvalId, 'approve')
    expect(await code(claimHandoffApproval(t.approvalId, { ...identity(s), display: { targetTitle: 'Payroll' } }, deps))).toBe('handoff_changed')
    expect(await code(claimHandoffApproval(t.approvalId, { ...identity(s), targetScope: 'family' }, deps))).toBe('handoff_changed')
    expect((await claimHandoffApproval(t.approvalId, { ...identity(s), display: { targetTitle: 'Accounts payable' } }, deps)).status).toBe('claimed')
  })

  it('lists only this router\'s asks for this exact item, with no content', async () => {
    const t = await requestHandoffApproval(snapshot(), {}, deps)
    await requestHandoffApproval(snapshot({ byTaskId: 'task-router-x' }), {}, deps)
    const other = { ...SOURCE, message: 'INBOX:1:43' }
    await requestHandoffApproval(snapshot({ source: other, content: { ...snapshot().content, item: { ...snapshot().content.item, source: other } } }), {}, deps)
    const list = await routerHandoffsForItem(SOURCE, 'task-router-p', deps)
    expect(list).toEqual([{ approvalId: t.approvalId, canonicalKey: snapshot().canonicalKey, targetTaskId: 'task-work-1', targetScope: 'work',
      brief: 'Please review the invoice.', reason: 'The invoice is work, not personal.', status: 'pending' }])
    expect(JSON.stringify(list)).not.toMatch(/token-|Original cached body/)
  })

  it('refuses a target scope that is neither an area id nor unscoped', async () => {
    expect(await code(requestHandoffApproval(snapshot({ targetScope: '../work' }), {}, deps))).toBe('bad_snapshot')
  })

  it('a claimed snapshot stays readable past a week and past many later asks', async () => {
    const s = snapshot()
    const t = await requestHandoffApproval(s, { timeoutMs: 60_000 }, deps)
    answer(t.approvalId, 'approve')
    await claimHandoffApproval(t.approvalId, identity(s), deps)
    clock += 8 * 24 * 60 * 60_000
    for (let i = 0; i < 3; i++) await requestHandoffApproval(snapshot({ brief: `Later ${i}` }), {}, deps)
    expect((await ownedClaimedHandoff(SOURCE, 'task-work-1', deps))?.brief).toBe('Please review the invoice.')
  })

  it('the saved receipt alone lets the receiver read; a missing or contradicted receipt does not', async () => {
    const s = snapshot()
    const t = await requestHandoffApproval(s, {}, deps)
    answer(t.approvalId, 'approve')
    await claimHandoffApproval(t.approvalId, identity(s), deps)
    const file = handoffApprovalsPath(home)
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(saved.entries[0].proof).toMatchObject({ approvalId: t.approvalId, decision: 'approve', guard: 'person', requesterTaskId: 'task-router-p' })
    // A record that disagrees with the receipt refuses.
    const rec = recs.get(t.approvalId)!
    const at = rec.answer!.at
    rec.answer!.at = new Date(clock + 5).toISOString()
    expect(await ownedClaimedHandoff(SOURCE, 'task-work-1', deps)).toBeUndefined()
    rec.answer!.at = at
    // The approvals store no longer keeping the record: the receipt stands, with no clock involved.
    recs.delete(t.approvalId)
    expect((await ownedClaimedHandoff(SOURCE, 'task-work-1', deps))?.brief).toBe('Please review the invoice.')
    // No receipt, or a forged one, reads nothing.
    const forged = structuredClone(saved)
    forged.entries[0].proof.guard = 'vault'
    fs.writeFileSync(file, JSON.stringify(forged))
    expect(await ownedClaimedHandoff(SOURCE, 'task-work-1', deps)).toBeUndefined()
    delete saved.entries[0].proof
    fs.writeFileSync(file, JSON.stringify(saved))
    expect(await ownedClaimedHandoff(SOURCE, 'task-work-1', deps)).toBeUndefined()
  })

  it('only asks still waiting count against the cap; denied ones stay as history', async () => {
    for (let i = 0; i < 10; i++) {
      const t = await requestHandoffApproval(snapshot({ brief: `Denied ${i}` }), {}, deps)
      answer(t.approvalId, 'deny')
    }
    expect((await requestHandoffApproval(snapshot({ brief: 'New question' }), {}, deps)).status).toBe('pending')
    for (let i = 0; i < 9; i++) await requestHandoffApproval(snapshot({ brief: `Open ${i}` }), {}, deps)
    expect(await code(requestHandoffApproval(snapshot({ brief: 'One too many' }), {}, deps))).toBe('too_many_pending')
    expect((await routerHandoffsForItem(SOURCE, 'task-router-p', deps)).filter((h) => h.status === 'denied')).toHaveLength(10)
  })

  it('refuses content whose key is not the canonical key, and a brief or reason past the route limits', async () => {
    const s = snapshot()
    s.content.item.key = 'mail:desk:<other@marina.example.invalid>'
    expect(await code(requestHandoffApproval(s, {}, deps))).toBe('bad_snapshot')
    expect(await code(requestHandoffApproval(snapshot({ brief: 'b'.repeat(20_001) }), {}, deps))).toBe('bad_snapshot')
    expect(await code(requestHandoffApproval(snapshot({ reason: 'r'.repeat(501) }), {}, deps))).toBe('bad_snapshot')
    expect(created).toHaveLength(0)
  })

  it('a saved handoff that changes or vanishes while its yes is used writes no receipt and returns nothing', async () => {
    const realWait = deps.waitApproval!
    const file = handoffApprovalsPath(home)
    for (const change of ['edit', 'remove'] as const) {
      const s = snapshot({ brief: `Case ${change}` })
      const t = await requestHandoffApproval(s, {}, deps)
      answer(t.approvalId, 'approve')
      deps.waitApproval = async (id, token, ms) => {
        const out = await realWait(id, token, ms)
        if (change === 'edit') editSnapshot(t.digest, (snap) => { snap.content.body = { text: 'Swapped' } })
        else {
          const data = JSON.parse(fs.readFileSync(file, 'utf8'))
          data.entries = data.entries.filter((e: { approvalId: string }) => e.approvalId !== id)
          fs.writeFileSync(file, JSON.stringify(data))
        }
        return out
      }
      expect(await code(claimHandoffApproval(t.approvalId, identity(s), deps))).toBe('proof_not_saved')
    }
    expect(await ownedClaimedHandoff(SOURCE, 'task-work-1', deps)).toBeUndefined()
  })

  it('a used record that differs from the approved one is not a go', async () => {
    const realWait = deps.waitApproval!
    const tampers: Array<(r: ApprovalRecord) => void> = [
      (r) => { r.answer!.at = new Date(clock + 1).toISOString() },
      (r) => { r.requester = { ...r.requester, sessionId: 'sid-1' } },
      (r) => { r.detail = 'Something else' },
      (r) => { r.answer!.mode = 'biometric' },
    ]
    for (const [n, tamper] of tampers.entries()) {
      const s = snapshot({ brief: `Tamper ${n}` })
      const t = await requestHandoffApproval(s, {}, deps)
      answer(t.approvalId, 'approve')
      deps.waitApproval = async (id, token, ms) => {
        const out = await realWait(id, token, ms)
        tamper(out.approval as ApprovalRecord)
        return out
      }
      expect(await code(claimHandoffApproval(t.approvalId, identity(s), deps))).toBe('approval_used')
    }
    expect(await ownedClaimedHandoff(SOURCE, 'task-work-1', deps)).toBeUndefined()
  })

  it('says plainly when the target is outside isolation in the same area, or an older unscoped task', async () => {
    await requestHandoffApproval(snapshot({ targetScope: 'personal' }), {}, deps)
    await requestHandoffApproval(snapshot({ targetScope: 'unscoped', brief: 'Old target' }), {}, deps)
    expect(created[0].detail).toContain('an existing conversation of this area that sits outside its isolated context')
    expect(created[0].detail).not.toContain('another area')
    expect(created[1].detail).toContain('an older task in no area, whose conversation is not isolated')
  })

  it('the index holds no content, and a receiver read opens only its own snapshot', async () => {
    const big = (c: string) => c.repeat(300_000)
    const items = ['INBOX:1:42', 'INBOX:1:43', 'INBOX:1:44'].map((m, i) => itemFor(m, big('abc'[i])))
    const tickets = []
    for (const s of items) tickets.push(await requestHandoffApproval(s, {}, deps))
    answer(tickets[0].approvalId, 'approve')
    await claimHandoffApproval(tickets[0].approvalId, identity(items[0]), deps)
    expect(fs.statSync(handoffApprovalsPath(home)).size).toBeLessThan(20_000)
    const index = fs.readFileSync(handoffApprovalsPath(home), 'utf8')
    expect(index).not.toContain('Please review the invoice.')
    expect(index).not.toContain('The invoice is work, not personal.')
    // The other two snapshots are unreadable: a read that touched them would fail.
    for (const t of tickets.slice(1)) fs.writeFileSync(handoffSnapshotPath(t.digest, home), 'not json')
    expect((await ownedClaimedHandoff(items[0].source, 'task-work-1', deps))?.content.body?.text).toBe(big('a'))
    expect((await routerHandoffsForItem(items[1].source, 'task-router-p', deps)).map((h) => h.approvalId)).toEqual([tickets[1].approvalId])
    expect(await code(claimHandoffApproval(tickets[1].approvalId, identity(items[1]), deps))).toBe('payload_changed')
  })

  it('a missing snapshot file is no handoff, receipt or not', async () => {
    const s = snapshot()
    const t = await requestHandoffApproval(s, {}, deps)
    answer(t.approvalId, 'approve')
    await claimHandoffApproval(t.approvalId, identity(s), deps)
    fs.rmSync(handoffSnapshotPath(t.digest, home))
    expect(await ownedClaimedHandoff(SOURCE, 'task-work-1', deps)).toBeUndefined()
    expect(await code(peekHandoff(t.approvalId, identity(s), deps))).toBe('payload_changed')
  })

  it('an expired ask\'s content goes only after the index without it is saved; a claimed one stays', async () => {
    const kept = snapshot({ brief: 'Claimed one' })
    const k = await requestHandoffApproval(kept, {}, deps)
    answer(k.approvalId, 'approve')
    await claimHandoffApproval(k.approvalId, identity(kept), deps)
    const old = await requestHandoffApproval(snapshot({ brief: 'Old ask' }), { timeoutMs: 60_000 }, deps)
    clock += 60_000 + HANDOFF_CLAIM_GRACE_MS + 24 * 60 * 60_000 + 1
    // A save that fails keeps the old content.
    onCreate = () => {
      fs.renameSync(handoffApprovalsPath(home), `${handoffApprovalsPath(home)}.saved`)
      fs.mkdirSync(path.join(handoffApprovalsPath(home), 'blocker'), { recursive: true })
    }
    expect(await code(requestHandoffApproval(snapshot({ brief: 'Blocked' }), {}, deps))).not.toBe('resolved')
    expect(fs.existsSync(handoffSnapshotPath(old.digest, home))).toBe(true)
    fs.rmSync(handoffApprovalsPath(home), { recursive: true, force: true })
    fs.renameSync(`${handoffApprovalsPath(home)}.saved`, handoffApprovalsPath(home))
    onCreate = undefined
  })

  it('a saved prune removes the expired ask\'s content and keeps the claimed one', async () => {
    const kept = snapshot({ brief: 'Claimed one' })
    const k = await requestHandoffApproval(kept, {}, deps)
    answer(k.approvalId, 'approve')
    await claimHandoffApproval(k.approvalId, identity(kept), deps)
    const old = await requestHandoffApproval(snapshot({ brief: 'Old ask' }), { timeoutMs: 60_000 }, deps)
    clock += 60_000 + HANDOFF_CLAIM_GRACE_MS + 24 * 60 * 60_000 + 1
    await requestHandoffApproval(snapshot({ brief: 'New ask' }), {}, deps)
    expect(fs.existsSync(handoffSnapshotPath(old.digest, home))).toBe(false)
    expect(fs.existsSync(handoffSnapshotPath(k.digest, home))).toBe(true)
    expect((await ownedClaimedHandoff(SOURCE, 'task-work-1', deps))?.brief).toBe('Claimed one')
  })

  it('never drops live asks however many the index holds', async () => {
    const future = new Date(clock + 60 * 60_000).toISOString()
    const seeded = Array.from({ length: 600 }, (_, i) => ({
      approvalId: `apr-seed-${i}`, digest: 'f'.repeat(64), approvalDigest: 'x', waitToken: 'w', mode: 'tap', state: 'pending',
      createdAt: new Date(clock).toISOString(), expiresAt: future, display: {}, identity: identity(snapshot({ byTaskId: 'task-router-seed' })),
    }))
    fs.mkdirSync(path.dirname(handoffApprovalsPath(home)), { recursive: true })
    fs.writeFileSync(handoffApprovalsPath(home), JSON.stringify({ version: 1, entries: seeded }))
    await requestHandoffApproval(snapshot(), {}, deps)
    const after = JSON.parse(fs.readFileSync(handoffApprovalsPath(home), 'utf8')).entries
    expect(after).toHaveLength(601)
  })

  it('rejects content that belongs to another item', async () => {
    const s = snapshot()
    s.content.item.source = { ...SOURCE, message: 'INBOX:1:99' }
    expect(await code(requestHandoffApproval(s, {}, deps))).toBe('bad_snapshot')
    expect(created).toHaveLength(0)
  })

  describe('handoffWaitingSources', () => {
    const KEY = routerKey(SOURCE)
    const held = async () => handoffWaitingSources([SOURCE], 'task-router-p', deps)

    it('holds an item whose only ask is pending, denied, canceled, expired, missing or claimed', async () => {
      const t = await requestHandoffApproval(snapshot(), { timeoutMs: 60_000 }, deps)
      expect(await held()).toEqual(new Set([KEY]))
      for (const end of ['denied', 'canceled'] as const) {
        recs.get(t.approvalId)!.status = end
        expect(await held()).toEqual(new Set([KEY]))
      }
      recs.get(t.approvalId)!.status = 'pending'
      clock += 61_000
      expect(await held()).toEqual(new Set([KEY]))
      recs.delete(t.approvalId)
      expect(await held()).toEqual(new Set([KEY]))
    })

    it('lets a usable yes through exactly until it is used, and holds a half-done claim', async () => {
      const s = snapshot()
      const t = await requestHandoffApproval(s, {}, deps)
      answer(t.approvalId, 'approve')
      expect(await held()).toEqual(new Set())
      await claimHandoffApproval(t.approvalId, identity(s), deps)
      expect(await held()).toEqual(new Set([KEY]))

      const s2 = snapshot({ brief: 'Half done' })
      const t2 = await requestHandoffApproval(s2, {}, deps)
      answer(t2.approvalId, 'approve')
      deps.waitApproval = async (id) => ({ approval: structuredClone(recs.get(id)!), used: false })
      await code(claimHandoffApproval(t2.approvalId, identity(s2), deps))
      expect(await held()).toEqual(new Set([KEY]))
    })

    it('a yes past its claim window or already consumed elsewhere holds', async () => {
      const t = await requestHandoffApproval(snapshot(), {}, deps)
      answer(t.approvalId, 'approve')
      recs.get(t.approvalId)!.consumedAt = new Date(clock).toISOString()
      expect(await held()).toEqual(new Set([KEY]))
      delete recs.get(t.approvalId)!.consumedAt
      clock += HANDOFF_CLAIM_GRACE_MS + 1
      expect(await held()).toEqual(new Set([KEY]))
    })

    it('one usable yes among several asks wakes the item; other routers and items are untouched', async () => {
      const denied = await requestHandoffApproval(snapshot(), {}, deps)
      answer(denied.approvalId, 'deny')
      const yes = await requestHandoffApproval(snapshot({ brief: 'Second ask' }), {}, deps)
      answer(yes.approvalId, 'approve')
      await requestHandoffApproval(snapshot({ byTaskId: 'task-router-w' }), {}, deps)
      const other = { ...SOURCE, message: 'INBOX:1:43' }
      expect(await handoffWaitingSources([SOURCE, other], 'task-router-p', deps)).toEqual(new Set())
      expect(await handoffWaitingSources([SOURCE], 'task-router-w', deps)).toEqual(new Set([KEY]))
      expect(await handoffWaitingSources([other], 'task-router-w', deps)).toEqual(new Set())
    })

    it('never opens a snapshot, broken or 300KB, and makes or uses no approval', async () => {
      const big = itemFor('INBOX:1:42', 'z'.repeat(300_000))
      const t = await requestHandoffApproval(big, {}, deps)
      fs.writeFileSync(handoffSnapshotPath(t.digest, home), 'not json')
      const before = { created: created.length, waits }
      expect(await handoffWaitingSources([big.source], 'task-router-p', deps)).toEqual(new Set([routerKey(big.source)]))
      expect({ created: created.length, waits }).toEqual(before)
      expect(recs.get(t.approvalId)!.status).toBe('pending')
    })

    it('fails closed when the index or an approval cannot be read', async () => {
      await requestHandoffApproval(snapshot(), {}, deps)
      deps.getApproval = async () => { throw new Error('approvals unreadable') }
      await expect(held()).rejects.toThrow(/approvals unreadable/)
      fs.writeFileSync(handoffApprovalsPath(home), '{ broken')
      await expect(held()).rejects.toThrow()
    })
  })

  describe('handoffAsksForSources', () => {
    const KEY = routerKey(SOURCE)
    const asks = async (area = 'personal', routers = ['task-router-p']) => handoffAsksForSources(area, routers, [SOURCE], deps)

    it('names the latest ask of this area\'s router only, with no token, hash or brief', async () => {
      const first = await requestHandoffApproval(snapshot(), { targetTitle: 'Old target' }, deps)
      answer(first.approvalId, 'deny')
      clock += 1000
      const second = await requestHandoffApproval(snapshot({ brief: 'Second ask' }), { targetTitle: 'Accounts payable' }, deps)
      const secondAt = clock
      clock += 1000
      const otherRouter = await requestHandoffApproval(snapshot({ byTaskId: 'task-router-w', brief: 'Other router' }), {}, deps)
      const view = (await asks()).get(KEY)
      expect(view).toEqual({ approvalId: second.approvalId, at: secondAt, status: 'pending', targetTitle: 'Accounts payable' })
      expect(JSON.stringify([...(await asks()).values()])).not.toMatch(/token-|Second ask|[0-9a-f]{64}/)
      expect((await asks('work')).size).toBe(0)
      expect((await asks('personal', ['task-router-x'])).size).toBe(0)
      expect((await asks('personal', [])).size).toBe(0)
      // Across every router of the area (a paused one included), the latest exact ask wins.
      expect((await asks('personal', ['task-router-p', 'task-router-w'])).get(KEY)?.approvalId).toBe(otherRouter.approvalId)
      expect((await handoffAsksForSources('personal', ['task-router-p'], [{ ...SOURCE, message: 'INBOX:1:43' }], deps)).size).toBe(0)
    })

    it('reads each state from the approval record, never as routed', async () => {
      const t = await requestHandoffApproval(snapshot(), { timeoutMs: 60_000 }, deps)
      const status = async () => (await asks()).get(KEY)?.status
      expect(await status()).toBe('pending')
      answer(t.approvalId, 'approve')
      expect(await status()).toBe('approved')
      recs.get(t.approvalId)!.status = 'denied'
      expect(await status()).toBe('denied')
      recs.get(t.approvalId)!.status = 'canceled'
      expect(await status()).toBe('canceled')
      recs.get(t.approvalId)!.status = 'pending'
      clock += 61_000
      expect(await status()).toBe('expired')
      recs.delete(t.approvalId)
      expect(await status()).toBe('missing')
    })

    it('a claim, done or half done, reads as not confirmed here: the receipt says what happened', async () => {
      const s = snapshot()
      const t = await requestHandoffApproval(s, {}, deps)
      answer(t.approvalId, 'approve')
      await claimHandoffApproval(t.approvalId, identity(s), deps)
      expect((await asks()).get(KEY)?.status).toBe('claim_incomplete')
    })

    it('never opens a snapshot and fails when the index or an approval cannot be read', async () => {
      const t = await requestHandoffApproval(snapshot(), {}, deps)
      fs.writeFileSync(handoffSnapshotPath(t.digest, home), 'not json')
      expect((await asks()).get(KEY)?.status).toBe('pending')
      deps.getApproval = async () => { throw new Error('approvals unreadable') }
      await expect(asks()).rejects.toThrow(/approvals unreadable/)
      fs.writeFileSync(handoffApprovalsPath(home), '{ broken')
      await expect(asks()).rejects.toThrow()
    })
  })
})

describe('the routing rule frozen into a handoff', () => {
  it('names the rule in the digest and the ask, and a use must name the same rule', async () => {
    const ruled = snapshot({ ruleId: 'dock-invoices' })
    expect(handoffDigestOf(ruled)).not.toBe(handoffDigestOf(snapshot()))
    expect(handoffDigestOf(ruled)).not.toBe(handoffDigestOf(snapshot({ ruleId: 'dock-other' })))
    const t = await requestHandoffApproval(ruled, {}, deps)
    expect(created[0].detail).toContain('Routing rule: dock-invoices')
    answer(t.approvalId, 'approve')
    for (const other of [identity(snapshot({ ruleId: 'dock-other' })), identity(snapshot())]) {
      expect(await code(peekHandoff(t.approvalId, other, deps))).toBe('handoff_changed')
      expect(await code(claimHandoffApproval(t.approvalId, other, deps))).toBe('handoff_changed')
    }
    expect(waits).toBe(0)
    const used = await claimHandoffApproval(t.approvalId, identity(ruled), deps)
    expect(used).toMatchObject({ status: 'claimed', snapshot: { ruleId: 'dock-invoices' } })
    expect((await routerHandoffsForItem(SOURCE, ruled.byTaskId, deps))[0]).toMatchObject({ ruleId: 'dock-invoices', status: 'claimed' })
  })

  it('reads an ask saved before rules rode along, with no rule key anywhere', async () => {
    const t = await requestHandoffApproval(snapshot(), {}, deps)
    // With no rule, the index entry and snapshot keep the shape older code wrote: no ruleId key.
    const index = JSON.parse(fs.readFileSync(handoffApprovalsPath(home), 'utf8'))
    expect(index.entries[0].identity).not.toHaveProperty('ruleId')
    expect(JSON.parse(fs.readFileSync(handoffSnapshotPath(t.digest, home), 'utf8')).snapshot).not.toHaveProperty('ruleId')
    expect(t.digest).toBe(handoffDigestOf({ ...snapshot(), ruleId: undefined }))
    expect(created[0].detail).not.toContain('Routing rule')
    answer(t.approvalId, 'approve')
    expect(await code(claimHandoffApproval(t.approvalId, identity(snapshot({ ruleId: 'dock-invoices' })), deps))).toBe('handoff_changed')
    const used = await claimHandoffApproval(t.approvalId, identity(snapshot()), deps)
    expect(used.status).toBe('claimed')
    expect(used.status === 'claimed' && used.snapshot).not.toHaveProperty('ruleId')
    expect((await routerHandoffsForItem(SOURCE, 'task-router-p', deps))[0]).not.toHaveProperty('ruleId')
  })

  it('refuses a rule id that is not one', async () => {
    for (const ruleId of ['', ' spaced', 'x'.repeat(61), 7 as unknown as string]) {
      expect(await code(requestHandoffApproval(snapshot({ ruleId }), {}, deps))).toBe('bad_snapshot')
    }
    expect(created).toHaveLength(0)
  })
})
