/**
 * A host that cannot answer transcript reads logs once per episode, never once per read
 * (src/core/sessions/host-history-reads.ts noteDegraded). 2026-11-24: every poll of a session on
 * clouddev in the windows of a leader restart wrote "host history read degraded" at warn, 44 an
 * hour on a day of many deploys, and raised the log spike alarm though nothing was broken.
 *
 * The guard enumerates every reader of HOST_CALL_ALLOWLIST.history, so a new reader that logs its
 * own degraded read per call fails here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-host-history-reads-logging'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { log } from '../../../src/logging/index.js'
import {
  _resetHostHistoryReadsForTesting, _setBootGraceForTesting, noteHostReadsHistory, setHostHistoryCaller, viaJudgingHost,
  type HostHistoryRead,
} from '../../../src/core/sessions/host-history-reads.js'
import { HOST_CALL_ALLOWLIST, HOST_HISTORY_WIRE } from '../../../src/core/session-channel/host-calls.js'
import { _resetJudgeOfForTesting, noteHostJudged } from '../../../src/core/sessions/judge-of.js'

const HOST = 'devbox'
const SID = '60000000-0000-4000-8000-0000000000b1'
const READERS = HOST_CALL_ALLOWLIST.history.filter((m) => !(HOST_HISTORY_WIRE as readonly string[]).includes(m)) as HostHistoryRead[]
const knownFile = () => path.join(WALNUT_HOME as string, 'host-history-readers.json')

const warns: Array<[string, Record<string, unknown>]> = []
const infos: Array<[string, Record<string, unknown>]> = []
const degradedWarns = () => warns.filter(([m]) => m === 'host history read degraded')
const degradedInfos = () => infos.filter(([m]) => m === 'host history read degraded')

let fail: string | null = null
const caller = vi.fn(async (_host: string, body: { member: string }) => {
  if (body.member === 'cancelRead') return { k: 'cancelled' }
  if (fail) throw new Error(fail)
  return { k: 'full', version: 'v1', chars: 1, wire: { k: 'v', value: 1 } }
})

/** Every reader, `times` reads each: answers whatever its degraded path answers (a throw included). */
async function readAll(times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    for (const m of READERS) await viaJudgingHost(SID, HOST, m, [i], async () => 'here').catch(() => {})
  }
}

beforeEach(async () => {
  await _resetHostHistoryReadsForTesting()
  _resetJudgeOfForTesting()
  await fsp.mkdir(WALNUT_HOME as string, { recursive: true })
  // The host answered reads before (on disk): its sessions are never parsed here.
  await fsp.writeFile(knownFile(), JSON.stringify({ hosts: [HOST] }) + '\n')
  noteHostJudged(SID, HOST)
  warns.length = 0
  infos.length = 0
  fail = null
  caller.mockClear()
  vi.spyOn(log.session, 'warn').mockImplementation((msg: string, data?: Record<string, unknown>) => { warns.push([msg, data ?? {}]) })
  vi.spyOn(log.session, 'info').mockImplementation((msg: string, data?: Record<string, unknown>) => { infos.push([msg, data ?? {}]) })
})
afterEach(async () => {
  vi.restoreAllMocks()
  setHostHistoryCaller(null)
  await _resetHostHistoryReadsForTesting()
})

describe('a degraded host logs once per episode', () => {
  it('a host whose service is down: every reader read three times warns once, its end says how many reads', async () => {
    setHostHistoryCaller(caller)
    _setBootGraceForTesting(0)
    noteHostReadsHistory(HOST, 'down')
    await readAll(3)
    expect(caller).not.toHaveBeenCalled()
    expect(degradedWarns()).toHaveLength(1)
    expect(degradedWarns()[0][1]).toMatchObject({ host: HOST, reads: 1 })
    noteHostReadsHistory(HOST, 'answers')
    await vi.waitFor(() => expect(infos.find(([m]) => m === 'host history reads answered again')?.[1]).toMatchObject({ host: HOST, degradedReads: READERS.length * 3 }))
    // A new outage is a new episode: it warns again, once.
    noteHostReadsHistory(HOST, 'down')
    await readAll(2)
    expect(degradedWarns()).toHaveLength(2)
  })

  it('the leader starting, before the host first reports: info, no warn; past the window it warns once', async () => {
    setHostHistoryCaller(caller)
    await readAll(3)
    expect(degradedWarns()).toHaveLength(0)
    expect(degradedInfos()).toHaveLength(1)
    expect(degradedInfos()[0][1]).toMatchObject({ host: HOST, expected: 'leader starting' })
    // A 'down' view inside the window (the host's link still coming up) is still that window.
    noteHostReadsHistory(HOST, 'down')
    await readAll(1)
    expect(degradedWarns()).toHaveLength(0)
    _setBootGraceForTesting(0)
    await readAll(2)
    expect(degradedWarns()).toHaveLength(1)
  })

  it('the leader stopping (no caller): info, no warn', async () => {
    setHostHistoryCaller(caller)
    noteHostReadsHistory(HOST, 'answers')
    setHostHistoryCaller(null)
    await readAll(3)
    expect(degradedWarns()).toHaveLength(0)
    expect(degradedInfos()).toHaveLength(1)
    expect(degradedInfos()[0][1]).toMatchObject({ expected: 'leader stopping' })
  })

  it('calls that fail (the link closed) warn once; the next answer ends the episode', async () => {
    setHostHistoryCaller(caller)
    noteHostReadsHistory(HOST, 'answers')
    fail = 'the request did not reach the host devbox: the link to devbox closed'
    await readAll(2)
    expect(degradedWarns()).toHaveLength(1)
    expect(String(degradedWarns()[0][1].why)).toContain('the link to devbox closed')
    // The host keeps reporting `answers` (every view patch) while its calls fail: still the one episode.
    for (let i = 0; i < 3; i++) { noteHostReadsHistory(HOST, 'answers'); await readAll(1) }
    expect(degradedWarns()).toHaveLength(1)
    expect(infos.filter(([m]) => m === 'host history reads answered again')).toHaveLength(0)
    fail = null
    expect(await viaJudgingHost(SID, HOST, 'readSessionBody', ['fresh'], async () => 'here')).toBe(1)
    await vi.waitFor(() => expect(infos.find(([m]) => m === 'host history reads answered again')?.[1]).toMatchObject({ degradedReads: READERS.length * 5 }))
  })

  it('a process whose leader side never started: past the start window, a degraded read warns (never "stopping")', async () => {
    await readAll(1)
    expect(degradedWarns()).toHaveLength(0)
    expect(degradedInfos()[0][1]).toMatchObject({ expected: 'leader starting' })
    _setBootGraceForTesting(0)
    await readAll(2)
    expect(degradedWarns()).toHaveLength(1)
    expect(degradedWarns()[0][1].expected).toBeUndefined()
  })
})
