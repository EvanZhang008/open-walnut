#!/usr/bin/env bun
/**
 * Run: bun scripts/lib/desktop-popout-session.mjs <port>
 *
 * Makes one task with a session on a test server (the browser suite's fixture, whose
 * CLI is the mock) and prints the session's id once its first turn ended, for
 * scripts/test-desktop-popout.sh. Never production: port 3456 is refused.
 */
const port = Number(process.argv[2])
if (!Number.isInteger(port) || port <= 0 || port === 3456) {
  console.error('usage: desktop-popout-session.mjs <test server port> (never 3456)')
  process.exit(2)
}
const api = `http://localhost:${port}`
const json = { 'content-type': 'application/json' }

async function call(method, route, body) {
  const res = await fetch(`${api}${route}`, { method, headers: json, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : {}
}

const created = await call('POST', '/api/v1/tasks', { title: 'Desktop popout test' })
const taskId = created.task?.id ?? created.id
if (!taskId) throw new Error(`no task id in ${JSON.stringify(created).slice(0, 300)}`)
const started = await call('POST', `/api/v1/tasks/${taskId}/start`, { message: 'Ready for the popout test' })
let sid = started.sessionId
const deadline = Date.now() + 90_000
while (Date.now() < deadline) {
  if (!sid) sid = (await call('GET', `/api/v1/tasks/${taskId}`)).task?.session_id
  if (sid) {
    const status = (await call('GET', `/api/sessions/${sid}`)).session?.process_status
    // The mock CLI may end with its turn (stopped); the next message resumes it.
    if (status === 'idle' || status === 'stopped') {
      console.log(sid)
      process.exit(0)
    }
    if (status === 'error') throw new Error(`session ${sid} ended in error`)
  }
  await new Promise((r) => setTimeout(r, 1000))
}
throw new Error(`no idle session for task ${taskId} after 90 s (session ${sid ?? 'none'})`)
