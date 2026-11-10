/**
 * Ratchet: every write route a person reaches on the cloud companion says what happens
 * to it while the Mac is away.
 *
 * 2026-11-05: the user answered an inbox letter on the phone while the Mac was away; the
 * companion's reply route only relayed to the Mac and answered 503, though the read, pin
 * and archive flags beside it went into the companion's journal. Nothing listed which
 * routes keep a person's write and which do not, so the gap was found by the user.
 *
 * The route files below are read for their write routes, and each must have a row here:
 *   journal   kept in the companion's journal under `kind`, which the Mac applies; a route
 *             that takes pictures names the kind they go under too (`pictures`): a turn's
 *             words never go to the Mac without the pictures sent with them
 *   queue     kept in another store on the companion that the Mac's return drains
 *   local     this box's own state, nothing for the Mac
 *   agent     written by sessions, not by a person on the companion
 *   leader    cannot be kept for the Mac; `why` says why in a sentence
 * A new write route in these files fails until it is given a row, and a row whose route
 * is gone fails too.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { APPLIED_V2_KINDS } from '../../src/core/offline-merge/apply-v2.js'

type Row =
  | { offline: 'journal'; kind: string; pictures?: string }
  | { offline: 'queue'; store: string }
  | { offline: 'local' | 'agent' }
  | { offline: 'leader'; why: string }

const ROUTES_DIR = path.resolve(__dirname, '../../src/web/routes')
const FILES = [
  'human-inbox-v1.ts', 'human-inbox-items-v1.ts', 'org-threads-v1.ts', 'session-stream-v1.ts',
  'session-extras-v1.ts', 'session-lifecycle-v1.ts', 'personal-ai-v1.ts', 'api-v1.ts',
]

const LEADER_SESSION = 'a running session lives on its host and is driven through the Mac or the host itself'

const TABLE: Record<string, Row> = {
  // The human inbox.
  'POST /human-inbox': { offline: 'agent' },
  'POST /human-inbox/body': { offline: 'agent' },
  'POST /human-inbox/:id/reply': { offline: 'agent' },
  'POST /human-inbox/:id/settle': { offline: 'agent' },
  'POST /human-inbox/:id/read': { offline: 'journal', kind: 'inbox-state' },
  'POST /human-inbox/:id/pin': { offline: 'journal', kind: 'inbox-state' },
  'POST /human-inbox/:id/archive': { offline: 'journal', kind: 'inbox-state' },
  'POST /human-inbox/:id/answer': { offline: 'journal', kind: 'inbox-reply', pictures: 'inbox-reply-pictures' },
  'POST /human-inbox/:id/human-reply': { offline: 'journal', kind: 'inbox-reply', pictures: 'inbox-reply-pictures' },
  'POST ${ROOT}/prepare': { offline: 'leader', why: 'a mail item acts on an account only the Mac signs in to' },
  'POST ${ROOT}/execute': { offline: 'leader', why: 'a mail item acts on an account only the Mac signs in to' },
  // Org threads: only the Mac keeps them; the companion holds no copy to write to.
  'POST /tasks/:id/threads': { offline: 'leader', why: 'threads are kept on the Mac only, the companion holds no copy' },
  'POST /tasks/:id/threads/open': { offline: 'leader', why: 'threads are kept on the Mac only, the companion holds no copy' },
  'PATCH /tasks/:id/threads/:thread': { offline: 'leader', why: 'threads are kept on the Mac only, the companion holds no copy' },
  'POST /tasks/:id/threads/:thread/split': { offline: 'leader', why: 'threads are kept on the Mac only, the companion holds no copy' },
  'POST /tasks/:id/threads/:thread/move': { offline: 'leader', why: 'threads are kept on the Mac only, the companion holds no copy' },
  'PUT /tasks/:id/threads/:thread/follow-ups/:messageId': { offline: 'leader', why: 'a Follow up\'s thread is noted in the Mac\'s memory; with the Mac away the send is filed by Walnut\'s pick, as before' },
  // Sessions.
  'POST /sessions/:id/messages': { offline: 'queue', store: 'send-queue (core/send-queue.ts), drained when the bridge returns' },
  'PUT /sessions/:id/uploads/:uploadId': { offline: 'local' },
  'PUT /uploads/:uploadId': { offline: 'local' },
  'POST /sessions/:id/controls': { offline: 'leader', why: LEADER_SESSION },
  'POST /sessions/:id/side-question': { offline: 'leader', why: LEADER_SESSION },
  'POST /sessions/:id/side-question/:qid/promote': { offline: 'leader', why: LEADER_SESSION },
  'DELETE /sessions/:id/side-question/:qid': { offline: 'leader', why: LEADER_SESSION },
  'POST /sessions/:id/execute-compact': { offline: 'leader', why: LEADER_SESSION },
  'PATCH /sessions/:id/queue/:messageId': { offline: 'leader', why: 'a queued message lives in the Mac\'s queue until it is sent' },
  'DELETE /sessions/:id/queue/:messageId': { offline: 'leader', why: 'a queued message lives in the Mac\'s queue until it is sent' },
  'PATCH /sessions/:id': { offline: 'journal', kind: 'session-meta' },
  'POST /sessions/:id/terminate': { offline: 'leader', why: LEADER_SESSION },
  'POST /sessions/:id/restart': { offline: 'leader', why: LEADER_SESSION },
  'POST /sessions/:id/retry': { offline: 'leader', why: LEADER_SESSION },
  'POST /sessions/:id/recheck': { offline: 'leader', why: LEADER_SESSION },
  'POST /sessions/:id/interrupt': { offline: 'leader', why: LEADER_SESSION },
  'POST /sessions/:id/permission': { offline: 'leader', why: LEADER_SESSION },
  'POST /sessions/:id/execute-continue': { offline: 'leader', why: LEADER_SESSION },
  // The Personal AI chat.
  'PUT /conversations/active': { offline: 'local' },
  'PUT /chat/model': { offline: 'leader', why: 'the chat engine and its settings are the Mac\'s' },
  'POST /chat/engine/session': { offline: 'leader', why: 'the chat engine and its settings are the Mac\'s' },
  'POST /chat/clear': { offline: 'leader', why: 'the chat engine and its settings are the Mac\'s' },
  'POST /chat/compact': { offline: 'leader', why: 'the chat engine and its settings are the Mac\'s' },
  'PATCH /conversations/:id': { offline: 'journal', kind: 'conversation-edit' },
  'DELETE /conversations/:id': { offline: 'journal', kind: 'conversation-edit' },
  'POST /conversations/:id/stop': { offline: 'leader', why: 'a running chat turn is stopped where it runs' },
  'POST /conversations/:id/answer': { offline: 'leader', why: 'a running chat turn is answered where it runs' },
  'POST /conversations': { offline: 'journal', kind: 'conversation-edit' },
  'POST /conversations/:id/messages': { offline: 'journal', kind: 'chat-turn' },
  // Tasks, notes, this device.
  'POST /devices/self': { offline: 'local' },
  'POST /client-logs': { offline: 'local' },
  'POST /tasks': { offline: 'journal', kind: 'task-create' },
  'PATCH /tasks/:id': { offline: 'journal', kind: 'task-fields' },
  'PUT /notes/content/*path': { offline: 'journal', kind: 'note' },
  'POST /notes': { offline: 'journal', kind: 'note' },
  'DELETE /notes/*path': { offline: 'journal', kind: 'note' },
}

const ROUTE_RE = /\b[A-Za-z0-9]+[Rr]outer\.(get|post|put|patch|delete)\(\s*(?:'([^']+)'|`([^`]+)`)/g

/** `METHOD /path` for every write route the files register on a router, with its handler's text. */
function writeRouteTexts(): Map<string, string> {
  const out = new Map<string, string>()
  for (const name of FILES) {
    const text = fs.readFileSync(path.join(ROUTES_DIR, name), 'utf8')
    const found = [...text.matchAll(ROUTE_RE)]
    found.forEach((m, i) => {
      if (m[1] === 'get') return
      // The handler runs to the next route the file registers.
      out.set(`${m[1].toUpperCase()} ${m[2] ?? m[3]}`, text.slice(m.index, found[i + 1]?.index ?? text.length))
    })
  }
  return out
}
function writeRoutes(): string[] {
  return [...writeRouteTexts().keys()]
}

