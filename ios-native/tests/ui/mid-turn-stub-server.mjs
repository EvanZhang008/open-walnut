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
//   POST /__stub/engine?mode=X → what `GET /api/v1/chat/engine` answers from now
//                               on (ModelPillHealUITests). Reset puts it back to
//                               `default`, the answer the mid-turn tests rely on.
//                                 default      lane, no session, switchable:false
//                                 unreachable  503 primary_unreachable {retry:true}
//                                              (a replica whose bridge to the Mac
//                                              is down, as api-v1 answers it)
//                                 degraded     an OLD replica's own config: one
//                                              in-process model, no catalog
//                                              (`&model=<id>` picks which model;
//                                              default global.anthropic.claude-opus-5)
//                                 lane         the Mac's lane session, whose
//                                              /sessions/:id/model-options is the
//                                              full ten-row catalog below
//                               The lane session's model and effort WRITES
//                               (POST /sessions/:id/model, /effort) are answered
//                               and recorded (with the value), so a test can prove
//                               whether a tap wrote anything, and what.
//   POST /__stub/write-delay?ms=N → those writes answer after N ms (a pick in
//                               flight a test can see). Reset puts it back to 0.
//   POST /__stub/lane?model=X&effort=Y → the lane session's CURRENT model and
//                               effort as the Mac reports them, without a recorded
//                               app write (`effort=none` = the session reports no
//                               effort, the CLI default). Reset clears both.
//   POST /__stub/drop-streams → end every open conversation SSE stream (and the
//                               work session's), so the app reconnects (what a
//                               network blip does).
//   POST /__stub/work-session?on=1 → the Tasks board gets one pinned task whose
//                               session is the lane session, so a test can open a
//                               SESSION page (its composer is the `.session(id)`
//                               surface): GET /tasks, /focus/tasks, /tasks/:id,
//                               /sessions, /sessions/:id, its transcript and its
//                               SSE stream. Off (the default) they answer as before.
//   POST /__stub/status?mode=X[&cloudChat=Y] → what GET /api/v1/status answers
//                               (ProvenanceAndInboxUITests). Reset puts it back to
//                               `live`, the answer every other test relies on.
//                                 live              the Mac itself (mode LIVE)
//                                 replica-mac       the cloud companion with the
//                                                   Mac's bridge (`__local__`) up
//                                 replica-mac-down  the companion, Mac bridge gone
//                                                   (`bridgeHosts: []`)
//                                 replica-unknown   the companion, too old to
//                                                   report bridges (no key)
//                               `cloudChat` = available | unavailable | absent
//                               (default absent: an older replica does not say).
//   POST /__stub/answered-by?mode=X → who answers the NEXT turn, as the frames and
//                               the history row say it. Reset puts it back to `mac`.
//                                 mac     nothing extra (the relayed/primary shape)
//                                 cloud   `answeredBy:"cloud"` on message-start,
//                                         message-end and the history row (a
//                                         current companion's cloud fallback)
//                                 legacy  `engine:"walnut-agent-fallback"` on
//                                         message-end and NOTHING in history (the
//                                         older companion's built-in agent)
//                               A cloud or legacy turn replies with its own text
//                               (CLOUD_REPLY), never FINAL_REPLY, so the phone's
//                               remembered cloud answers can never land on a
//                               Mac reply another test staged.
//   POST /__stub/inbox?seed=parity[&allRead=1] → the human inbox serves the 40 letters of
//                               tests/fixtures/inbox-parity/letters.json, their
//                               times moved so the newest is a few minutes old.
//                               GET /human-inbox[?archived=1], GET /human-inbox/:id
//                               and POST /human-inbox/:id/{read,pin,archive} then
//                               answer like the real routes. `allRead=1` marks
//                               every letter read ten minutes ago (the empty
//                               filter states). Reset empties it.
//   POST /__stub/inbox-read-fail?count=N[&status=S] → the next N read writes fail
//                               with S (default 503 bridge_offline, what a replica
//                               answers while the Mac is away). count=0 clears it.
//   POST /__stub/inbox-add[?type=T] → a new UNREAD letter arrives at the top.
//   POST /__stub/offline?on=1|0 → while on, every app request has its socket
//                               destroyed (a network failure, what an unreachable
//                               server looks like to the phone); /__stub/* keeps
//                               answering. Reset turns it off.
//   POST /__stub/session-replica?on=1[&honor=1][&rows=N] → the work session's
//                               stream behaves like the CLOUD REPLICA's
//                               (SessionStreamStormUITests): an id-less
//                               bridge-online/offline attach frame, then the replay
//                               of a never-reset 512-frame ring with process-style
//                               ids, honouring Last-Event-ID unless honor=0 (an
//                               old server). Its transcript serves N dense rows
//                               (default 300) and its messages POST answers like
//                               the replica, banking a send while the bridge is down
//                               (`queued: true`) and delivering it on return. Needs
//                               /__stub/work-session?on=1. Reset turns it off.
//   POST /__stub/session-honor?on=0|1 → flip Last-Event-ID honouring mid-test.
//   POST /__stub/session-emit?n=N    → N ring-shaped frames (status, deltas,
//                               turn-ends, bridge offline/online pairs) to the ring
//                               and to open streams, as a flapping bridge fills it.
//   POST /__stub/session-turn?text=T → a real new turn: turn-start, delta,
//                               turn-end, and its assistant row in the transcript.
//   POST /__stub/session-bridge?up=0|1 → the Mac's bridge drops / returns
//                               (bridge-offline / bridge-online frames; the return
//                               delivers banked sends into the transcript).
//   POST /__stub/session-blip?ms=M   → down now, back after M ms (default 1300).
//                               With from=attach the M ms count from the NEXT
//                               stream attach, so a page opened during the blip
//                               sees exactly M ms of absence however slowly the
//                               UI test reached it.
//   GET  /__stub/session-state       → ring size, newest id, bridge, banked and
//                               delivered sends, and every stream attach with the
//                               Last-Event-ID it sent.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

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

/** What GET /chat/engine answers (see /__stub/engine in the header). */
let engineMode = 'default'
const ENGINE_MODES = new Set(['default', 'unreachable', 'degraded', 'lane'])
const LANE_SESSION_ID = 'sess-stub-lane'
const DEGRADED_MODEL = 'global.anthropic.claude-opus-5'
let degradedModel = DEGRADED_MODEL
/** The lane session's model and effort, moved by the app's writes. */
let laneModel = null
let laneEffort = null
/** The lane session's permission mode, moved by the app's mode pill. */
let laneMode = 'bypass'
/** `laneEffort` value for "the session reports no effort". */
const NO_EFFORT = Symbol('no-effort')
/** How long the lane session's writes take to answer, so a test can see a pick
 *  in flight. */
let laneWriteDelayMs = 0

/** What GET /api/v1/status answers (see /__stub/status in the header). */
let statusMode = 'live'
const STATUS_MODES = new Set(['live', 'replica-mac', 'replica-mac-down', 'replica-unknown'])
/** `cloudChat` on a replica's /status, or null for "the key is absent". */
let statusCloudChat = null
/** Who answers the next turn (see /__stub/answered-by in the header). */
let answeredByMode = 'mac'
const ANSWERED_BY_MODES = new Set(['mac', 'cloud', 'legacy'])
/** Human-inbox letters (LetterRecord envelopes). Empty unless seeded. */
let inboxLetters = []
let inboxReadFailures = 0
let inboxReadFailStatus = 503
let inboxAdded = 0
/** The server is unreachable (see /__stub/offline in the header). */
let appOffline = false

/** The Mac's catalog, same row shape as GET /sessions/:id/model-options
 *  (`src/web/routes/session-control-v1.ts`), in the Mac's order. Copied from
 *  what a real primary's CLI answered (its host model catalog, 2026-09-24),
 *  `resolvedModel` included: alias rows (`default`, `opus`, `haiku`) only name
 *  a real model there, and the phone's row labels derive from it. */
