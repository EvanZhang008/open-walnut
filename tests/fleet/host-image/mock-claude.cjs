/**
 * The fleet's `claude`: on every host (and on the Mac's PATH) it stands in for the
 * real CLI, so no model is ever called. Shaped like the real one:
 *
 *   claude --version            prints a version and exits (the host preflight asks)
 *   claude auth status --json   signed in (the preflight's sign-in check)
 *   claude -p --input-format stream-json ...
 *                               long-running: one process across turns, reading user
 *                               lines from stdin between them (as
 *                               tests/helpers/replica-mock-cli.cjs does)
 *
 * A turn answers "echo: <the person's words>" after MOCK_THINK_MS (default 300 ms),
 * with Walnut's own wrapping (banners, notes, reminders, the reference card) peeled off.
 *
 * "please update <task id> title <words> after <n>s" waits n seconds (so the test
 * can close the Mac's lid or cut its link mid-turn), then runs
 * `walnut tools call task_update` through the daemon's shim on PATH, the way a real
 * session's Bash tool does, and retries while the daemon says the hub is away or
 * slow (exit 5), every 2 s for up to 3 minutes. Each attempt is one line in
 * ~/.fleet-mock/<sid>.walnut.jsonl (exit code and output), where the test reads it;
 * the call and its output are also a Bash tool_use / tool_result pair in the
 * stream, as the real CLI writes them.
 *
 * Each turn is filed in the CLI's own transcript (<config>/projects/<cwd>/<sid>.jsonl,
 * a parentUuid chain), where Walnut reads the history.
 */
'use strict'
const { execFile } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const argv = process.argv.slice(2)
if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write('2.1.300 (Claude Code)\n')
  process.exit(0)
}
// The host preflight's sign-in check (claude-check-core.ts): signed in.
if (argv[0] === 'auth' && argv[1] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }) + '\n')
  process.exit(0)
}
// Any other subcommand (no prompt mode): nothing to say.
if (!argv.includes('-p') && !argv.includes('--print') && argv[0] && !argv[0].startsWith('-')) process.exit(0)

const flag = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null }
const sid = flag('--session-id') || flag('--resume') || crypto.randomUUID()
const THINK_MS = Math.max(0, Number(process.env.MOCK_THINK_MS || 300))
const out = (o) => process.stdout.write(JSON.stringify(Object.assign({}, o, { session_id: sid })) + '\n')

const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const transcript = path.join(configDir, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'), `${sid}.jsonl`)
const attemptsFile = path.join(os.homedir(), '.fleet-mock', `${sid}.walnut.jsonl`)
let parent = null
try {
  const lines = fs.readFileSync(transcript, 'utf8').trim().split('\n')
  parent = JSON.parse(lines[lines.length - 1]).uuid || null
} catch { /* a new session */ }
function file(row) {
  try {
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    const shared = { sessionId: sid, cwd: process.cwd(), timestamp: new Date().toISOString(), isSidechain: false }
    fs.appendFileSync(transcript, JSON.stringify(Object.assign(shared, row)) + '\n')
  } catch { /* the reply still streams */ }
}

/** Walnut's machine banners (`[Name]\n...\n[/Name]`) at the start of a send. */
function stripBanners(text) {
  let body = text
  for (;;) {
    // A bracketed banner, or one of Walnut's own notes riding in front of the words (a moved task,
    // a restart, default instructions that changed: <walnut-message kind="notification">).
    const m = body.match(/^\s*\[([^\]\n]+)\]\n[\s\S]*?\n\[\/\1\]\s*/) || body.match(/^\s*<walnut-message\b[\s\S]*?<\/walnut-message>\s*/)
    if (!m) break
    body = body.slice(m[0].length)
  }
  return body
}
/** The rest Walnut wraps around the words: the message hints, the reference card, thread lines. */
function stripInputDecorations(text) {
  const lines = text
    .replace(/<system-reminder>\s*Walnut \([^)]*\):[\s\S]*?<\/system-reminder>\s*/g, '')
    .split('\n')
  const kept = []
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t === '---walnut-refs---') {
      while (i < lines.length && lines[i].trim() !== '---/walnut-refs---') i++
      continue
    }
    if (t.startsWith('[Rich output mode') || t.startsWith('[Reply language')) continue
    if (/^\(Back to (the main conversation|the earlier (thread|question) about)/.test(t)) continue
    kept.push(lines[i])
  }
  const body = kept.join('\n').trim()
  return body === '' ? text.trim() : body
}

function message(content, stopReason) {
  return {
    id: `msg_${crypto.randomBytes(6).toString('hex')}`, type: 'message', role: 'assistant', model: 'mock-model',
    content, stop_reason: stopReason, usage: { input_tokens: 1, output_tokens: 1 },
  }
}

