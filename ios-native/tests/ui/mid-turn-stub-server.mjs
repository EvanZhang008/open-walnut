#!/usr/bin/env node
// Throwaway /api/v1 stub that can hold a chat turn open for as long as a test
// needs, so the MID-TURN composer state is deterministic.
//
// WHY THIS EXISTS. The behaviour under test is "what the composer does WHILE the
// agent is talking": the send button must stay a send, the tap must be banked as
// a queued bubble, and the banked message must go out exactly once after the turn
// settles. A real model turn cannot be used to stage that. It ends when it feels
// like it (so the mid-turn window is a race), its text is different every run,
// and the only box that has one is the human's production Walnut on :3456, which
// this test layer is forbidden to write to. So the turn is staged instead: the
// stub accepts the POST, answers 202 like the real route, opens the conversation
// stream, emits a few frames, and then simply STOPS emitting until the test says
// `POST /__stub/finish-turn`. The window is as long as the test needs and the
// screen is in a known state for every assertion.
//
// WHAT IT IS NOT. Not a second implementation of Walnut. Every response here is
// the smallest body the iOS client will accept, with field names copied from
// `src/web/routes/api-v1.ts` and `docs/reference/api-v1.md` — nothing is
// invented, because a stub that answers a shape the real server never sends
// makes the test lie in the client's favour.
//
// THE SHAPE THE REAL SERVER USES, and the two places it is easy to get backwards:
//  1. `POST /api/v1/conversations/:id/messages` is NOT the stream. It answers
//     `202 {"turnId":…}` as ordinary JSON, and the turn's frames arrive on the
//     SEPARATE `GET /api/v1/conversations/:id/stream` SSE channel.
//  2. That stream is opened by the client BEFORE the POST (ChatStore connects it
//     the moment `createConversation` names the conversation), but "before" is a
//     race, not a guarantee. So frames go into a per-conversation ring first and
//     are replayed to whoever attaches, which is what the real route does too.
//
// HOLDING A TURN IS NOT ENOUGH: the client has a watchdog that refetches history
// after 30s of stream silence and settles the turn if that history looks
// finished. Two things keep a held turn honestly in flight for minutes:
// a `thinking` frame every few seconds (the agent IS reasoning), and the
// in-flight turn's assistant row carrying `inFlight: true` on
// `GET /conversations/:id/messages`, which is the field the client trusts first.
//
// SAFETY. Binds 127.0.0.1 only, on port 0 (the kernel picks), and prints the
// chosen port on stdout so two runs can never collide and neither can ever be
// :3456 (production) or :3457 (the Playwright fixture). It refuses to start if
// a port is forced to either of those.
//
// USAGE
//   node mid-turn-stub-server.mjs                 # serve
//   node mid-turn-stub-server.mjs --probe         # log every request, answer 404
//                                                 # (this is how the endpoint
//                                                 #  surface below was found)
// WHAT THE PROBE FOUND, since the endpoint list below is measured and not
// guessed. Pointed at `--probe` (404 to everything) the app still reached the
// Chat tab and asked for exactly these, in this order: `POST /client-logs`,
// `GET /chat/engine`, `GET /events`, `GET /human-inbox`, `GET /status` (x2),
// `POST /devices/self`, `GET /tasks`, `GET /tasks/groups`, `GET /focus/tiers`,
// `GET /sessions`, `GET /focus/tasks`, `GET /agents`, `GET /conversations`,
// `GET /notes`, `GET /favorites`. Two things that list settles:
//  - NO conversation is opened on launch (`ChatStore.initialize` selects `nil`;
//    a new chat is the resting state), so the conversation this test drives is
//    created by its FIRST send. Nothing has to be seeded.
//  - A 404 does not take the app offline. Only a TRANSPORT failure counts
//    toward `ConnectionStore`'s two-strike gate, and `disabled: !online` is what
//    greys the send button — so the endpoints below are served for a clean
//    screen and an honest wire log, not to keep the composer alive.
//
// ENV
//   WALNUT_STUB_RECORD   JSON file every request is appended to, in order.
//                        Default /tmp/midturn-queue/stub-requests.json
//   WALNUT_STUB_SHOTS    directory screenshots POSTed by the test are written to.
//                        Default /tmp/midturn-queue
//   WALNUT_STUB_SHOT_SUFFIX  appended to every screenshot name. This is how one
//                        run can be repeated under a different simulator text
//                        size without the second pass overwriting the first.
//   WALNUT_STUB_PORT     force a port (refused for 3456/3457)
//
// CONTROL PLANE (same server, so the test needs only one base URL)
//   POST /__stub/reset        → new generation: close held streams, forget the
//                               conversations and the record. A previous test's
//                               banked message is pruned by the client itself,
//                               because its conversation is no longer listed.
//   POST /__stub/finish-turn  → the held turn emits `message-end` and settles.
//   GET  /__stub/state        → generation, whether a turn is held, the message
//                               POSTs seen this generation, the history.
//   GET  /__stub/requests     → every recorded request this generation, in order.
//   POST /__stub/screenshot?name=X  → body is PNG bytes; written to
//                               <shots>/X<suffix>.png. The XCUITest runner is a
//                               sandboxed process on the simulator, so the one
//                               reliable way to land a PNG at a path a human can
//                               open is to hand it to this host process.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const PROBE = process.argv.includes('--probe')
const RECORD_PATH = process.env.WALNUT_STUB_RECORD
  || '/tmp/midturn-queue/stub-requests.json'
