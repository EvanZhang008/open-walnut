/**
 * The standby of a home that handed the leader over (docs/reference/leader-switch.md
 * "Standby"). A server that would boot as the leader on such a home does not refuse and exit
 * (its launcher would restart it in a loop): it stays up as this standby instead.
 *
 * It opens nothing in the home. The home is the copy a switch falls back to and stays byte for
 * byte as it was: opening its databases would write their WAL and shm files and run migrations,
 * a log or a lock file would land in it. So the standby is not the server with jobs turned off
 * (no boot policy column): it is this small HTTP listener on the server's port, which
 *   GET  /api/leader/status   says this machine leads nothing and who does: the machine the
 *                             witnesses name now (read live, read-only), else the one the marker names
 *   anything else             409 { code: 'handed_over', error: "this machine handed the leader to X (switch S)" }
 * and writes only its pid file beside the instance lock (machine-id.ts standbyServerFile),
 * outside the home. It sends nothing, fires nothing and claims nothing: no outward door is
 * reached, the permit's door log (in the home) gets no line.
 *
 * Two ways in (server.ts): the marker, checked before anything else of the boot; or the write
 * permission's boot step finding a record that names another machine (boot.ts). Taking new
 * data from the new leader as its replica is the cross-machine phase's.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { getVersion } from '../../version.js'
import { markerRefusal, readMarker, summarize, type HandedOverMarker, type RecordSummary } from './records.js'
import { permitHolderId, standbyServerFile } from './machine-id.js'
import type { PermitRecord } from '../permit/types.js'

export interface HandedOverStandby {
  home: string
  /** This machine's id, when it has one. */
  machine: string | null
  /** The machine that leads now as the boot found it: the witnesses' record, else the marker's `to`. */
  leader: string | null
  switchId: string | null
  marker: HandedOverMarker | null
  /** The record that named another machine, when the witnesses decided it. */
  record: RecordSummary | null
  /** The full reason (the line a refused boot printed before). */
  why: string
  /** The one line every answer carries. */
  message: string
}

/** The machine a standing record says leads now. */
export function leaderOf(r: PermitRecord | RecordSummary | null | undefined): string | null {
  if (!r) return null
  if (r.kind === 'handover') return r.to ?? null
  if (r.kind === 'release') return r.by
  return r.holder
}

function messageOf(leader: string | null, marker: HandedOverMarker | null, record: RecordSummary | null): string {
  if (marker?.torn) return 'this machine holds a leader-switch marker that cannot be read: it does not lead'
  if (marker?.state === 'switching') return `this machine is handing the leader to ${marker.to} (switch ${marker.switchId}): finish or cancel it with \`walnut leader switch --resume\` or \`--cancel\``
  if (marker) return `this machine handed the leader to ${marker.to} (switch ${marker.switchId})`
  return `machine ${leader ?? '?'} leads (permit record ${record?.number ?? '?'}): this machine does not`
}

function standbyOf(o: { home: string; env: NodeJS.ProcessEnv; marker: HandedOverMarker | null; record: RecordSummary | null; leader: string | null; why: string }): HandedOverStandby {
  return {
    home: path.resolve(o.home),
    machine: permitHolderId(o.env),
    leader: o.leader,
    switchId: o.marker?.switchId ?? null,
    marker: o.marker,
    record: o.record,
    why: o.why,
    message: messageOf(o.leader, o.marker, o.record),
  }
}

/** The standby of a home the switch marked, or null when it carries no marker. */
export function handedOverAtBoot(o: { home: string; env?: NodeJS.ProcessEnv }): HandedOverStandby | null {
  const marker = readMarker(o.home)
  if (!marker) return null
  return standbyOf({ home: o.home, env: o.env ?? process.env, marker, record: null, leader: marker.torn ? null : marker.to, why: markerRefusal(marker) })
}

/** The standby of a home whose boot found another machine named by the witnesses (boot.ts). */
export function standbyForRecord(o: { home: string; env?: NodeJS.ProcessEnv; leader: string; record?: PermitRecord; why: string }): HandedOverStandby {
  return standbyOf({ home: o.home, env: o.env ?? process.env, marker: readMarker(o.home), record: summarize(o.record), leader: o.leader, why: o.why })
}

export interface StandbyListener { server: http.Server; close(): Promise<void> }

/** How long a live read of the witnesses is reused by the status route. */
const LIVE_READ_MS = 3_000

/**
 * The witnesses' record now, read-only (a reader never proposes), when the home's config names
 * witnesses; null when it names none or no majority answers.
 */
async function readLive(home: string, machine: string | null): Promise<RecordSummary | null> {
  const { readHomeSwitchConfig } = await import('./settings.js')
  const cfg = readHomeSwitchConfig(home)
  if (!cfg.settings) return null
  const { openPermitClient, readStanding } = await import('./permit-ops.js')
  const h = openPermitClient(`${machine ?? 'unknown'}-standby-reader`, cfg.settings.witnesses, cfg.settings.params)
  try {
    const { standing } = await readStanding(h)
    return summarize(standing)
  } finally {
    h.client.stop('read once')
  }
}

