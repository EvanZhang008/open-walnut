/**
 * A session that ran without some of its Walnut tools is counted at the source: the host's MCP
 * server tells the hub once the whole list is here (walnut-mcp-stdio.ts tellShort), and the hub
 * counts it as a failed call of `tools/list` (capability-router.ts, usage-watch/gateway-record.ts),
 * code tools_missing (none given) or tools_short (some missing).
 *
 * 2026-11-23: the daily audit counted 8, 12, 24 and 10 "Walnut tools vanished" a day from Claude
 * Code's list changes in session transcripts. On 11-23 none of the 71 changes (14 on the Mac, 57 on
 * clouddev) left a session without its Walnut tools: they were sessions moving to their role's
 * shorter list (experiment mcp_tools_by_role) and tools a deploy retired. Only the MCP server knows
 * whether it gave its session fewer tools than its list, so it says so and the monitor counts that.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeUsageWatchStore, readToolErrors, setUsageWatchFile } from '../../../src/core/usage-watch/store.js'
import { _resetUsageRecorderForTesting, flushUsage } from '../../../src/core/usage-watch/record.js'
import { SHORT_LIST_OP, recordShortToolList, shortListOf } from '../../../src/core/usage-watch/gateway-record.js'
import { handleGatewayCapability, type CapabilityRouterDeps } from '../../../src/core/peers/capability-router.js'
import { PeerThrottle } from '../../../src/core/peers/peer-throttle.js'

let dir: string
const SID = '5f1c2a77-0b2e-4d43-9c55-2f6ad3e0c1aa'

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'short-tool-list-'))
  setUsageWatchFile(path.join(dir, 'usage-watch.sqlite'))
  _resetUsageRecorderForTesting(true)
})

afterEach(() => {
  closeUsageWatchStore()
  setUsageWatchFile(null)
  _resetUsageRecorderForTesting(false)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('the word of a short list', () => {
  it('is a list given short of the whole one, with how long; anything else is no word', () => {
    expect(shortListOf({ short_list: { given: 0, full: 84, ms: 31_000, why: 'slow' } })).toEqual({ given: 0, full: 84, ms: 31_000, why: 'slow' })
    // An older server names no why (or one unknown here): counted as short.
    expect(shortListOf({ short_list: { given: 47, full: 84, ms: 12_000 } })).toEqual({ given: 47, full: 84, ms: 12_000, why: 'short' })
    expect(shortListOf({ short_list: { given: 47, full: 84, ms: 12_000, why: 'Other Reason' } })?.why).toBe('short')
    // A whole list (or a longer one) given is no shortfall; a malformed word counts nothing.
    expect(shortListOf({ short_list: { given: 84, full: 84, ms: 1 } })).toBeNull()
    expect(shortListOf({ short_list: { given: -1, full: 84, ms: 1 } })).toBeNull()
    expect(shortListOf({ short_list: { given: '0', full: 84, ms: 1 } })).toBeNull()
    expect(shortListOf({ other: true })).toBeNull()
    expect(shortListOf(null)).toBeNull()
  })

  it('counts one failed tools/list per word at the time the gap began: away, none or some missing, with its task', async () => {
    const taskOf = async () => 'mtaskaaa-0001'
    const now = Date.parse('2026-11-23T18:00:00Z')
    expect(await recordShortToolList(SID, 'clouddev', { short_list: { given: 0, full: 84, ms: 31_000, why: 'slow' } }, taskOf, now)).toBe(true)
    // The Mac's own daemon relays as __local__: one host, `local`, as the session hook names it.
    expect(await recordShortToolList(SID, '__local__', { short_list: { given: 47, full: 84, ms: 12_000, why: 'partial' } }, async () => undefined, now)).toBe(true)
    // A night with the Mac asleep is expected, told apart from a fault.
    expect(await recordShortToolList(SID, 'clouddev', { short_list: { given: 26, full: 84, ms: 10 * 3_600_000, why: 'away' } }, taskOf, now)).toBe(true)
    expect(await recordShortToolList(SID, 'local', { short_list: { given: 84, full: 84, ms: 1 } }, taskOf, now)).toBe(false)
    flushUsage()
    const rows = readToolErrors({ since: 0, limit: 10 }).map((r) => ({ at: new Date(r.at).toISOString(), op: r.op, code: r.code, host: r.host, sid: r.sid, taskId: r.taskId ?? null, client: r.client }))
    expect(rows).toEqual(expect.arrayContaining([
      { at: '2026-11-23T17:59:29.000Z', op: SHORT_LIST_OP, code: 'tools_missing', host: 'clouddev', sid: SID, taskId: 'mtaskaaa-0001', client: 'mcp' },
      { at: '2026-11-23T17:59:48.000Z', op: SHORT_LIST_OP, code: 'tools_short', host: 'local', sid: SID, taskId: null, client: 'mcp' },
      { at: '2026-11-23T08:00:00.000Z', op: SHORT_LIST_OP, code: 'tools_away', host: 'clouddev', sid: SID, taskId: 'mtaskaaa-0001', client: 'mcp' },
    ]))
    expect(rows).toHaveLength(3)
  })
})

describe('the hub takes the word on tools.list', () => {
  const deps = (): CapabilityRouterDeps => ({
    throttle: new PeerThrottle(), cloudMode: false,
    taskOfCaller: async () => 'mtaskaaa-0001', pluginsLoading: async () => false, listingRole: async () => undefined,
  })

  it('a report is counted and answered with nothing listed', async () => {
    const out = await handleGatewayCapability('tools.list', SID, { report: { short_list: { given: 0, full: 84, ms: 5_000 } } }, 'clouddev', deps())
    expect(out).toEqual({ ok: true, result: { recorded: true } })
    flushUsage()
    expect(readToolErrors({ since: 0, limit: 10 }).map((r) => r.code)).toEqual(['tools_missing'])
  })

  it('a caller with no session (a bare walnut) counts nothing', async () => {
    const { EXTERNAL_CALLER_SID } = await import('../../../src/providers/gateway-core.js')
    expect(await handleGatewayCapability('tools.list', EXTERNAL_CALLER_SID, { report: { short_list: { given: 0, full: 84, ms: 5 } } }, 'clouddev', deps()))
      .toEqual({ ok: true, result: { recorded: false } })
    flushUsage()
    expect(readToolErrors({ since: 0, limit: 10 })).toEqual([])
  })

  it('a report that is no shortfall counts nothing, and a list without one still lists', async () => {
    expect(await handleGatewayCapability('tools.list', SID, { report: { short_list: { given: 9, full: 9, ms: 5 } } }, 'clouddev', deps()))
      .toEqual({ ok: true, result: { recorded: false } })
    const listed = await handleGatewayCapability('tools.list', SID, { schemas: true }, 'clouddev', deps())
    expect(listed.ok && Array.isArray((listed.result as { ops?: unknown[] }).ops)).toBe(true)
    flushUsage()
    expect(readToolErrors({ since: 0, limit: 10 })).toEqual([])
  })
})
