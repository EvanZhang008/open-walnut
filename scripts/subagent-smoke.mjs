#!/usr/bin/env node
/**
 * Real end-to-end smoke of Walnut subagents (subagent_run), run on the host of a real caller
 * session against the production server. Every case starts a real subagent as that session
 * (WALNUT_SESSION_ID, the way the session's own `walnut` calls do) and checks that its end
 * comes back into the caller by itself: a foreground call returns the answer, and a background
 * run's end shows up in the caller's own conversation (task_history) with nothing read or polled
 * by the caller. This script itself reads subagent_read only to time each run.
 *
 *   node scripts/subagent-smoke.mjs --caller-task <task id> [--engines claude,codex]
 *     [--hosts __local__,clouddev] [--only name,name] [--out DIR] [--restart-wait-min N]
 *
 * Cases (each engine x host): fg (foreground), bg (background, caller idle), followup (a message
 * to a finished run), busy (background while the caller is mid-turn). Once: fail (its CLI is
 * killed), timeout (runs past its 1 minute), compact (the caller compacts mid-run; needs
 * --compact-cmd), restart (a server restart mid-run: it waits up to --restart-wait-min for the
 * next deploy, or runs --restart-cmd). Writes results.json and matrix.html in --out.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true'])
  return acc
}, []))
const callerTask = args['caller-task']
if (!callerTask) { console.error('--caller-task is required'); process.exit(2) }
const engines = (args.engines ?? 'claude,codex').split(',')
const hosts = (args.hosts ?? '__local__,clouddev').split(',')
const only = args.only ? new Set(args.only.split(',')) : null
const out = path.resolve(args.out ?? `subagent-smoke-${new Date().toISOString().replace(/[:.]/g, '-')}`)
fs.mkdirSync(out, { recursive: true })

function walnut(op, input, sid) {
  const env = { ...process.env, ...(sid ? { WALNUT_SESSION_ID: sid } : {}) }
  try {
    const text = execFileSync('walnut', ['tools', 'call', op, JSON.stringify(input)], { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60_000 })
    return JSON.parse(text)
  } catch (err) {
    const text = String(err.stdout ?? '') || String(err.message)
    try { return JSON.parse(text) } catch { return { error: text.slice(0, 2000) } }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const iso = (t) => (t ? new Date(t).toISOString() : '')

const task = walnut('task_get', { id: callerTask })
const caller = (task.task ?? task).session_id
if (!caller) { console.error(`task ${callerTask} has no session`); process.exit(2) }
console.log(`caller ${caller} (task ${callerTask}); results in ${out}`)

/** When the caller's own conversation got the end of `id` (turn > 1: "answered your message"). */
function toldAt(id, turn) {
  const h = walnut('task_history', { id: callerTask, limit: 80 })
  const want = turn > 1 ? 'answered your message' : null
  const row = (h.messages ?? []).find((m) => m.role === 'user' && typeof m.text === 'string' && m.text.includes(`Your subagent ${id} `) && (!want || m.text.includes(want)))
  return row ? Date.parse(row.timestamp) : null
}
async function waitTold(id, turn, ms) {
  const until = Date.now() + ms
  for (;;) {
    const at = toldAt(id, turn)
    if (at || Date.now() > until) return at
    await sleep(15_000)
  }
}
async function waitEnd(id, ms) {
  const until = Date.now() + ms
  for (;;) {
    const r = walnut('subagent_read', { id }, caller)
    if ((r.state && r.state !== 'running') || r.error || Date.now() > until) return r
    await sleep(10_000)
  }
}

const results = []
function record(c, o) {
  const row = { case: c.name, engine: c.engine, host: c.host, background: c.background, ...o }
  results.push(row)
  console.log(JSON.stringify(row))
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 1))
}

async function runCase(c) {
  const started = Date.now()
  const r = walnut('subagent_run', {
    prompt: c.prompt, description: `smoke ${c.name}`, engine: c.engine,
    ...(c.host !== '__local__' ? { host: c.host } : {}),
    background: c.background, ...(c.timeoutMin ? { timeout_min: c.timeoutMin } : {}),
  }, caller)
  const id = r.id
  if (!id) return record(c, { id: null, started: iso(started), verdict: 'FAIL', why: `no run: ${JSON.stringify(r).slice(0, 300)}` })
  if (c.during) await c.during(id)
  if (!c.background) {
    const ok = r.state === c.expect && (c.expect !== 'completed' || String(r.answer ?? '').includes(c.token))
    return record(c, { id, started: iso(started), ended: iso(Date.now()), told: 'returned in the call', state: r.state, verdict: ok ? 'PASS' : 'FAIL', answer: String(r.answer ?? r.error ?? '').slice(0, 200) })
  }
  const end = await waitEnd(id, (c.waitMin ?? 20) * 60_000)
  const told = await waitTold(id, 1, 5 * 60_000)
  const okState = end.state === c.expect && (c.expect !== 'completed' || String(end.answer ?? '').includes(c.token))
  const row = { id, started: iso(started), ended: iso(end.elapsed_ms ? started + end.elapsed_ms : Date.now()), told: iso(told), state: end.state, code: end.code, answer: String(end.answer ?? end.error ?? '').slice(0, 200) }
  if (c.followup) {
    const f = walnut('subagent_send', { id, message: `Reply with exactly: AGAIN ${c.token}`, background: true }, caller)
    const told2 = await waitTold(id, 2, 10 * 60_000)
    row.followup = { turn: f.turn, told: iso(told2) }
    row.verdict = okState && told && told2 ? 'PASS' : 'FAIL'
  } else row.verdict = okState && told ? 'PASS' : 'FAIL'
  walnut('subagent_stop', { id }, caller)
  record(c, row)
}