export async function serveHandedOver(s: HandedOverStandby, o: { port: number; host?: string; env?: NodeJS.ProcessEnv }): Promise<StandbyListener> {
  const env = o.env ?? process.env
  // One standby per home: a second process (a launcher's restart beside a live one) starts none.
  const running = readStandbyServer(s.home, env)
  if (running && running.pid !== process.pid && await confirmStandby(running)) {
    throw new Error(`a standby of this home already runs (pid ${running.pid}, port ${running.port}): ${s.message}`)
  }
  let live: { at: number; record: RecordSummary | null } | null = null
  // Requests at the same moment share one read of the witnesses.
  let reading: Promise<RecordSummary | null> | null = null
  const liveRecord = (): Promise<RecordSummary | null> => {
    if (live && Date.now() - live.at <= LIVE_READ_MS) return Promise.resolve(live.record)
    reading ??= readLive(s.home, s.machine).catch(() => null).then((record) => {
      live = { at: Date.now(), record }
      reading = null
      return record
    })
    return reading
  }
  const status = async () => {
    const now = await liveRecord()
    const record = now ?? s.record
    const leader = leaderOf(now) ?? s.leader
    return {
      // WALNUT_LEADER_SWITCH_FAKE_VERSION: the rehearsal's way to claim an older program (routes/leader-switch.ts).
      version: env.WALNUT_LEADER_SWITCH_FAKE_VERSION || getVersion(),
      machine: s.machine,
      trial: false,
      standby: true,
      // What the switch's side checks before it signals the pid its file names (side.ts).
      pid: process.pid,
      leader,
      switchId: s.switchId,
      handedOver: s.marker,
      record,
      message: s.message,
      permit: { state: 'standby', mayAct: false, remainingMs: 0, record, why: s.why },
    }
  }
  const refusal = () => JSON.stringify({ error: s.message, code: 'handed_over', leader: s.leader, switchId: s.switchId })
  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0]
    if (req.method === 'GET' && url === '/api/leader/status') {
      void status().then((body) => json(res, 200, body)).catch((err: unknown) => {
        if (!res.headersSent) json(res, 500, { error: `the standby could not read its status: ${err instanceof Error ? err.message : String(err)}`, standby: true })
        else res.end()
      })
      return
    }
    // What the Mac app asks before it attaches (desktop/main.swift: GET / for a 200, then
    // GET /api/config for the login session): a 200, so it attaches to this standby and shows
    // its page instead of starting another server on the next port.
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(standbyPage(s))
      return
    }
    if (req.method === 'GET' && (url === '/api/health' || url === '/api/config')) {
      json(res, 200, { standby: true, leader: s.leader, switchId: s.switchId, message: s.message })
      return
    }
    // Drained so a client's body upload ends cleanly, then refused.
    req.resume()
    res.writeHead(409, { 'content-type': 'application/json' })
    res.end(refusal())
  })
  server.on('upgrade', (_req, socket) => {
    socket.end(`HTTP/1.1 409 Conflict\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n${refusal()}`)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(o.port, o.host, () => { server.off('error', reject); resolve() })
  })
  const file = standbyServerFile(s.home, env)
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : o.port
  // Where a later process reaches it: the bound address (a --bind to a Tailscale address listens
  // on nothing else), or loopback when it listens on every interface.
  const bound = typeof address === 'object' && address ? address.address : '127.0.0.1'
  const host = bound === '0.0.0.0' || bound === '::' || bound === '' ? '127.0.0.1' : bound
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, `${JSON.stringify({ pid: process.pid, port, host, home: s.home, at: new Date().toISOString() })}\n`, { mode: 0o600 })
  const unlink = () => { try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file) } catch { /* gone */ } }
  // An exit that skips close() (an uncaught error, process.exit) takes its file along; a SIGKILL
  // leaves it, and side.ts asks the port before it believes it.
  process.once('exit', unlink)
  return {
    server,
    close: async () => {
      unlink()
      process.off('exit', unlink)
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** A standby's pid file: its process, its port and the address it listens on. */
export interface StandbyServer { pid: number; port: number; host?: string }

/**
 * The standby running on `home`, as its pid file says and its process is alive. A file a killed
 * standby left can name a pid used again since: `confirmStandby` asks its port before a signal.
 */
export function readStandbyServer(home: string, env: NodeJS.ProcessEnv = process.env): StandbyServer | null {
  try {
    const j = JSON.parse(fs.readFileSync(standbyServerFile(home, env), 'utf8')) as { pid?: number; port?: number; host?: string; home?: string }
    if (typeof j.pid !== 'number' || j.pid <= 1 || j.home !== path.resolve(home)) return null
    try { process.kill(j.pid, 0) } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EPERM') return null }
    return { pid: j.pid, port: typeof j.port === 'number' ? j.port : 0, ...(typeof j.host === 'string' && j.host ? { host: j.host } : {}) }
  } catch {
    return null
  }
}

const escapeHtml = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** The one page the standby serves: what happened, and where Walnut runs now. */
function standbyPage(s: HandedOverStandby): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Walnut: standby</title>
<style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 1.5rem;color:#222}h1{font-size:1.3rem}code{font-size:.9em}</style>
</head><body>
<h1>This Walnut is on standby</h1>
<p>${escapeHtml(s.message.charAt(0).toUpperCase() + s.message.slice(1))}.</p>
<p>${s.leader ? `Open Walnut on <code>${escapeHtml(s.leader)}</code>, which leads now.` : 'Open Walnut on the machine that leads now.'} Nothing here changes while this machine waits: its data stays as it was handed over.</p>
<p>To make this machine lead again, run <code>walnut leader switch --back</code> on the machine that leads.</p>
</body></html>
`
}

/** The standby's own port answers that it is that standby (its pid): only then may it be signalled. */
export async function confirmStandby(sb: StandbyServer): Promise<boolean> {
  if (!sb.port) return false
  const host = sb.host ?? '127.0.0.1'
  const r = await fetch(`http://${host.includes(':') ? `[${host}]` : host}:${sb.port}/api/leader/status`, { signal: AbortSignal.timeout(5_000) }).catch(() => null)
  const j = (await r?.json().catch(() => null)) as { standby?: boolean; pid?: number } | null
  return j?.standby === true && j.pid === sb.pid
}
