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
 *   GET  / (any page)         the standby page, which loads again by itself once the console has the port
 *   anything else             409 { code: 'handed_over', error: "this machine handed the leader to X (switch S)", leader, leaderDoors }
 *   POST /leader-witness/*    this machine's witness door, only when the server opens it (witness-door.ts)
 * and writes only its pid file beside the instance lock (machine-id.ts standbyServerFile),
 * outside the home (and, through its door, this machine's witness record in the state dir). It sends nothing, fires nothing and claims nothing: no outward door is
 * reached, the permit's door log (in the home) gets no line.
 *
 * Two ways in (server.ts): the marker, checked before anything else of the boot; or the write
 * permission's boot step finding a record that names another machine (boot.ts).
 *
 * It shares its port with this machine's console (core/handed-over-console.ts). The replica this
 * machine's daemon runs for the new leader serves the console of this home at the same address;
 * while it holds, or waits for, that port (its holder file names a live process and this port),
 * the standby gives the port up and stays, holding nothing: the process the Mac app started keeps
 * running, so the app never sees it end. When the console ends (the replica stops, or never
 * answers as this Walnut for a minute) the standby takes the port back. It ends (`ended`) only
 * when this home no longer stands handed over in its switch (a switch back moved it aside) or
 * another standby of this home serves the port. While it holds no port it writes no pid file
 * (readStandbyServer finds none): a yielded standby is ended by its own marker check, never by
 * a signal from LocalSide.stopStandby.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { getVersion } from '../../version.js'
import { markerRefusal, readMarker, summarize, type HandedOverMarker, type RecordSummary } from './records.js'
import { permitHolderId, standbyServerFile } from './machine-id.js'
import type { PermitRecord } from '../permit/types.js'
import type { ConsoleHolder, HandedOverConsole } from '../../handed-over-console.js'

export interface HandedOverStandby {
  home: string
  /** This machine's id, when it has one. */
  machine: string | null
  /** The machine that leads now as the boot found it: the witnesses' record, else the marker's `to`. */
  leader: string | null
  /** Where that machine's server is reached (the marker's leaderDoors: leader_switch.machines[].doors), when known. */
  leaderDoors: string[]
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
    // The doors the marker names are the marker's machine's; a leader the witnesses name otherwise has none known here.
    leaderDoors: o.marker && !o.marker.torn && o.marker.to === o.leader && Array.isArray(o.marker.leaderDoors) ? o.marker.leaderDoors.filter((d) => typeof d === 'string') : [],
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

export interface StandbyListener {
  /** The standby's listener; it listens only while the console does not hold the port. */
  server: http.Server
  close(): Promise<void>
  /** The line to print first: the standby listens, or this machine's replica serves the console here. */
  line: string
  /** Settles (with the line to print) when this standby has nothing left to do: `walnut web` then ends. */
  ended: Promise<string>
}

/** How often a standby looks for this machine's console replica (and, while it gave the port up, for its end). */
const CONSOLE_LOOK_MS = 1_000
/** How long a console replica holding this port may not answer as this Walnut before the standby takes the port back. */
const CONSOLE_ANSWER_WAIT_MS = 60_000
/** At a start, how long a replica that only waits for the port gets before the standby listens (and gives the port up as usual). */
const CONSOLE_WAITING_START_MS = 5_000

export interface ConsoleOnPort { holder: ConsoleHolder; console: HandedOverConsole }

/**
 * The live replica that holds (or waits for) the console of `home` on `port`, with that console,
 * or null. Only this port: a console the replica waits for elsewhere (its port taken by another
 * program, the app moved on to the next one) is not this standby's to give way to.
 */
export async function consoleOnPort(home: string, port: number): Promise<ConsoleOnPort | null> {
  const { consolesOfHome, consoleRefusal, readHolder } = await import('../../handed-over-console.js')
  for (const c of consolesOfHome(home)) {
    if (c.port !== port || consoleRefusal(c)) continue
    const holder = readHolder(c.walnutId)
    if (holder && holder.port === port) return { holder, console: c }
  }
  return null
}

function hostOf(c: { host: string }): string {
  return c.host === '::' || c.host === '0.0.0.0' || !c.host ? '127.0.0.1' : c.host
}

/**
 * The console answers at its address as this Walnut (GET /api/v1/instance names its id; online the
 * leader answers it through the replica, away the replica itself): not just anything on the port.
 */
export async function consoleAnswers(c: HandedOverConsole): Promise<boolean> {
  const h = hostOf(c)
  try {
    const r = await fetch(`http://${h.includes(':') ? `[${h}]` : h}:${c.port}/api/v1/instance`, { signal: AbortSignal.timeout(3_000) })
    const j = await r.json() as { instance?: unknown }
    return j.instance === c.walnutId
  } catch {
    return false
  }
}