const ALL_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
const FULL_CATALOG = {
  models: [
    ['default', 'global.anthropic.claude-opus-5-5[1m]', 'Default', ALL_LEVELS],
    ['global.anthropic.claude-fable-5[1m]', 'global.anthropic.claude-fable-5[1m]', 'Fable', ALL_LEVELS],
    ['global.anthropic.claude-fable-5-1[1m]', 'global.anthropic.claude-fable-5-1[1m]', 'Fable 5.1', ALL_LEVELS],
    ['global.anthropic.claude-sonnet-5', 'global.anthropic.claude-sonnet-5', 'Sonnet', ALL_LEVELS],
    ['opus', 'global.anthropic.claude-opus-5-5[1m]', 'Opus 5.5 (1M context)', ALL_LEVELS],
    ['haiku', 'global.anthropic.claude-haiku-4-5-20251001-v1:0', 'Haiku', null],
    ['gpt-6-astra', 'gpt-6-astra', 'GPT-6 Astra', ALL_LEVELS],
    ['gpt-6-sol', 'gpt-6-sol', 'GPT-6 Sol', null],
    ['gpt-6-luna', 'gpt-6-luna', 'GPT-6 Luna', null],
    ['gpt-5.6-sol', 'gpt-5.6-sol', 'GPT-5.6 Sol', null],
  ].map(([id, resolvedModel, label, levels]) => ({
    id, label, resolvedModel,
    // Rows the CLI reports no effort axis for carry neither field, like the real answer.
    ...(levels ? { supportsEffort: true, supportedEffortLevels: levels } : {}),
  })),
  current: 'global.anthropic.claude-fable-5-1[1m]',
  currentEffort: 'high',
}

