/**
 * Who writes which field of a session record (src/core/sessions/session-row-owner.ts).
 * The table must name every field of SessionRecord: a new field fails here until it is
 * given an owner. The leader's fields are exactly what a person or the leader's own hooks
 * set; the session-meta journal kind (what a host journals while the leader is away) names
 * only leader fields.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  LEADER_SESSION_FIELDS, SESSION_FIELD_OWNER, judgedByHost, mergeLeaderCopy, ownedPartOf, rowOwnedHere, writingAsHost,
} from '../../../src/core/sessions/session-row-owner.js'
import type { SessionRecord } from '../../../src/core/types.js'

const ROOT = path.resolve(__dirname, '../../..')

function sessionRecordFields(): string[] {
  const src = fs.readFileSync(path.join(ROOT, 'src/core/types.ts'), 'utf8')
  const start = src.indexOf('export interface SessionRecord {')
  expect(start).toBeGreaterThan(0)
  const end = src.indexOf('\n}', start)
  const body = src.slice(start, end)
  return [...body.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map((m) => m[1])
}

describe('every field of SessionRecord has an owner', () => {
  it('the table names each field of the interface, and nothing else', () => {
    const fields = sessionRecordFields()
    expect(fields.length).toBeGreaterThan(100)
    expect(Object.keys(SESSION_FIELD_OWNER).sort()).toEqual([...fields].sort())
  })

  it('the leader fields are the ones a person, the leader\'s hooks or its send path write', () => {
    expect([...LEADER_SESSION_FIELDS].sort()).toEqual([
      'archive_reason', 'archived', 'hintState', 'human_note', 'output_mode', 'output_mode_injected', 'overview', 'overviewAt', 'passageComments', 'pinnedMessages',
      'recap', 'recapAt', 'stopRequest', 'summary', 'summaryGeneratedAt', 'threadAnchors', 'threadMeta', 'title',
    ])
  })

  it('every field the session-meta journal kind takes is a leader field', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/core/offline-merge/apply-session-meta.ts'), 'utf8')
    const m = src.match(/const FIELDS = new Set\(\[([^\]]+)\]\)/)
    expect(m).not.toBeNull()
    const wire = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1])
    // The v1 API names two of them in snake case.
    const toRecord: Record<string, string> = { thread_anchors: 'threadAnchors', thread_meta: 'threadMeta' }
    for (const f of wire) expect(SESSION_FIELD_OWNER[(toRecord[f] ?? f) as keyof SessionRecord], f).toBe('leader')
  })
})

const hostRow = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  claudeSessionId: 's1', taskId: 't1', project: 'Marina', process_status: 'running', mode: 'default',
  host: 'devbox', judge: 'host', title: 'Mine', messageCount: 4, ...over,
} as SessionRecord)

describe('ownership of a row', () => {
  it('a row is the host\'s only with judge host and a host', () => {
    expect(judgedByHost(hostRow())).toBe(true)
    expect(judgedByHost(hostRow({ judge: undefined }))).toBe(false)
    expect(judgedByHost(hostRow({ host: '' }))).toBe(false)
    expect(rowOwnedHere(hostRow(), 'devbox')).toBe(true)
    expect(rowOwnedHere(hostRow(), 'otherbox')).toBe(false)
    expect(rowOwnedHere(hostRow(), '')).toBe(false)
  })

  it('a leader copy brings the leader fields (an absent one cleared) and keeps every host field', () => {
    const own = hostRow({ human_note: 'old note', cliModel: 'opus' })
    const merged = mergeLeaderCopy(own, hostRow({ title: 'Renamed', process_status: 'stopped', messageCount: 1, cliModel: 'sonnet' }))
    expect(merged).toMatchObject({ title: 'Renamed', process_status: 'running', messageCount: 4, cliModel: 'opus' })
    expect(merged.human_note).toBeUndefined()
  })
})

describe('what a write may change', () => {
  const patch = { title: 'T', archived: true, process_status: 'stopped', messageCount: 9 } as Record<string, unknown>

  it('the leader writes only the leader fields of a host row', () => {
    const r = ownedPartOf(hostRow(), patch, '')
    expect(r.patch).toEqual({ title: 'T', archived: true })
    expect(r.dropped.sort()).toEqual(['messageCount', 'process_status'])
  })

  it('the channel that applies the host\'s facts writes every field', () => {
    expect(writingAsHost(() => ownedPartOf(hostRow(), patch, '')).patch).toEqual(patch)
  })

  it('the owning host writes only its own fields', () => {
    const r = ownedPartOf(hostRow(), patch, 'devbox')
    expect(r.patch).toEqual({ process_status: 'stopped', messageCount: 9 })
  })

  it('a row the leader runs takes the whole patch, wherever', () => {
    expect(ownedPartOf(hostRow({ judge: undefined }), patch, '').patch).toBe(patch)
    expect(ownedPartOf(hostRow({ judge: undefined }), patch, 'devbox').patch).toBe(patch)
  })
})
