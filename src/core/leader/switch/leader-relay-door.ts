/**
 * The leader's relay door (leader-relay.ts): what a stream a host opened with the relay purpose reaches.
 * The leader's DaemonConnection hands such a stream here with the key of the host it came from
 * (never to its tunnel port), so whoever calls is a process of that host's account, and the host is
 * known by its link: the machine id the daemon said in its hello. One HTTP request per stream:
 *
 *   POST /leader-switch/begin   {to, switchId}: a switch begun on the new leader's machine (the
 *        switch command run there). The trust rule: the link is `to` (the machine id its daemon said in its hello,
 *        or this leader's own key of that host when leader_switch.machines names it as `to`'s host_key), `to` is a machine of
 *        leader_switch.machines, and its machine holds this leader's standby target (beginRefusal,
 *        through switchLink, which also checks the copy link answers). Then the begin is recorded
 *        (this server's console and Walnut Health: who began it on which machine) and this server starts
 *        the source job on its own machine, detached, with that switch id, as the command here would.
 *   GET  /leader-switch/job?switchId=..&from=..   that job's output from a byte offset, whether it
 *        runs, how it ended, and its switch state's step: what the command on the other machine prints.
 *   POST /leader-witness/challenge|request   this machine's witness door (witness-door.ts), the same
 *        door every server opens with the capability witness-door: proven with the witness's own key.
 *
 * Mounted only while this server runs the permit (the experiment with a leader_switch section); off,
 * the DaemonConnection destroys the stream before this module loads.
 */
import fs from 'node:fs'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { RELAY_BEGIN_PATH, RELAY_JOB_PATH } from './leader-relay.js'
import { WITNESS_DOOR_PATH } from './witness-wire.js'
import type { StartedBy } from './flow.js'
import type { SwitchLink } from './switch-link.js'

/** A begin this server took from another machine, and the source job it started for it. */
export interface ForwardedBegin {
  switchId: string
  to: string
  by: StartedBy
  hostKey: string
  at: string
  job: { log: string; from: number; pid: number | null; exit: { code: number | null; signal: string | null } | null }
}

const forwarded = new Map<string, ForwardedBegin>()

/** The forwarded begin of `switchId`, if this server took one (the source job's own begin on loopback reads it). */
export function forwardedBeginOf(switchId: string): ForwardedBegin | null {
  return forwarded.get(switchId) ?? null
}

/** Tests only. */
export function _forgetForwardedBegins(): void { forwarded.clear() }

export interface ForwardedBeginDeps {
  /** This server's permit: its machine, or null when it does not lead (a trial start, no permit). */
  leader(): { machine: string } | null
  /** The machine id the host link `hostKey` said in its hello (null: not known). */
  machineIdOf(hostKey: string): string | null
  /** The trust rule and the copy link (switch-link.ts). */
  switchLink(to: string, me: string, o: { forwardedBy: string | null; forwardedHostKey: string }): Promise<SwitchLink>
  /** A switch from this home already under way (its step), or null. */
  underWay(): { id: string; to: string; step: string } | null
  /** Who began it, in the console and Walnut Health. */
  record(o: { switchId: string; from: string; to: string; by: StartedBy }): void
  /** Start the source job, detached; its log and where its output for this switch starts. */
  startSourceJob(o: { switchId: string; to: string }): { log: string; from: number; pid: number | null; exit: Promise<{ code: number | null; signal: string | null }> }
}

export interface RelayAnswerBody { status: number; json: Record<string, unknown> }

