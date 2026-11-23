/**
 * The `claude` of tests/helpers/replica-cluster.ts: a long-running stream-json
 * CLI, the shape of the real one (one process across turns, reading user lines
 * from stdin between them). Each user line is one turn: the CLI says it runs,
 * thinks for MOCK_THINK_MS (default 300 ms, so the person's words land before the
 * reply, as with a real model), answers "echo: <the person's words>" and says it
 * is idle. A line that lands while a turn runs waits for it (the real CLI queues).
 *
 * The person's words: what Walnut wraps around them (its `[Name] ... [/Name]`
 * banners, the rich output reminder, the reference card, thread lines) is peeled
 * off, as tests/providers/mock-claude.mjs does, so a reply reads like a model's.
 *
 * Each turn is filed in the CLI's own transcript (`<config>/projects/<cwd>/<sid>.jsonl`,
 * a parentUuid chain, the user line under the uuid Walnut gave it), where Walnut's
 * history reads it.
 *
 * "please run <command>" asks for the Bash tool first: a can_use_tool control
 * request on stdout, as the real CLI makes in default mode; the turn answers
 * "echo: ran <command>" (allowed) or "echo: did not run <command>" once the
 * matching control_response arrives on stdin. "please ask <question>" asks the
 * person with AskUserQuestion (which the daemon never answers by itself, in any
 * mode): "echo: answered <their answer>" once the answer comes, else "echo: not answered".
 * "please hold until <absolute path>" keeps the turn running until that file exists (a
 * test reads the running turn, then releases it): "echo: released <path>". An interrupt
 * control request (Walnut's Stop) ends such a held turn at once: "echo: interrupted".
 * "please stream <n> lines at <r> per second" writes a busy turn's output (streamLines, for
 * scripts/bench-host-judged-sessions.mts): "echo: streamed <what it wrote, by kind>".
 *
 * Copied into the cluster's own bin dir, so its command line names that dir.
 */
'use strict'
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const argv = process.argv.slice(2)
const flag = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null }
const sid = flag('--session-id') || flag('--resume') || crypto.randomUUID()
const THINK_MS = Math.max(0, Number(process.env.MOCK_THINK_MS || 300))
const out = (o) => process.stdout.write(JSON.stringify(Object.assign({}, o, { session_id: sid })) + '\n')
// One line per run, start and end, in the run's own HOME (a cluster's throwaway home): what a
// kept cluster (cluster-keep.ts) shows of each CLI the host started.
const runLog = (what) => { try { fs.appendFileSync(path.join(os.homedir(), 'mock-cli-runs.log'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, sid, what, ...(what === 'start' ? { argv: argv.filter((a) => !a.startsWith('{')).slice(0, 40), cwd: process.cwd() } : {}) }) + '\n') } catch { /* no home */ } }
runLog('start')
process.on('exit', (code) => runLog(`exit ${code}`))

const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const transcript = path.join(configDir, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'), `${sid}.jsonl`)
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
    const m = body.match(/^\s*\[([^\]\n]+)\]\n[\s\S]*?\n\[\/\1\]\s*/)
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
    if (t.startsWith('[Rich output mode')) continue
    if (/^\(Back to (the main conversation|the earlier (thread|question) about)/.test(t)) continue
    kept.push(lines[i])
  }
  const body = kept.join('\n').trim()
  return body === '' ? text.trim() : body
}

// Keep the actual launch context for fixture acceptance, regardless of whether
// the trusted template passed it inline or by file. This mock never runs outside
// the cluster's private HOME and PATH.
const contextFile = flag('--append-system-prompt-file')
const context = flag('--append-system-prompt') || (contextFile ? fs.readFileSync(contextFile, 'utf8') : '')
const launchDir = path.join(configDir, 'fixture-launches')
fs.mkdirSync(launchDir, { recursive: true, mode: 0o700 })
fs.writeFileSync(path.join(launchDir, `${sid}.json`), JSON.stringify({ context, cwd: process.cwd() }), { mode: 0o600 })

