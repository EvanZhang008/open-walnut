#!/usr/bin/env node
/**
 * Standalone MockDaemon process — runs outside vitest's module system.
 * Prints the port on stdout, then handles WebSocket commands.
 * Used by the session e2e files that want the daemon in a separate process.
 *
 * Session commands answer with the real daemon's reply shapes (daemon-core.ts
 * handleSendCommand / handleSendRawCommand, daemon-standalone cmdStop), the same
 * ones tests/helpers/mock-daemon.ts mirrors. It does not answer `hello`, so the
 * server treats it as a daemon without the optional capabilities: no snapshots,
 * and session status comes from the server's own (legacy) path.
 *
 * Usage: node mock-daemon-process.mjs
 * Prints: PORT=<number>\n
 * Stop: kill the process or send SIGTERM. It also exits when its parent dies.
 */

import { WebSocketServer, WebSocket } from 'ws'
import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createServer } from 'node:net'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-daemon-proc-'))
fs.mkdirSync(path.join(tmpDir, 'streams'), { recursive: true })

const sessions = new Map()

// Find a free port
const port = await new Promise((resolve, reject) => {
  const srv = createServer()
  srv.listen(0, '127.0.0.1', () => {
    const p = srv.address().port
    srv.close(() => resolve(p))
  })
})

const wss = new WebSocketServer({ port, host: '127.0.0.1' })
await new Promise(resolve => wss.on('listening', resolve))

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    const raw = typeof data === 'string' ? data : data.toString()
    handleMessage(ws, raw)
  })
})

// Signal port to parent
process.stdout.write(`PORT=${port}\n`)

// A SIGKILLed test run must not leave this daemon (and its mock CLIs) behind.
const parentPid = process.ppid
setInterval(() => {
  try { process.kill(parentPid, 0) } catch { shutdown() }
}, 2000).unref()

// Cleanup on exit
function shutdown() {
  for (const [, s] of sessions) {
    if (s.pollTimer) clearInterval(s.pollTimer)
    if (s.proc && s.exitCode === null) try { s.proc.kill('SIGTERM') } catch {}
  }
  wss.close(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    process.exit(0)
  })
}
process.on('SIGTERM', shutdown)

function handleMessage(ws, raw) {
  let cmd
  try { cmd = JSON.parse(raw) } catch { ws.send(JSON.stringify({ id: 0, ok: false, error: 'invalid JSON' })); return }
  const id = cmd.id

  switch (cmd.cmd) {
    case 'start': return cmdStart(ws, id, cmd)
    case 'attach': return cmdAttach(ws, id, cmd)
    case 'send': return cmdSend(ws, id, cmd)
    case 'sendRaw': return cmdSendRaw(ws, id, cmd)
    case 'appendUserMarker': return cmdAppendUserMarker(ws, id, cmd)
    case 'stop': return cmdStop(ws, id, cmd)
    case 'status': return cmdStatus(ws, id, cmd)
    case 'ping': return sendOk(ws, id, { pong: true })
    case 'rename': return cmdRename(ws, id, cmd)
    case 'fs.read': return cmdFsRead(ws, id, cmd)
    case 'fs.ls': return cmdFsLs(ws, id, cmd)
    case 'list': return sendOk(ws, id, { sessions: [...sessions.entries()].map(([sid, s]) => ({ sid, alive: s.exitCode === null, pid: s.pid })) })
    default: return sendError(ws, id, `unknown command: ${cmd.cmd}`)
  }
}