/** The forwarded begin (the top of this file). */
export async function beginForwarded(hostKey: string, body: unknown, deps: ForwardedBeginDeps): Promise<RelayAnswerBody> {
  const b = (body && typeof body === 'object' ? body : {}) as { to?: unknown; switchId?: unknown }
  const to = typeof b.to === 'string' ? b.to : ''
  const switchId = b.switchId
  const { isSwitchId } = await import('./ticket.js')
  if (!isSwitchId(switchId)) return { status: 400, json: { ok: false, why: 'not a switch id' } }
  const me = deps.leader()
  if (!me) return { status: 409, json: { ok: false, why: 'this server does not hold the write permission' } }
  if (!to) return { status: 400, json: { ok: false, why: 'name the machine to switch to' } }
  const had = forwarded.get(switchId)
  // The same begin asked again (the command's answer was lost): the job it started is the answer.
  if (had) return had.to === to ? { status: 200, json: { ok: true, switchId, leader: me.machine, startedBy: had.by, again: true } } : { status: 409, json: { ok: false, why: `switch ${switchId} was begun for ${had.to}` } }
  const machineId = deps.machineIdOf(hostKey)
  const link = await deps.switchLink(to, me.machine, { forwardedBy: machineId, forwardedHostKey: hostKey })
  if ('refused' in link) return { status: 403, json: { ok: false, why: link.refused, leader: me.machine } }
  link.peer.close()
  const open = deps.underWay()
  if (open) return { status: 409, json: { ok: false, why: `switch ${open.id} to ${open.to} is under way here (step ${open.step})`, leader: me.machine } }
  const by: StartedBy = { machine: to, via: 'forwarded' }
  let job: ReturnType<ForwardedBeginDeps['startSourceJob']>
  try {
    job = deps.startSourceJob({ switchId, to })
  } catch (err) {
    return { status: 500, json: { ok: false, why: `the switch job did not start on ${me.machine}: ${err instanceof Error ? err.message : String(err)}`, leader: me.machine } }
  }
  deps.record({ switchId, from: me.machine, to, by })
  const entry: ForwardedBegin = { switchId, to, by, hostKey, at: new Date().toISOString(), job: { log: job.log, from: job.from, pid: job.pid, exit: null } }
  forwarded.set(switchId, entry)
  void job.exit.then((e) => { entry.job.exit = e })
  return { status: 200, json: { ok: true, switchId, leader: me.machine, startedBy: by } }
}

/** The source job of a forwarded begin: its output from `from` (bytes, at most 64 KB), whether it runs, its step. */
export function forwardedJob(switchId: string, from: number, readState: (id: string) => { step: string; rollbackWhy?: string } | null): RelayAnswerBody {
  const f = forwarded.get(switchId)
  if (!f) return { status: 404, json: { ok: false, why: `this server began no switch ${switchId} for another machine` } }
  const start = Math.max(f.job.from, Number.isFinite(from) ? from : 0)
  let text = ''
  let to = start
  try {
    const size = fs.statSync(f.job.log).size
    if (size > start) {
      const fd = fs.openSync(f.job.log, 'r')
      try {
        const b = Buffer.alloc(Math.min(size - start, 64 * 1024))
        const n = fs.readSync(fd, b, 0, b.length, start)
        // Whole lines only while the job runs: a line it is still writing comes with the next read.
        const s = b.subarray(0, n).toString('utf8')
        const cut = f.job.exit && n === size - start ? s.length : s.lastIndexOf('\n') + 1
        text = s.slice(0, cut)
        to = start + Buffer.byteLength(text)
      } finally { fs.closeSync(fd) }
    }
  } catch { /* no output yet */ }
  const st = readState(switchId)
  return { status: 200, json: { ok: true, text, to, running: f.job.exit === null, exit: f.job.exit, state: st ? { step: st.step, rollbackWhy: st.rollbackWhy ?? null } : null } }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), connection: 'close' })
  res.end(text)
}

async function readBody(req: IncomingMessage, max: number): Promise<unknown> {
  const parts: Buffer[] = []
  let n = 0
  for await (const c of req) {
    n += (c as Buffer).length
    if (n > max) throw new Error('too_large')
    parts.push(c as Buffer)
  }
  return n ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}
}

/** The production deps of the forwarded begin, in a leader server. */
async function serverDeps(): Promise<ForwardedBeginDeps> {
  const [{ currentLeaderPermit }, { pooledMachineIdOf }, { switchLink }, { WALNUT_HOME }, { readSwitchState, SOURCE_FINAL }, { startSourceJobFor }] = await Promise.all([
    import('./boot.js'), import('../../../providers/daemon-connection.js'), import('./switch-link.js'), import('../../../constants.js'), import('./flow.js'), import('./switch-command.js'),
  ])
  return {
    leader: () => { const p = currentLeaderPermit(); return p && !p.trial ? { machine: p.machine } : null },
    machineIdOf: (k) => pooledMachineIdOf(k),
    switchLink,
    underWay: () => { const st = readSwitchState(WALNUT_HOME); return st && !SOURCE_FINAL.has(st.step) ? { id: st.id, to: st.to, step: st.step } : null },
    record: (o) => { void recordBegin(o) },
    // As the switch command on this machine starts it (its env, its log beside this machine's id).
    startSourceJob: (o) => startSourceJobFor({ home: WALNUT_HOME, ...o }),
  }
}