const cases = []
for (const engine of engines) for (const host of hosts) {
  const tag = `${engine}-${host === '__local__' ? 'local' : host}`
  const pong = (name) => `Reply with exactly one line: PONG ${tag}-${name}`
  cases.push({ name: `fg-${tag}`, engine, host, background: false, prompt: pong('fg'), token: `PONG ${tag}-fg`, expect: 'completed' })
  cases.push({ name: `bg-${tag}`, engine, host, background: true, prompt: pong('bg'), token: `PONG ${tag}-bg`, expect: 'completed' })
  cases.push({ name: `followup-${tag}`, engine, host, background: true, prompt: pong('followup'), token: `PONG ${tag}-followup`, expect: 'completed', followup: true })
  cases.push({
    name: `busy-${tag}`, engine, host, background: true, prompt: `Run the shell command \`sleep 20\`, then reply with exactly one line: PONG ${tag}-busy`, token: `PONG ${tag}-busy`, expect: 'completed',
    // The caller is mid-turn when the end comes.
    during: async () => { walnut('task_send', { id: callerTask, message: 'Smoke test: run the shell command `sleep 90`, then reply with one line "busy done". Nothing else.', expect_reply: false }) },
  })
}
const first = { engine: engines[0], host: hosts[hosts.length - 1] }
cases.push({ name: 'fail', ...first, background: true, prompt: 'Run this shell command exactly, nothing else: kill -9 $PPID', token: '', expect: 'failed' })
cases.push({ name: 'timeout', ...first, background: true, timeoutMin: 1, prompt: 'Run the shell command `sleep 150`, then reply with exactly one line: PONG timeout', token: '', expect: 'failed', waitMin: 6 })
if (args['compact-cmd']) {
  cases.push({
    name: 'compact', ...first, background: true, prompt: 'Run the shell command `sleep 120`, then reply with exactly one line: PONG compact', token: 'PONG compact', expect: 'completed',
    during: async () => { await sleep(10_000); execFileSync('bash', ['-c', args['compact-cmd']], { stdio: 'inherit' }) },
  })
}
if (args['restart-wait-min'] || args['restart-cmd']) {
  const waitMin = Number(args['restart-wait-min'] ?? 15)
  cases.push({
    name: 'restart', ...first, background: true, timeoutMin: waitMin + 10,
    prompt: `Run the shell command \`sleep ${Math.max(60, waitMin * 60)}\`, then reply with exactly one line: PONG restart`, token: 'PONG restart', expect: 'completed', waitMin: waitMin + 15,
    during: async () => { if (args['restart-cmd']) { await sleep(20_000); execFileSync('bash', ['-c', args['restart-cmd']], { stdio: 'inherit' }) } },
  })
}

const todo = cases.filter((c) => !only || only.has(c.name))
// Background cases run side by side (a session keeps 4 answering at once); the rest one by one.
const fg = todo.filter((c) => !c.background)
const bg = todo.filter((c) => c.background)
for (const c of fg) await runCase(c)
for (let i = 0; i < bg.length; i += 4) await Promise.all(bg.slice(i, i + 4).map((c) => runCase(c)))

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch])
const html = `<!doctype html><meta charset="utf-8"><title>Walnut subagent smoke</title>
<style>body{font:14px system-ui;margin:24px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left;vertical-align:top}.PASS{background:#e6f6e6}.FAIL{background:#fbe3e3}</style>
<h1>Walnut subagent smoke</h1><p>Caller session ${esc(caller)} (task ${esc(callerTask)}), ${new Date().toISOString()}. ${results.filter((r) => r.verdict === 'PASS').length} of ${results.length} passed.</p>
<table><tr><th>case</th><th>engine</th><th>host</th><th>mode</th><th>run</th><th>started</th><th>ended</th><th>told to its session</th><th>state</th><th>follow-up told</th><th>verdict</th><th>answer</th></tr>
${results.map((r) => `<tr class="${r.verdict}"><td>${esc(r.case)}</td><td>${esc(r.engine)}</td><td>${esc(r.host)}</td><td>${r.background ? 'background' : 'foreground'}</td><td>${esc(r.id)}</td><td>${esc(r.started)}</td><td>${esc(r.ended)}</td><td>${esc(r.told)}</td><td>${esc(r.state)} ${esc(r.code ?? '')}</td><td>${esc(r.followup?.told ?? '')}</td><td>${r.verdict}</td><td>${esc(r.answer ?? r.why)}</td></tr>`).join('\n')}
</table>`
fs.writeFileSync(path.join(out, 'matrix.html'), html)
console.log(`${results.filter((r) => r.verdict === 'PASS').length}/${results.length} passed; ${path.join(out, 'matrix.html')}`)
process.exit(results.every((r) => r.verdict === 'PASS') ? 0 : 1)
