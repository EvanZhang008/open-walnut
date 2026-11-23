/**
 * A revoked host is a ban on what it brings this leader, not only a closed door (R2-S2;
 * src/core/session-channel/revoked-hosts.ts names every reader):
 *   - its sessions' relayed `walnut` calls run nothing (peers/capability-router.ts);
 *   - its journal is held, not dropped: nothing is read or acked, so every record stays on the host
 *     and the first drain after an allow takes them in (offline-handover.ts).
 * A start aimed at it is in tests/providers/host-judged-runner.test.ts; its channel in
 * tests/core/session-channel/host-data-ownership-ratchet.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-revoked-host-input'))
const executeOp = vi.hoisted(() => vi.fn())
vi.mock('../../../src/ops/index.js', async (orig) => ({ ...(await orig<typeof import('../../../src/ops/index.js')>()), executeOp }))
vi.mock('../../../src/core/task-manager.js', () => ({ getTask: async () => { throw new Error('a held write never reads a task') } }))
vi.mock('../../../src/core/session-tracker.js', () => ({ getSessionByClaudeId: async () => null }))
vi.mock('../../../src/core/sessions/session-send-core.js', () => ({ deliverToSession: vi.fn() }))

import { handleGatewayCapability } from '../../../src/core/peers/capability-router.js'
import { runOfflineHandover, type HandoverConnection } from '../../../src/core/offline-handover.js'
import { _setLedgerFileForTesting } from '../../../src/core/offline-merge/ledger.js'
import { setRevokedHosts } from '../../../src/core/session-channel/revoked-hosts.js'
import type { OfflineRecord } from '../../../src/providers/offline-host-core.js'

const SID = 'eeeeeeee-7777-4777-8777-777777777778'

const held = (seq: number): OfflineRecord => ({
  seq, at: Date.parse('2026-11-23T06:56:54.000Z'), kind: 'op', op: 'task_send',
  args: { task: 'msjfj3no', message: `held ${seq}`, messageId: `qm-host-${seq}` }, callerSid: SID, opId: `held-${seq}`,
} as OfflineRecord)

function link(hostKey: string, journal: OfflineRecord[], asked: string[], aliases?: string[]): HandoverConnection {
  return {
    hostKey,
    ...(aliases ? { aliases } : {}),
    send: async (cmd, params) => {
      asked.push(cmd)
      if (cmd === 'offline.drain') return { ok: true, records: [...journal], more: false }
      if (cmd === 'offline.ack') {
        const upTo = Number(params?.upTo)
        journal.splice(0, journal.length, ...journal.filter((r) => r.seq > upTo))
        return { ok: true, remaining: journal.length }
      }
      return { ok: true }
    },
  }
}

let dir = ''
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revoked-input-'))
  _setLedgerFileForTesting(path.join(dir, 'applied-ops.sqlite'))
  executeOp.mockReset()
  executeOp.mockResolvedValue({ ok: true, result: {} })
})
afterEach(() => {
  setRevokedHosts([])
  _setLedgerFileForTesting(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('a revoked host\'s sessions\' relayed calls', () => {
  it('run nothing, with the reason; another host\'s and this machine\'s still run', async () => {
    setRevokedHosts(['devbox-a'])
    const out = await handleGatewayCapability('tools.call', SID, { name: 'task_list', args: {} }, 'devbox-a')
    expect(out).toMatchObject({ ok: false, error: { code: 'host_revoked' } })
    expect(JSON.stringify(out)).toMatch(/the host devbox-a is revoked/)
    expect((await handleGatewayCapability('tools.list', SID, {}, 'devbox-a')).ok).toBe(false)
    expect(executeOp).not.toHaveBeenCalled()
    expect((await handleGatewayCapability('tools.call', SID, { name: 'task_list', args: {} }, 'devbox-b')).ok).toBe(true)
    expect((await handleGatewayCapability('tools.call', SID, { name: 'task_list', args: {} }, '__local__')).ok).toBe(true)
    expect(executeOp).toHaveBeenCalledTimes(2)
  })
})

describe('a revoked host\'s journal', () => {
  it('is held on the host while it is revoked (under any of its names), then drains whole after an allow', async () => {
    const journal = [held(1), held(2)]
    const asked: string[] = []
    setRevokedHosts(['devbox-a'])
    expect(await runOfflineHandover(link('devbox-a', journal, asked))).toMatchObject({ held: true, records: 0 })
    // Reached under another name of the same daemon: still held.
    expect(await runOfflineHandover(link('devbox-a-net', journal, asked, ['devbox-a', 'devbox-a-net']))).toMatchObject({ held: true })
    expect(asked).toEqual([])
    expect(executeOp).not.toHaveBeenCalled()
    expect(journal.map((r) => r.seq)).toEqual([1, 2])
    setRevokedHosts([])
    const r = await runOfflineHandover(link('devbox-a', journal, asked))
    expect(r.held).toBeUndefined()
    expect(executeOp).toHaveBeenCalledTimes(2)
    expect(journal).toEqual([])
  })
})
