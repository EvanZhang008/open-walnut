#!/usr/bin/env node
/**
 * A stand-in `claude -p` for a model helper Walnut's server spawns with a shell
 * (the AI search child, core/task-search-agent.ts). It does what the model and
 * the CLI's Bash tool would do with the search contract: it takes the single
 * `curl` line the system prompt tells it to run, fills in the terms, runs it in
 * a real `/bin/sh` with the env the CLI was given, and answers with every task
 * id the call returned (the answer contract: {"results":[{task_id,...}]}).
 *
 * HELPER_FAKE_TERMS: the terms it searches (default "acme").
 * HELPER_FAKE_PROBE: a file it appends one JSON line to per run: the command it
 * ran and what the call answered (status and body), for the test to read.
 *
 * Both input modes, as the real CLI: stream-json (a warm child answers each user
 * line) and text (reads stdin to EOF, answers once).
 */
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')

const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const streamIn = flag('--input-format') === 'stream-json'
const sessionId = flag('--session-id') || 'helper-fake-' + process.pid
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')

function systemPrompt() {
  const file = flag('--system-prompt-file')
  if (file) { try { return fs.readFileSync(file, 'utf8') } catch { return '' } }
  return flag('--system-prompt') || ''
}

/** The prompt's single-search curl line, with the terms filled in. */
function searchCommand() {
  const line = systemPrompt().split('\n').find((l) => l.includes('curl ') && l.includes('q=<terms>'))
  if (!line) return null
  const start = line.indexOf('curl ')
  const cmd = line.slice(start).replace(/`.*$/, '').trim()
  return cmd.replace('<terms>', process.env.HELPER_FAKE_TERMS || 'acme')
}

function answer() {
  const cmd = searchCommand()
  let body = ''
  let status = 0
  if (cmd) {
    // What the Bash tool runs: the command in a shell, in the CLI's own env.
    const r = spawnSync('/bin/sh', ['-c', `${cmd} -w '\\n%{http_code}'`], { env: process.env, encoding: 'utf8', timeout: 20_000 })
    const text = String(r.stdout || '')
    const nl = text.lastIndexOf('\n')
    body = nl >= 0 ? text.slice(0, nl) : text
    status = Number(nl >= 0 ? text.slice(nl + 1) : 0) || 0
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: cmd } }] } })
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: body }] } })
  }
  if (process.env.HELPER_FAKE_PROBE) {
    fs.appendFileSync(process.env.HELPER_FAKE_PROBE, JSON.stringify({ command: cmd, status, body }) + '\n')
  }
  let ids = []
  try {
    const parsed = JSON.parse(body)
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.results) ? parsed.results : []
    ids = rows.map((r) => r && (r.taskId || r.id)).filter((id) => typeof id === 'string')
  } catch { /* a refusal is not JSON rows */ }
  const reply = JSON.stringify({ results: ids.map((id) => ({ task_id: id, evidence: 'matched the search', confidence: 'high' })) })
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } })
  out({ type: 'result', subtype: 'success', result: reply, session_id: sessionId, total_cost_usd: 0.001 })
}

process.stdin.setEncoding('utf8')
if (streamIn) {
  out({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(), model: 'fake' })
  let buf = ''
  process.stdin.on('data', (chunk) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      try { if (JSON.parse(line).type === 'user') answer() } catch { /* not a message */ }
    }
  })
  process.stdin.on('end', () => process.exit(0))
} else {
  process.stdin.on('data', () => {})
  process.stdin.on('end', () => {
    out({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(), model: 'fake' })
    answer()
    process.exit(0)
  })
}
