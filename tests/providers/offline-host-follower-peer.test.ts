/**
 * The daemon's side of a message the host's own Walnut server decided (`follower.peer`,
 * offline-host-core.ts handleFollowerPeer): the same tails as the daemon's own answers. Pinned:
 * a retry of the same call (its op id) is written once, also while the first still writes; a
 * failed write leaves no row; online, what this host cannot be sure of (a prompt, a copy it
 * answered once, a failed write) is left to the server, and its records never pin the gateway
 * away; a held message needs a Mac that drains `held-op`; a reply settles a copy's request once.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupJournalDirs, JHOME, journalHost, journalTmpDir, jslice, SID_A, SID_B, TASK_B } from '../helpers/offline-journal-harness.js'
import { createOfflineHost, type HostSlice } from '../../src/providers/offline-host-core.js'
import { JOURNAL_V2_DRAINS } from '../../src/providers/offline-journal-core.js'

const T0 = Date.parse('2026-11-20T12:00:00Z')

afterEach(() => cleanupJournalDirs())

function host(o: { slice?: HostSlice; drains?: string[]; gate?: Promise<void>; fail?: string } = {}) {
  const h = journalHost(journalTmpDir(), { now: T0 }, { drains: o.drains ?? [...JOURNAL_V2_DRAINS, 'held-op'] })
  const delivered: Array<{ sid: string; text: string; messageId: string }> = []
  const prompts = new Map<string, string>()
  const host = createOfflineHost({
    ...h.deps,
    pendingPrompt: (sid) => prompts.get(sid) ?? null,
    deliver: async (sid, text, messageId) => {
      if (o.gate) await o.gate
      if (o.fail) return { ok: false, reason: o.fail }
      delivered.push({ sid, text, messageId })
      return { ok: true }
    },
  })
  host.configure(o.slice ?? jslice())
  return { host, journal: h.journal, delivered, prompts }
}

const SEND = { kind: 'send', fromSessionId: SID_A, toSessionId: SID_B, toTaskId: TASK_B, text: '<walnut-message kind="peer-note">hi</walnut-message>', dupText: 'hi', messageId: 'qm-host-call1', ask: { id: 'rq-0a0a0a0a0a0a', preview: 'hi', secs: 3600 } }

describe('follower.peer: a send', () => {
  it('registers the row, writes the CLI with the reply line, journals row and delivery', async () => {
    const h = host()
    const r = await h.host.handleFollowerPeer(JHOME, { ...SEND, opId: 'op-send-1' })
    expect(r).toMatchObject({ ok: true, result: { delivered: true, targetSessionId: SID_B, requestId: 'rq-0a0a0a0a0a0a', messageId: 'qm-host-call1' } })
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]!.text).toContain('Reply when done: mcp__walnut__task_send {"in_reply_to":"rq-0a0a0a0a0a0a"')
    expect(h.journal.records(JHOME)).toEqual([
      expect.objectContaining({ kind: 'row', row: expect.objectContaining({ id: 'rq-0a0a0a0a0a0a', status: 'pending', messageId: 'qm-host-call1', deadlineAt: T0 + 3_600_000 }) }),
      expect.objectContaining({ kind: 'delivery', opId: 'op-send-1', requestId: 'rq-0a0a0a0a0a0a', toSessionId: SID_B }),
    ])
  })

  it('a retry of the same call is written once, also while the first still writes', async () => {
    let open!: () => void
    const gate = new Promise<void>((r) => { open = r })
    const h = host({ gate })
    const first = h.host.handleFollowerPeer(JHOME, { ...SEND, opId: 'op-send-2' })
    const second = h.host.handleFollowerPeer(JHOME, { ...SEND, opId: 'op-send-2' })
    open()
    const [a, b] = await Promise.all([first, second])
    expect(a).toMatchObject({ ok: true })
    expect(b).toMatchObject({ ok: true, result: { duplicate: true, requestId: 'rq-0a0a0a0a0a0a' } })
    const later = await h.host.handleFollowerPeer(JHOME, { ...SEND, opId: 'op-send-2', ask: { id: 'rq-0b0b0b0b0b0b', preview: 'hi', secs: 60 } })
    expect(later).toMatchObject({ ok: true, result: { duplicate: true, requestId: 'rq-0a0a0a0a0a0a', messageId: 'qm-host-call1' } })
    expect(h.delivered).toHaveLength(1)
    expect(h.journal.records(JHOME)).toHaveLength(2)
  })

  it('a failed write leaves no row: away it fails, online it is the server\'s', async () => {
    const h = host({ fail: 'fifo_closed' })
    expect(await h.host.handleFollowerPeer(JHOME, { ...SEND, opId: 'op-send-3' })).toMatchObject({ ok: false, error: { code: 'internal' } })
    expect(await h.host.handleFollowerPeer(JHOME, { ...SEND, online: true, opId: 'op-send-4' })).toMatchObject({ ok: false, error: { code: 'needs_leader', detail: { why: 'server_delivers' } } })
    expect(h.journal.records(JHOME)).toEqual([])
    expect(h.host.journal.state(JHOME)).toMatchObject({ rows: {} })
  })

  it('online: a target on a prompt is the server\'s; its records are online and never pin the gateway', async () => {
    const h = host()
    h.prompts.set(SID_B, 'Bash')
    expect(await h.host.handleFollowerPeer(JHOME, { ...SEND, online: true, opId: 'op-send-5' })).toMatchObject({ ok: false, error: { code: 'needs_leader' } })
    h.prompts.clear()
    expect(await h.host.handleFollowerPeer(JHOME, { ...SEND, online: true, opId: 'op-send-6' })).toMatchObject({ ok: true })
    expect((h.journal.records(JHOME) as unknown as Array<{ online?: boolean; row?: { online?: boolean } }>).every((x) => x.online === true)).toBe(true)
    expect((h.journal.records(JHOME) as unknown as Array<{ row?: { online?: boolean } }>)[0]!.row!.online).toBe(true)
    expect(h.host.pendingHandover(JHOME)).toBe(false)
  })

  it('its row is watched as the daemon\'s own: the target ends its turn without replying, the asker hears it', async () => {
    const h = host()
    await h.host.handleFollowerPeer(JHOME, { ...SEND, opId: 'op-send-8' })
    await h.host.onResult(SID_B, JSON.stringify({ type: 'result', subtype: 'success', result: 'finished' }))
    expect(h.delivered.map((d) => d.sid)).toEqual([SID_B, SID_A])
    expect(h.delivered[1]!.text).toContain('rq-0a0a0a0a0a0a')
    expect(h.journal.records(JHOME)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'row', row: expect.objectContaining({ id: 'rq-0a0a0a0a0a0a', status: 'notified' }) })]))
  })

  it('a target that is not live here, or not of this Walnut, is refused before anything is written', async () => {
    const h = host()
    expect(await h.host.handleFollowerPeer(JHOME, { ...SEND, toSessionId: 'ffffffff-0000-4000-8000-000000000000', opId: 'op-send-7' }))
      .toMatchObject({ ok: false, error: { code: 'needs_leader', detail: { why: 'not_running_here' } } })
    expect(await h.host.handleFollowerPeer(JHOME, { ...SEND, opId: 'bad op id' })).toMatchObject({ ok: false, error: { code: 'bad_request' } })
    expect(h.delivered).toEqual([])
  })
})

describe('follower.peer: a reply', () => {
  const copy = { id: 'rq-c0c0c0c0c0c0', fromSessionId: SID_A, toSessionId: SID_B, toTaskId: TASK_B, preview: 'p', status: 'pending' as const, createdAt: '2026-11-20T11:00:00Z', deadlineAt: T0 }
  const REPLY = { kind: 'reply', fromSessionId: SID_B, toSessionId: SID_A, requestId: copy.id, text: 'done', messageId: 'qm-host-reply1', replierTaskId: TASK_B, score: { function: 9 } }

  it('settles a copy\'s request with its score, and an online second answer to it is the server\'s', async () => {
    const h = host({ slice: jslice({ requests: [copy] }) })
    expect(await h.host.handleFollowerPeer(JHOME, { ...REPLY, opId: 'op-reply-1' })).toMatchObject({ ok: true, result: { repliedTo: copy.id } })
    expect(h.journal.records(JHOME)).toEqual([
      expect.objectContaining({ kind: 'settle', requestId: copy.id, status: 'replied', score: expect.objectContaining({ function: 9, taskId: TASK_B }) }),
      expect.objectContaining({ kind: 'delivery', reply: true, requestId: copy.id, opId: 'op-reply-1' }),
    ])
    expect(await h.host.handleFollowerPeer(JHOME, { ...REPLY, online: true, opId: 'op-reply-2' })).toMatchObject({ ok: false, error: { code: 'needs_leader' } })
    expect(h.delivered).toHaveLength(1)
  })

  it('the other requests one answer covers settle with it', async () => {
    const two = { ...copy, id: 'rq-c1c1c1c1c1c1' }
    const h = host({ slice: jslice({ requests: [copy, two] }) })
    const r = await h.host.handleFollowerPeer(JHOME, { ...REPLY, alsoSettle: [two.id], part: 1, opId: 'op-reply-3' })
    expect(r).toMatchObject({ ok: true, result: { alsoSettled: [two.id] } })
    expect(h.journal.records(JHOME).map((x) => [x.kind, (x as { requestId?: string }).requestId])).toEqual([['settle', copy.id], ['delivery', copy.id], ['settle', two.id]])
    // Its own key per asker's part of the call.
    expect(h.journal.records(JHOME)[1]).toMatchObject({ opId: 'op-reply-3-p1' })
  })
})

describe('follower.peer: a held message', () => {
  const HOLD = { kind: 'hold', fromSessionId: SID_A, args: { to: 'mtaskzzz-0009', text: 'later', messageId: 'qm-host-call9' }, callId: 'oc-call9call9call9' }

  it('is held under its call id for a Mac that drains held-op, once', async () => {
    const h = host()
    expect(await h.host.handleFollowerPeer(JHOME, { ...HOLD, opId: 'op-hold-1' })).toMatchObject({ ok: true, result: { held: true, op: 'task_send' } })
    expect(await h.host.handleFollowerPeer(JHOME, { ...HOLD, opId: 'op-hold-2' })).toMatchObject({ ok: true, result: { held: true } })
    expect(h.journal.records(JHOME)).toEqual([expect.objectContaining({ kind: 'op', op: 'task_send', opId: 'held-call9call9call9', callId: 'oc-call9call9call9', callerSid: SID_A })])
  })

  it('an older Mac that drains no held-op: needs the Mac, nothing journaled', async () => {
    const h = host({ drains: JOURNAL_V2_DRAINS.filter((k) => k !== 'held-op') })
    expect(await h.host.handleFollowerPeer(JHOME, { ...HOLD, opId: 'op-hold-3' })).toMatchObject({ ok: false, error: { code: 'needs_leader', detail: { why: 'not_held' } } })
    expect(await h.host.handleFollowerPeer(JHOME, { ...HOLD, online: true, opId: 'op-hold-4' })).toMatchObject({ ok: false, error: { code: 'bad_request' } })
    expect(h.journal.records(JHOME)).toEqual([])
  })
})