out({ type: 'system', subtype: 'init', cwd: process.cwd(), model: 'mock-model', tools: [], mcp_servers: [], permissionMode: 'default' })

const queue = []
let busy = false
/** Turns ended so far: the result's cost is cumulative, as the real CLI's is (an unchanged cost reads as a stale result). */
let turnsDone = 0
function runNext() {
  if (busy || queue.length === 0) return
  busy = true
  const msg = queue.shift()
  const c = msg.message && msg.message.content
  const raw = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && b.type === 'text' ? b.text : '')).join('') : ''
  const words = stripInputDecorations(stripBanners(raw))
  const userUuid = typeof msg.uuid === 'string' && msg.uuid ? msg.uuid : crypto.randomUUID()
  if (msg.uuid) out({ type: 'command_lifecycle', command_uuid: msg.uuid, state: 'started' })
  out({ type: 'system', subtype: 'session_state_changed', state: 'running' })
  file({ type: 'user', uuid: userUuid, parentUuid: parent, message: { role: 'user', content: raw } })
  parent = userUuid
  // "please run <command>": the turn asks for the Bash tool first (a can_use_tool prompt,
  // as the real CLI does in default mode) and answers once the prompt is answered.
  const ask = /^please run (.+)$/i.exec(words.trim())
  if (ask) {
    const requestId = `req-${crypto.randomBytes(6).toString('hex')}`
    out({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: ask[1] } } })
    waiting.set(requestId, (r) => finish(r.behavior === 'allow' ? `echo: ran ${ask[1]}` : `echo: did not run ${ask[1]}`))
    return
  }
  const question = /^please ask (.+)$/i.exec(words.trim())
  if (question) {
    const q = question[1]
    const requestId = `req-${crypto.randomBytes(6).toString('hex')}`
    out({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: q, header: 'Ask', multiSelect: false, options: [{ label: 'Friday', description: 'After the drill' }, { label: 'Monday', description: 'Next week' }] }] } } })
    waiting.set(requestId, (r) => {
      const answers = r.behavior === 'allow' && r.updatedInput && r.updatedInput.answers
      finish(answers && typeof answers[q] === 'string' ? `echo: answered ${answers[q]}` : 'echo: not answered')
    })
    return
  }
  const hold = /please hold until (\/\S+)/i.exec(words)
  if (hold) {
    const gate = setInterval(() => {
      if (!fs.existsSync(hold[1])) return
      clearInterval(gate)
      stopHeld = null
      finish(`echo: released ${hold[1]}`)
    }, 50)
    stopHeld = () => { clearInterval(gate); stopHeld = null; finish('echo: interrupted') }
    return
  }
  const stream = /^please stream (\d+) lines at (\d+) per second$/i.exec(words.trim())
  if (stream) {
    streamLines(Number(stream[1]), Number(stream[2]), (n) => finish(`echo: streamed ${JSON.stringify(n)}`))
    return
  }
  setTimeout(() => finish(`echo: ${words}`), THINK_MS)
  function finish(reply) {
    const message = {
      id: `msg_${crypto.randomBytes(6).toString('hex')}`, type: 'message', role: 'assistant', model: 'mock-model',
      content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
    }
    out({ type: 'assistant', message, parent_tool_use_id: null })
    const answerUuid = crypto.randomUUID()
    file({ type: 'assistant', uuid: answerUuid, parentUuid: parent, message })
    parent = answerUuid
    out({ type: 'result', subtype: 'success', is_error: false, result: reply, duration_ms: THINK_MS, num_turns: 1, total_cost_usd: (turnsDone += 1) / 1000, usage: { input_tokens: 1, output_tokens: 1 } })
    if (msg.uuid) out({ type: 'command_lifecycle', command_uuid: msg.uuid, state: 'completed' })
    out({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    busy = false
    runNext()
  }
}
/**
 * "please stream <n> lines at <r> per second": a busy turn's output, paced at r lines a second, in
 * whole steps of 13 lines as the real CLI writes them with --include-partial-messages: a message
 * start, a text block (start, 8 text deltas, stop), the assistant message (that text and a tool
 * call) and the tool's result, 16 KB every tenth step (a file read), a few hundred bytes otherwise.
 * `done` gets what was written, by kind, for the reader to check what arrived.
 */
function streamLines(total, perSecond, done) {
  const n = { lines: 0, steps: 0, deltas: 0, deltaChars: 0, toolUses: 0, toolResults: 0, big: 0 }
  const pending = []
  const words = 'the build reads its config then walks every package and checks each lockfile against '
  const step = () => {
    const i = n.steps++
    const msgId = `msg_${crypto.randomBytes(6).toString('hex')}`
    const toolId = `toolu_${crypto.randomBytes(8).toString('hex')}`
    const ev = (event) => ({ type: 'stream_event', event, parent_tool_use_id: null, uuid: crypto.randomUUID() })
    pending.push(ev({ type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', model: 'mock-model', content: [], usage: { input_tokens: 1, output_tokens: 1 } } }))
    pending.push(ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    let text = ''
    for (let k = 0; k < 8; k++) {
      const piece = `${words.slice(k * 10, k * 10 + 10)}(${i}.${k}) `
      text += piece
      pending.push(ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } }))
      n.deltas++
      n.deltaChars += piece.length
    }
    pending.push(ev({ type: 'content_block_stop', index: 0 }))
    const read = i % 10 === 9
    const input = read ? { file_path: `/work/src/module-${i}.ts` } : { command: `npm test -- --shard ${i}` }
    pending.push({ type: 'assistant', message: { id: msgId, type: 'message', role: 'assistant', model: 'mock-model', content: [{ type: 'text', text }, { type: 'tool_use', id: toolId, name: read ? 'Read' : 'Bash', input }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 8 } }, parent_tool_use_id: null, uuid: crypto.randomUUID() })
    n.toolUses++
    const body = read ? `export const line = ${'x'.repeat(60)}\n`.repeat(200).slice(0, 16_000) : `PASS shard ${i}: 41 tests, 0 failed\n`.repeat(8)
    if (read) n.big++
    pending.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: body }] }, parent_tool_use_id: null, uuid: crypto.randomUUID() })
    n.toolResults++
  }
  const start = Date.now()
  const timer = setInterval(() => {
    const due = Math.min(total, Math.floor(((Date.now() - start) / 1000) * perSecond))
    while (n.lines < due || (pending.length > 0 && n.lines >= total)) {
      if (pending.length === 0) step()
      out(pending.shift())
      n.lines++
    }
    if (n.lines >= total && pending.length === 0) { clearInterval(timer); done(n) }
  }, 20)
}
/** Prompts this CLI asked and waits on (request id -> its answer). */
const waiting = new Map()
/** Ends the held turn running now (an interrupt), or null. */
let stopHeld = null

let buf = ''
process.stdin.on('error', () => {})
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8')
  let nl
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.type === 'control_request') {
      if (msg.request && msg.request.subtype === 'interrupt') {
        // As the real CLI answers (interrupt receipt): cancel_queued drops the lines not yet
        // started and names them; none survive. Without the receipt Walnut counts every line it
        // queued as surviving and stops the process instead of the turn.
        const cancelled = msg.request.cancel_queued ? queue.splice(0).map((m) => m.uuid).filter((u) => typeof u === 'string' && u) : []
        for (const uuid of cancelled) out({ type: 'command_lifecycle', command_uuid: uuid, state: 'cancelled' })
        out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { still_queued: queue.map((m) => m.uuid).filter(Boolean), cancelled } } })
        if (stopHeld) stopHeld()
        continue
      }
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } })
      continue
    }
    if (msg.type === 'control_response') {
      const r = msg.response || {}
      const answer = waiting.get(r.request_id)
      if (answer) { waiting.delete(r.request_id); answer(r.response || {}) }
      continue
    }
    if (msg.type !== 'user') continue
    queue.push(msg)
    runNext()
  }
})
setInterval(() => {}, 1 << 30)