function answerEngine(res) {
  switch (engineMode) {
    case 'unreachable':
      // Exactly `relayChatToPrimary`'s answer in src/web/routes/personal-ai-v1.ts.
      return json(res, 503, {
        error: {
          code: 'primary_unreachable',
          message: 'Your primary box is unreachable, so the chat engine could not be reached yet',
        },
        retry: true,
      })
    case 'degraded':
      // What an old replica said about ITSELF while the Mac was away.
      return json(res, 200, {
        engine: 'in-process', sessionId: null, model: degradedModel,
      })
    case 'lane':
      return json(res, 200, {
        engine: 'lane', sessionId: LANE_SESSION_ID, cwd: '/stub', host: '', switchable: true,
      })
    default:
      // `sessionId: null` = the lane has no CLI session yet, which is the honest
      // answer for a stub and makes the composer's model pill read-only instead of
      // showing a retry affordance over the button under test.
      return json(res, 200, { engine: 'lane', sessionId: null, switchable: false })
  }
}

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
  // The time is on the line because the record FILE is reset per test, and
  // spacing between requests (the model pill's retry ladder) is evidence too.
  console.log(`[stub] ${row.at} g${generation} ${row.seq} ${entry.method} ${entry.path}`
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

// ── The work session (a pinned task with a live session) ────────────────────

const WORK_TASK_ID = 'task-stub-work'
let workSession = false

function workTask() {
  return {
    id: WORK_TASK_ID, title: 'Stub work task', status: 'in_progress', phase: 'IN_PROGRESS',
    priority: 'none', project: 'Stub', pinned: true,
    created_at: '2026-09-24T00:00:00Z', updated_at: '2026-09-24T00:00:00Z',
  }
}

function workSessionRow() {
  const now = new Date().toISOString()
  return {
    id: LANE_SESSION_ID, title: 'Stub work session', task_id: WORK_TASK_ID, task_title: 'Stub work task',
    project: 'Stub', host: '', process_status: 'idle', model: laneModel ?? FULL_CATALOG.current,
    mode: null, started_at: now, last_active_at: now, message_count: 0, cwd: '/tmp', pinned: false,
  }
}

/** The work-session routes, or false when the flag is off or the path is not one. */
function answerWorkSession(p, req, res) {
  if (!workSession || req.method !== 'GET') return false
  const now = new Date().toISOString()
  if (p === '/api/v1/tasks') return json(res, 200, { tasks: [workTask()], syncedAt: now }), true
  if (p === '/api/v1/focus/tasks') {
    return json(res, 200, { pinned_tasks: [WORK_TASK_ID], focus_tasks: [WORK_TASK_ID] }), true
  }
  if (p === `/api/v1/tasks/${WORK_TASK_ID}`) {
    return json(res, 200, { task: { ...workTask(), session_ids: [LANE_SESSION_ID] } }), true
  }
  if (p === '/api/v1/sessions') return json(res, 200, { sessions: [workSessionRow()], syncedAt: now }), true
  if (p === `/api/v1/sessions/${LANE_SESSION_ID}`) {
    const row = workSessionRow()
    return json(res, 200, {
      session: {
        claudeSessionId: LANE_SESSION_ID, process_status: 'idle', title: row.title, taskId: WORK_TASK_ID,
        project: 'Stub', host: '', cwd: '/tmp', startedAt: now, lastActiveAt: now, messageCount: 0,
        model: row.model,
      },
      pendingPermissions: [],
    }), true
  }
  if (p === `/api/v1/sessions/${LANE_SESSION_ID}/transcript`) {
    return json(res, 200, { sessionId: LANE_SESSION_ID, exportedAt: now, truncated: false, messages: [] }), true
  }
  if (p === `/api/v1/sessions/${LANE_SESSION_ID}/stream`) {
    attachStream(`session:${LANE_SESSION_ID}`, res)
    return true
  }
  return false
}

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
/** The reply of a turn the cloud companion answers (answered-by cloud/legacy). */
const CLOUD_REPLY = 'Your Mac is offline, so this answer came from the cloud server. It has no Mac sessions.'

function startHeldTurn(conversationID, turnId) {
  // Captured per turn: the frames and the history row of ONE turn always agree.
  const answeredBy = answeredByMode
  emit(conversationID, 'message-start', { turnId, ...(answeredBy === 'cloud' ? { answeredBy: 'cloud' } : {}) })
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
  heldTurn = { conversationID, turnId, keepalive, answeredBy }
}

function finishHeldTurn() {
  if (!heldTurn) return null
  const { conversationID, turnId, keepalive, answeredBy } = heldTurn
  clearInterval(keepalive)
  heldTurn = null
  const cloudAnswered = answeredBy === 'cloud' || answeredBy === 'legacy'
  const reply = cloudAnswered ? CLOUD_REPLY : FINAL_REPLY
  // The in-flight row becomes the settled reply. Only a CURRENT companion says
  // who answered in history; the older one's row carries nothing (api-v1.md).
  const idx = history.findIndex((m) => m.inFlight)
  if (idx >= 0) history[idx] = {
    id: history[idx].id, role: 'assistant', text: reply,
    createdAt: history[idx].createdAt,
    ...(answeredBy === 'cloud' ? { answeredBy: 'cloud' } : {}),
  }
  const who = answeredBy === 'cloud'
    ? { engine: 'claude-code', answeredBy: 'cloud' }
    : answeredBy === 'legacy' ? { engine: 'walnut-agent-fallback' } : {}
  emit(conversationID, 'message-end', { turnId, fullText: reply, ...who })
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
  engineMode = 'default'
  degradedModel = DEGRADED_MODEL
  laneModel = null
  laneEffort = null
  laneMode = 'bypass'
  laneWriteDelayMs = 0
  workSession = false
  statusMode = 'live'
  statusCloudChat = null
  answeredByMode = 'mac'
  inboxLetters = []
  inboxReadFailures = 0
  inboxReadFailStatus = 503
  inboxAdded = 0
  appOffline = false
  resetSessionReplica()
  resetLetterReply()
  generation += 1
  try {
    fs.mkdirSync(path.dirname(RECORD_PATH), { recursive: true })
    fs.writeFileSync(RECORD_PATH, JSON.stringify([], null, 2))
  } catch { /* the record file is evidence, not a dependency */ }
  return generation
}

// ── The work session as a CLOUD REPLICA stream (SessionStreamStormUITests) ──
// Same shapes as src/web/sse-channels.ts + src/web/ws/bridge-registry.ts: ids
// are one process-wide counter (so they start high, like a replica that has
// been up for a while), the ring holds 512 frames and is never reset, an attach
// writes an id-less bridge-online/offline frame first and then replays the ring
// after Last-Event-ID (or all of it without one, or always when honor=0).

const REPLICA_RING_MAX = 512
let sessionReplica = null

function replicaTranscriptRows(n) {
  const rows = []
  const prose = 'The rollout reached the second wave. Error rates stayed flat, p99 latency rose '
    + 'by 4 ms on the write path, and the canary pool drained cleanly before the next step.'
  const table = '| step | status | p99 |\n|---|---|---|\n| wave 1 | done | 212 ms |\n| wave 2 | done | 216 ms |'
  const code = '```bash\nkubectl rollout status deploy/api --timeout=120s\n```'
  const start = Date.now() - n * 20_000
  for (let i = 0; i < n; i += 1) {
    const timestamp = new Date(start + i * 20_000).toISOString()
    const slot = i % 10
    if (slot < 6) {
      const body = slot % 3 === 0 ? `${prose}\n\n${table}` : slot % 3 === 1 ? `${prose}\n\n${code}` : prose
      rows.push({ role: 'assistant', text: `Step ${i}: ${body}`, timestamp })
    } else if (slot < 8) {
      rows.push({ role: 'assistant', text: 'Bash', timestamp, kind: 'tool', detail: 'kubectl get pods -n api' })
    } else {
      rows.push({ role: 'user', text: `Check item ${i} and keep it read-only.`, timestamp })
    }
  }
  return rows
}

function resetSessionReplica() { sessionReplica = null }

function replicaOn() {
  return workSession && sessionReplica !== null && sessionReplica.generation === generation
}

function replicaWrite(res, frame) {
  try { res.write(frame) } catch { /* a closed stream is cleaned up by its close handler */ }
}

function replicaConns() {
  return streams.get(`session:${LANE_SESSION_ID}`) || []
}

function replicaEmit(event, data) {
  const r = sessionReplica
  r.seq += 1
  const frame = { id: r.seq, text: `id: ${r.seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n` }
  r.ring.push(frame)
  if (r.ring.length > REPLICA_RING_MAX) r.ring.splice(0, r.ring.length - REPLICA_RING_MAX)
  for (const res of replicaConns()) replicaWrite(res, frame.text)
  return r.seq
}

function replicaAttach(req, res) {
  const r = sessionReplica
  const raw = req.headers['last-event-id']
  const lastId = raw !== undefined && raw !== '' ? Number(raw) : null
  r.attaches.push({ at: nowISO(), lastEventId: raw ?? null, bridgeUp: r.bridgeUp })
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  res.write(': connected\n\n')
  res.write(`event: ${r.bridgeUp ? 'bridge-online' : 'bridge-offline'}\ndata: {}\n\n`)
  let replayed = 0
  for (const frame of r.ring) {
    if (r.honor && lastId !== null && Number.isFinite(lastId) && frame.id <= lastId) continue
    res.write(frame.text)
    replayed += 1
  }
  console.log(`[stub] replica stream attach lastEventId=${raw ?? '-'} replayed=${replayed} (honor=${r.honor})`)
  const key = `session:${LANE_SESSION_ID}`
  streams.set(key, [...(streams.get(key) || []), res])
  res.on('close', () => streams.set(key, (streams.get(key) || []).filter((x) => x !== res)))
  if (r.blipOnAttachMs !== null && !r.bridgeUp) {
    const ms = r.blipOnAttachMs
    r.blipOnAttachMs = null
    replicaBlipReturn(ms)
  }
}

/** Bring the bridge back after `ms`, unless the replica was reset meanwhile. */
function replicaBlipReturn(ms) {
  const r = sessionReplica
  const blipGeneration = generation
  setTimeout(() => {
    if (!replicaOn() || generation !== blipGeneration || r !== sessionReplica || r.bridgeUp) return
    r.bridgeUp = true
    replicaDeliverBanked()
    replicaEmit('bridge-online', {})
    console.log('[stub] replica bridge back after the blip')
  }, ms).unref?.()
}

function replicaDeliverBanked() {
  const r = sessionReplica
  for (const send of r.banked.splice(0)) {
    if (r.delivered.includes(send.messageId)) continue
    r.delivered.push(send.messageId)
    r.transcript.push({ role: 'user', text: send.text, timestamp: nowISO() })
  }
}

/** The replica-mode work-session routes, or false when the mode is off. */
function answerSessionReplica(p, req, res, raw) {
  if (!replicaOn()) return false
  const r = sessionReplica
  const base = `/api/v1/sessions/${LANE_SESSION_ID}`
  if (p === `${base}/stream` && req.method === 'GET') return replicaAttach(req, res), true
  if (p === `${base}/transcript` && req.method === 'GET') {
    return json(res, 200, {
      sessionId: LANE_SESSION_ID, exportedAt: nowISO(), truncated: false, messages: r.transcript,
    }), true
  }
  if (p === `${base}/messages` && req.method === 'POST') {
    let body = {}
    try { body = JSON.parse(raw || '{}') } catch { /* answered with a minted id */ }
    const messageId = typeof body.messageId === 'string' ? body.messageId : `qm-stub-${r.seq}`
    const text = String(body.text ?? '')
    r.posts.push({ at: nowISO(), messageId, text, bridgeUp: r.bridgeUp })
    if (!r.bridgeUp) {
      // Exactly the replica's fast-accept (core/send-queue.ts): banked, 202 queued.
      if (!r.banked.some((b) => b.messageId === messageId) && !r.delivered.includes(messageId)) {
        r.banked.push({ messageId, text })
      }
      return json(res, 202, { messageId, queued: true }), true
    }
    if (!r.delivered.includes(messageId)) {
      r.delivered.push(messageId)
      r.transcript.push({ role: 'user', text, timestamp: nowISO() })
    }
    return json(res, 202, { messageId }), true
  }
  return false
}

function replicaRingFrames(n) {
  const kinds = [
    ['status', { processStatus: 'running' }],
    ['text-delta', { delta: 'Checking the rollout. ' }],
    ['turn-end', {}],
    ['status', { processStatus: 'idle' }],
    ['bridge-offline', {}],
    ['bridge-online', {}],
    ['turn-end', {}],
  ]
  let last = 0
  for (let i = 0; i < n; i += 1) {
    const [event, data] = kinds[i % kinds.length]
    // Never end the batch on an unpaired offline: the bridge is up afterwards.
    if (i === n - 1 && event === 'bridge-offline') break
    last = replicaEmit(event, data)
  }
  return last
}

function answerSessionReplicaControl(p, req, res, url) {
  if (p === '/__stub/session-replica' && req.method === 'POST') {
    if (url.searchParams.get('on') !== '1') { sessionReplica = null; return json(res, 200, { ok: true, on: false }) }
    const rows = Math.max(0, Number(url.searchParams.get('rows') || 300))
    sessionReplica = {
      generation, honor: url.searchParams.get('honor') !== '0', bridgeUp: true,
      // A replica that has been up for a while: its ids are far from zero.
      seq: 40_000 + generation * 10_000, ring: [], attaches: [], posts: [], banked: [], delivered: [],
      blipOnAttachMs: null,
      transcript: replicaTranscriptRows(rows),
    }
    console.log(`[stub] session replica on (honor=${sessionReplica.honor}, rows=${rows})`)
    return json(res, 200, { ok: true, on: true, rows })
  }
  if (!replicaOn()) return json(res, 409, { ok: false, message: 'session replica mode is off' })
  const r = sessionReplica
  if (p === '/__stub/session-honor' && req.method === 'POST') {
    r.honor = url.searchParams.get('on') !== '0'
    return json(res, 200, { ok: true, honor: r.honor })
  }
  if (p === '/__stub/session-emit' && req.method === 'POST') {
    const n = Math.max(1, Math.min(4096, Number(url.searchParams.get('n') || 512)))
    const last = replicaRingFrames(n)
    console.log(`[stub] replica emitted ${n} frames, newest id ${last}`)
    return json(res, 200, { ok: true, lastId: last, ring: r.ring.length })
  }
  if (p === '/__stub/session-turn' && req.method === 'POST') {
    const text = url.searchParams.get('text') || 'The canary is healthy and the rollout can continue.'
    replicaEmit('turn-start', {})
    replicaEmit('text-delta', { delta: text })
    r.transcript.push({ role: 'assistant', text, timestamp: nowISO() })
    const last = replicaEmit('turn-end', {})
    return json(res, 200, { ok: true, lastId: last })
  }
  if (p === '/__stub/session-bridge' && req.method === 'POST') {
    const up = url.searchParams.get('up') === '1'
    if (up !== r.bridgeUp) {
      r.bridgeUp = up
      if (up) replicaDeliverBanked()
      replicaEmit(up ? 'bridge-online' : 'bridge-offline', {})
      console.log(`[stub] replica bridge ${up ? 'UP' : 'DOWN'}`)
    }
    return json(res, 200, { ok: true, up })
  }
  if (p === '/__stub/session-blip' && req.method === 'POST') {
    const ms = Math.max(0, Number(url.searchParams.get('ms') || 1300))
    const fromAttach = url.searchParams.get('from') === 'attach'
    if (r.bridgeUp) {
      r.bridgeUp = false
      replicaEmit('bridge-offline', {})
    }
    if (fromAttach) r.blipOnAttachMs = ms
    else replicaBlipReturn(ms)
    console.log(`[stub] replica bridge blip ${ms}ms${fromAttach ? ' from the next attach' : ''}`)
    return json(res, 200, { ok: true, ms, fromAttach })
  }
  if (p === '/__stub/session-state' && req.method === 'GET') {
    return json(res, 200, {
      honor: r.honor, bridgeUp: r.bridgeUp, ring: r.ring.length, lastId: r.seq,
      attaches: r.attaches, posts: r.posts, banked: r.banked, delivered: r.delivered,
      transcriptRows: r.transcript.length,
      transcriptTexts: r.transcript.filter((m) => m.role === 'user').map((m) => m.text),
      openStreams: replicaConns().length,
    })
  }
  return notFound(res, `unknown session replica control ${p}`)
}

// ── Human inbox (seeded from the parity fixture) ────────────────────────────

const INBOX_FIXTURE = new URL('../../../tests/fixtures/inbox-parity/letters.json', import.meta.url)
/** The fixture's own clock (`NOW` in tests/web/inbox-ios-parity.test.ts). */
const INBOX_FIXTURE_NOW = 1_800_000_000_000

function seedInbox({ allRead = false } = {}) {
  const fixture = JSON.parse(fs.readFileSync(INBOX_FIXTURE, 'utf8'))
  // Moved onto the real clock so "3 min ago" reads as it will on a phone, and
  // so the 5-minute decision grace the phone applies is measured against now.
  const shift = Date.now() - INBOX_FIXTURE_NOW
  const moved = (v) => (typeof v === 'number' ? v + shift : v)
  inboxLetters = fixture.letters.map((l) => ({
    ...l,
    createdAt: moved(l.createdAt),
    ...(l.readAt !== undefined ? { readAt: moved(l.readAt) } : {}),
    ...(l.answered ? { answered: { ...l.answered, at: moved(l.answered.at) } } : {}),
    // Everything read ten minutes ago: past the decision grace, so every state
    // filter is empty while All still lists 40 letters.
    ...(allRead ? { read: true, readAt: Date.now() - 10 * 60_000 } : {}),
  }))
  return inboxLetters.length
}

/** Same order as core/human-inbox/store.ts sortLetters. */
function sortedLetters(list) {
  return [...list].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt
    return b.id.localeCompare(a.id)
  })
}

