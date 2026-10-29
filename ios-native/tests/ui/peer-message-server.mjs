import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const sessionId = 'fixture-session-4001'
export const taskId = 'fixture-task-4001'
const now = '2026-10-24T00:00:00.000Z'
const escapeAttr = value => value.replace(/\s+/g, ' ').trim().replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const body = 'INTERNAL_BODY ' + 'Detailed check output. '.repeat(1000)
// Senders as Walnut writes them: a routine names itself, an App by its name, a task with its short id.
const senders = { trigger: 'Trigger: Nightly build', 'app-state': 'Calendar' }
export function envelope(kind, title) {
  return `<walnut-message kind="${kind}" from="${senders[kind] ?? 'Build checks [1234abcd]'}" host="local" title="${escapeAttr(title)}" about="Build checks [1234abcd]" about-session="fixture-session-4000" request="rq-fixture" asked="PRIVATE_REQUEST">\n${body}\n</walnut-message>`
}
const row = (role, text, kind, extra = {}) => ({ role, text, timestamp: now, ...(kind ? { kind } : {}), ...extra })
// Who sent a user row, as the current server says it (core/sessions/transcript-sent-by.ts): a row
// that is only complete envelopes is a delivery, anything else a person's. An older server says nothing.
const delivery = /^<walnut-message [^\n]*>\n[\s\S]*\n<\/walnut-message>\s*$/
export const withSender = message => message.role !== 'user' || message.kind ? message
  : { ...message, sentBy: delivery.test(message.text) ? 'agent' : 'person' }
export const scenarios = {
  long: [row('assistant', 'Normal assistant response.'), row('user', envelope('reply', 'Checks passed; release pending'))],
  mixed: [row('user', 'Human summary before\n\n' + envelope('peer-note', 'First update') + "\nReply when done: walnut tools call task_send '{}'\n\nHuman summary after")],
  kinds: ['peer-note', 'reply', 'notification', 'trigger', 'app-state'].map(kind => row('user', envelope(kind, kind + ' title'))),
  updated: [row('assistant', 'Normal assistant response.'), row('user', envelope('reply', 'Updated after refresh'))],
  longtitle: [row('user', envelope('reply', 'A longer description that wraps across several lines and stays readable at every supported text size without exposing detailed check output or controls'))],
  partial: [row('user', '<walnut-message kind="reply" from="Build checks" title="Still arriving">\nINTERNAL_BODY')],
  fallback: [row('user', '<walnut-message kind="reply" host="local">\nINTERNAL_BODY\n</walnut-message>')],
  image: [row('user', envelope('app-state', 'Image context') + '\n\n[Images attached]\n- /tmp/fixture/photo.png\n\nNormal image caption')],
  regression: [row('user', 'Normal user message.'), row('assistant', 'Normal assistant response.'),
    row('assistant', 'Bash', 'tool', { detail: 'fixture command', inputPreview: '{"command":"fixture command"}', resultPreview: 'Fixture tool output' }),
    row('user', envelope('reply', 'Final update'))],
  turn: [row('user', 'Can you check the build?'), row('assistant', 'Asked the build checks.'), row('user', envelope('reply', 'Checks passed; release pending')),
    row('assistant', 'Bash', 'tool', { detail: 'release status', inputPreview: '{"command":"release status"}', resultPreview: 'Fixture tool output' }),
    row('assistant', 'The release is ready.')],
  // Shapes the timeline draws without a title or a fold of their own, as Walnut writes them.
  shapes: [
    row('user', '<walnut-message kind="notification" from="Walnut" outcome="moved" note="automated Walnut status notice">\nINTERNAL_BODY moved\n</walnut-message>\n\nPlease draft the notes.'),
    row('assistant', 'Drafted the notes.'),
    row('user', envelope('peer-note', 'Hidden ping')), row('assistant', '<walnut-turn status="agent-ack"/>'),
    row('user', '<walnut-message kind="Odd_Kind" from="Docs lead">\nINTERNAL_BODY odd\n</walnut-message>'), row('assistant', 'Read the odd one.'),
    row('user', '<walnut-message kind="notification" from="Walnut" about="Docs lead [1a2b3c4d]" about-session="fixture-session-4002" outcome="completed" note="automated Walnut status notice">\nINTERNAL_BODY completed\n</walnut-message>'),
    row('assistant', 'Noted the completion.'),
    row('user', '<walnut-message kind="trigger" from="Walnut: wait until" note="the time this task was waiting for has passed">\nINTERNAL_BODY clock\n</walnut-message>'),
    row('assistant', 'Checked the wait.'),
    row('user', envelope('peer-note', 'Please confirm the date')),
    row('assistant', 'mcp__walnut__task_send', 'tool', { detail: 'confirm', inputPreview: '{"to":"fixture"}', resultPreview: 'Delivered' }),
    row('assistant', 'Confirmed the date.'),
  ],
  dense: Array.from({ length: 80 }, (_, index) => row(index % 3 === 0 ? 'assistant' : 'user', index % 3 === 0 ? `Normal round ${index}` : envelope('reply', `Round ${index} update`))),
}
const task = { id: taskId, title: 'Peer message fixture', status: 'in_progress', phase: 'IN_PROGRESS', priority: 'none', project: 'Fixture', pinned: true,
  focus_tier: 'focus', created_at: now, updated_at: now, session_ids: [sessionId] }