function servedLine(found: ConsoleOnPort): string {
  return `Walnut console listening on http://localhost:${found.console.port}: served by this machine's replica of ${found.console.to} (pid ${found.holder.pid}); this home handed the leader over (switch ${found.console.switchId})`
}

const holderKey = (f: ConsoleOnPort) => `${f.holder.pid}:${f.holder.since}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

export async function serveHandedOver(s: HandedOverStandby, o: {
  port: number
  host?: string
  env?: NodeJS.ProcessEnv
  /** Where later lines go (the port given up, taken back); stdout by default. */
  say?: (line: string) => void
  /** Tests: CONSOLE_ANSWER_WAIT_MS and CONSOLE_LOOK_MS. */
  answerWaitMs?: number
  lookMs?: number
  /**
   * What this standby holds of the machine's session runtime (web/standby-service.ts), for its
   * status: the runtime the server before it held in process (`held`), or none and why.
   */
  sessionRuntime?: () => unknown
}): Promise<StandbyListener> {
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
      leaderDoors: leader === s.leader ? s.leaderDoors : [],
      switchId: s.switchId,
      handedOver: s.marker,
      record,
      message: s.message,
      permit: { state: 'standby', mayAct: false, remainingMs: 0, record, why: s.why },
      ...(o.sessionRuntime ? { sessionRuntime: o.sessionRuntime() ?? null } : {}),
    }
  }
  const refusal = () => JSON.stringify({ error: s.message, code: 'handed_over', leader: s.leader, leaderDoors: s.leaderDoors, switchId: s.switchId })
  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  // This machine's witness door, when its server opens it (capability witness-door): a machine's witness stays
  // reachable after it handed the leader over. Its record is in the state dir (machine-id.ts witnessRoot), never in
  // the home; the door writes no log line. Off, nothing of it is loaded and its paths get the refusal below.
  const witnessDoor = (await import('../../capabilities.js')).hasCapability('witness-door')
    ? await (async () => {
      const [{ machineWitnessDoor, serveDoorHttp }, { witnessRoot }, { WITNESS_DOOR_PATH }] = await Promise.all([
        import('./witness-door.js'), import('./machine-id.js'), import('./witness-wire.js'),
      ])
      return { door: machineWitnessDoor({ root: witnessRoot(env) }), serve: serveDoorHttp, prefix: WITNESS_DOOR_PATH }
    })()
    : null
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0]
    if (witnessDoor && url.startsWith(`${witnessDoor.prefix}/`)
      && witnessDoor.serve(witnessDoor.door, url.slice(witnessDoor.prefix.length), req, res, req.socket.remoteAddress ?? 'unknown')) return
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
    // Any page a browser opens (a reload of the console's page once the standby has the port
    // back included) is the standby page; the API below stays JSON.
    const page = url === '/' || url === '/index.html' || (!url.startsWith('/api/') && /\btext\/html\b/.test(String(req.headers.accept ?? '')))
    if (req.method === 'GET' && page) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(standbyPage(s))
      return
    }
    if (req.method === 'GET' && (url === '/api/health' || url === '/api/config')) {
      json(res, 200, { standby: true, leader: s.leader, leaderDoors: s.leaderDoors, switchId: s.switchId, message: s.message })
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
  const file = standbyServerFile(s.home, env)
  const unlink = () => { try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file) } catch { /* gone */ } }
  let boundPort = o.port
  async function listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(o.port, o.host, () => { server.off('error', reject); resolve() })
    })
    const address = server.address()
    boundPort = typeof address === 'object' && address ? address.port : o.port
    // Where a later process reaches it: the bound address (a --bind to a Tailscale address listens
    // on nothing else), or loopback when it listens on every interface.
    const bound = typeof address === 'object' && address ? address.address : '127.0.0.1'
    const host = bound === '0.0.0.0' || bound === '::' || bound === '' ? '127.0.0.1' : bound
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, `${JSON.stringify({ pid: process.pid, port: boundPort, host, home: s.home, at: new Date().toISOString() })}\n`, { mode: 0o600 })
    // An exit that skips close() (an uncaught error, process.exit) takes its file along; a SIGKILL
    // leaves it, and side.ts asks the port before it believes it.
    process.once('exit', unlink)
  }
  async function release(): Promise<void> {
    unlink()
    process.off('exit', unlink)
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  const listeningLine = (why = '') => `Walnut standby listening on http://localhost:${boundPort}${why}`

  let state: 'serving' | 'yielded' = 'serving'
  // A holder that never answered as this Walnut while it could have (a pid used again, another program on the port).
  let distrusted: string | null = null
  let silentSince = 0
  let closed = false
  let endWith: (line: string) => void = () => {}
  const ended = new Promise<string>((resolve) => { endWith = resolve })
  const say = o.say ?? ((line: string) => console.log(line))

  // At the start this machine's replica may hold this port already (the app started `walnut web`
  // after it): stand by without the port, as long as it answers.
  let line = ''
  const first = await consoleOnPort(s.home, o.port)
  if (first) {
    // A replica that holds the port gets the whole answer wait; one that only waits for it (the
    // port is free) a few seconds, then this standby listens and gives the port up as usual.
    const answerWait = o.answerWaitMs ?? CONSOLE_ANSWER_WAIT_MS
    const deadline = Date.now() + (first.holder.state === 'waiting' ? Math.min(answerWait, CONSOLE_WAITING_START_MS) : answerWait)
    let now: ConsoleOnPort | null = first
    while (now && !(await consoleAnswers(now.console)) && Date.now() < deadline) {
      await sleep(500)
      now = await consoleOnPort(s.home, o.port)
    }
    if (now && await consoleAnswers(now.console)) { state = 'yielded'; line = servedLine(now) }
    else if (now && now.holder.state !== 'waiting') distrusted = holderKey(now)
  }
  if (state === 'serving') {
    try {
      await listen()
    } catch (err) {
      // The word the Mac app looks for to try its next port (desktop/main.swift), as server.ts says it.
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EADDRINUSE' || /in use/i.test(String(err))) throw new Error(`Port ${o.port} is in use by another program (EADDRINUSE): this standby cannot listen there`)
      throw err
    }
    line = listeningLine()
  }

  /**
   * A marked home that no longer stands for its switch (a rollback removed the marker, a switch back moved the
   * home aside), or one a switch now claims (promotion-wait.ts): this standby is done, whichever state it is in.
   */
  const superseded = async (): Promise<string | null> => {
    if (!s.marker || s.marker.torn) return null
    const m = readMarker(s.home)
    if (!m || m.switchId !== s.switchId) return `${s.home} no longer stands handed over by switch ${s.switchId}`
    const { readSwitchClaim } = await import('./ticket.js')
    const claim = readSwitchClaim(s.home, env)
    return claim ? `switch ${claim.switchId} is making ${s.home} the new leader's home` : null
  }
  /**
   * The same switch's marker, moved on since the boot (a standby the switch starts at the stop reads
   * `switching`; the commit then writes `handed-over` with the new leader's doors): every answer says it
   * from here on, as a standby booted now would.
   */
  const followMarker = () => {
    if (!s.marker || s.marker.torn) return
    const m = readMarker(s.home)
    if (!m || m.torn || m.switchId !== s.switchId || JSON.stringify(m) === JSON.stringify(s.marker)) return
    Object.assign(s, standbyOf({ home: s.home, env, marker: m, record: s.record, leader: m.to, why: markerRefusal(m) }))
  }
  async function step(): Promise<void> {
    const over = await superseded()
    followMarker()
    if (over) {
      closed = true
      clearInterval(look)
      if (state === 'serving') { state = 'yielded'; await release() }
      endWith(`Walnut standby: ${over}; this standby ends`)
      return
    }
    if (state === 'serving') {
      const found = await consoleOnPort(s.home, o.port)
      if (!found || holderKey(found) === distrusted || closed) return
      await release()
      state = 'yielded'
      silentSince = 0
      say(`${servedLine(found)}: this standby gave the port up and takes it back if the console ends`)
      return
    }
    // A switch back moved this home aside (or another switch took it): nothing to stand by for. The same
    // switch still at `switching` (its job died after the commit, before the hand-off wrote `handed-over`) is
    // still this standby's: it keeps its runtime for the resume. (A console stands only once the marker says
    // `handed-over`, so a standby yields after that only; the rule holds either way.)
    const m = readMarker(s.home)
    if (!m || (m.state !== 'handed-over' && m.state !== 'switching') || m.switchId !== s.switchId) {
      closed = true
      clearInterval(look)
      endWith(`Walnut standby: ${s.home} no longer stands handed over by switch ${s.switchId}; this standby ends`)
      return
    }
    const found = await consoleOnPort(s.home, o.port)
    if (found) {
      if (await consoleAnswers(found.console)) { silentSince = 0; return }
      silentSince ||= Date.now()
      if (Date.now() - silentSince < (o.answerWaitMs ?? CONSOLE_ANSWER_WAIT_MS)) return
      distrusted = holderKey(found)
    }
    // Nothing serves the console here any more: the port is the standby's again.
    const other = readStandbyServer(s.home, env)
    if (other && other.pid !== process.pid && await confirmStandby(other)) {
      closed = true
      clearInterval(look)
      endWith(`Walnut standby: another standby of this home (pid ${other.pid}) serves port ${other.port}; this one ends`)
      return
    }
    try {
      await listen()
    } catch {
      return // taken (the replica still holds it, or another program): looked at again in a second
    }
    if (closed) { await release(); return }
    state = 'serving'
    silentSince = 0
    say(listeningLine(': this machine\'s console replica no longer serves it'))
  }
  let looking = false
  const look = setInterval(() => {
    if (looking || closed) return
    looking = true
    void step().catch(() => {}).finally(() => { looking = false })
  }, o.lookMs ?? CONSOLE_LOOK_MS)
  look.unref?.()
  const close = async () => {
    if (closed && state === 'yielded') return
    closed = true
    clearInterval(look)
    if (state === 'serving') { state = 'yielded'; await release() }
  }
  return { server, close, line, ended }
}