const SHOTS_DIR = process.env.WALNUT_STUB_SHOTS || '/tmp/midturn-queue'
const SHOT_SUFFIX = process.env.WALNUT_STUB_SHOT_SUFFIX || ''
const FORCED_PORT = Number(process.env.WALNUT_STUB_PORT || 0)

if (FORCED_PORT === 3456 || FORCED_PORT === 3457) {
  console.error('refusing to bind 3456 (production) or 3457 (playwright fixture)')
  process.exit(2)
}

// ── State ────────────────────────────────────────────────────────────────────
// Everything is per GENERATION. A test calls /__stub/reset, gets a generation,
// and every assertion it makes is scoped to that number — so one xcodebuild run
// can host five tests without their evidence mixing.

let generation = 0
/** Requests seen this generation, in arrival order. */
let records = []
/** Conversations created this generation. Only these are LISTED, which is what
 *  makes the client prune a previous test's banked send instead of delivering
 *  it into this one (ChatSendQueueRules.pruned). */
let conversations = []
/** Canonical history, oldest first, shaped like GET /conversations/:id/messages. */
let history = []
/** The turn being held open, or null. */
let heldTurn = null
/** Open SSE responses per conversation id. */
const streams = new Map()
/** Current turn's frames per conversation id, for replay on a late attach. */
const rings = new Map()

let seq = 0
let eventId = 0

function nowISO() { return new Date().toISOString() }

function record(entry) {
  const row = { seq: ++seq, at: nowISO(), generation, ...entry }
  records.push(row)
  try {
    fs.mkdirSync(path.dirname(RECORD_PATH), { recursive: true })
    fs.writeFileSync(RECORD_PATH, JSON.stringify(records, null, 2))
  } catch (err) {
    console.error(`could not write ${RECORD_PATH}: ${err.message}`)
  }
  console.log(`[stub] ${row.seq} ${entry.method} ${entry.path}`
    + (entry.text === undefined ? '' : ` text=${JSON.stringify(entry.text)}`))
}

