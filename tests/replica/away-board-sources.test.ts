/**
 * Who wrote a Board's page, as a host replica shows it while the Mac is away
 * (src/replica/away-reads.ts overlayBoard, away-wiring.ts shownBoard, the board kit's
 * apply in src/providers/offline-board-core.ts). The copy's Board answers the page's
 * provenance the way board-v1.ts publicBoard does (`updated_session_id`,
 * `html_sources`); every write still in the journal is applied over it.
 *
 * Pinned: a pending post or project status leaves the page's writer, session and spans
 * as the copy has them; a device's full write makes the whole page the person's and
 * drops the old session; partial edits by two devices make only the changed text the
 * person's, every untouched span keeping its writer and session; provenance a client
 * puts in a write's args is never taken. A device write's actor is the paired device
 * (WriteActor has no session id); a session's writer is never guessed here.
 *
 * Over the REAL write port, overlay and offline host with journal v2 (no daemon
 * process): the link is ws-writes.ts linkWrite onto handleFollower, as in
 * tests/replica/away-writes.test.ts.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import path from 'node:path'
import crypto from 'node:crypto'
import { createMockConstants } from '../helpers/mock-constants.js'

const copyBoards = vi.hoisted(() => new Map<string, Record<string, unknown>>())
vi.mock('../../src/constants.js', () => createMockConstants('walnut-away-board-sources'))
vi.mock('../../src/core/boards/board-store.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBoard: async (taskId: string) => copyBoards.get(taskId) ?? null,
}))

import { JHOME, TASK_A, TASK_B, SID_A, SID_B, journalTmpDir, cleanupJournalDirs, journalHost, jslice, journalLines } from '../helpers/offline-journal-harness.js'
import { awayWrites } from '../../src/replica/away-writes.js'
import { awayReads, overlayBoard, overlayTiers } from '../../src/replica/away-reads.js'
import { createOverlay } from '../../src/replica/overlay.js'
import { createWritePort, type TaskRow, type WriteActor } from '../../src/replica/write-port.js'
import { linkWrite } from '../../src/replica/ws-writes.js'
import { wireAwayWrites, JOURNAL_V2_CAP } from '../../src/replica/away-wiring.js'
import { createDeviceCopy, type DeviceCopy } from '../../src/host-server/device-copy.js'
import type { FollowerLink } from '../../src/core/link/follower-link.js'

const T0 = Date.parse('2026-10-14T12:00:00Z')
const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const PHONE_TOKEN = 'marina-phone-token-0001'
const TABLET_TOKEN = 'acme-tablet-token-0002'
const PHONE: WriteActor = { kind: 'device', deviceId: 'dev-marina-phone', name: 'Marina phone' }
const COPY_ONLY = 'mtaskccc-0003'

/** The page: a heading the leader's session wrote, a body the worker's session wrote last. */
const HEAD = '<h1>Release</h1>'
const BODY = '<p id="build">Build: green</p>'
const HTML = HEAD + BODY
const REMOTE_SOURCES = [
  { start: 0, end: HEAD.length, by: `task:${TASK_A}`, sessionId: SID_A },
  { start: HEAD.length, end: HTML.length, by: `task:${TASK_B}`, sessionId: SID_B },
]
const COPY_BOARD = {
  html: HTML, version: 4, updated_at: '2026-10-14T11:00:00.000Z',
  updated_by: `task:${TASK_B}`, updated_session_id: SID_B, html_sources: REMOTE_SOURCES,
}
/** What a client might put in a write's args to claim the page: never taken. */
const FORGED_SID = 'forged-session-0001'
const FORGED_SOURCES = [{ start: 0, end: 5, by: 'task:mforged-9999', sessionId: FORGED_SID }]

afterEach(() => { cleanupJournalDirs(); copyBoards.clear() })