function cmdStart(ws, id, cmd) {
  const sid = cmd.sid
  const cwd = cmd.cwd || tmpDir
  const message = cmd.message || ''
  const resume = cmd.resume ?? false

  // The real daemon refuses a cwd that does not exist on its host
  if (!fs.existsSync(cwd)) return sendError(ws, id, `start: cwd does not exist on this host (mock): ${cwd}`)

  const streamsDir = path.join(tmpDir, 'streams')
  const pipePath = path.join(streamsDir, `${sid}.pipe`)
  const jsonlPath = path.join(streamsDir, `${sid}.jsonl`)

  // Clean up old session entry for this sid (resume case).
  // Without this, the old session's pollTimer keeps running and can send duplicate events.
  const oldSession = sessions.get(sid)
  if (oldSession) {
    if (oldSession.pollTimer) clearInterval(oldSession.pollTimer)
    sessions.delete(sid)
  }

  // Create FIFO (skip if already exists from previous session — resume case)
  try { fs.unlinkSync(pipePath) } catch { /* didn't exist */ }
  try { execSync(`mkfifo ${JSON.stringify(pipePath)}`) } catch (err) { return sendError(ws, id, `mkfifo: ${err.message}`) }

  const pipeFd = fs.openSync(pipePath, fs.constants.O_RDWR | fs.constants.O_NONBLOCK)
  if (!resume) fs.writeFileSync(jsonlPath, '')
  const outputFd = fs.openSync(jsonlPath, resume ? 'a' : 'w')
  const stderrFd = fs.openSync(jsonlPath + '.err', resume ? 'a' : 'w')

  // Like the real daemon, run the transport's args verbatim (args[0] is the
  // `claude` the mock CLI stands in for): every flag reaches the CLI, including
  // --session-id, --input-format and --resume.
  const cliArgs = Array.isArray(cmd.args) ? cmd.args.slice(1) : ['-p', '--output-format', 'stream-json', '--verbose']
  if (resume && sid && !cliArgs.includes('--resume')) cliArgs.push('--resume', sid)
  if (message) cliArgs.push(message)

  const proc = spawn(process.execPath, [MOCK_CLI, ...cliArgs], {
    stdio: [pipeFd, outputFd, stderrFd],
    cwd,
    env: { ...process.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' },
  })

  // A spawn that fails (ENOENT) ends this session, never the daemon
  proc.on('error', (err) => {
    process.stderr.write(`[MockDaemon] spawn error for sid=${sid}: ${err.message}\n`)
    session.exitCode = 1
    if (session.pollTimer) clearInterval(session.pollTimer)
    session.pollTimer = null
    sendEvent(ws, 'exit', { sid, code: 1, error: err.message })
    markExited()
  })

  process.stderr.write(`[MockDaemon] spawned mock-claude pid=${proc.pid} sid=${sid} cli=${MOCK_CLI} args=${JSON.stringify(cliArgs)}\n`)

  try { fs.closeSync(pipeFd) } catch {}
  try { fs.closeSync(outputFd) } catch {}
  try { fs.closeSync(stderrFd) } catch {}

  // For resume, start polling from current file size to avoid replaying old events.
  // Without this, the previous turn's result gets re-sent, causing duplicate SESSION_RESULT.
  const initialOffset = resume ? (() => { try { return fs.statSync(jsonlPath).size } catch { return 0 } })() : 0
  let markExited
  const exited = new Promise((resolve) => { markExited = resolve })
  const session = { proc, pid: proc.pid, pipePath, jsonlPath, pollTimer: null, offset: initialOffset, exitCode: null, exited }

  proc.on('exit', (code) => {
    session.exitCode = code ?? 1
    setTimeout(() => {
      if (session.pollTimer) clearInterval(session.pollTimer)
      session.pollTimer = null
      // The real daemon's generation guard: a process a newer start replaced
      // (a cold --resume) must not report its exit as the new process's
      if (sessions.get(sid) === session) {
        pollJsonl(ws, sid, session)
        sendEvent(ws, 'exit', { sid, code: session.exitCode })
      }
      markExited()
    }, 100)
  })

  sessions.set(sid, session)
  session.pollTimer = setInterval(() => pollJsonl(ws, sid, session), 50)
  sendOk(ws, id, { pid: proc.pid, outputFile: jsonlPath, offset: initialOffset })
}

function cmdRename(ws, id, cmd) {
  const { oldSid, newSid } = cmd
  const session = sessions.get(oldSid)
  if (!session) return sendOk(ws, id, {}) // nothing to rename
  sessions.delete(oldSid)
  sessions.set(newSid, session)
  // Rename files
  const streamsDir = path.join(tmpDir, 'streams')
  try { fs.renameSync(session.pipePath, path.join(streamsDir, `${newSid}.pipe`)); session.pipePath = path.join(streamsDir, `${newSid}.pipe`) } catch {}
  try { fs.renameSync(session.jsonlPath, path.join(streamsDir, `${newSid}.jsonl`)); session.jsonlPath = path.join(streamsDir, `${newSid}.jsonl`) } catch {}
  sendOk(ws, id, {})
}

function cmdAttach(ws, id, cmd) {
  const sid = cmd.sid
  const fromOffset = cmd.fromOffset ?? 0
  const session = sessions.get(sid)

  if (!session) return sendError(ws, id, `session not found: ${sid}`)

  // Resume polling from the requested offset
  session.offset = fromOffset

  // Stop any existing poll timer (e.g. from a previous WS connection)
  if (session.pollTimer) {
    clearInterval(session.pollTimer)
    session.pollTimer = null
  }

  // Start polling JSONL for the new WS connection
  session.pollTimer = setInterval(() => pollJsonl(ws, sid, session), 50)

  sendOk(ws, id, { pid: session.pid, alive: session.exitCode === null })
}

// Strict-ack replies, as daemon-core's handleSendCommand: a delivery problem is
// {ok:false, reason} inside a successful envelope, never a protocol error.
function cmdSend(ws, id, cmd) {
  if (!cmd.sid || !cmd.message) return sendError(ws, id, 'send: missing sid or message')
  const payload = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: cmd.message },
    ...(typeof cmd.uuid === 'string' ? { uuid: cmd.uuid } : {}),
  })
  writeFifo(ws, id, cmd.sid, payload + '\n', 'send')
}

