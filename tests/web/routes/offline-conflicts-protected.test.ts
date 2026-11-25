/**
 * The conflict log route (src/web/routes/offline-conflicts-v1.ts) answers an entry about a locked or
 * hidden note without the words typed away (`replica`, `base`) to anyone but the person: an agent's
 * `api` call or Inbox Triage reading the letter's link would get the text otherwise
 * (docs/reference/locked-notes.md). Fake text only.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-offline-conflicts-protected'))

const { WALNUT_HOME } = await import('../../../src/constants.js')
const { ConflictLog } = await import('../../../src/core/offline-merge/conflict-log.js')
const { offlineConflictsV1Router } = await import('../../../src/web/routes/offline-conflicts-v1.js')

const AWAY = 'gibbonmeadowawaytext'
let base = ''
let server: Server
let drainId = ''

beforeAll(async () => {
  const log = new ConflictLog('marina', WALNUT_HOME)
  log.addDurable([
    { kind: 'note', seq: 1, opId: 'op-1', recordKind: 'note', notePath: 'journal/Kept.md', why: 'hidden', kept: 'mac', replica: `typed away: ${AWAY}`, base: `before: ${AWAY}` },
    { kind: 'note', seq: 2, opId: 'op-2', recordKind: 'note', notePath: 'journal/Sealed.md', why: 'locked', kept: 'mac', replica: `typed away: ${AWAY}` },
    { kind: 'note', seq: 3, opId: 'op-3', recordKind: 'note', notePath: 'journal/Plain.md', why: 'both-changed', kept: 'mac', replica: 'plain words away' },
  ] as never)
  drainId = log.drainId
  const app = express()
  app.use('/api/v1', offlineConflictsV1Router)
  server = app.listen(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
})

afterAll(() => { server.close() })

const read = async (headers: Record<string, string> = {}) => (await (await fetch(`${base}/offline-conflicts/${drainId}`, { headers })).json()) as { entries: Array<Record<string, unknown>> }

describe('a conflict log entry about a locked or hidden note', () => {
  it('keeps the words typed away for the person', async () => {
    const r = await read()
    expect(JSON.stringify(r)).toContain(AWAY)
  })

  it('answers an agent, a script and a forwarded call without them, and a plain note\'s entry whole', async () => {
    for (const headers of [{ 'x-walnut-caller-sid': 'sess-agent' }, { 'x-walnut-caller-kind': 'automation' }, { 'x-walnut-origin': 'remote-http' }]) {
      const r = await read(headers)
      expect(JSON.stringify(r)).not.toContain(AWAY)
      expect(r.entries.map((e) => e.notePath)).toEqual(['journal/Kept.md', 'journal/Sealed.md', 'journal/Plain.md'])
      expect(r.entries[0]).toMatchObject({ why: 'hidden', withheld: expect.any(String) })
      expect(r.entries[2]).toMatchObject({ replica: 'plain words away' })
    }
  })
})