function rig() {
  const dir = journalTmpDir()
  const clock = { now: T0 }
  const { host } = journalHost(dir, clock, { boards: true })
  host.configure(jslice({ boards: [{ taskId: TASK_A, html: HTML, version: 4, threads: {} }] }))
  const copy: TaskRow[] = [{ id: TASK_A, title: 'Leader work', phase: 'IN_PROGRESS', project: 'Acme', pinned: true }]
  const devices = createDeviceCopy(path.join(dir, 'replica', 'devices.json'))
  devices.put({ devices: [
    { id: 'dev-marina-phone', name: 'Marina phone', tokenHash: sha(PHONE_TOKEN) },
    { id: 'dev-acme-tablet', name: 'Acme tablet', tokenHash: sha(TABLET_TOKEN) },
  ] })
  const reqLink = async (cmd: string, params: Record<string, unknown>) => {
    const r = cmd === 'follower.op' ? host.handleFollower(JHOME, params as never) : { ok: false as const, error: { code: 'not_found', message: 'no such command here' } }
    return r.ok ? { ok: true, ...r.result } : { ok: false, error: r.error.message, errorKind: r.error.code }
  }
  const overlay = createOverlay({ fetchPending: async () => host.pendingFor(JHOME, 0) as never, now: () => clock.now })
  const shown = async (id: string) => { await overlay.refresh(); return overlay.task(id, copy.find((t) => t.id === id) ?? null) as TaskRow | null }
  const port = createWritePort({ task: shown, board: async () => null, noteWritten: (e) => overlay.noteWritten(e), now: () => clock.now })
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => {
    if (req.method !== 'GET') req.replicaWrite = linkWrite({ request: reqLink, linked: () => true, log: () => {} })
    res.setHeader('x-walnut-answered-via', 'replica')
    next()
  })
  app.use('/api', awayReads({ overlay, answeredAway: (res) => res.getHeader('x-walnut-answered-via') === 'replica' }))
  app.use('/api', awayWrites({
    port, task: shown, tiers: async () => overlayTiers({ pinned_tasks: [TASK_A], focus_tasks: [], wait_tasks: [], backlog_tasks: [], satellite_tasks: [TASK_A], custom_tier_tasks: {} }, overlay),
    actorOf: (req) => { const d = devices.verifyDevice(String(req.headers.authorization ?? '').replace(/^Bearer /, '')); return d?.id ? { kind: 'device', deviceId: d.id, name: d.name } : null },
    sessionHere: async () => false,
    revokeLocally: (id) => { devices.revoke(id) },
    log: () => {},
  }))
  // The copy's Board as board-v1.ts answers it (publicBoard carries the page's provenance).
  app.get('/api/v1/tasks/:id/board', (req, res) => {
    res.json({ board_task_id: req.params.id, board: { ...COPY_BOARD, html_sources: REMOTE_SOURCES.map((s) => ({ ...s })) }, threads: {}, marks: {}, projects: {}, choices: {}, board_version: 4 })
  })
  const records = () => journalLines(dir).map((l) => JSON.parse(l)).filter((r) => typeof r.seq === 'number')
  return { app, records }
}

const phone = { authorization: `Bearer ${PHONE_TOKEN}` }
const tablet = { authorization: `Bearer ${TABLET_TOKEN}` }
const readBoard = (app: express.Express) => request(app).get(`/api/v1/tasks/${TASK_A}/board`).set(phone)

