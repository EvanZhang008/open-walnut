/**
 * /api/v1/human-inbox routes — the whole letter loop through a REAL server
 * (startServer({ port: 0, dev: true })), which is also what proves the router
 * is actually mounted on the v1 surface.
 *
 * What this file pins, beyond the happy path:
 *  - the SENDER is stamped from the caller-sid header, never from the body, and
 *    an unknown/absent caller becomes the honest `external` sender;
 *  - the ops registry reaches these routes end to end (executeOp → HTTP →
 *    letter), including the header the executor adds and its env fallback;
 *  - a human answer is RECORDED before it is delivered, and the delivery text
 *    the origin session receives carries subject, choice, and the one op call
 *    the agent needs to answer back.
 *
 * The session message queue is the only mock (its real path would spawn a CLI).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-human-inbox-routes'))

/** Captured deliveries — hoisted so the mock factory can close over it. */
const { deliveries } = vi.hoisted(() => ({
  deliveries: [] as Array<{ sessionId: string; message: string; source?: string }>,
}))

vi.mock('../../src/core/session-message-queue.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/session-message-queue.js')>()
  return {
    ...actual,
    sendMessageToSession: async (sessionId: string, message: string, opts?: { source?: string }) => {
      deliveries.push({ sessionId, message, source: opts?.source })
      return { id: `qm-test-${deliveries.length}` }
    },
  }
})

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { CALLER_SID_HEADER, executeOp } from '../../src/ops/index.js'
import { LETTER_BODY_MAX_BYTES, LETTER_HTML_MAX_BYTES } from '../../src/core/human-inbox/types.js'

let server: HttpServer
let port: number
/** The letter-sending session (created once; its sid is the caller identity). */
const SENDER_SID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
let senderTaskId = ''
const envSidBefore = process.env.WALNUT_SESSION_ID

function url(path: string): string {
  return `http://127.0.0.1:${port}${path}`
}

async function post(path: string, body: unknown, sid?: string): Promise<Response> {
  return fetch(url(path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(sid ? { [CALLER_SID_HEADER]: sid } : {}),
    },
    body: JSON.stringify(body ?? {}),
  })
}

interface LetterEnvelope {
  id: string
  subject: string
  type: string
  read: boolean
  pinned: boolean
  archived: boolean
  textPreview: string
  sender: Record<string, unknown>
  thread: Array<{ from: string; text: string }>
  answered?: { actionId: string; label: string; freeText?: string }
}

async function sendLetter(body: Record<string, unknown>, sid?: string): Promise<string> {
  const res = await post('/api/v1/human-inbox', body, sid)
  expect(res.status, await res.clone().text()).toBe(201)
  const { id } = await res.json() as { id: string }
  expect(id).toMatch(/^lt-/)
  return id
}

async function getLetter(id: string): Promise<{ letter: LetterEnvelope & { body: string } }> {
  const res = await fetch(url(`/api/v1/human-inbox/${id}`))
  expect(res.status, await res.clone().text()).toBe(200)
  return res.json() as Promise<{ letter: LetterEnvelope & { body: string } }>
}

async function listLetters(archived = false): Promise<{ letters: LetterEnvelope[]; unreadCount: number }> {
  const res = await fetch(url(`/api/v1/human-inbox${archived ? '?archived=1' : ''}`))
  expect(res.status).toBe(200)
  return res.json() as Promise<{ letters: LetterEnvelope[]; unreadCount: number }>
}

const ACTION_LETTER = {
  subject: 'Cache strategy: A or B?',
  type: 'action_required',
  markdown: 'Two ways forward.\n\n- **A** cache in memory\n- **B** recompute',
  text: 'Pick A (cache) or B (recompute).',
  actions: [
    { id: 'a', label: 'Cache in memory', description: 'Recommended' },
    { id: 'b', label: 'Recompute each time' },
  ],
}