function inboxList(archived) {
  return {
    letters: sortedLetters(inboxLetters.filter((l) => !!l.archived === archived)),
    unreadCount: inboxLetters.filter((l) => !l.archived && !l.read).length,
  }
}

function addInboxLetter(type) {
  inboxAdded += 1
  const letter = {
    id: `lt-stub-new-${generation}-${inboxAdded}`,
    subject: `New letter ${inboxAdded}: the overnight import finished and needs a look`,
    type, bodyFormat: 'markdown',
    textPreview: 'Arrived while the list was open.',
    sender: { sessionId: 'sess-stub-new', sessionTitle: 'Overnight import', host: 'devbox' },
    createdAt: Date.now(), read: false, pinned: false, archived: false,
    ...(type === 'action_required'
      ? { actions: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] }
      : {}),
  }
  inboxLetters.push(letter)
  return letter
}

/** Routes for /api/v1/human-inbox/*. Returns true when it answered. */
function answerInbox(p, req, res, raw, url) {
  if (p === '/api/v1/human-inbox' && req.method === 'GET') {
    const archived = url.searchParams.get('archived') === '1' || url.searchParams.get('archived') === 'true'
    json(res, 200, inboxList(archived))
    return true
  }
  const one = p.match(/^\/api\/v1\/human-inbox\/([^/]+)$/)
  if (one && req.method === 'GET') {
    const letter = inboxLetters.find((l) => l.id === decodeURIComponent(one[1]))
    if (!letter) { notFound(res, 'no such letter'); return true }
    json(res, 200, {
      letter: { ...letter, body: `# ${letter.subject}\n\nThis is the body of ${letter.id}.` },
    })
    return true
  }
  const write = p.match(/^\/api\/v1\/human-inbox\/([^/]+)\/(read|pin|archive)$/)
  if (write && req.method === 'POST') {
    const letter = inboxLetters.find((l) => l.id === decodeURIComponent(write[1]))
    if (!letter) { notFound(res, 'no such letter'); return true }
    let payload = {}
    try { payload = JSON.parse(raw || '{}') } catch { /* answered as an empty body */ }
    if (write[2] === 'read') {
      if (inboxReadFailures > 0) {
        inboxReadFailures -= 1
        console.log(`[stub] inbox read write REFUSED ${inboxReadFailStatus} (${inboxReadFailures} more)`)
        // Exactly the replica's answer while the Mac's bridge is down.
        json(res, inboxReadFailStatus, {
          error: { code: 'bridge_offline', message: 'The primary is not connected to this companion right now.' },
        })
        return true
      }
      const read = payload.read === true
      // Same rule as the store's setReadFlag: an unchanged flag keeps its time.
      if (!!letter.read !== read) { letter.read = read; letter.readAt = Date.now() }
      console.log(`[stub] inbox read WRITE ${letter.id} → ${read}`)
    } else if (write[2] === 'pin') {
      letter.pinned = payload.pinned === true
    } else {
      letter.archived = payload.archived === true
    }
    json(res, 200, { letter })
    return true
  }
  return false
}

// ── Letter replies + voice (LetterReplyUITests) ─────────────────────────────
//   POST /__stub/letter-reply?seed=1 → three letters join the inbox:
//          lt-stub-reply-a  from the work session (`sess-stub-lane`, task
//                           `task-stub-work`), stamped taskTitle "Promotion
//                           check-in". Turn /__stub/work-session?on=1 on too and
//                           the phone's tasks store knows that task as "Stub work
//                           task", and the session page opens.
//          lt-stub-reply-b  a second letter, for leaving and coming back.
//          lt-stub-reply-c  from a session nobody knows, no task title.
//        It also resets this section's modes.
//   POST /__stub/letter-reply-mode?delivery=D[&fail=F&count=N] → how the next
//        POST /human-inbox/:id/human-reply answers.
//          delivery  queued | deferred | skipped | failed (default queued): the
//                    status recorded on the turn and returned, as the real
//                    route does (src/core/human-inbox/letter-ops.ts).
//          fail      503      answer 503 bridge_offline (no bridge), record nothing
//                             (after delayMs, when set, so a Retry stays on its
//                             way long enough to watch)
//                    504none  the CURRENT server's 504, which it sends only when
//                             NOTHING was recorded (the write outlasted the
//                             deadline): record nothing, answer 504 `timeout`
//                             after delayMs (default 12000)
//                    timeout  record the turn but never answer (the phone's
//                             request times out; a retry with the same
//                             clientId must find the turn already there)
//                    hang     record nothing and never answer
//                    504      an OLDER server at its 12s route deadline: record
//                             the turn with NO delivery, answer 504 `timeout`
//                             after delayMs (default 12000), and write the
//                             delivery settleMs (default 20000) after recording
//                    202      the CURRENT server when the delivery outlasts the
//                             route budget: record the turn with a `pending`
//                             delivery, answer 202 `{letter, delivery:{status:
//                             'pending'}}` after delayMs (default 0), and write
//                             the outcome settleMs after recording
//          count     how many requests the failure applies to (default 1).
//          delayMs   answer every later reply this long after recording it (a
//                    slow relay), so the phone waits with the words in flight.
//          settleMs  504 / 202 only: when the delivery outcome is written.
//   POST /__stub/letter-reply-mark?name=N → logs `[mark] N <epoch seconds>`, to cut a screen
//        recording of a run at the moment a test acted.
//   POST /__stub/letter-reply-skew?ms=M → the server's clock for recorded human
//        turns runs M ms off the phone's (negative = behind): the time a reply is
//        recorded at is not the phone's send time, so ordering by clock shows.
//        Reset by /__stub/letter-reply.
//   POST /__stub/letter-reply-reads?fail=N → the next N reads of a seeded
//        letter (GET /human-inbox/lt-stub-reply-*) answer 503 bridge_offline, so a
//        reply whose answer was lost stays unconfirmed. fail=0 turns it off.
//   POST /__stub/letter-reply-thread?id=I&n=N → letter I (default b) gains N
//        agent/human exchanges, each human turn recorded with a clientId and a
//        queued delivery: a letter taller than the screen whose newest reply
//        already has a status line.
//   GET  /__stub/letter-reply-state → every human-reply POST this generation
//        (clientId, text, outcome), every decision answer, and each seeded
//        letter's thread.
//   POST /api/v1/human-inbox/:id/answer → the real route's shape
//        (letter-ops.ts answerLetterAndDeliver): 409 once answered, 400 for an
//        unknown action, else the answer is threaded as a human turn with a
//        queued delivery.
//   POST /__stub/stt?mode=ok|unavailable|empty[&text=T] → what
//        POST /api/v1/stt/transcribe answers. `ok` returns T (default below).
//        `unavailable` is the real route's 503 stt_unavailable.
// The cloud companion's words when there is no bridge to the Mac at all
// (src/web/routes/bridge-offline-copy.ts): the case that provably sent nothing.
const NO_BRIDGE_SENTENCE = 'No live bridge to the primary box. Your primary box (Mac) is asleep or offline.'
// The real route's deadline answer (src/web/routes/human-inbox-v1.ts guard()).
const DEADLINE_SENTENCE = 'POST /human-inbox/:id/human-reply did not finish in 12000ms. Try again.'
const REPLY_TASK_ID = 'task-stub-work'
const REPLY_SESSION_ID = 'sess-stub-lane'
// Mixed English and Chinese test data ("then send me the results"), escaped.
const STT_DEFAULT_TEXT = 'and please rerun the tests \u7136\u540e\u628a\u7ed3\u679c\u53d1\u7ed9\u6211'
let letterReply = freshLetterReply()
/** Responses held open by `fail=timeout|hang`, ended on reset so nothing leaks. */
const heldReplyResponses = new Set()
/** Delivery outcomes still to be written (`fail=504|202`), cleared on reset. */
const settleTimers = new Set()

