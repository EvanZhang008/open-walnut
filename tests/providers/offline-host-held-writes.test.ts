/**
 * Writes held while nothing can take them (2026-11-13, the org reflection: a VP on a host sent to
 * another host's task and to its own lead, and wrote its memory, while the Walnut server was away;
 * each call failed with hub_unreachable, at 04:01, 04:08 and 05:30 UTC, and was resent by hand).
 * The host holds a message or a memory write in its journal and answers "queued"
 * (offline-host-core.ts holdWrite); the Mac replays it once (offline-handover.ts, its test
 * tests/core/offline-handover-held-writes.test.ts).
 *
 * Guards for the class:
 *  - a retry of the same call (its call id) is answered from the first record, never held twice;
 *  - a Mac that does not drain `held-op` is never handed one (the caller hears the error, as before);
 *  - both daemon twins ask holdWrite where their offline answer ends in hub_unreachable, and the
 *    host's held list and the Mac's replay list are the same ops.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  JHOME, SID_A, TASK_A, TASK_B, journalTmpDir, cleanupJournalDirs, journalHost, jslice,
} from '../helpers/offline-journal-harness.js'
import { JOURNAL_V2_DRAINS } from '../../src/providers/offline-journal-core.js'
import { MAC_DRAINS } from '../../src/core/offline-merge/apply-v2.js'

const T0 = Date.parse('2026-11-13T04:01:00Z')
const DRAINS = [...JOURNAL_V2_DRAINS, 'held-op']
const send = (args: Record<string, unknown>, callId?: string) => ({ name: 'task_send', args, ...(callId ? { callId } : {}) })

afterEach(() => cleanupJournalDirs())

describe('offline host: a write nothing could take is held for the server', () => {
  it('a message is queued once per call: a retry of the same call is answered from the first record', () => {
    const h = journalHost(journalTmpDir(), { now: T0 }, { drains: DRAINS })
    h.host.configure(jslice())
    const first = h.host.holdWrite(JHOME, SID_A, 'tools.call', send({ task: 'msjfj3no', message: 'The CR is out' }, 'oc-abcdef12_3456'))
    expect(first).toMatchObject({ ok: true, result: { queued: true, held: true, op: 'task_send', messageId: 'qm-host-abcdef12-3456' } })
    expect(String((first as { result: { outcome: string } }).result.outcome)).toContain('Do NOT resend')
    const again = h.host.holdWrite(JHOME, SID_A, 'tools.call', send({ task: 'msjfj3no', message: 'The CR is out' }, 'oc-abcdef12_3456'))
    expect(again).toMatchObject({ ok: true, result: { queued: true, messageId: 'qm-host-abcdef12-3456' } })
    const held = h.journal.records(JHOME).filter((r) => r.kind === 'op')
    expect(held).toHaveLength(1)
    // The caller's call id, verbatim: the Mac replays under it, so the caller's own retry meets it.
    expect(held[0]).toMatchObject({ op: 'task_send', callerSid: SID_A, opId: 'held-abcdef12-3456', callId: 'oc-abcdef12_3456', args: { task: 'msjfj3no', messageId: 'qm-host-abcdef12-3456' } })
    // Another call is another message.
    expect(h.host.holdWrite(JHOME, SID_A, 'tools.call', send({ task: 'msjfj3no', message: 'And merged' }, 'oc-99999999_0000'))).toMatchObject({ ok: true })
    expect(h.journal.records(JHOME).filter((r) => r.kind === 'op')).toHaveLength(2)
  })

  it('a reply keeps its in_reply_to, and a memory write is pinned to the caller\'s own task', () => {
    const h = journalHost(journalTmpDir(), { now: T0 }, { drains: DRAINS })
    h.host.configure(jslice())
    expect(h.host.holdWrite(JHOME, SID_A, 'tools.call', send({ in_reply_to: ['rq-111111', 'rq-222222'], title: 'Done', text: 'Landed' }))).toMatchObject({ ok: true, result: { queued: true } })
    const mem = h.host.holdWrite(JHOME, SID_A, 'tools.call', { name: 'agent_memory_write', args: { content: 'The VP decided: land tonight.' } })
    expect(mem).toMatchObject({ ok: true, result: { queued: true, op: 'agent_memory_write' } })
    expect((mem as { result: Record<string, unknown> }).result.messageId).toBeUndefined()
    // Another task's MEMORY.md, named: kept as named.
    h.host.holdWrite(JHOME, SID_A, 'tools.call', { name: 'agent_memory_write', args: { content: 'x', task: TASK_B, file: 'steps.md' } })
    h.host.holdWrite(JHOME, SID_A, 'tools.call', { name: 'agent_memory_write', args: { content: 'y', file: 'steps.md' } })
    const ops = h.journal.records(JHOME).filter((r) => r.kind === 'op') as unknown as { op: string; args: Record<string, unknown> }[]
    expect(ops.map((r) => [r.op, r.args.in_reply_to ?? r.args.task])).toEqual([
      ['task_send', ['rq-111111', 'rq-222222']],
      ['agent_memory_write', TASK_A],
      ['agent_memory_write', TASK_B],
      ['agent_memory_write', TASK_A],
    ])
  })

  it('holds nothing for a Mac that does not drain held-op, a caller outside the copy, another op or a call in a file', () => {
    const old = journalHost(journalTmpDir(), { now: T0 }, { drains: JOURNAL_V2_DRAINS.slice() })
    old.host.configure(jslice())
    expect(old.host.holdWrite(JHOME, SID_A, 'tools.call', send({ task: 'x', message: 'hi' }))).toBeNull()
    expect(old.journal.records(JHOME)).toEqual([])
    const h = journalHost(journalTmpDir(), { now: T0 }, { drains: DRAINS })
    h.host.configure(jslice())
    expect(h.host.holdWrite(JHOME, 'ffffffff-9999-4999-8999-999999999999', 'tools.call', send({ task: 'x', message: 'hi' }))).toBeNull()
    expect(h.host.holdWrite(JHOME, SID_A, 'tools.call', { name: 'task_create', args: { title: 'x' } })).toBeNull()
    expect(h.host.holdWrite(JHOME, SID_A, 'tools.call', { name: 'task_send', argsFile: '/tmp/args.json' })).toBeNull()
    expect(h.host.holdWrite(JHOME, SID_A, 'session.send', send({ task: 'x', message: 'hi' }))).toBeNull()
    expect(h.host.holdWrite('/fixture/other-home', SID_A, 'tools.call', send({ task: 'x', message: 'hi' }))).toBeNull()
    expect(h.journal.records(JHOME)).toEqual([])
  })
})

describe('the held write path stays wired end to end', () => {
  const ROOT = path.resolve(__dirname, '../..')
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  const listIn = (src: string, re: RegExp) => {
    const m = src.match(re)
    expect(m, String(re)).not.toBeNull()
    return [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort()
  }

  it('the host holds what the Mac replays, and the Mac says it drains it', () => {
    const host = listIn(read('src/providers/offline-host-core.ts'), /const HELD_OPS = \[([^\]]*)\]/)
    const mac = listIn(read('src/core/offline-handover.ts'), /const HELD_OPS[^=]*= new Set\(\[([^\]]*)\]\)/)
    expect(host).toEqual(mac)
    expect(host).toEqual(['agent_memory_write', 'session_send', 'task_send'])
    expect(MAC_DRAINS).toContain('held-op')
  })

  it('both daemon twins hold a write where their offline answer ends in hub_unreachable', () => {
    for (const twin of ['src/providers/daemon-standalone.ts', 'src/providers/daemon-source.ts']) {
      const src = read(twin)
      expect(src, twin).toMatch(/offlineHost\.holdWrite\(home, callerSid, capability, payload\)/)
      // Its last answer and the companion's both go through it.
      expect(src, twin).toMatch(/heldOr\(r( as GatewayResponse)?\)/)
      expect(src, twin).toMatch(/forwardToBackup\(home, capability, callerSid, payload, (\(b\) =>|function \(b\)) \{ if \(unreachable\(b\) && waitHere\(\)\) return;? heldOr\(b\)/)
    }
  })
})
