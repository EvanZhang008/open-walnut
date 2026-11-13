/**
 * A task's MEMORY.md append while its Walnut server is away (offline-host-core.ts
 * opAgentMemoryWrite): an org reflection run on an always-on host writes the owner's memory
 * (src/core/routines/offline-run.ts). The host saves the entry as an `agent-memory` record, only
 * for a leading Mac that drains `agent-memory` (an older Mac's drain never asks for the kind, so
 * the record waits); the Mac adds it to the file as it stands then (apply-agent-memory.ts), under
 * the op id its own route gives the same call. A replace needs the file the host does not hold:
 * refused, nothing saved. Real files, fake clock.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  JHOME, SID_A, SID_B, TASK_A, TASK_B, journalTmpDir, cleanupJournalDirs, journalHost, jslice, gatewayCall,
} from '../helpers/offline-journal-harness.js'
import { JOURNAL_V2_DRAINS } from '../../src/providers/offline-journal-core.js'
import { APPLIED_V2_KINDS, MAC_DRAINS } from '../../src/core/offline-merge/apply-v2.js'
import { writeOpId } from '../../src/lib/op-call-id.js'

const T0 = Date.parse('2026-11-13T04:00:00Z')
const WITH_MEMORY = JOURNAL_V2_DRAINS.slice()
const WITHOUT_MEMORY = JOURNAL_V2_DRAINS.filter((k) => k !== 'agent-memory')
const OWNER = 'mownerzz-0099'

afterEach(() => cleanupJournalDirs())

function host(drains: string[] | null = WITH_MEMORY) {
  const clock = { now: T0 }
  const h = journalHost(journalTmpDir(), clock, { drains })
  h.host.configure(jslice())
  return { ...h, clock }
}

const records = (h: ReturnType<typeof host>) => h.journal.records(JHOME) as unknown as Array<Record<string, unknown>>

describe('offline agent_memory_write: a Mac that drains agent-memory', () => {
  it('the kind is one the host writes and the Mac applies and drains', () => {
    expect(JOURNAL_V2_DRAINS).toContain('agent-memory')
    expect(APPLIED_V2_KINDS).toContain('agent-memory')
    expect(MAC_DRAINS.filter((k) => k === 'agent-memory')).toHaveLength(1)
  })

  it('saves an append as its own agent-memory record and answers queued', async () => {
    const h = host()
    const r = await gatewayCall(h.host, SID_A, 'agent_memory_write', { task: TASK_B, content: 'CR 2 waits on the go-ahead \u4f60\u597d' })
    expect(r).toMatchObject({ ok: true, result: { queued: true, offline: true, task_id: TASK_B, mode: 'append' } })
    if (r.ok) expect(String(r.result.outcome)).toMatch(/after what it holds then/)
    expect(records(h)).toHaveLength(1)
    expect(records(h)[0]).toMatchObject({
      kind: 'agent-memory', taskId: TASK_B, mode: 'append', content: 'CR 2 waits on the go-ahead \u4f60\u597d', actor: { kind: 'session', sid: SID_A },
    })
  })

  it('names the caller\'s own task when no task is given', async () => {
    const h = host()
    expect((await gatewayCall(h.host, SID_B, 'agent_memory_write', { content: 'mine' })).ok).toBe(true)
    expect(records(h)[0]).toMatchObject({ taskId: TASK_B })
  })

  it('an owner task this host\'s copy does not hold is saved by its id (the Mac checks it at replay)', async () => {
    const h = host()
    expect((await gatewayCall(h.host, SID_A, 'agent_memory_write', { task: OWNER, content: 'for the owner' })).ok).toBe(true)
    expect(records(h)[0]).toMatchObject({ taskId: OWNER })
  })

  it('two appends to one task are two records, never folded into one', async () => {
    const h = host()
    await gatewayCall(h.host, SID_A, 'agent_memory_write', { task: TASK_A, content: 'first' })
    h.clock.now += 1000
    await gatewayCall(h.host, SID_A, 'agent_memory_write', { task: TASK_A, content: 'second' })
    expect(records(h).map((r) => r.content)).toEqual(['first', 'second'])
  })

  it('a retry of the same call (its call id) is one record, under the op id the Mac\'s route gives that call; two calls with the same words are two', async () => {
    const h = host()
    const call = (callId: string) => h.host.handle(JHOME, SID_A, 'tools.call', { name: 'agent_memory_write', args: { task: TASK_A, content: 'same words' }, callId })
    const first = await call('oc-AbCdEfGh_12345678')
    const retry = await call('oc-AbCdEfGh_12345678')
    expect(first).toMatchObject({ ok: true, result: { queued: true } })
    expect(retry).toMatchObject({ ok: true, result: { queued: true, duplicate: true } })
    expect(records(h)).toHaveLength(1)
    // The op id the Mac's op executor sends for this call's PUT (src/ops/executor.ts nextWriteOpId, its first write there).
    expect(records(h)[0]).toMatchObject({ opId: writeOpId('oc-AbCdEfGh_12345678', 'PUT', `/tasks/${encodeURIComponent(TASK_A)}/agent-memory`, 0) })
    // The task as named, as the op puts it in its path: a call that names none is its own task.
    const own = await h.host.handle(JHOME, SID_B, 'tools.call', { name: 'agent_memory_write', args: { content: 'own' }, callId: 'oc-OwnOwnOw_00000000' })
    expect(own.ok).toBe(true)
    expect(records(h).find((r) => r.content === 'own')).toMatchObject({ opId: writeOpId('oc-OwnOwnOw_00000000', 'PUT', `/tasks/${encodeURIComponent(TASK_B)}/agent-memory`, 0) })
    await call('oc-ZyXwVuTs_87654321')
    expect(records(h).filter((r) => r.content === 'same words')).toHaveLength(2)
  })

  it('lists the op among what this host answers', async () => {
    const h = host()
    const r = await h.host.handle(JHOME, SID_A, 'tools.list', {})
    expect(r.ok && (r.result.ops as Array<{ name: string }>).map((o) => o.name)).toContain('agent_memory_write')
  })

  const REFUSED: Array<[string, Record<string, unknown>, string, RegExp]> = [
    ['a replace (the host does not hold the file)', { task: TASK_A, content: 'all new', mode: 'replace' }, 'needs_leader', /replace of MEMORY\.md can only be made while the Walnut server answers/],
    ['a memory folder file', { task: TASK_A, content: 'x', file: 'notes.md' }, 'hub_unreachable', /memory folder file/],
    ['an empty entry', { task: TASK_A, content: '  ' }, 'bad_request', /non-empty/],
    ['an entry past the file\'s limit', { task: TASK_A, content: 'x'.repeat(20_001) }, 'agent_memory_too_long', /over the 20000-character limit/],
    ['an unknown mode', { task: TASK_A, content: 'x', mode: 'merge' }, 'bad_request', /append or replace/],
    ['a name that is no task id', { task: 'no', content: 'x' }, 'hub_unreachable', /not in this host's offline copy/],
  ]

  it.each(REFUSED)('refuses %s and saves nothing', async (_label, args, code, words) => {
    const h = host()
    const r = await gatewayCall(h.host, SID_A, 'agent_memory_write', args)
    expect(r).toMatchObject({ ok: false, error: { code } })
    if (!r.ok) expect(r.error.message).toMatch(words)
    expect(records(h)).toEqual([])
  })

  it('a completed task in the copy keeps its file', async () => {
    const clock = { now: T0 }
    const h = journalHost(journalTmpDir(), clock, { drains: WITH_MEMORY })
    h.host.configure(jslice({ tasks: [{ id: TASK_A, title: 'Leader work', phase: 'COMPLETE' }, { id: TASK_B, title: 'w', phase: 'IN_PROGRESS', parent_task_id: TASK_A }] }))
    const r = await gatewayCall(h.host, SID_A, 'agent_memory_write', { task: TASK_A, content: 'late' })
    expect(r).toMatchObject({ ok: false, error: { code: 'task_complete' } })
  })
})

describe('offline agent_memory_write: an older Mac', () => {
  it('a record saved for a Mac that drains agent-memory waits on the host for one that does not ask for the kind (a rollback)', async () => {
    const h = host()
    await gatewayCall(h.host, SID_A, 'agent_memory_write', { task: TASK_A, content: 'kept for later' })
    // An older Mac's drain names its own kinds: the record is not handed out, and so never acked away.
    const old = h.journal.drain(JHOME, { kinds: WITHOUT_MEMORY.filter((k) => k !== 'device-actor' && k !== 'routine-run') })
    expect(old.records.filter((r) => r.kind === 'agent-memory')).toEqual([])
    expect(records(h)).toHaveLength(1)
    const now = h.journal.drain(JHOME, { kinds: [...APPLIED_V2_KINDS] })
    expect(now.records.map((r) => r.kind)).toEqual(['agent-memory'])
  })

  it('a Mac that does not drain agent-memory gets today\'s answer: the op needs the server', async () => {
    for (const drains of [WITHOUT_MEMORY, null]) {
      const h = host(drains)
      const r = await gatewayCall(h.host, SID_A, 'agent_memory_write', { task: TASK_A, content: 'x' })
      expect(r).toMatchObject({ ok: false, error: { code: 'hub_unreachable' } })
      expect(records(h)).toEqual([])
      const list = await h.host.handle(JHOME, SID_A, 'tools.list', {})
      expect(list.ok && (list.result.ops as Array<{ name: string }>).map((o) => o.name)).not.toContain('agent_memory_write')
    }
  })
})