/** A handler that takes the person's pictures (`images` inline or `imageRefs` uploaded). */
const TAKES_PICTURES = /\bimageRefs\b|withInlinePictures\(|savePicturesOnce\(|saveAnswerPictures\(/

describe('companion person writes', () => {
  const routes = writeRoutes()

  it('reads the route files', () => {
    expect(routes.length).toBeGreaterThan(40)
    expect(routes).toContain('POST /human-inbox/:id/human-reply')
  })

  it('every write route has a row', () => {
    expect(routes.filter((r) => !(r in TABLE))).toEqual([])
  })

  it('every row names a route that exists', () => {
    expect(Object.keys(TABLE).filter((r) => !routes.includes(r))).toEqual([])
  })

  it('a journal row names a kind the Mac applies and the companion writes', () => {
    const journal = fs.readFileSync(path.resolve(__dirname, '../../src/core/companion-journal.ts'), 'utf8')
    for (const [route, row] of Object.entries(TABLE)) {
      if (row.offline !== 'journal') continue
      expect((APPLIED_V2_KINDS as readonly string[]).includes(row.kind), `${route}: ${row.kind} is not applied on the Mac`).toBe(true)
      // A note record is built by the journal core's appendNote (offline-journal-core.ts).
      const writes = journal.includes(`kind: '${row.kind}'`) || (row.kind === 'note' && journal.includes('.appendNote('))
      expect(writes, `${route}: the companion journal writes no ${row.kind} record`).toBe(true)
    }
  })

  it('a journal route that takes pictures names their kind, applied on the Mac and written by the companion', () => {
    const journal = fs.readFileSync(path.resolve(__dirname, '../../src/core/companion-journal.ts'), 'utf8')
    const texts = writeRouteTexts()
    const takers = [...texts].filter(([, t]) => TAKES_PICTURES.test(t)).map(([r]) => r)
    expect(takers).toContain('POST /human-inbox/:id/human-reply')
    for (const route of takers) {
      const row = TABLE[route]
      if (row?.offline !== 'journal') continue
      expect(row.pictures, `${route} takes pictures: name the journal kind they go under`).toBeTruthy()
      expect((APPLIED_V2_KINDS as readonly string[]).includes(row.pictures!), `${route}: ${row.pictures} is not applied on the Mac`).toBe(true)
      expect(journal.includes(`kind: '${row.pictures}'`), `${route}: the companion journal writes no ${row.pictures} record`).toBe(true)
    }
  })

  it('a leader row says why in a sentence', () => {
    for (const [route, row] of Object.entries(TABLE)) {
      if (row.offline === 'leader') expect(row.why.length, route).toBeGreaterThan(20)
    }
  })
})
