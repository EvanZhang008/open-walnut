/**
 * The cross-machine rehearsal's hands on another machine (rehearsal (b), real-world.ts): started there by the
 * driver over one ssh channel, it runs machine-ops.ts operations sent as JSON lines on its stdin and answers each
 * on its stdout (machine-io.ts AgentIO). It is that machine's local driver: the daemon, the host service, a server
 * started by hand, the switch command, the readers of the machine's records all run here, with this process's
 * environment, which keeps every place inside the rehearsal root (checked below before anything runs).
 *
 *   cd <root>/code && env -i <the machine env> <root>/bin/bun scripts/leader-switch/machine-agent.ts
 *
 * Its stdin's end (the driver gone, the ssh channel closed) or SIGTERM or SIGHUP stops what it keeps and ends it.
 */
import fs from 'node:fs'
import path from 'node:path'

const AGENT_LINE = '\u0001RB '
const send = (msg: unknown) => process.stdout.write(`${AGENT_LINE}${JSON.stringify(msg)}\n`)
// A module's own print goes to stderr: stdout carries only answers.
for (const k of ['log', 'info', 'debug'] as const) console[k] = (...a: unknown[]) => console.error(...a)

const root = process.env.WALNUT_REHEARSAL_ROOT ?? ''
const inside = (p: string | undefined) => !!p && path.resolve(p).startsWith(`${path.resolve(root)}${path.sep}`)
const places = ['HOME', 'TMPDIR', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'WALNUT_REHEARSAL_PIDS'] as const
const outside = places.filter((k) => !inside(process.env[k]))
if (!path.isAbsolute(root) || path.resolve(root).split(path.sep).filter(Boolean).length < 2 || outside.length || process.env.OPEN_WALNUT_HOME) {
  console.error(`machine-agent: refusing to run: WALNUT_REHEARSAL_ROOT ${JSON.stringify(root)} must be an absolute folder at least two levels deep, ${outside.join(', ') || 'every place'} inside it, OPEN_WALNUT_HOME unset`)
  process.exit(2)
}
const tick = (() => { try { const s = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8'); return Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[19]) } catch { return null } })()
fs.appendFileSync(process.env.WALNUT_REHEARSAL_PIDS!, `${JSON.stringify({ pid: process.pid, tick, what: 'agent', argv: process.argv, at: new Date().toISOString() })}\n`, { mode: 0o600 })

const { runOp, OPS } = await import('./machine-ops.js')

let ending = false
async function end(code: number): Promise<never> {
  if (!ending) { ending = true; await OPS.stopAllKept().catch(() => {}) }
  process.exit(code)
}
process.on('SIGTERM', () => { void end(0) })
process.on('SIGHUP', () => { void end(0) })

send({ id: 0, ok: true, value: { pid: process.pid, bun: process.versions.bun ?? process.version, platform: `${process.platform}-${process.arch}`, cwd: process.cwd(), repo: path.resolve(import.meta.dirname, '../..') } })

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d: string) => {
  buf += d
  for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let req: { id: number; op: string; args: unknown[] }
    try { req = JSON.parse(line) } catch { console.error(`machine-agent: unreadable request ${line.slice(0, 200)}`); continue }
    void runOp(req.op as Parameters<typeof runOp>[0], (req.args ?? []) as never)
      .then((value) => send({ id: req.id, ok: true, value: value ?? null }))
      .catch((err: unknown) => send({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) }))
  }
})
process.stdin.on('end', () => { void end(0) })