describe('away Board reads: the page\'s writer and spans over the journal', () => {
  it('a pending post and a pending project status keep the copy\'s session and spans, and GET returns them', async () => {
    const r = rig()
    const post = await request(r.app).post(`/api/v1/tasks/${TASK_A}/board/threads/build`).set(phone).send({ text: 'Looks good from the phone' })
    expect(post.status).toBe(201)
    const project = await request(r.app).put(`/api/v1/tasks/${TASK_A}/board/projects/build`).set(phone)
      .send({ title: 'Build', status: 'wip', html_sources: FORGED_SOURCES, updated_session_id: FORGED_SID, updated_by: 'task:mforged-9999' })
    expect(project.status).toBe(200)
    expect(r.records().map((x) => [x.kind, x.op])).toEqual([['board', 'board_post'], ['board', 'board_project_set']])
    // The journal keeps no provenance a client named.
    expect(JSON.stringify(r.records())).not.toContain(FORGED_SID)

    const got = await readBoard(r.app)
    expect(got.status).toBe(200)
    expect(got.body.replica_sync).toBe('pending')
    expect(got.body.threads.build).toEqual([expect.objectContaining({ author: 'user', text: 'Looks good from the phone' })])
    expect(got.body.projects.build).toMatchObject({ title: 'Build', status: 'wip' })
    expect(got.body.projects.build).not.toHaveProperty('html_sources')
    // The page is as the copy has it: same writer, same session, same spans, same version.
    expect(got.body.board).toEqual(COPY_BOARD)
    expect(got.body.board_version).toBe(4)
  })

  it('a device\'s full write makes the whole page the person\'s and drops the old session; the body\'s provenance is not taken', async () => {
    const r = rig()
    const next = '<h1>Release</h1><p>Rolled back</p>'
    const put = await request(r.app).put(`/api/v1/tasks/${TASK_A}/board`).set(phone)
      .send({ html: next, version: 4, html_sources: FORGED_SOURCES, updated_session_id: FORGED_SID, updated_by: 'task:mforged-9999' })
    expect(put.status).toBe(200)
    expect(r.records()[0]).toMatchObject({ kind: 'board', op: 'board_set', args: { html: next, task: TASK_A } })
    expect(r.records()[0].args).not.toHaveProperty('html_sources')

    const got = await readBoard(r.app)
    const board = got.body.board as Record<string, unknown>
    expect(board.html).toBe(next)
    expect(board.version).toBe(5)
    expect(board.html_sources).toEqual([{ start: 0, end: next.length, by: 'human' }])
    expect(board).not.toHaveProperty('updated_session_id')
    expect(String(board.updated_by)).not.toMatch(/^task:/)
    expect(JSON.stringify(got.body)).not.toContain('forged')
  })

  it('partial edits by two devices make only the changed text the person\'s; untouched spans keep their writer and session; edit items cannot claim a writer', async () => {
    const r = rig()
    const a = await request(r.app).post(`/api/v1/tasks/${TASK_A}/board/edits`).set(phone)
      .send({ edits: [{ old: 'Build: green', new: 'Build: red' }], version: 4 })
    expect(a.status).toBe(200)
    const b = await request(r.app).post(`/api/v1/tasks/${TASK_A}/board/edits`).set(tablet)
      .send({ edits: [{ old: HEAD, new: '<h1>Release notes</h1>', by: 'task:mforged-9999', sessionId: FORGED_SID, html_sources: FORGED_SOURCES }] })
    expect(b.status).toBe(200)
    expect(r.records().map((x) => x.op)).toEqual(['board_edit', 'board_edit'])

    const got = await readBoard(r.app)
    const board = got.body.board as Record<string, unknown>
    const html = '<h1>Release notes</h1><p id="build">Build: red</p>'
    expect(board.html).toBe(html)
    expect(board.version).toBe(6)
    const at = (s: string) => html.indexOf(s)
    expect(board.html_sources).toEqual([
      // '<h1>Release' stays the leader's session; ' notes' is the tablet's person.
      { start: 0, end: at(' notes'), by: `task:${TASK_A}`, sessionId: SID_A },
      { start: at(' notes'), end: at('</h1>'), by: 'human' },
      { start: at('</h1>'), end: at('<p '), by: `task:${TASK_A}`, sessionId: SID_A },
      // 'Build: ' and '</p>' stay the worker's session; 'red' is the phone's person.
      { start: at('<p '), end: at('red'), by: `task:${TASK_B}`, sessionId: SID_B },
      { start: at('red'), end: at('</p>'), by: 'human' },
      { start: at('</p>'), end: html.length, by: `task:${TASK_B}`, sessionId: SID_B },
    ])
    // The page's last writer is a person now: the worker's session is no longer its writer.
    expect(board).not.toHaveProperty('updated_session_id')
    expect(JSON.stringify(got.body)).not.toContain('forged')
  })
})