beforeAll(async () => {
  // A stray WALNUT_SESSION_ID (this suite may itself run inside a managed
  // session) would silently stamp every op-sent letter — own the variable.
  delete process.env.WALNUT_SESSION_ID
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port

  // A real task + a real session record: the sender envelope is resolved from
  // the session tracker and the task store, not from anything the caller sends.
  const taskRes = await post('/api/v1/tasks', { title: 'Ship the cache layer', project: 'marina' })
  expect(taskRes.status).toBe(201)
  senderTaskId = ((await taskRes.json()) as { task: { id: string } }).task.id
  const { createSessionRecord } = await import('../../src/core/session-tracker.js')
  await createSessionRecord(SENDER_SID, senderTaskId, 'marina', '/tmp/marina', {
    title: 'cache refactor',
    host: 'workbench',
  })
}, 60_000)

afterAll(async () => {
  await stopServer()
  if (envSidBefore === undefined) delete process.env.WALNUT_SESSION_ID
  else process.env.WALNUT_SESSION_ID = envSidBefore
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(async () => {
  deliveries.length = 0
  // Letters are durable by design (no cap, no tail drop), so each test starts
  // from a clean index rather than filtering a shared feed.
  await fs.rm(`${WALNUT_HOME}/human-inbox`, { recursive: true, force: true }).catch(() => {})
})

describe('POST /api/v1/human-inbox — send + sender stamping', () => {
  it('stamps the envelope from the caller-sid header (session, task, project, host)', async () => {
    const id = await sendLetter({
      subject: 'Migration done',
      type: 'completion',
      markdown: '# Done\n42 files, all tests green.',
    }, SENDER_SID)

    const { letters, unreadCount } = await listLetters()
    expect(letters).toHaveLength(1)
    expect(unreadCount).toBe(1)
    expect(letters[0]).toMatchObject({ id, subject: 'Migration done', type: 'completion', read: false })
    expect(letters[0].sender).toEqual({
      sessionId: SENDER_SID,
      sessionTitle: 'cache refactor',
      taskId: senderTaskId,
      taskTitle: 'Ship the cache layer',
      project: 'marina',
      host: 'workbench',
    })
    // Envelopes carry a preview, never the body.
    expect(letters[0].textPreview).toContain('42 files')
    expect((letters[0] as unknown as { body?: string }).body).toBeUndefined()

    const { letter } = await getLetter(id)
    expect(letter.body).toBe('# Done\n42 files, all tests green.')
    expect(letter.thread).toEqual([])
  })

  it('an absent or unknown caller sid becomes the external sender', async () => {
    const anonymous = await sendLetter({ subject: 'From a script', type: 'info', markdown: 'hi' })
    const bogus = await sendLetter({ subject: 'Forged', type: 'info', markdown: 'hi' }, 'no-such-session-id')
    const byId = new Map((await listLetters()).letters.map((l) => [l.id, l]))
    for (const id of [anonymous, bogus]) {
      expect(byId.get(id)!.sender).toEqual({ sessionId: 'external', host: 'local' })
    }
  })

  it('the body can never claim a different sender', async () => {
    const id = await sendLetter({
      subject: 'Nice try',
      type: 'info',
      markdown: 'hi',
      sender: { sessionId: 'someone-else', host: 'their-box' },
    }, SENDER_SID)
    const { letter } = await getLetter(id)
    expect(letter.sender.sessionId).toBe(SENDER_SID)
    expect(letter.sender.host).toBe('workbench')
  })

  it('rejects the malformed letter shapes with 400 bad_request', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['no subject', { type: 'info', markdown: 'x' }],
      ['unknown type', { subject: 's', type: 'nonsense', markdown: 'x' }],
      ['no body', { subject: 's', type: 'info' }],
      ['both bodies', { subject: 's', type: 'info', markdown: 'x', html: '<p>x</p>' }],
      ['actions on a non-decision letter', {
        subject: 's', type: 'info', markdown: 'x', actions: [{ id: 'a', label: 'A' }],
      }],
      ['action without a label', {
        subject: 's', type: 'action_required', markdown: 'x', actions: [{ id: 'a' }],
      }],
    ]
    for (const [label, payload] of cases) {
      const res = await post('/api/v1/human-inbox', payload, SENDER_SID)
      expect(res.status, label).toBe(400)
      expect((await res.json()).error.code, label).toBe('bad_request')
    }
    expect((await listLetters()).letters).toHaveLength(0)
  })

  it('refuses an oversize markdown body with 413 instead of writing it', async () => {
    const res = await post('/api/v1/human-inbox', {
      subject: 'Whale', type: 'review', markdown: 'x'.repeat(LETTER_BODY_MAX_BYTES + 1),
    }, SENDER_SID)
    expect(res.status).toBe(413)
    expect((await res.json()).error.code).toBe('too_large')
    expect((await listLetters()).letters).toHaveLength(0)
  })

  /**
   * The audio-digest case, end to end over real HTTP: an html body may be far
   * over the markdown cap (a base64 `<audio>` podcast is 2-5MB), and what comes
   * back out has to be byte-identical — a body truncated anywhere inside the
   * base64 is a player that renders and never plays.
   */
  it('accepts a multi-MB html body and returns it byte-identical', async () => {
    const audio = 'A'.repeat(1024 * 1024 + 7)
    const html = `<h1>Daily digest</h1><audio controls src="data:audio/mpeg;base64,${audio}"></audio>`
    const id = await sendLetter({
      subject: 'Your Thursday digest', type: 'info', html, text: 'Four minutes of audio.',
    }, SENDER_SID)

    const { letter } = await getLetter(id)
    expect(letter.bodyFormat).toBe('html')
    expect(letter.body).toBe(html)
    // The envelope stays a phone-sized envelope: no base64 in the preview.
    expect(letter.textPreview).toBe('Four minutes of audio.')

    // The list route carries envelopes only — the body must not ride it.
    const listed = (await listLetters()).letters.find(l => l.id === id)
    expect(listed).toBeTruthy()
    expect(JSON.stringify(listed)).not.toContain('AAAA')
  })

  it('still refuses an html body over the 10MB media cap', async () => {
    const res = await post('/api/v1/human-inbox', {
      subject: 'Whale', type: 'review', html: 'x'.repeat(LETTER_HTML_MAX_BYTES + 1),
    }, SENDER_SID)
    expect(res.status).toBe(413)
    expect((await res.json()).error.code).toBe('too_large')
    expect((await listLetters()).letters).toHaveLength(0)
  })
})