/** daemon-core handleSendRawCommand: a complete JSON line (control_request /
 *  control_response) written verbatim, with the same strict-ack replies. */
function cmdSendRaw(ws, id, cmd) {
  if (!cmd.sid || !cmd.raw) return sendError(ws, id, 'sendRaw: missing sid or raw')
  writeFifo(ws, id, cmd.sid, cmd.raw.endsWith('\n') ? cmd.raw : cmd.raw + '\n', 'sendRaw')
}

function writeFifo(ws, id, sid, line, what) {
  const session = sessions.get(sid)
  if (!session) return sendOk(ws, id, { ok: false, reason: 'not_found' })
  if (session.exitCode !== null) return sendOk(ws, id, { ok: false, reason: 'session_dead', exitCode: reapExitCode(session) })
  try {
    const fd = fs.openSync(session.pipePath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
    try { fs.writeSync(fd, Buffer.from(line)) } finally { fs.closeSync(fd) }
    sendOk(ws, id, { ok: true })
  } catch (err) {
    // A readerless FIFO means the CLI is gone: the real daemon reaps it and
    // answers with reapSession's normalized exit code.
    if (err.code === 'ENXIO') return sendOk(ws, id, { ok: false, reason: 'ENXIO', exitCode: reapExitCode(session) })
    if (err.code === 'EAGAIN') return sendOk(ws, id, { ok: false, reason: 'EAGAIN', retriable: true })
    sendError(ws, id, `${what} failed: ${err.message}`)
  }
}

/** reapSession's exit-code normalization (daemon-core isTurnCompleteExit): a CLI
 *  whose stream ends in a completed, non-error turn exited cleanly (0). */
function reapExitCode(session) {
  const code = session.exitCode ?? -1
  if (code === 0) return 0
  try {
    const stat = fs.statSync(session.jsonlPath)
    const len = Math.min(stat.size, 8192)
    const buf = Buffer.alloc(len)
    const fd = fs.openSync(session.jsonlPath, 'r')
    try { fs.readSync(fd, buf, 0, len, stat.size - len) } finally { fs.closeSync(fd) }
    const lines = buf.toString('utf-8').split('\n').map((l) => l.trim()).filter(Boolean)
    const last = JSON.parse(lines[lines.length - 1] ?? '')
    const failed = last.subtype === 'error_max_turns' || last.subtype === 'error_during_execution'
    return last.type === 'result' && !failed ? 0 : code
  } catch { return code }
}

/** daemon-core handleAppendUserMarker: the walnut-injected turn-start marker. */
function cmdAppendUserMarker(ws, id, cmd) {
  const { sid, message, messageId } = cmd
  if (!sid || !message || !messageId) return sendError(ws, id, 'appendUserMarker: missing sid, message, or messageId')
  const session = sessions.get(sid)
  if (!session) return sendOk(ws, id, { ok: false, reason: 'not_found' })
  try {
    fs.appendFileSync(session.jsonlPath, JSON.stringify({
      type: 'user',
      subtype: 'walnut-injected',
      message: { role: 'user', content: message },
      walnutMessageId: messageId,
      timestamp: new Date().toISOString(),
    }) + '\n')
    sendOk(ws, id, { ok: true, size: fs.statSync(session.jsonlPath).size })
  } catch (err) { sendError(ws, id, `appendUserMarker failed: ${err.message}`) }
}

// daemon-standalone stopSessionProcess: SIGINT, SIGTERM at 5s, and `stopped:true`
// only once the process is gone (here: after its exit event went out), an error
// at 7s. A session already gone is a confirmed no-op. RemoteSessionManager.stop()
// reads anything without `stopped:true` as "the daemon did not confirm".
function cmdStop(ws, id, cmd) {
  const session = sessions.get(cmd.sid)
  if (!session?.proc) return sendOk(ws, id, { stopped: true, noop: true, reason: session ? 'already_exited' : 'not_in_registry' })
  if (session.exitCode !== null) return sendOk(ws, id, { stopped: true, noop: true, reason: 'already_exited' })
  try { session.proc.kill('SIGINT') } catch {}
  const term = setTimeout(() => { if (session.exitCode === null) try { session.proc.kill('SIGTERM') } catch {} }, 5000)
  let giveUp
  const timedOut = new Promise((resolve) => { giveUp = setTimeout(() => resolve(false), 7000) })
  void Promise.race([session.exited.then(() => true), timedOut]).then((gone) => {
    clearTimeout(term)
    clearTimeout(giveUp)
    if (gone) sendOk(ws, id, { stopped: true })
    else sendError(ws, id, 'stop: process did not exit after SIGTERM')
  })
}

function cmdStatus(ws, id, cmd) {
  const session = sessions.get(cmd.sid)
  if (!session) return sendOk(ws, id, { alive: false })
  sendOk(ws, id, { alive: session.exitCode === null, pid: session.pid, exitCode: session.exitCode })
}

function cmdFsRead(ws, id, cmd) {
  try {
    const data = cmd.encoding === 'base64'
      ? fs.readFileSync(cmd.path).toString('base64')
      : fs.readFileSync(cmd.path, 'utf-8')
    sendOk(ws, id, { data })
  } catch (err) { sendError(ws, id, `fs.read: ${err.message}`) }
}

function cmdFsLs(ws, id, cmd) {
  try {
    const entries = fs.readdirSync(cmd.path, { withFileTypes: true })
    sendOk(ws, id, { entries: entries.map(e => ({ name: e.name, isDir: e.isDirectory() })) })
  } catch (err) { sendError(ws, id, `fs.ls: ${err.message}`) }
}

function pollJsonl(ws, sid, session) {
  if (ws.readyState !== WebSocket.OPEN) { if (session.pollTimer) clearInterval(session.pollTimer); return }
  try {
    const stat = fs.statSync(session.jsonlPath)
    if (stat.size <= session.offset) return
    const fd = fs.openSync(session.jsonlPath, 'r')
    const buf = Buffer.alloc(stat.size - session.offset)
    fs.readSync(fd, buf, 0, buf.length, session.offset)
    fs.closeSync(fd)
    session.offset = stat.size
    for (const line of buf.toString('utf-8').split('\n')) {
      if (line.trim()) sendEvent(ws, 'jsonl', { sid, line })
    }
  } catch {}
}

function sendOk(ws, id, data) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id, ok: true, ...data })) }
function sendError(ws, id, error) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id, ok: false, error })) }
function sendEvent(ws, ev, data) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ev, ...data })) }