function freshLetterReply() {
  return {
    delivery: 'queued', fail: 'none', failCount: 0, delayMs: 0, settleMs: 20_000, skewMs: 0, posts: [],
    sttMode: 'ok', sttText: STT_DEFAULT_TEXT, sttCalls: 0, readFailCount: 0, reads: 0, answers: [],
  }
}

function resetLetterReply() {
  for (const res of heldReplyResponses) { try { res.destroy() } catch { /* already gone */ } }
  heldReplyResponses.clear()
  for (const t of settleTimers) clearTimeout(t)
  settleTimers.clear()
  letterReply = freshLetterReply()
}

function seedReplyLetters() {
  const now = Date.now()
  inboxLetters = inboxLetters.filter((l) => !l.id.startsWith('lt-stub-reply-'))
  inboxLetters.push(
    {
      id: 'lt-stub-reply-a', subject: 'Promotion check-in: three items need your read', type: 'review',
      bodyFormat: 'markdown', textPreview: 'The draft is ready. Three items need your read before Friday.',
      sender: {
        sessionId: REPLY_SESSION_ID, sessionTitle: 'Promotion check-in', taskId: REPLY_TASK_ID,
        taskTitle: 'Promotion check-in', host: '',
      },
      createdAt: now - 3 * 60_000, read: false, pinned: true, archived: false,
      thread: [{ from: 'agent', text: 'I drafted the summary. Tell me what to change.', at: now - 2 * 60_000 }],
    },
    {
      id: 'lt-stub-reply-b', subject: 'Weekly digest is ready', type: 'info', bodyFormat: 'markdown',
      textPreview: 'Seven things happened this week.',
      sender: { sessionId: REPLY_SESSION_ID, sessionTitle: 'Weekly digest', taskId: REPLY_TASK_ID, host: '' },
      createdAt: now - 4 * 60_000, read: false, pinned: true, archived: false, thread: [],
    },
    {
      id: 'lt-stub-reply-c', subject: 'A note from a session nobody tracks', type: 'info', bodyFormat: 'markdown',
      textPreview: 'Sent by a session this phone has never seen.',
      sender: { sessionId: 'sess-stub-unknown', host: '' },
      createdAt: now - 5 * 60_000, read: false, pinned: true, archived: false, thread: [],
    },
  )
}

function deliveryFor(status, sessionId) {
  const reason = { deferred: 'origin_awaiting_permission', skipped: 'origin_session_gone', failed: 'timeout' }[status]
  return { status, ...(reason ? { reason } : {}), sessionId }
}

function answerLetterReplyControl(p, req, res, url) {
  if (p === '/__stub/letter-reply' && req.method === 'POST') {
    resetLetterReply()
    seedReplyLetters()
    console.log('[stub] letter-reply letters seeded')
    return json(res, 200, { ok: true, ids: ['lt-stub-reply-a', 'lt-stub-reply-b', 'lt-stub-reply-c'] })
  }
  if (p === '/__stub/letter-reply-mode' && req.method === 'POST') {
    const delivery = url.searchParams.get('delivery') || 'queued'
    const fail = url.searchParams.get('fail') || 'none'
    if (!['queued', 'deferred', 'skipped', 'failed'].includes(delivery)) return json(res, 400, { ok: false, message: `unknown delivery ${delivery}` })
    if (!['none', '503', 'timeout', 'hang', '504', '202', '504none'].includes(fail)) return json(res, 400, { ok: false, message: `unknown fail ${fail}` })
    letterReply.delivery = delivery
    letterReply.fail = fail
    letterReply.failCount = fail === 'none' ? 0 : Math.max(1, Number(url.searchParams.get('count') || 1))
    letterReply.delayMs = Math.min(30_000, Math.max(0, Number(url.searchParams.get('delayMs') || 0)))
    letterReply.settleMs = Math.min(120_000, Math.max(0, Number(url.searchParams.get('settleMs') || 20_000)))
    console.log(`[stub] letter replies → delivery=${delivery} fail=${fail} x${letterReply.failCount} delay=${letterReply.delayMs}ms`)
    return json(res, 200, { ok: true, delivery, fail, count: letterReply.failCount, delayMs: letterReply.delayMs })
  }
  if (p === '/__stub/letter-reply-mark' && req.method === 'POST') {
    // A UI test's timestamp in the stub log (epoch seconds), so a screen
    // recording of the run can be cut at the moment the test acted.
    const at = Date.now() / 1000
    console.log(`[mark] ${url.searchParams.get('name') || 'mark'} ${at.toFixed(3)}`)
    return json(res, 200, { ok: true, at })
  }
  if (p === '/__stub/letter-reply-skew' && req.method === 'POST') {
    letterReply.skewMs = Math.max(-3_600_000, Math.min(3_600_000, Number(url.searchParams.get('ms') || 0)))
    console.log(`[stub] server clock skew ${letterReply.skewMs}ms`)
    return json(res, 200, { ok: true, skewMs: letterReply.skewMs })
  }
  if (p === '/__stub/letter-reply-reads' && req.method === 'POST') {
    letterReply.readFailCount = Math.max(0, Number(url.searchParams.get('fail') || 0))
    console.log(`[stub] letter reads → fail x${letterReply.readFailCount}`)
    return json(res, 200, { ok: true, fail: letterReply.readFailCount })
  }
  if (p === '/__stub/letter-reply-thread' && req.method === 'POST') {
    const id = url.searchParams.get('id') || 'lt-stub-reply-b'
    const n = Math.max(1, Math.min(20, Number(url.searchParams.get('n') || 6)))
    const letter = inboxLetters.find((l) => l.id === id)
    if (!letter) return json(res, 404, { ok: false, message: `no letter ${id}` })
    letter.thread = letter.thread || []
    const base = Date.now() - n * 120_000
    for (let i = 0; i < n; i++) {
      // "This is note N." and "Thanks, looks right." in Chinese, escaped.
      letter.thread.push({
        from: 'agent', at: base + i * 120_000,
        text: `Agent note ${i + 1}: I looked at item ${i + 1} and pushed a fix. \u8fd9\u662f\u7b2c ${i + 1} \u6761\u8bf4\u660e\u3002`,
      })
      const at = base + i * 120_000 + 60_000
      letter.thread.push({
        from: 'human', at, clientId: `rp-seeded-${i + 1}`,
        text: `Reply ${i + 1}: thanks, looks right. \u8c22\u8c22\uff0c\u770b\u8d77\u6765\u6ca1\u95ee\u9898\u3002`,
        delivery: { status: 'queued', sessionId: letter.sender?.sessionId, at: at + 1_000 },
      })
    }
    console.log(`[stub] letter-reply thread: ${n} exchanges on ${id}`)
    return json(res, 200, { ok: true, turns: letter.thread.length })
  }
  if (p === '/__stub/letter-reply-state' && req.method === 'GET') {
    return json(res, 200, {
      posts: letterReply.posts,
      answers: letterReply.answers,
      reads: letterReply.reads,
      sttCalls: letterReply.sttCalls,
      letters: inboxLetters.filter((l) => l.id.startsWith('lt-stub-reply-')).map((l) => ({ id: l.id, thread: l.thread || [] })),
    })
  }
  if (p === '/__stub/stt' && req.method === 'POST') {
    const mode = url.searchParams.get('mode') || 'ok'
    if (!['ok', 'unavailable', 'empty'].includes(mode)) return json(res, 400, { ok: false, message: `unknown stt mode ${mode}` })
    letterReply.sttMode = mode
    letterReply.sttText = url.searchParams.get('text') || STT_DEFAULT_TEXT
    console.log(`[stub] stt → ${mode}`)
    return json(res, 200, { ok: true, mode })
  }
  return notFound(res, `unknown letter-reply control ${p}`)
}

/** POST /api/v1/human-inbox/:id/{human-reply,answer}, POST /api/v1/stt/transcribe,
 *  and a seeded letter's read while `letter-reply-reads` makes it fail. */