describe('read / pin / archive', () => {
  it('toggles each flag and keeps the archived feed separate', async () => {
    const id = await sendLetter({ subject: 'Digest', type: 'review', markdown: 'yesterday' }, SENDER_SID)

    const read = await post(`/api/v1/human-inbox/${id}/read`, { read: true })
    expect(read.status).toBe(200)
    expect(((await read.json()) as { letter: LetterEnvelope }).letter.read).toBe(true)
    expect((await listLetters()).unreadCount).toBe(0)

    const pinned = await post(`/api/v1/human-inbox/${id}/pin`, { pinned: true })
    expect(((await pinned.json()) as { letter: LetterEnvelope }).letter.pinned).toBe(true)

    const archived = await post(`/api/v1/human-inbox/${id}/archive`, { archived: true })
    expect(((await archived.json()) as { letter: LetterEnvelope }).letter.archived).toBe(true)
    expect((await listLetters()).letters).toHaveLength(0)
    expect((await listLetters(true)).letters.map((l) => l.id)).toEqual([id])
  })

  it('a missing boolean is a 400, not a silent false', async () => {
    const id = await sendLetter({ subject: 'x', type: 'info', markdown: 'x' }, SENDER_SID)
    for (const [path, body] of [['read', {}], ['pin', { pinned: 'yes' }], ['archive', {}]] as const) {
      const res = await post(`/api/v1/human-inbox/${id}/${path}`, body)
      expect(res.status, path).toBe(400)
    }
  })

  it('404s an unknown letter id on every surface', async () => {
    const unknown = 'lt-zzzzzz-abcdef'
    expect((await fetch(url(`/api/v1/human-inbox/${unknown}`))).status).toBe(404)
    expect((await post(`/api/v1/human-inbox/${unknown}/read`, { read: true })).status).toBe(404)
    expect((await post(`/api/v1/human-inbox/${unknown}/answer`, { actionId: 'a' })).status).toBe(404)
  })
})