function json(res, code, body) {
  const payload = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function notFound(res, message) {
  json(res, 404, { error: { code: 'not_found', message: message || 'not found' } })
}

// ── SSE ──────────────────────────────────────────────────────────────────────

function attachStream(conversationID, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const list = streams.get(conversationID) || []
  list.push(res)
  streams.set(conversationID, list)
  // Replay the current turn, exactly as the real route does for a client that
  // attaches mid-turn with no Last-Event-ID. This is what removes the
  // connect-versus-POST race: a frame emitted before anyone was listening is
  // still delivered.
  for (const frame of rings.get(conversationID) || []) res.write(frame)
  res.on('close', () => {
    const open = (streams.get(conversationID) || []).filter((r) => r !== res)
    streams.set(conversationID, open)
  })
}

function emit(conversationID, event, data) {
  const frame = `id: ${++eventId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  const ring = rings.get(conversationID) || []
  // message-start opens a turn's ring; nothing before it is ever replayed.
  if (event === 'message-start') rings.set(conversationID, [frame])
  else { ring.push(frame); rings.set(conversationID, ring) }
  for (const res of streams.get(conversationID) || []) res.write(frame)
}

// ── The held turn ────────────────────────────────────────────────────────────

/** Text the held turn has "said so far". Shown on screen and carried by the
 *  in-flight assistant row, so the mid-turn screenshot is a real streaming turn
 *  rather than a bare spinner. */
const PARTIAL_REPLY = 'Working on it. Reading the first file now'
const FINAL_REPLY = 'Working on it. Reading the first file now, and here is the answer.'

function startHeldTurn(conversationID, turnId) {
  emit(conversationID, 'message-start', { turnId })
  emit(conversationID, 'text-delta', { delta: PARTIAL_REPLY })
  // The in-flight row the watchdog reads. Never the user's own row: the server
  // flags "the assistant, thinking and tool rows after the last user row".
  history.push({
    id: `m${history.length + 1}`, role: 'assistant', text: PARTIAL_REPLY,
    createdAt: nowISO(), inFlight: true,
  })
  const keepalive = setInterval(() => {
    if (!heldTurn || heldTurn.turnId !== turnId) return
    // A `thinking` frame, not a `: ping` comment: the client's stall watchdog
    // counts parsed EVENTS, and a comment would let it decide after 30s that
    // the turn it can still see is over.
    emit(conversationID, 'thinking', { delta: '.' })
  }, 4000)
  keepalive.unref?.()
  heldTurn = { conversationID, turnId, keepalive }
}

function finishHeldTurn() {
  if (!heldTurn) return null
  const { conversationID, turnId, keepalive } = heldTurn
  clearInterval(keepalive)
  heldTurn = null
  // The in-flight row becomes the settled reply.
  const idx = history.findIndex((m) => m.inFlight)
  if (idx >= 0) history[idx] = {
    id: history[idx].id, role: 'assistant', text: FINAL_REPLY,
    createdAt: history[idx].createdAt,
  }
  emit(conversationID, 'message-end', { turnId, fullText: FINAL_REPLY })
  return turnId
}

function resetAll() {
  if (heldTurn) clearInterval(heldTurn.keepalive)
  heldTurn = null
  for (const list of streams.values()) for (const res of list) res.end()
  streams.clear()
  rings.clear()
  records = []
  conversations = []
  history = []
  seq = 0
  generation += 1
  try {
    fs.mkdirSync(path.dirname(RECORD_PATH), { recursive: true })
    fs.writeFileSync(RECORD_PATH, JSON.stringify([], null, 2))
  } catch { /* the record file is evidence, not a dependency */ }
  return generation
}

// ── Routing ──────────────────────────────────────────────────────────────────

/** Buffers, never a concatenated string: one of these bodies is PNG bytes, and
 *  string concatenation would replace every invalid UTF-8 sequence in it. */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

/** What gets recorded for a body. Deliberately NOT the raw body: an image send
 *  carries megabytes of base64 and the evidence file has to stay readable. */
function summarize(raw) {
  if (!raw) return {}
  try {
    const body = JSON.parse(raw)
    const out = {}
    if (typeof body.text === 'string') out.text = body.text
    if (Array.isArray(body.images)) out.imageCount = body.images.length
    if (typeof body.agentId === 'string') out.agentId = body.agentId
    if (typeof body.title === 'string') out.title = body.title
    return out
  } catch {
    return { bodyBytes: Buffer.byteLength(raw) }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const p = url.pathname
  const body = req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT'
    ? await readBody(req)
    : Buffer.alloc(0)
  const raw = p === '/__stub/screenshot' ? '' : body.toString('utf8')

  // The control plane is never recorded: it is the test talking to its own
  // fixture, and mixing it into the wire log would muddy exactly the evidence
  // the log exists to give ("what did the APP send, and when").
  if (p.startsWith('/__stub/')) {
    if (p === '/__stub/reset' && req.method === 'POST') {
      const g = resetAll()
      console.log(`[stub] reset → generation ${g}`)
      return json(res, 200, { ok: true, generation: g })
    }
    if (p === '/__stub/finish-turn' && req.method === 'POST') {
      const turnId = finishHeldTurn()
      console.log(`[stub] finish-turn → ${turnId ?? 'no turn held'}`)
      return json(res, 200, { ok: true, finished: turnId })
    }
    if (p === '/__stub/state') {
      return json(res, 200, {
        generation,
        turnHeld: heldTurn ? heldTurn.turnId : null,
        conversations,
        messagePosts: records
          .filter((r) => r.method === 'POST' && /\/messages$/.test(r.path))
          .map((r) => ({ seq: r.seq, at: r.at, path: r.path, text: r.text })),
        history,
        requestCount: records.length,
      })
    }
    if (p === '/__stub/requests') return json(res, 200, records)
    if (p === '/__stub/diag' && req.method === 'POST') {
      // Same reasoning as the screenshot sink: the runner is sandboxed on the
      // simulator, and an accessibility-hierarchy dump is only useful if a human
      // can open it. An XCTAttachment needs xcresult archaeology to read.
      const name = (url.searchParams.get('name') || 'diag')
        .replace(/[^A-Za-z0-9._-]/g, '-')
      const file = path.join(SHOTS_DIR, `${name}${SHOT_SUFFIX}.txt`)
      try {
        fs.mkdirSync(SHOTS_DIR, { recursive: true })
        fs.writeFileSync(file, body)
        console.log(`[stub] diag → ${file} (${body.length} bytes)`)
        return json(res, 200, { ok: true, file, bytes: body.length })
      } catch (err) {
        return json(res, 500, { ok: false, message: err.message })
      }
    }
    if (p === '/__stub/screenshot' && req.method === 'POST') {
      const name = (url.searchParams.get('name') || 'shot')
        .replace(/[^A-Za-z0-9._-]/g, '-')
      const file = path.join(SHOTS_DIR, `${name}${SHOT_SUFFIX}.png`)
      try {
        fs.mkdirSync(SHOTS_DIR, { recursive: true })
        fs.writeFileSync(file, body)
        console.log(`[stub] screenshot → ${file} (${body.length} bytes)`)
        return json(res, 200, { ok: true, file, bytes: body.length })
      } catch (err) {
        console.error(`[stub] screenshot failed: ${err.message}`)
        return json(res, 500, { ok: false, message: err.message })
      }
    }
    return notFound(res, `unknown control endpoint ${p}`)
  }

  record({ method: req.method, path: p, query: url.search || '', ...summarize(raw) })

  if (PROBE) return notFound(res, 'probe mode answers 404 to everything')

  // ── GET /api/v1/status ─────────────────────────────────────────────────────
  if (p === '/api/v1/status' && req.method === 'GET') {
    return json(res, 200, {
      mode: 'LIVE', cloud: false, version: '0.0.0-stub', serverTime: nowISO(),
    })
  }

  // ── GET /api/v1/agents ─────────────────────────────────────────────────────
  if (p === '/api/v1/agents' && req.method === 'GET') {
    return json(res, 200, [{ id: 'general', name: 'Walnut', isMain: true }])
  }

  // ── Conversations ──────────────────────────────────────────────────────────
  if (p === '/api/v1/conversations' && req.method === 'GET') {
    return json(res, 200, conversations)
  }
  if (p === '/api/v1/conversations' && req.method === 'POST') {
    const id = `conv-stub-${generation}-${conversations.length + 1}`
    conversations.unshift({
      id, title: 'Mid-turn queue', updatedAt: nowISO(), messageCount: 0,
    })
    return json(res, 201, { id })
  }

  const messagesMatch = p.match(/^\/api\/v1\/conversations\/([^/]+)\/messages$/)
  if (messagesMatch && req.method === 'GET') {
    // The whole history, in-flight row included and flagged. The client is the
    // one that decides to withhold an in-flight row from its timeline; a stub
    // that hid it would be testing the stub's judgement instead of the app's.
    return json(res, 200, history)
  }
  if (messagesMatch && req.method === 'POST') {
    const conversationID = decodeURIComponent(messagesMatch[1])
    let body = {}
    try { body = JSON.parse(raw) } catch { /* recorded as bodyBytes above */ }
    if (heldTurn) {
      // Exactly what the real route answers while a turn owns the conversation.
      // It should be UNREACHABLE for a queued send (the point of the queue is
      // that nothing is posted until the turn settles), so answering honestly
      // here is what makes a regression visible instead of silently accepted.
      return json(res, 409, {
        error: { code: 'turn_active', message: 'A turn is already running' },
      })
    }
    history.push({
      id: `m${history.length + 1}`, role: 'user', text: String(body.text ?? ''),
      createdAt: nowISO(),
    })
    const turnId = `turn-stub-${eventId + 1}`
    json(res, 202, { turnId })
    // After the 202, so the client has its accepted answer before the first frame.
    startHeldTurn(conversationID, turnId)
    return
  }

  const streamMatch = p.match(/^\/api\/v1\/conversations\/([^/]+)\/stream$/)
  if (streamMatch && req.method === 'GET') {
    return attachStream(decodeURIComponent(streamMatch[1]), res)
  }

  const stopMatch = p.match(/^\/api\/v1\/conversations\/([^/]+)\/stop$/)
  if (stopMatch && req.method === 'POST') {
    const turnId = finishHeldTurn()
    return json(res, 200, { stopped: turnId != null, questionCancelled: false })
  }

  // ── Everything else the app pokes at on launch ─────────────────────────────
  // Answered with the smallest valid body rather than 404 only where a 404
  // costs something (a retry loop, a visible banner). The probe run is what
  // decided this list; see the header.
  if (p === '/api/v1/chat/engine' && req.method === 'GET') {
    // `sessionId: null` = the lane has no CLI session yet, which is the honest
    // answer for a stub and makes the composer's model pill read-only instead of
    // showing a retry affordance over the button under test.
    return json(res, 200, { engine: 'lane', sessionId: null, switchable: false })
  }
  if (p === '/api/v1/client-logs' && req.method === 'POST') return json(res, 200, { ok: true })
  if (p === '/api/v1/devices/self' && req.method === 'POST') return json(res, 200, { ok: true })
  if (p === '/api/v1/time/heartbeats' && req.method === 'POST') return json(res, 200, { ok: true })
  if (p === '/api/v1/human-inbox' && req.method === 'GET') {
    return json(res, 200, { letters: [], unreadCount: 0 })
  }
  if (p === '/api/v1/tasks' && req.method === 'GET') return json(res, 200, { tasks: [] })
  if (p === '/api/v1/sessions' && req.method === 'GET') return json(res, 200, { sessions: [] })
  if (p === '/api/v1/focus/tasks' && req.method === 'GET') return json(res, 200, { tasks: [] })
  if (p === '/api/v1/events' && req.method === 'GET') {
    // Held open with comments only. TasksStore reconnects with backoff when this
    // closes, and a reconnect storm in the log makes the chat evidence harder to
    // read; no event it could send matters to this test.
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write(': stub\n\n')
    const ping = setInterval(() => res.write(': ping\n\n'), 25000)
    ping.unref?.()
    res.on('close', () => clearInterval(ping))
    return
  }

  return notFound(res, `stub does not serve ${req.method} ${p}`)
})

server.listen(FORCED_PORT, '127.0.0.1', () => {
  const { port } = server.address()
  // The ONE line the runner parses. Keep it first-token-stable.
  console.log(`PORT ${port}`)
  console.log(`[stub] ${PROBE ? 'PROBE (404 to everything)' : 'serving'} on http://127.0.0.1:${port}`)
  console.log(`[stub] recording to ${RECORD_PATH}`)
  resetAll()
})

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (heldTurn) clearInterval(heldTurn.keepalive)
    for (const list of streams.values()) for (const res of list) res.end()
    server.close(() => process.exit(0))
    // A held SSE response keeps the server from closing on its own.
    setTimeout(() => process.exit(0), 200).unref?.()
  })
}