describe('overlayBoard: a noted write\'s args never name the page\'s writer', () => {
  it('a full write noted with forged provenance in its args is the device\'s whole page; a project write with it keeps the copy\'s', () => {
    const body = { board: { ...COPY_BOARD }, threads: {}, marks: {}, projects: {}, choices: {} }
    const note = (seq: number, op: string, args: Record<string, unknown>) => {
      const overlay = createOverlay({ fetchPending: async () => ({ records: [] }), now: () => T0 })
      overlay.noteWritten({ opId: `op-forged-000${seq}`, seq, rev: 1, kind: 'board', at: T0, actor: PHONE, record: { kind: 'board', op, args: { task: TASK_A, ...args } } })
      return overlayBoard(TASK_A, body, overlay).board as Record<string, unknown>
    }
    const forged = { html_sources: FORGED_SOURCES, updated_session_id: FORGED_SID, updated_by: 'task:mforged-9999', by: 'task:mforged-9999', sessionId: FORGED_SID }

    const set = note(1, 'board_set', { html: '<p>Mine</p>', ...forged })
    expect(set.html_sources).toEqual([{ start: 0, end: '<p>Mine</p>'.length, by: 'human' }])
    expect(set).not.toHaveProperty('updated_session_id')
    expect(JSON.stringify(set)).not.toContain('forged')

    const proj = note(2, 'board_project_set', { id: 'build', status: 'wip', ...forged })
    expect(proj).toEqual(COPY_BOARD)
  })
})

describe('away wiring: the Board a write is checked against carries the page\'s provenance', () => {
  it('shownBoard hands the copy\'s session and spans to the daemon as the base, then the spans a pending edit made', async () => {
    const dir = journalTmpDir()
    const clock = { now: T0 }
    const { host } = journalHost(dir, clock, { boards: true })
    host.configure(jslice())
    // A Board this host does not keep: the daemon checks against the replica's base.
    copyBoards.set(COPY_ONLY, { task_id: COPY_ONLY, ...COPY_BOARD, threads: {}, marks: {}, projects: {}, choices: {} })
    const link = {
      linkState: () => 'following',
      capabilities: () => [JOURNAL_V2_CAP],
      request: async (cmd: string) => (cmd === 'follower.pending' ? { ok: true, ...host.pendingFor(JHOME, 0) } : { ok: false, error: 'no such command here' }),
    } as unknown as FollowerLink
    const devices = { verifyDevice: () => null, revoke: () => {}, namedByMac: () => true } as unknown as DeviceCopy
    const wiring = await wireAwayWrites({ link, devices, broadcast: () => {}, hostKey: null, setRpcAnswer: () => {} })
    try {
      const sent: Array<Record<string, unknown>> = []
      const reqLink = async (cmd: string, params: Record<string, unknown>) => {
        if (cmd === 'follower.op') sent.push(JSON.parse(JSON.stringify(params)))
        const r = host.handleFollower(JHOME, params as never)
        return r.ok ? { ok: true, ...r.result } : { ok: false, error: r.error.message, errorKind: r.error.code }
      }
      const w = () => linkWrite({ request: reqLink, linked: () => true, log: () => {} })

      const first = await wiring.port.board(w(), PHONE, 'board_edit', COPY_ONLY, { edits: [{ old: 'Build: green', new: 'Build: red' }], version: 4 })
      expect(first).toMatchObject({ answered: false, status: 200 })
      expect(sent[0]!.base).toMatchObject({ html: HTML, version: 4, updated_by: `task:${TASK_B}`, updated_session_id: SID_B, html_sources: REMOTE_SOURCES })

      const second = await wiring.port.board(w(), PHONE, 'board_edit', COPY_ONLY, { edits: [{ old: '<h1>Release</h1>', new: '<h1>Release!</h1>' }] })
      expect(second).toMatchObject({ answered: false, status: 200 })
      const base = sent[1]!.base as Record<string, unknown>
      const html = HEAD + '<p id="build">Build: red</p>'
      const at = (s: string) => html.indexOf(s)
      expect(base).toMatchObject({ html, version: 5 })
      expect(base).not.toHaveProperty('updated_session_id')
      expect(base.html_sources).toEqual([
        { start: 0, end: HEAD.length, by: `task:${TASK_A}`, sessionId: SID_A },
        { start: HEAD.length, end: at('red'), by: `task:${TASK_B}`, sessionId: SID_B },
        { start: at('red'), end: at('</p>'), by: 'human' },
        { start: at('</p>'), end: html.length, by: `task:${TASK_B}`, sessionId: SID_B },
      ])
    } finally {
      wiring.stop()
    }
  })
})