describe('answer flow (action_required)', () => {
  it('records the choice, delivers it to the origin session, and refuses a second answer', async () => {
    const id = await sendLetter(ACTION_LETTER, SENDER_SID)

    const res = await post(`/api/v1/human-inbox/${id}/answer`, { actionId: 'a', freeText: 'but after the tests pass' })
    expect(res.status, await res.clone().text()).toBe(200)
    const answered = await res.json() as { letter: LetterEnvelope; delivery: { status: string; sessionId?: string } }
    expect(answered.letter.answered).toMatchObject({ actionId: 'a', label: 'Cache in memory', freeText: 'but after the tests pass' })
    expect(answered.letter.thread.at(-1)).toMatchObject({ from: 'human' })
    expect(answered.delivery).toMatchObject({ status: 'queued', sessionId: SENDER_SID })

    // The origin session receives the subject, the choice, and ONE instruction.
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0].sessionId).toBe(SENDER_SID)
    expect(deliveries[0].source).toBe('human-inbox')
    expect(deliveries[0].message).toContain('Cache strategy: A or B?')
    expect(deliveries[0].message).toContain('Cache in memory')
    expect(deliveries[0].message).toContain('but after the tests pass')
    expect(deliveries[0].message).toContain(`human_inbox_reply '{"letter":"${id}"`)

    const second = await post(`/api/v1/human-inbox/${id}/answer`, { actionId: 'b' })
    expect(second.status).toBe(409)
    expect((await second.json()).error.code).toBe('conflict')
    expect(deliveries).toHaveLength(1)
  })

  it('an unknown actionId is a 400 and delivers nothing', async () => {
    const id = await sendLetter(ACTION_LETTER, SENDER_SID)
    const res = await post(`/api/v1/human-inbox/${id}/answer`, { actionId: 'c' })
    expect(res.status).toBe(400)
    expect(deliveries).toHaveLength(0)
    const { letter } = await getLetter(id)
    expect(letter.answered).toBeUndefined()
  })

  it('answering an archived letter un-archives it (the decision belongs with the thread)', async () => {
    const id = await sendLetter(ACTION_LETTER, SENDER_SID)
    await post(`/api/v1/human-inbox/${id}/archive`, { archived: true })
    const res = await post(`/api/v1/human-inbox/${id}/answer`, { actionId: 'b' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { letter: LetterEnvelope }).letter.archived).toBe(false)
    expect((await listLetters()).letters.map((l) => l.id)).toEqual([id])
  })

  it('a letter with no reachable origin session keeps the answer and reports skipped', async () => {
    const id = await sendLetter(ACTION_LETTER) // external sender
    const res = await post(`/api/v1/human-inbox/${id}/answer`, { actionId: 'a' })
    expect(res.status).toBe(200)
    const out = await res.json() as { letter: LetterEnvelope; delivery: { status: string; reason?: string } }
    expect(out.delivery).toEqual({ status: 'skipped', reason: 'no_origin_session' })
    expect(out.letter.answered?.actionId).toBe('a')
    expect(deliveries).toHaveLength(0)
  })
})