/** Who began a switch on which machine: this server's log (its console) and Walnut Health. */
export async function recordBegin(o: { switchId: string; from: string; to: string; by: StartedBy }): Promise<void> {
  const [{ beganLine }, { log }, { raiseHealthItem }] = await Promise.all([import('./final-stop.js'), import('../../../logging/index.js'), import('../../notifications/health-items.js')])
  const line = beganLine(o)
  log.web.info(`leader switch: ${line.title}`, { switchId: o.switchId, from: o.from, to: o.to, startedBy: o.by })
  void raiseHealthItem({ kind: 'operation-error', severity: 'info', title: line.title, body: line.body, dedupKey: `leader-switch-began:${o.switchId}`, category: 'Leader switch' }, 'leader-switch')
}

let server: http.Server | null = null
const hostOf = new WeakMap<object, string>()

/** A relay stream from host `hostKey` (DaemonConnection, purpose leader-relay): one HTTP exchange on it. */
export function acceptLeaderRelay(hostKey: string, stream: Duplex): void {
  if (!server) {
    server = http.createServer((req, res) => { void handle(req, res) })
    server.on('clientError', (_err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n') } catch { /* gone */ } })
  }
  stream.on('error', () => { /* the host went */ })
  hostOf.set(stream, hostKey)
  server.emit('connection', stream)
}

let witnessDoor: Promise<{ door: import('./witness-door.js').WitnessDoor; serve: typeof import('./witness-door.js').serveDoorHttp } | null> | null = null

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const hostKey = hostOf.get(req.socket) ?? ''
  const url = new URL(req.url ?? '/', 'http://relay')
  try {
    if (!hostKey) { req.resume(); return sendJson(res, 403, { ok: false, why: 'not a host link' }) }
    if (req.method === 'POST' && url.pathname === RELAY_BEGIN_PATH) {
      const body = await readBody(req, 64 * 1024)
      const r = await beginForwarded(hostKey, body, await serverDeps())
      return sendJson(res, r.status, r.json)
    }
    if (req.method === 'GET' && url.pathname === RELAY_JOB_PATH) {
      req.resume()
      const [{ readSwitchState }, { WALNUT_HOME }] = await Promise.all([import('./flow.js'), import('../../../constants.js')])
      const r = forwardedJob(url.searchParams.get('switchId') ?? '', Number(url.searchParams.get('from') ?? 0), (id) => { const st = readSwitchState(WALNUT_HOME); return st && st.id === id ? st : null })
      return sendJson(res, r.status, r.json)
    }
    if (req.method === 'POST' && url.pathname.startsWith(`${WITNESS_DOOR_PATH}/`)) {
      // The same door the capability opens on this server's own listener, over this machine's witness root.
      witnessDoor ??= (async () => {
        const { hasCapability } = await import('../../capabilities.js')
        if (!hasCapability('witness-door')) return null
        const [{ machineWitnessDoor, serveDoorHttp }, { witnessRoot }, { log }] = await Promise.all([import('./witness-door.js'), import('./machine-id.js'), import('../../../logging/index.js')])
        return { door: machineWitnessDoor({ root: witnessRoot(), onRefuse: (code) => log.web.info('witness door (relay): refused', { code }), log: (level, msg, data) => log.web[level](msg, data) }), serve: serveDoorHttp }
      })()
      const d = await witnessDoor
      // Counted per host link: every relay request arrives on loopback.
      if (d && d.serve(d.door, url.pathname.slice(WITNESS_DOOR_PATH.length), req, res, `relay:${hostKey}`)) return
    }
    req.resume()
    sendJson(res, 404, { ok: false, error: 'not_found' })
  } catch (err) {
    if (!res.headersSent) sendJson(res, (err as Error).message === 'too_large' ? 413 : 500, { ok: false, why: err instanceof Error ? err.message : String(err) })
  }
}