/** Another process's standby of `home` that runs now (its pid file names it and its port confirms it), or null. */
export async function otherStandbyOf(home: string, env: NodeJS.ProcessEnv = process.env): Promise<StandbyServer | null> {
  const running = readStandbyServer(home, env)
  return running && running.pid !== process.pid && await confirmStandby(running) ? running : null
}

/**
 * A start of a home whose standby already runs in another process: a launcher's start beside the standby
 * the switch started at the stop (source-job.ts, so the machine's session runtime comes back at once), or the
 * other way round. It waits as a promotion wait does (no port, no file, nothing opened) and ends once that
 * standby is gone, so its launcher starts it again by the usual rules. Ending at once instead had a launcher
 * that restarts what it sees stop start it again every few seconds for as long as the other one ran.
 */
export function waitForOtherStandby(s: HandedOverStandby, running: StandbyServer, o: { env?: NodeJS.ProcessEnv; lookMs?: number; confirm?: (sb: StandbyServer) => Promise<boolean> } = {}): StandbyListener {
  const env = o.env ?? process.env
  let endWith: (line: string) => void = () => {}
  const ended = new Promise<string>((resolve) => { endWith = resolve })
  let closed = false
  let looks = 0
  let asking = false
  const end = () => {
    closed = true
    clearInterval(look)
    endWith(`Walnut: the standby of ${s.home} (pid ${running.pid}) is gone; this waiting process ends, so the next start boots by the usual rules`)
  }
  const look = setInterval(() => {
    if (closed || asking) return
    const now = readStandbyServer(s.home, env)
    if (!now || now.pid !== running.pid) { end(); return }
    // Every tenth look its port is asked too: a standby killed by SIGKILL leaves its pid file, and a pid used
    // again by another long-lived process would keep this one waiting for good.
    if (++looks % 10) return
    asking = true
    void (o.confirm ?? confirmStandby)(now).then((yes) => { asking = false; if (!yes && !closed) end() }, () => { asking = false })
  }, o.lookMs ?? 1_000)
  return {
    server: http.createServer(),
    line: `Walnut waits: a standby of this home already runs (pid ${running.pid}, port ${running.port}): ${s.message}. It takes no port and opens nothing until that standby ends`,
    ended,
    close: async () => { closed = true; clearInterval(look) },
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

/**
 * The page's own check, every 2 s: once this port no longer answers as the standby (this
 * machine's replica serves the console here now), it loads again. A poll that fails (the second
 * between the standby letting the port go and the replica taking it) is only tried again, where a
 * meta refresh that failed would never fire again.
 */
const STANDBY_PAGE_POLL = `setInterval(function(){fetch('/api/health',{cache:'no-store'}).then(function(r){if(r.status>=500)return;return r.json().catch(function(){return null}).then(function(j){if(!j||j.standby!==true)location.reload()})}).catch(function(){})},2000)`

/** The one page the standby serves: what happened, and where Walnut runs now. */
function standbyPage(s: HandedOverStandby): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Walnut: standby</title>
<noscript><meta http-equiv="refresh" content="15"></noscript>
<style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 1.5rem;color:#222}h1{font-size:1.3rem}code{font-size:.9em}</style>
</head><body>
<h1>This Walnut is on standby</h1>
<p>${escapeHtml(s.message.charAt(0).toUpperCase() + s.message.slice(1))}.</p>
<p>${s.leader ? `Open Walnut on <code>${escapeHtml(s.leader)}</code>, which leads now.` : 'Open Walnut on the machine that leads now.'} Nothing here changes while this machine waits: its data stays as it was handed over.</p>
${s.leaderDoors.length ? `<p>It is reached at ${s.leaderDoors.map((d) => `<code>${escapeHtml(d)}</code>`).join(', ')}.</p>` : ''}
<p>To make this machine lead again, run <code>walnut leader switch --back</code> on the machine that leads.</p>
<script>${STANDBY_PAGE_POLL}</script>
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