describe('replies in both directions', () => {
  it('a human free-text reply threads and is delivered verbatim', async () => {
    const id = await sendLetter({ subject: 'Root cause found', type: 'review', markdown: 'the lock is stale' }, SENDER_SID)
    const res = await post(`/api/v1/human-inbox/${id}/human-reply`, { text: 'does this explain Tuesday too?' })
    expect(res.status, await res.clone().text()).toBe(200)
    const out = await res.json() as { letter: LetterEnvelope; delivery: { status: string } }
    expect(out.letter.thread).toHaveLength(1)
    expect(out.letter.thread[0]).toMatchObject({ from: 'human', text: 'does this explain Tuesday too?' })
    expect(out.delivery.status).toBe('queued')
    expect(deliveries[0].message).toContain('does this explain Tuesday too?')
    expect(deliveries[0].message).toContain('Root cause found')
  })

  it('an agent thread reply flips the letter back to unread', async () => {
    const id = await sendLetter({ subject: 'Root cause found', type: 'review', markdown: 'the lock is stale' }, SENDER_SID)
    await post(`/api/v1/human-inbox/${id}/read`, { read: true })

    const res = await post(`/api/v1/human-inbox/${id}/reply`, {
      text: 'Yes, Tuesday has the same signature.',
      markdown: '## Tuesday\nSame stale lock.',
    }, SENDER_SID)
    expect(res.status, await res.clone().text()).toBe(200)
    expect(((await res.json()) as { letter: LetterEnvelope }).letter.read).toBe(false)

    const { letter } = await getLetter(id)
    expect(letter.thread).toHaveLength(1)
    expect(letter.thread[0]).toMatchObject({ from: 'agent' })
    expect((letter.thread[0] as unknown as { body?: string }).body).toBe('## Tuesday\nSame stale lock.')
    expect((await listLetters()).unreadCount).toBe(1)
  })

  it('a reply with no text is a 400', async () => {
    const id = await sendLetter({ subject: 's', type: 'info', markdown: 'x' }, SENDER_SID)
    expect((await post(`/api/v1/human-inbox/${id}/reply`, {}, SENDER_SID)).status).toBe(400)
    expect((await post(`/api/v1/human-inbox/${id}/human-reply`, { text: '  ' })).status).toBe(400)
  })
})

describe('ops registry parity — executeOp reaches the real routes', () => {
  const apiBase = () => `http://127.0.0.1:${port}`

  it('the header name the executor sends is the one the route reads', () => {
    expect(CALLER_SID_HEADER).toBe('x-walnut-caller-sid')
  })

  it('human_inbox_send + human_inbox_reply run end to end with an explicit callerSid', async () => {
    const sent = await executeOp('human_inbox_send', {
      subject: 'Nightly run finished',
      type: 'completion',
      markdown: 'All green.',
      text: 'All green.',
      pin: true,
    }, { apiBase: apiBase(), callerSid: SENDER_SID })
    expect(sent.ok, sent.ok ? '' : sent.message).toBe(true)
    const letterId = (sent as { result: { letterId: string } }).result.letterId
    expect(letterId).toMatch(/^lt-/)

    const replied = await executeOp('human_inbox_reply', {
      letter: letterId,
      text: 'One follow-up: the flaky test is quarantined.',
    }, { apiBase: apiBase(), callerSid: SENDER_SID })
    expect(replied.ok, replied.ok ? '' : replied.message).toBe(true)

    const { letter } = await getLetter(letterId)
    expect(letter.sender.sessionId).toBe(SENDER_SID)
    expect(letter.pinned).toBe(true)
    expect(letter.thread).toHaveLength(1)
    expect(letter.thread[0].from).toBe('agent')
  })

  it('falls back to WALNUT_SESSION_ID when no callerSid is passed (CLI / MCP path)', async () => {
    process.env.WALNUT_SESSION_ID = SENDER_SID
    try {
      const sent = await executeOp('human_inbox_send', {
        subject: 'From the in-session CLI', type: 'info', markdown: 'hello',
      }, { apiBase: apiBase() })
      expect(sent.ok, sent.ok ? '' : sent.message).toBe(true)
      const letterId = (sent as { result: { letterId: string } }).result.letterId
      const { letter } = await getLetter(letterId)
      expect(letter.sender.sessionId).toBe(SENDER_SID)
      expect(letter.sender.host).toBe('workbench')
    } finally {
      delete process.env.WALNUT_SESSION_ID
    }
  })

  it('op-level validation rejects a bad letter before any HTTP call', async () => {
    const bad = await executeOp('human_inbox_send', { subject: 'x' }, { apiBase: apiBase() })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.message).toContain('Invalid arguments')
  })
})
