#!/usr/bin/env node
/**
 * Standalone MockDaemon process — runs outside vitest's module system.
 * Prints the port on stdout, then handles WebSocket commands.
 * Used by remote-session-e2e.test.ts to avoid vitest module isolation issues.
 *
 * Usage: node mock-daemon-process.mjs
 * Prints: PORT=<number>\n
 * Stop: kill the process or send SIGTERM
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

// Cleanup on exit
process.on('SIGTERM', () => {
  for (const [, s] of sessions) {
    if (s.pollTimer) clearInterval(s.pollTimer)
    if (s.proc && s.exitCode === null) try { s.proc.kill('SIGTERM') } catch {}
  }
  wss.close(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    process.exit(0)
  })
})

function handleMessage(ws, raw) {
  let cmd
  try { cmd = JSON.parse(raw) } catch { ws.send(JSON.stringify({ id: 0, ok: false, error: 'invalid JSON' })); return }
  const id = cmd.id

  switch (cmd.cmd) {
    case 'start': return cmdStart(ws, id, cmd)
    case 'attach': return cmdAttach(ws, id, cmd)
    case 'send': return cmdSend(ws, id, cmd)
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

  const cliArgs = ['-p', '--output-format', 'stream-json', '--verbose']
  if (resume && sid) cliArgs.push('--resume', sid)

  // Forward CLI flags from the transport's args array (e.g. --model, --permission-mode)
  if (Array.isArray(cmd.args)) {
    for (let i = 0; i < cmd.args.length; i++) {
      const arg = cmd.args[i]
      if (arg === '--model' || arg === '--permission-mode' || arg === '--append-system-prompt') {
        if (cmd.args[i + 1]) {
          cliArgs.push(arg, cmd.args[++i])
        }
      } else if (arg === '--dangerously-skip-permissions') {
        cliArgs.push(arg)
      }
    }
  }

  if (message) cliArgs.push(message)

  const proc = spawn(process.execPath, [MOCK_CLI, ...cliArgs], {
    stdio: [pipeFd, outputFd, stderrFd],
    cwd,
    env: { ...process.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' },
  })

  proc.on('error', (err) => {
    process.stderr.write(`[MockDaemon] spawn error for sid=${sid}: ${err.message}\n`)
  })

  process.stderr.write(`[MockDaemon] spawned mock-claude pid=${proc.pid} sid=${sid} cli=${MOCK_CLI} args=${JSON.stringify(cliArgs)}\n`)

  try { fs.closeSync(pipeFd) } catch {}
  try { fs.closeSync(outputFd) } catch {}
  try { fs.closeSync(stderrFd) } catch {}

  // For resume, start polling from current file size to avoid replaying old events.
  // Without this, the previous turn's result gets re-sent, causing duplicate SESSION_RESULT.
  const initialOffset = resume ? (() => { try { return fs.statSync(jsonlPath).size } catch { return 0 } })() : 0
  const session = { proc, pid: proc.pid, pipePath, jsonlPath, pollTimer: null, offset: initialOffset, exitCode: null }

  proc.on('exit', (code) => {
    session.exitCode = code ?? 1
    setTimeout(() => {
      pollJsonl(ws, sid, session)
      if (session.pollTimer) clearInterval(session.pollTimer)
      session.pollTimer = null
      sendEvent(ws, 'exit', { sid, code: session.exitCode })
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

function cmdSend(ws, id, cmd) {
  const session = sessions.get(cmd.sid)
  if (!session) return sendError(ws, id, `session not found: ${cmd.sid}`)
  try {
    const payload = JSON.stringify({ type: 'user', message: { role: 'user', content: cmd.message } })
    const fd = fs.openSync(session.pipePath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
    fs.writeSync(fd, Buffer.from(payload + '\n'))
    fs.closeSync(fd)
    sendOk(ws, id, {})
  } catch (err) { sendError(ws, id, `write failed: ${err.message}`) }
}

function cmdStop(ws, id, cmd) {
  const session = sessions.get(cmd.sid)
  if (!session?.proc) return sendOk(ws, id, {})
  try { session.proc.kill('SIGINT') } catch {}
  setTimeout(() => { if (session.exitCode === null && session.proc) try { session.proc.kill('SIGTERM') } catch {} }, 2000)
  sendOk(ws, id, {})
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