function answerLetterReply(p, req, res, raw) {
  const read = p.match(/^\/api\/v1\/human-inbox\/(lt-stub-reply-[^/]+)$/)
  if (read && req.method === 'GET') {
    letterReply.reads += 1
    if (letterReply.readFailCount > 0) {
      letterReply.readFailCount -= 1
      console.log(`[stub] letter read REFUSED ${read[1]} (${letterReply.readFailCount} more)`)
      json(res, 503, { error: { code: 'bridge_offline', message: NO_BRIDGE_SENTENCE } })
      return true
    }
    return false // the inbox section answers it
  }
  const decided = p.match(/^\/api\/v1\/human-inbox\/([^/]+)\/answer$/)
  if (decided && req.method === 'POST') {
    const letter = inboxLetters.find((l) => l.id === decodeURIComponent(decided[1]))
    if (!letter) { notFound(res, 'no such letter'); return true }
    let payload = {}
    try { payload = JSON.parse(raw || '{}') } catch { /* answered as an empty body */ }
    letterReply.answers.push({ id: letter.id, actionId: payload.actionId ?? null, freeText: payload.freeText ?? null })
    if (letter.answered) {
      json(res, 409, { error: { code: 'conflict', message: `Letter ${letter.id} was already answered (${letter.answered.actionId})` } })
      return true
    }
    const action = (letter.actions || []).find((a) => a.id === payload.actionId)
    if (!action) { json(res, 400, { error: { code: 'bad_request', message: `Unknown actionId: ${payload.actionId}` } }); return true }
    const at = Date.now()
    const note = String(payload.freeText || '').trim()
    letter.answered = { actionId: action.id, label: action.label, at, ...(note ? { freeText: note } : {}) }
    const delivery = deliveryFor('queued', letter.sender?.sessionId)
    letter.thread = letter.thread || []
    // The store joins the choice and the note; a colon here, not its dash.
    letter.thread.push({ from: 'human', text: note ? `${action.label}: ${note}` : action.label, at, delivery: { ...delivery, at } })
    letter.read = true
    letter.readAt = at
    letter.archived = false
    console.log(`[stub] answer ${letter.id} ${action.id} note=${JSON.stringify(note)}`)
    json(res, 200, { letter: { ...letter, body: `# ${letter.subject}\n\nThis is the body of ${letter.id}.` }, delivery })
    return true
  }
  if (p === '/api/v1/stt/transcribe' && req.method === 'POST') {
    letterReply.sttCalls += 1
    if (letterReply.sttMode === 'unavailable') {
      // The real route's answer when no engine is reachable (src/web/routes/stt-v1.ts).
      json(res, 503, { error: { code: 'stt_unavailable', message: 'No speech engine is reachable right now' } })
    } else {
      json(res, 200, { text: letterReply.sttMode === 'empty' ? '' : letterReply.sttText })
    }
    return true
  }
  const m = p.match(/^\/api\/v1\/human-inbox\/([^/]+)\/human-reply$/)
  if (!m || req.method !== 'POST') return false
  const letter = inboxLetters.find((l) => l.id === decodeURIComponent(m[1]))
  if (!letter) { notFound(res, 'no such letter'); return true }
  let payload = {}
  try { payload = JSON.parse(raw || '{}') } catch { /* answered as an empty body */ }
  const text = String(payload.text ?? '').trim()
  const clientId = typeof payload.clientId === 'string' ? payload.clientId : undefined
  const post = { at: nowISO(), clientId: clientId ?? null, text, outcome: '' }
  letterReply.posts.push(post)
  if (!text) { post.outcome = '400'; json(res, 400, { error: { code: 'bad_request', message: 'text is required' } }); return true }

  const failing = letterReply.failCount > 0 ? letterReply.fail : 'none'
  if (failing !== 'none') letterReply.failCount -= 1
  if (failing === '503' || failing === 'hang') {
    post.outcome = failing
    console.log(`[stub] human-reply ${failing} (${letterReply.failCount} more)`)
    if (failing === '503') {
      const refuse = () => {
        if (res.destroyed || res.writableEnded) return
        heldReplyResponses.delete(res)
        json(res, 503, { error: { code: 'bridge_offline', message: NO_BRIDGE_SENTENCE } })
      }
      if (letterReply.delayMs > 0) {
        heldReplyResponses.add(res)
        res.on('close', () => heldReplyResponses.delete(res))
        setTimeout(refuse, letterReply.delayMs)
      } else refuse()
    } else {
      heldReplyResponses.add(res)
      res.on('close', () => heldReplyResponses.delete(res))
    }
    return true
  }

  if (failing === '504' || failing === '202') return answerSlowDelivery(res, letter, text, clientId, post, failing)
  if (failing === '504none') {
    post.outcome = '504:nothing-recorded'
    console.log(`[stub] human-reply 504 with nothing recorded (${letterReply.failCount} more)`)
    heldReplyResponses.add(res)
    res.on('close', () => heldReplyResponses.delete(res))
    setTimeout(() => {
      if (res.destroyed || res.writableEnded) return
      heldReplyResponses.delete(res)
      json(res, 504, { error: { code: 'timeout', message: DEADLINE_SENTENCE } })
    }, letterReply.delayMs || 12_000)
    return true
  }

  // Record exactly as the real store does: one turn per clientId, and a repeat of
  // a FAILED delivery is the retry.
  letter.thread = letter.thread || []
  const sessionId = letter.sender?.sessionId
  let turn = clientId ? letter.thread.find((t) => t.from === 'human' && t.clientId === clientId) : undefined
  let delivery
  if (turn) {
    if (turn.delivery?.status === 'failed') turn.delivery = { ...deliveryFor(letterReply.delivery, sessionId), at: Date.now() }
    delivery = deliveryFor(turn.delivery?.status ?? letterReply.delivery, sessionId)
    post.outcome = `duplicate:${delivery.status}`
  } else {
    delivery = deliveryFor(letterReply.delivery, sessionId)
    const at = Date.now() + letterReply.skewMs
    turn = { from: 'human', text, at, ...(clientId ? { clientId } : {}), delivery: { ...delivery, at } }
    letter.thread.push(turn)
    letter.read = true
    letter.readAt = Date.now()
    post.outcome = `recorded:${delivery.status}`
  }
  console.log(`[stub] human-reply ${post.outcome} clientId=${clientId} text=${JSON.stringify(text)}`)
  if (failing === 'timeout') {
    post.outcome += ':unanswered'
    heldReplyResponses.add(res)
    res.on('close', () => heldReplyResponses.delete(res))
    return true
  }
  const answer = () => json(res, 200, {
    letter: { ...letter, body: `# ${letter.subject}\n\nThis is the body of ${letter.id}.` },
    delivery,
  })
  if (letterReply.delayMs > 0) {
    // Held like the failure modes, so a reset ends it rather than answering late.
    heldReplyResponses.add(res)
    res.on('close', () => heldReplyResponses.delete(res))
    setTimeout(() => {
      if (res.destroyed || res.writableEnded) return
      heldReplyResponses.delete(res)
      post.answeredAt = nowISO()
      answer()
    }, letterReply.delayMs)
    return true
  }
  answer()
  return true
}

/**
 * A reply whose delivery outlasts the route (see `fail=504|202` above). The turn
 * is threaded at once; its outcome is written `settleMs` later, so a phone that
 * re-reads the letter sees it change from "no outcome yet" to the outcome.
 */
function answerSlowDelivery(res, letter, text, clientId, post, mode) {
  letter.thread = letter.thread || []
  const sessionId = letter.sender?.sessionId
  let turn = clientId ? letter.thread.find((t) => t.from === 'human' && t.clientId === clientId) : undefined
  if (turn) {
    post.outcome = `duplicate:${turn.delivery?.status ?? 'no-delivery'}`
  } else {
    const at = Date.now() + letterReply.skewMs
    turn = {
      from: 'human', text, at, ...(clientId ? { clientId } : {}),
      ...(mode === '202' ? { delivery: { status: 'pending', at } } : {}),
    }
    letter.thread.push(turn)
    letter.read = true
    letter.readAt = at
    post.outcome = mode === '202' ? 'recorded:pending:202' : 'recorded:no-delivery:504'
    const settled = turn
    const timer = setTimeout(() => {
      settleTimers.delete(timer)
      settled.delivery = { ...deliveryFor(letterReply.delivery, sessionId), at: Date.now() }
      console.log(`[stub] human-reply delivery settled clientId=${clientId} → ${settled.delivery.status}`)
    }, letterReply.settleMs)
    settleTimers.add(timer)
  }
  console.log(`[stub] human-reply ${post.outcome} clientId=${clientId} text=${JSON.stringify(text)}`)
  const final = turn.delivery && turn.delivery.status !== 'pending'
  const answer = () => {
    if (final) {
      json(res, 200, { letter: replyLetter(letter), delivery: deliveryFor(turn.delivery.status, sessionId) })
    } else if (mode === '202') {
      json(res, 202, { letter: replyLetter(letter), delivery: { status: 'pending' } })
    } else {
      json(res, 504, { error: { code: 'timeout', message: DEADLINE_SENTENCE } })
    }
    post.answeredAt = nowISO()
  }
  const wait = final ? 0 : (letterReply.delayMs || (mode === '504' ? 12_000 : 0))
  if (wait === 0) { answer(); return true }
  heldReplyResponses.add(res)
  res.on('close', () => heldReplyResponses.delete(res))
  setTimeout(() => {
    if (res.destroyed || res.writableEnded) return
    heldReplyResponses.delete(res)
    answer()
  }, wait)
  return true
}

