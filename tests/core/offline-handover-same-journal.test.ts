/**
 * One daemon reached under two host names keeps ONE journal, and the Mac drains it as one
 * (src/core/offline-handover.ts journalKey, src/core/offline-merge/ledger.ts noteSameJournal).
 *
 * 2026-11-23, a real companion-lead window: `newdev` and `clouddev`, two rows of one machine,
 * drained its journal each under its own name, twice at once at 07:07:35Z. The ledger and the
 * create remap are keyed by the host name, so a record one name applied whose ack was lost ran
 * again under the other, and a task one name created was not found by the other.
 *
 * Real drain, ledger and remap on a temp file; the op executor is stubbed and the host side is
 * a fake journal that both "links" read.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-handover-same-journal'))
const executeOp = vi.hoisted(() => vi.fn())
vi.mock('../../src/ops/index.js', () => ({ executeOp }))
vi.mock('../../src/core/task-manager.js', () => ({ getTask: async () => { throw new Error('a held write never reads a task') } }))
vi.mock('../../src/core/session-tracker.js', () => ({ getSessionByClaudeId: async () => null }))
vi.mock('../../src/core/sessions/session-send-core.js', () => ({ deliverToSession: vi.fn() }))

import { runOfflineHandover, runningHandover, type HandoverConnection } from '../../src/core/offline-handover.js'
import { _setLedgerFileForTesting, journalNamesOf, lookupDrained, lookupRemap, noteSameJournal, recordApplied, recordRemap } from '../../src/core/offline-merge/ledger.js'
import { WALNUT_HOME } from '../../src/constants.js'
import type { OfflineRecord } from '../../src/providers/offline-host-core.js'

const SID = 'eeeeeeee-7777-4777-8777-777777777777'
const JOURNAL = 'instance:mock-studio'

const held = (seq: number): OfflineRecord => ({
  seq, at: Date.parse('2026-11-23T06:56:54.000Z'), kind: 'op', op: 'task_send',
  args: { task: 'msjfj3no', message: `held ${seq}`, messageId: `qm-host-${seq}` }, callerSid: SID, opId: `held-${seq}`,
} as OfflineRecord)

/** A link to the one daemon: reads the shared journal; `loseAcks` drops its acks (the link went). */
function link(hostKey: string, journal: OfflineRecord[], opts: { loseAcks?: boolean; journalKey?: string; aliases?: string[] } = {}): HandoverConnection {
  return {
    hostKey,
    journalKey: opts.journalKey ?? JOURNAL,
    ...(opts.aliases ? { aliases: opts.aliases } : {}),
    send: async (cmd, params) => {
      if (cmd === 'offline.drain') return { ok: true, records: [...journal], more: false }
      if (cmd === 'offline.ack') {
        if (opts.loseAcks) throw new Error(`DaemonConnection not connected to ${hostKey}`)
        const upTo = Number(params?.upTo)
        journal.splice(0, journal.length, ...journal.filter((r) => r.seq > upTo))
        return { ok: true, remaining: journal.length }
      }
      return { ok: true }
    },
  }
}

describe('two names of one daemon drain its journal as one', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'same-journal-'))
    _setLedgerFileForTesting(path.join(dir, 'applied-ops.sqlite'))
    executeOp.mockReset()
    executeOp.mockResolvedValue({ ok: true, result: {} })
  })
  afterEach(() => {
    _setLedgerFileForTesting(null)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('a record one name applied, its ack lost, is not run again when the other name drains it', async () => {
    // The names come with the link (HandoverConnection.aliases), as daemon-connection.ts hands them.
    const both = ['studio', 'studio-net']
    const journal = [held(5296), held(5297)]
    await runOfflineHandover(link('studio-net', journal, { loseAcks: true, aliases: both })).catch(() => undefined)
    expect(executeOp).toHaveBeenCalledTimes(2)
    expect(journal.map((r) => r.seq)).toEqual([5296, 5297])
    await runOfflineHandover(link('studio', journal, { aliases: both }))
    // Each held message went out once, and the second drain still acked both.
    expect(executeOp).toHaveBeenCalledTimes(2)
    expect(journal).toEqual([])
  })

  it('without the names known as one (the old behavior), the same record would run twice', async () => {
    const journal = [held(7001)]
    await runOfflineHandover(link('lab', journal, { loseAcks: true, journalKey: 'instance:mock-lab' })).catch(() => undefined)
    await runOfflineHandover(link('lab-net', journal, { journalKey: 'instance:mock-lab' }))
    // Pins what the guard above prevents: two unrelated names share no ledger rows.
    expect(executeOp).toHaveBeenCalledTimes(2)
  })

  it('two names starting a drain at once run one drain', async () => {
    noteSameJournal(['studio', 'studio-net'])
    const journal = [held(5300)]
    const a = runOfflineHandover(link('studio-net', journal))
    const b = runOfflineHandover(link('studio', journal))
    expect(runningHandover(JOURNAL)).toBe(a)
    expect(b).toBe(a)
    await a
    expect(executeOp).toHaveBeenCalledTimes(1)
  })

  it('a task one name created while away is found under the other name, and so is its drain row', () => {
    noteSameJournal(['studio', 'studio-net'])
    recordRemap('studio-net', WALNUT_HOME, 'mint-0001', 'task-here-0001')
    expect(lookupRemap('studio', WALNUT_HOME, 'mint-0001')).toBe('task-here-0001')
    recordApplied({ hostKey: 'studio-net', home: WALNUT_HOME, opId: 'oc-abc-0' }, { outcome: 'applied', source: 'drain' })
    expect(lookupDrained(WALNUT_HOME, 'oc-abc-0', 'studio')?.outcome).toBe('applied')
    // A name in no group is only itself.
    expect(journalNamesOf('lab')).toEqual(['lab'])
    expect(lookupRemap('lab', WALNUT_HOME, 'mint-0001')).toBeUndefined()
  })
})