/** One `walnut tools call task_update` through the shim on PATH; resolves with its exit code and output. */
function walnutUpdate(args) {
  return new Promise((resolve) => {
    execFile('walnut', ['tools', 'call', 'task_update', JSON.stringify(args)], { timeout: 60_000, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || (err && code ? err.message : '')) })
    })
  })
}

async function updateTurn(taskId, title, waitMs) {
  await new Promise((r) => setTimeout(r, waitMs))
  const args = { id: taskId, title }
  const toolId = `toolu_${crypto.randomBytes(8).toString('hex')}`
  const use = message([{ type: 'tool_use', id: toolId, name: 'Bash', input: { command: `walnut tools call task_update '${JSON.stringify(args)}'` } }], 'tool_use')
  out({ type: 'assistant', message: use, parent_tool_use_id: null })
  const useUuid = crypto.randomUUID()
  file({ type: 'assistant', uuid: useUuid, parentUuid: parent, message: use })
  parent = useUuid
  const until = Date.now() + 180_000
  let attempt = 0
  let r
  for (;;) {
    attempt++
    r = await walnutUpdate(args)
    try {
      fs.mkdirSync(path.dirname(attemptsFile), { recursive: true })
      fs.appendFileSync(attemptsFile, JSON.stringify({ at: new Date().toISOString(), attempt, code: r.code, stdout: r.stdout.slice(0, 2000), stderr: r.stderr.slice(0, 2000) }) + '\n')
    } catch { /* the turn goes on */ }
    if (r.code !== 5 || Date.now() > until) break
    await new Promise((res) => setTimeout(res, 2_000))
  }
  const said = (r.stdout || r.stderr).trim().slice(0, 4000)
  const toolResult = { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: said, is_error: r.code !== 0 }] }
  out({ type: 'user', message: toolResult, parent_tool_use_id: null })
  const resultUuid = crypto.randomUUID()
  file({ type: 'user', uuid: resultUuid, parentUuid: parent, message: toolResult })
  parent = resultUuid
  return `echo: updated ${taskId} after ${attempt} attempt(s), exit ${r.code}`
}

out({ type: 'system', subtype: 'init', cwd: process.cwd(), model: 'mock-model', tools: ['Bash'], mcp_servers: [], permissionMode: 'default' })

const queue = []
let busy = false
// Rises every turn, as the real CLI's does: an unchanged cost tells Walnut a result line is a stale replay.
let cost = 0
function runNext() {
  if (busy || queue.length === 0) return
  busy = true
  const msg = queue.shift()
  const c = msg.message && msg.message.content
  const raw = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && b.type === 'text' ? b.text : '')).join('') : ''
  const words = stripInputDecorations(stripBanners(raw)).trim()
  const userUuid = typeof msg.uuid === 'string' && msg.uuid ? msg.uuid : crypto.randomUUID()
  if (msg.uuid) out({ type: 'command_lifecycle', command_uuid: msg.uuid, state: 'started' })
  out({ type: 'system', subtype: 'session_state_changed', state: 'running' })
  file({ type: 'user', uuid: userUuid, parentUuid: parent, message: { role: 'user', content: raw } })
  parent = userUuid
  const upd = /^please update (\S+) title (.+?)(?: after (\d+)s)?$/i.exec(words)
  if (upd) {
    updateTurn(upd[1], upd[2], Number(upd[3] || 0) * 1000).then(finish, (err) => finish(`echo: update failed: ${err && err.message}`))
    return
  }
  setTimeout(() => finish(`echo: ${words}`), THINK_MS)
  function finish(reply) {
    const m = message([{ type: 'text', text: reply }], 'end_turn')
    out({ type: 'assistant', message: m, parent_tool_use_id: null })
    const answerUuid = crypto.randomUUID()
    file({ type: 'assistant', uuid: answerUuid, parentUuid: parent, message: m })
    parent = answerUuid
    cost = Math.round((cost + 0.0001) * 1e4) / 1e4
    out({ type: 'result', subtype: 'success', is_error: false, result: reply, duration_ms: THINK_MS, num_turns: 1, total_cost_usd: cost, usage: { input_tokens: 1, output_tokens: 1 } })
    if (msg.uuid) out({ type: 'command_lifecycle', command_uuid: msg.uuid, state: 'completed' })
    out({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    busy = false
    if (ended && queue.length === 0) process.exit(0)
    runNext()
  }
}

let buf = ''
let ended = false
process.stdin.on('error', () => {})
// Stdin closed: the real CLI ends once its turn is done.
process.stdin.on('end', () => { ended = true; if (!busy && queue.length === 0) process.exit(0) })
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8')
  let nl
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } }); continue }
    if (msg.type !== 'user') continue
    queue.push(msg)
    runNext()
  }
})
setInterval(() => {}, 1 << 30)