function replyLetter(letter) {
  return { ...letter, body: `# ${letter.subject}\n\nThis is the body of ${letter.id}.` }
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

// ── The pinned board (BoardOrderParityUITests) ───────────────────────────────
//   POST /__stub/board?seed=pinned-tier-order[&as=primary|replica|old-replica]
//        → the Tasks board serves the neutral 71-pin board of
//          tests/fixtures/pinned-tier-order/cases.json with the server split the
//          web test pinned in expected.json: GET /tasks, /focus/tasks,
//          /focus/tiers, /tasks/groups and /ordering. `as` is who answers:
//            primary      the Mac (the default)
//            replica      a current companion: rows carry no group_id, and the
//                         folders and project order come from the primary's push
//            old-replica  a companion from before that push: no group_id, no
//                         folders, an empty project order
//        Per GENERATION, like everything else: the next /__stub/reset turns it off.
//   GET  /__stub/board-expected?view=<tier>/<project|custom>/all
//        → { ids }: the order the Mac's home panel draws for that view (from
//          expected.json), or for `old-replica` the order the phone owes the
//          user without folders or a project order (projects where their first
//          open row appears, rows in pin order).
const BOARD_DIR = new URL('../../../tests/fixtures/pinned-tier-order/', import.meta.url)
let pinnedBoard = null
let pinnedBoardGeneration = -1

function boardOn() {
  return pinnedBoard !== null && pinnedBoardGeneration === generation
}

function seedPinnedBoard(as) {
  const cases = JSON.parse(fs.readFileSync(new URL('cases.json', BOARD_DIR), 'utf8'))
  const expected = JSON.parse(fs.readFileSync(new URL('expected.json', BOARD_DIR), 'utf8'))
  const replicaRows = as !== 'primary'
  pinnedBoard = {
    as,
    // A replica's rows come from the slim projection, which carries no group_id.
    tasks: cases.board.tasks.map((t) => {
      if (!replicaRows) return t
      const { group_id: _dropped, ...rest } = t
      return rest
    }),
    tiers: cases.board.customTiers,
    groups: as === 'old-replica' ? [] : cases.board.groups,
    projects: as === 'old-replica' ? [] : cases.board.projectOrder,
    split: expected.board.split,
    views: expected.board.views,
  }
  pinnedBoardGeneration = generation
}

function tierIds(split, tier) {
  if (['focus', 'satellite', 'backlog', 'wait'].includes(tier)) return split[`${tier}_tasks`] ?? []
  return split.custom_tier_tasks?.[tier] ?? []
}

function boardExpected(view) {
  const [tier, mode, date] = view.split('/')
  if (pinnedBoard.as !== 'old-replica') return pinnedBoard.views[view]?.ids ?? null
  if (date !== 'all' || tier === 'all') return null
  const byId = new Map(pinnedBoard.tasks.map((t) => [t.id, t]))
  const open = tierIds(pinnedBoard.split, tier).filter((id) => {
    const t = byId.get(id)
    return t && t.status !== 'done' && t.phase !== 'COMPLETE'
  })
  if (mode === 'custom') return open
  const projects = []
  for (const id of open) {
    const project = byId.get(id).project || ''
    if (!projects.includes(project)) projects.push(project)
  }
  return projects.flatMap((project) => open.filter((id) => (byId.get(id).project || '') === project))
}

function answerPinnedBoardControl(p, req, res, url) {
  if (p === '/__stub/board' && req.method === 'POST') {
    const seed = url.searchParams.get('seed')
    const as = url.searchParams.get('as') || 'primary'
    if (seed !== 'pinned-tier-order') return json(res, 400, { ok: false, message: `unknown seed ${seed}` })
    if (!['primary', 'replica', 'old-replica'].includes(as)) return json(res, 400, { ok: false, message: `unknown as ${as}` })
    seedPinnedBoard(as)
    console.log(`[stub] pinned board on (${as}): ${pinnedBoard.tasks.length} tasks`)
    return json(res, 200, { ok: true, as, tasks: pinnedBoard.tasks.length })
  }
  if (p === '/__stub/board-expected' && req.method === 'GET') {
    if (!boardOn()) return json(res, 409, { ok: false, message: 'the pinned board is not seeded' })
    const ids = boardExpected(url.searchParams.get('view') || '')
    if (!ids) return json(res, 404, { ok: false, message: 'no such view' })
    return json(res, 200, { ids })
  }
  return notFound(res, `unknown control endpoint ${p}`)
}

/** The board routes, or false when the board is not seeded or the path is not one. */
function answerPinnedBoard(p, req, res) {
  if (!boardOn() || req.method !== 'GET') return false
  if (p === '/api/v1/tasks') return json(res, 200, { tasks: pinnedBoard.tasks, syncedAt: nowISO() }), true
  if (p === '/api/v1/focus/tasks') return json(res, 200, pinnedBoard.split), true
  if (p === '/api/v1/focus/tiers') return json(res, 200, { tiers: pinnedBoard.tiers }), true
  if (p === '/api/v1/tasks/groups') return json(res, 200, { groups: pinnedBoard.groups }), true
  if (p === '/api/v1/ordering') return json(res, 200, { projects: pinnedBoard.projects }), true
  return false
}

/** What gets recorded for a body. Deliberately NOT the raw body: an image send
 *  carries megabytes of base64 and the evidence file has to stay readable. */
/** Echo the app's own composer-pill log lines (menu opened/closed, a tap
 *  dropped, a switch written) to this process's console, so the ORDER of the
 *  UIKit menu edges and the taps is on record next to the wire log. Uploads are
 *  batched (every 45s and on foreground), so lines arrive late but carry the
 *  app's own timestamps. */
function printComposerLogLines(req, body) {
  try {
    const raw = req.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(body) : body
    const parsed = JSON.parse(raw.toString('utf8'))
    for (const line of parsed.lines || []) {
      const entry = typeof line === 'string' ? JSON.parse(line) : line
      if (/^composer (model|effort)/.test(entry.message || '')) {
        const meta = Object.entries(entry).filter(([k]) => k.startsWith('m_')).map(([k, v]) => `${k.slice(2)}=${v}`)
        console.log(`[stub] app-log ${entry.ts} ${entry.message} ${meta.join(' ')}`)
      }
    }
  } catch { /* the log echo is evidence, not a dependency */ }
}

function summarize(raw) {
  if (!raw) return {}
  try {
    const body = JSON.parse(raw)
    const out = {}
    if (typeof body.text === 'string') out.text = body.text
    if (Array.isArray(body.images)) out.imageCount = body.images.length
    if (typeof body.agentId === 'string') out.agentId = body.agentId
    if (typeof body.title === 'string') out.title = body.title
    if (typeof body.model === 'string') out.model = body.model
    if (typeof body.effort === 'string') out.effort = body.effort
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
    if (p === '/__stub/write-delay' && req.method === 'POST') {
      laneWriteDelayMs = Math.max(0, Number(url.searchParams.get('ms') || 0))
      console.log(`[stub] lane writes answer after ${laneWriteDelayMs}ms`)
      return json(res, 200, { ok: true, ms: laneWriteDelayMs })
    }
    if (p === '/__stub/lane' && req.method === 'POST') {
      const m = url.searchParams.get('model')
      const e = url.searchParams.get('effort')
      if (m) laneModel = m
      if (e) laneEffort = e === 'none' ? NO_EFFORT : e
      console.log(`[stub] lane current → model=${laneModel} effort=${String(e)}`)
      return json(res, 200, { ok: true })
    }
    if (p === '/__stub/work-session' && req.method === 'POST') {
      workSession = url.searchParams.get('on') === '1'
      console.log(`[stub] work session ${workSession ? 'on' : 'off'}`)
      return json(res, 200, { ok: true, on: workSession })
    }
    if (p === '/__stub/board' || p === '/__stub/board-expected') return answerPinnedBoardControl(p, req, res, url)
    if (p.startsWith('/__stub/session-')) return answerSessionReplicaControl(p, req, res, url)
    if (p === '/__stub/drop-streams' && req.method === 'POST') {
      let dropped = 0
      for (const list of streams.values()) for (const r of list) { r.end(); dropped += 1 }
      console.log(`[stub] dropped ${dropped} conversation stream(s)`)
      return json(res, 200, { ok: true, dropped })
    }
    if (p === '/__stub/engine' && req.method === 'POST') {
      const mode = url.searchParams.get('mode') || ''
      if (!ENGINE_MODES.has(mode)) return json(res, 400, { ok: false, message: `unknown mode ${mode}` })
      engineMode = mode
      degradedModel = url.searchParams.get('model') || DEGRADED_MODEL
      console.log(`[stub] engine → ${mode}${mode === 'degraded' ? ` (${degradedModel})` : ''}`)
      return json(res, 200, { ok: true, mode })
    }
    if (p === '/__stub/status' && req.method === 'POST') {
      const mode = url.searchParams.get('mode') || ''
      const cloudChat = url.searchParams.get('cloudChat') || 'absent'
      if (!STATUS_MODES.has(mode)) return json(res, 400, { ok: false, message: `unknown status mode ${mode}` })
      if (!['available', 'unavailable', 'absent'].includes(cloudChat)) {
        return json(res, 400, { ok: false, message: `unknown cloudChat ${cloudChat}` })
      }
      statusMode = mode
      statusCloudChat = cloudChat === 'absent' ? null : cloudChat
      console.log(`[stub] status → ${mode} cloudChat=${cloudChat}`)
      return json(res, 200, { ok: true, mode, cloudChat })
    }
    if (p === '/__stub/answered-by' && req.method === 'POST') {
      const mode = url.searchParams.get('mode') || ''
      if (!ANSWERED_BY_MODES.has(mode)) return json(res, 400, { ok: false, message: `unknown mode ${mode}` })
      answeredByMode = mode
      console.log(`[stub] next turn answered by ${mode}`)
      return json(res, 200, { ok: true, mode })
    }
    if (p === '/__stub/inbox' && req.method === 'POST') {
      if (url.searchParams.get('seed') !== 'parity') return json(res, 400, { ok: false, message: 'seed=parity only' })
      const count = seedInbox({ allRead: url.searchParams.get('allRead') === '1' })
      console.log(`[stub] inbox seeded with ${count} letters`)
      return json(res, 200, { ok: true, count, unreadCount: inboxList(false).unreadCount })
    }
    if (p === '/__stub/inbox-read-fail' && req.method === 'POST') {
      inboxReadFailures = Math.max(0, Number(url.searchParams.get('count') || 0))
      inboxReadFailStatus = Number(url.searchParams.get('status') || 503)
      console.log(`[stub] next ${inboxReadFailures} inbox read write(s) fail with ${inboxReadFailStatus}`)
      return json(res, 200, { ok: true, count: inboxReadFailures, status: inboxReadFailStatus })
    }
    if (p === '/__stub/inbox-add' && req.method === 'POST') {
      const letter = addInboxLetter(url.searchParams.get('type') || 'review')
      console.log(`[stub] inbox letter arrived ${letter.id}`)
      return json(res, 200, { ok: true, id: letter.id })
    }
    if (p === '/__stub/offline' && req.method === 'POST') {
      appOffline = url.searchParams.get('on') === '1'
      if (appOffline) for (const list of streams.values()) for (const r of list) r.destroy()
      console.log(`[stub] server ${appOffline ? 'unreachable' : 'reachable'}`)
      return json(res, 200, { ok: true, offline: appOffline })
    }
    if (p.startsWith('/__stub/letter-reply') || p === '/__stub/stt') return answerLetterReplyControl(p, req, res, url)
    if (p === '/__stub/inbox-state' && req.method === 'GET') {
      return json(res, 200, { ...inboxList(false), readFailuresLeft: inboxReadFailures })
    }
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

  record({
    method: req.method, path: p, query: url.search || '', ...summarize(raw),
    ...(req.headers['last-event-id'] !== undefined ? { lastEventId: req.headers['last-event-id'] } : {}),
  })

  if (PROBE) return notFound(res, 'probe mode answers 404 to everything')
  // Unreachable: no status line, no body, the connection just dies.
  if (appOffline) { req.socket.destroy(); return }

  // ── GET /api/v1/status ─────────────────────────────────────────────────────
  if (p === '/api/v1/status' && req.method === 'GET') {
    if (statusMode === 'live') {
      return json(res, 200, {
        mode: 'LIVE', cloud: false, version: '0.0.0-stub', serverTime: nowISO(),
      })
    }
    // A replica's shape (src/web/routes/api-v1.ts): `bridgeHosts` and `cloudChat`
    // are additive, and an older companion sends neither.
    const status = { mode: 'REPLICA', cloud: true, version: '0.0.0-stub', serverTime: nowISO() }
    if (statusMode === 'replica-mac') status.bridgeHosts = [{ hostAlias: '__local__', since: Date.now() - 60_000 }]
    if (statusMode === 'replica-mac-down') status.bridgeHosts = []
    if (statusCloudChat) status.cloudChat = statusCloudChat
    return json(res, 200, status)
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
  if (answerSessionReplica(p, req, res, raw)) return
  if (answerWorkSession(p, req, res)) return
  if (answerPinnedBoard(p, req, res)) return
  if (p === '/api/v1/chat/engine' && req.method === 'GET') return answerEngine(res)
  const modelOptionsMatch = p.match(/^\/api\/v1\/sessions\/([^/]+)\/model-options$/)
  if (modelOptionsMatch && req.method === 'GET') {
    if (decodeURIComponent(modelOptionsMatch[1]) !== LANE_SESSION_ID) return notFound(res, 'no such session')
    return json(res, 200, {
      ...FULL_CATALOG,
      current: laneModel ?? FULL_CATALOG.current,
      currentEffort: laneEffort === NO_EFFORT ? null : (laneEffort ?? FULL_CATALOG.currentEffort),
    })
  }
  const sessionWriteMatch = p.match(/^\/api\/v1\/sessions\/([^/]+)\/(model|effort)$/)
  if (sessionWriteMatch && req.method === 'POST') {
    if (decodeURIComponent(sessionWriteMatch[1]) !== LANE_SESSION_ID) return notFound(res, 'no such session')
    let payload = {}
    try { payload = JSON.parse(raw || '{}') } catch { /* answered as an empty body */ }
    if (laneWriteDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, laneWriteDelayMs))
    if (sessionWriteMatch[2] === 'model') {
      laneModel = String(payload.model ?? '')
      console.log(`[stub] lane model WRITE → ${laneModel}`)
      return json(res, 200, { model: laneModel, cliModel: null, appliedLive: true, effectiveModel: laneModel })
    }
    laneEffort = String(payload.effort ?? '')
    console.log(`[stub] lane effort WRITE → ${laneEffort}`)
    return json(res, 200, { effort: laneEffort, appliedLive: true, effectiveEffort: laneEffort })
  }
  // The lane session's provider controls: the real server's Claude shape
  // (`claudeModeControls` in src/core/sessions/session-extras.ts), every mode by
  // the mode registry's labels.
  const controlsMatch = p.match(/^\/api\/v1\/sessions\/([^/]+)\/controls$/)
  if (controlsMatch && (req.method === 'GET' || req.method === 'POST')) {
    if (decodeURIComponent(controlsMatch[1]) !== LANE_SESSION_ID) return notFound(res, 'no such session')
    if (req.method === 'POST') {
      let payload = {}
      try { payload = JSON.parse(raw || '{}') } catch { /* answered as an empty body */ }
      if (payload.id !== 'mode') return json(res, 400, { error: { code: 'bad_request', message: 'Claude sessions only support the mode control' } })
      laneMode = String(payload.value ?? '')
      console.log(`[stub] lane mode WRITE → ${laneMode}`)
    }
    const labels = { plan: 'Plan', default: 'Default', dontAsk: "Don't Ask", accept: 'Accept', auto: 'Auto', bypass: 'Bypass' }
    return json(res, 200, {
      engine: 'claude',
      controls: [{
        id: 'mode', name: 'Mode', type: 'select', currentValue: laneMode,
        options: Object.entries(labels).map(([value, name]) => ({ value, name })),
      }],
    })
  }
  if (p === '/api/v1/client-logs' && req.method === 'POST') {
    printComposerLogLines(req, body)
    return json(res, 200, { ok: true })
  }
  if (p === '/api/v1/devices/self' && req.method === 'POST') return json(res, 200, { ok: true })
  if (p === '/api/v1/time/heartbeats' && req.method === 'POST') return json(res, 200, { ok: true })
  if (answerLetterReply(p, req, res, raw)) return
  // Unseeded, the list is empty exactly as before (`{ letters: [], unreadCount: 0 }`).
  if (answerInbox(p, req, res, raw, url)) return
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
