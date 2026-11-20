/**
 * `walnut net hub-forward`: this machine's hub forwards (docs/reference/host-network.md,
 * "Reaching a port on the primary"; providers/hub-forward-core.ts). A forward is a 127.0.0.1
 * port here whose connections reach one port on the primary's own loopback, over the link the
 * primary already holds to this machine's daemon. This command writes this machine's own
 * forwards file, the one its daemon reads (the daemon names it in `hub.status`), and shows how
 * each forward is doing. The primary still takes only the ports its config lists for this
 * machine (`net.hub_ports`).
 *
 *   walnut net hub-forward                         list the forwards and their state
 *   walnut net hub-forward add <local_port> [port] add one (port: the primary's, default the same)
 *   walnut net hub-forward remove <local_port>     remove one
 */
import fs from 'node:fs'
import path from 'node:path'
import { daemonRpc, errText } from './net.js'
import { parseHubForwards, type HubForward, type HubForwardState } from '../providers/hub-forward-core.js'

const OLD_DAEMON = "this machine's Walnut daemon has no hub forwards yet. Run `walnut update`, then this again."
/** The daemon reads its file this often (hub-forward-core.ts RELOAD_MS), plus a moment. */
const APPLY_WAIT_MS = 8_000

type Status = { file: string; problems: string[]; forwards: HubForwardState[] }

async function status(): Promise<Status | { error: string }> {
  const hello = await daemonRpc('hello', {}, 10_000)
  if (!(hello.capabilities as string[] | undefined)?.includes('hub-forward-v1')) return { error: OLD_DAEMON }
  const s = await daemonRpc('hub.status', {}, 10_000)
  if (s.ok !== true || typeof s.file !== 'string') return { error: errText(s) }
  return { file: s.file, problems: Array.isArray(s.problems) ? s.problems as string[] : [], forwards: Array.isArray(s.forwards) ? s.forwards as HubForwardState[] : [] }
}

function when(ms: number | null): string {
  return ms ? new Date(ms).toISOString() : 'never'
}

function print(s: Status): void {
  process.stdout.write(`Forwards file: ${s.file}\n`)
  for (const p of s.problems) process.stdout.write(`  left out: ${p}\n`)
  if (s.forwards.length === 0) { process.stdout.write('No hub forwards on this machine.\n'); return }
  for (const f of s.forwards) {
    const state = f.listening ? 'listening' : `not listening${f.error ? ` (${f.error})` : ''}`
    process.stdout.write(`  127.0.0.1:${f.local_port} -> the primary's 127.0.0.1:${f.port}${f.walnut ? ` (Walnut ${f.walnut})` : ''}: ${state}\n`)
    process.stdout.write(`    open now ${f.active}, opened ${f.opened}, last ${when(f.lastOpenedAt)}; refused ${f.refused}${f.lastRefusal ? `, last: ${f.lastRefusal}` : ''}\n`)
  }
}

/** The file's forwards as written (an unreadable file refuses the edit: it is never overwritten). */
function readForwards(file: string): HubForward[] | { error: string } {
  let text: string | null = null
  try { text = fs.readFileSync(file, 'utf8') } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return { error: `cannot read ${file}: ${(err as Error).message}` }
  }
  const parsed = parseHubForwards(text)
  // An entry it would leave out is never dropped by an edit: the file is fixed by hand first.
  if (parsed.problems.length) return { error: `${file} has entries this command would drop (${parsed.problems[0]}); fix or remove them first` }
  return parsed.forwards
}

function writeForwards(file: string, forwards: HubForward[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ forwards }, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
}

function port(text: string | undefined): number | null {
  const n = Number(text)
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null
}

export async function runNetHubForward(action: string | undefined, args: string[]): Promise<number> {
  try {
    const s = await status()
    if ('error' in s) { process.stderr.write(`walnut net hub-forward: ${s.error}\n`); return 1 }
    if (!action || action === 'list') { print(s); return 0 }
    if (action !== 'add' && action !== 'remove') {
      process.stderr.write('walnut net hub-forward: use list, add <local_port> [port] or remove <local_port>\n')
      return 1
    }
    const local = port(args[0])
    if (local === null) { process.stderr.write('walnut net hub-forward: name a local port (1 to 65535)\n'); return 1 }
    const current = readForwards(s.file)
    if ('error' in current) { process.stderr.write(`walnut net hub-forward: ${current.error}\n`); return 1 }
    let next: HubForward[]
    if (action === 'add') {
      const remote = args[1] === undefined ? local : port(args[1])
      if (remote === null) { process.stderr.write("walnut net hub-forward: the primary's port must be 1 to 65535\n"); return 1 }
      // Replacing a forward keeps the Walnut it names.
      const was = current.find((f) => f.local_port === local)
      next = [...current.filter((f) => f.local_port !== local), { local_port: local, to: 'primary', port: remote, ...(was?.walnut ? { walnut: was.walnut } : {}) }]
    } else {
      next = current.filter((f) => f.local_port !== local)
      if (next.length === current.length) { process.stderr.write(`walnut net hub-forward: no forward on local port ${local}\n`); return 1 }
    }
    writeForwards(s.file, next)
    // The daemon reads the file again within a few seconds: show what it made of it.
    const until = Date.now() + APPLY_WAIT_MS
    let after = s
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 500))
      const now = await status()
      if ('error' in now) break
      after = now
      const f = now.forwards.find((x) => x.local_port === local)
      if (action === 'remove' ? !f : f && (f.listening || f.error)) break
    }
    print(after)
    if (action === 'add') process.stdout.write("The primary takes it only once its config lists this port for this machine (net.hub_ports).\n")
    return 0
  } catch (err) {
    process.stderr.write(`walnut net hub-forward: ${(err as Error).message}\n`)
    return 1
  }
}