const session = { id: sessionId, title: 'Peer message fixture', task_id: taskId, task_title: task.title, project: 'Fixture', host: '',
  process_status: 'idle', model: 'fixture-model', mode: null, started_at: now, last_active_at: now, message_count: 2, cwd: '/tmp/fixture', pinned: false }

export function fixtureApp(out) {
  let scenario = 'long'
  let fault = false
  let missing = false
  let sendFault = false
  let legacy = false
  const sent = []
  let closing = false
  const requests = []
  const streams = new Set()
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
  const snapshots = () => {
    const messages = [...scenarios[scenario], ...sent.map(item => row('user', item.text))]
    return { sessionId, exportedAt: now, truncated: false, rich: true, pageable: true, messages: legacy ? messages : messages.map(withSender) }
  }
  const arrive = () => { for (const stream of streams) stream.write('event: turn-end\ndata: {"success":true}\n\n') }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture.invalid')
    const requestRecord = { method: req.method, path: url.pathname, scenario, at: Date.now() }
    requests.push(requestRecord)
    res.on('finish', () => { requestRecord.status = res.statusCode })
    if (closing) { json(res, 503, { error: { code: 'fixture_closing', message: 'Fixture is closing' } }); return }
    try {
      if (url.pathname === '/__peer/state' && req.method === 'GET') { json(res, 200, { sessionId, taskId, scenario, fault, missing, sendFault, sent, requests, messages: snapshots().messages }); return }
      if (url.pathname === '/__peer/legacy' && req.method === 'POST') { legacy = url.searchParams.get('on') === '1'; json(res, 200, { ok: true }); return }
      if (url.pathname === '/__peer/send-fault' && req.method === 'POST') { sendFault = url.searchParams.get('on') === '1'; json(res, 200, { ok: true }); return }
      if (url.pathname === '/__peer/missing' && req.method === 'POST') { missing = url.searchParams.get('on') === '1'; json(res, 200, { ok: true }); return }
      if (url.pathname === '/__peer/arrive' && req.method === 'POST') { scenario = 'updated'; arrive(); json(res, 200, { ok: true }); return }
      if (url.pathname === '/__peer/close' && req.method === 'POST') {
        json(res, 200, { ok: true }); setImmediate(() => { void close().then(() => process.exit(0)) }); return
      }
      if (url.pathname === '/__peer/scenario' && req.method === 'POST') {
        const name = url.searchParams.get('name')
        if (!Object.hasOwn(scenarios, name)) { json(res, 400, { error: 'Invalid scenario' }); return }
        scenario = name; sent.length = 0; json(res, 200, { ok: true }); return
      }
      if (url.pathname === '/__peer/fault' && req.method === 'POST') { fault = url.searchParams.get('on') === '1'; json(res, 200, { ok: true }); return }
      if (url.pathname === '/__peer/shot' && req.method === 'POST') {
        const name = url.searchParams.get('name')
        if (!/^[a-z0-9-]+$/.test(name ?? '')) { json(res, 400, { error: 'Invalid screenshot name' }); return }
        let bytes = 0
        const chunks = []
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 5_000_000) throw new Error('Screenshot too large'); chunks.push(chunk) }
        await fs.writeFile(path.join(out, name + '.png'), Buffer.concat(chunks)); json(res, 200, { ok: true }); return
      }
      if (req.method === 'POST' && ['/api/v1/client-logs', '/api/v1/devices/self', '/api/v1/time/heartbeats'].includes(url.pathname)) {
        req.resume(); json(res, 200, { ok: true }); return
      }
      if (url.pathname === `/api/v1/sessions/${sessionId}/messages` && req.method === 'POST') {
        let text = ''
        for await (const chunk of req) { text += chunk; if (text.length > 100_000) throw new Error('Message too large') }
        const message = JSON.parse(text)
        if (sendFault) { json(res, 400, { error: { code: 'fixture_refused', message: 'Fixture rejected this send' } }); return }
        if (!sent.some(item => item.messageId === message.messageId)) sent.push(message)
        json(res, 202, { messageId: message.messageId, queued: false }); arrive(); return
      }
      if (req.method !== 'GET') { json(res, 405, { error: { code: 'read_only_fixture', message: 'This fixture does not execute writes' } }); return }
      if (url.pathname === '/api/v1/media') {
        res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(await fs.readFile(path.join(out, 'fixture-image.png'))); return
      }
      if (url.pathname === `/api/v1/sessions/${sessionId}/transcript`) {
        if (missing) json(res, 404, { error: { code: 'not_found', message: 'Fixture transcript missing' } })
        else if (fault) json(res, 503, { error: { code: 'bridge_offline', message: 'Fixture unavailable' } })
        else json(res, 200, snapshots())
        return
      }
      if (url.pathname === '/api/v1/tasks') { json(res, 200, { tasks: [task], syncedAt: now }); return }
      if (url.pathname === '/api/v1/focus/tasks') { json(res, 200, { pinned_tasks: [taskId], focus_tasks: [taskId] }); return }
      if (url.pathname === `/api/v1/tasks/${taskId}`) { json(res, 200, { task }); return }
      if (url.pathname === '/api/v1/sessions') { json(res, 200, { sessions: [session], syncedAt: now }); return }
      if (url.pathname === `/api/v1/sessions/${sessionId}`) { json(res, 200, { session: { claudeSessionId: sessionId, process_status: 'idle', title: session.title,
        taskId, project: 'Fixture', host: '', cwd: '/tmp/fixture', startedAt: now, lastActiveAt: now, messageCount: 2, model: 'fixture-model' }, pendingPermissions: [] }); return }
      if (url.pathname === '/api/v1/status') { json(res, 200, { mode: 'LIVE', cloud: false, version: '0.0.0-fixture', serverTime: new Date().toISOString() }); return }
      if (url.pathname === '/api/v1/agents') { json(res, 200, [{ id: 'general', name: 'Walnut', isMain: true }]); return }
      if (url.pathname === '/api/v1/conversations') { json(res, 200, []); return }
      if (url.pathname === '/api/v1/chat/engine') { json(res, 200, { engine: 'lane', sessionId: null, switchable: false }); return }
      if (url.pathname === '/api/v1/human-inbox') { json(res, 200, { letters: [], unreadCount: 0 }); return }
      if (url.pathname === '/api/v1/tasks/groups') { json(res, 200, { groups: [] }); return }
      if (url.pathname === '/api/v1/focus/tiers') { json(res, 200, { tiers: [] }); return }
      if (url.pathname === '/api/v1/favorites') { json(res, 200, { favorites: [] }); return }
      if (url.pathname === '/api/v1/notes') { json(res, 200, { entries: [] }); return }
      if (url.pathname === '/api/v1/events' || url.pathname === `/api/v1/sessions/${sessionId}/stream`) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }); res.write(': fixture\n\n')
        streams.add(res)
        const ping = setInterval(() => { res.write(': ping\n\n') }, 25_000)
        res.on('close', () => { clearInterval(ping); streams.delete(res) }); return
      }
      json(res, 404, { error: { code: 'not_found', message: 'Fixture route not provided' } })
    } catch (error) { if (!res.headersSent) json(res, 500, { error: String(error) }); else res.destroy() }
  })
  server.requestTimeout = 15_000; server.headersTimeout = 10_000
  async function close() {
    closing = true
    for (const stream of streams) stream.end()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await fs.writeFile(path.join(out, 'requests.json'), JSON.stringify(requests))
  }
  return { server, close }
}

if (process.argv[1] && await fs.realpath(process.argv[1]) === await fs.realpath(fileURLToPath(import.meta.url))) {
  const out = process.argv[2]
  const expected = process.env.PEER_HTTP_ROOT
  if (!out || !expected || await fs.realpath(out) !== await fs.realpath(expected)) throw new Error('Use the isolated HTTP launcher')
  const app = fixtureApp(out)
  const done = async () => { await app.close(); await fs.writeFile(path.join(out, 'http-closed.json'), JSON.stringify({ pid: process.pid })); process.exit(0) }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, () => { void done().catch(() => process.exit(1)) })
  app.server.listen(0, '127.0.0.1', async () => {
    const port = app.server.address().port
    if ([3456, 3457].includes(port)) { await done(); return }
    await fs.writeFile(path.join(out, 'http-ready.json'), JSON.stringify({ server: `http://127.0.0.1:${port}`, token: crypto.randomBytes(16).toString('hex'), sessionId, taskId }))
  })
}
