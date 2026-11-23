/**
 * A replica cluster (replica-cluster.ts) whose leader and host both run with the switch on
 * (src/core/session-channel/switch.ts), so a session on the host is run and judged by the host's
 * own service (docs/plan/one-service-every-host.md, phase 2):
 *
 *   the Mac      config `experimental.host_runs_sessions: true` (a config value, not the variable, so a
 *                test can turn it off while the Mac runs), and a probe in its process
 *   the host     a launcher's host (replica-cluster.ts hostService) switched to its one Walnut
 *                service, as `walnut daemon update --serve` switches it: the follower server and the
 *                daemon runtime in one process, started by the real entry (src/binary/service-entry.ts)
 *                with the host's switch on (WALNUT_HOST_RUNS_SESSIONS=1). Its session runner reaches
 *                the runtime through the own-sessions link, the production path; and a probe in its
 *                process (the module the entry imports once its server answers)
 *
 * The probes only read, but for the Mac's /delete (and the host's door port is the leader door
 * itself, for a send made on the host while the Mac is away).
 *
 * The host's ACP engines run the scripted adapter (tests/providers/mock-acp-agent.mjs) through an
 * ACP worker built from this checkout (acp-worker-bundle.ts): the setTestAcpArtifacts seam, as the
 * server's ACP e2e tests use it (no scripted adapter exists outside a test). Codex runs on its direct
 * app-server path against tests/providers/mock-codex-app-server.mjs (CODEX_PATH in the launcher's
 * env, which the runtime reads at its start). Each probe listens on 127.0.0.1:0 and names its port
 * in a file of the cluster's own base: `<base>/mh/mac-probe.json`, `<replica data>/cluster-probe.json`.
 *
 *   Mac   GET /events?sid=   the bus events of a session this process saw: name, when, source,
 *                            late, and a hash of the data (its data too when small)
 *         GET /delete?sid=   deletes the Mac's row of a session (deleteSessionRecords), as a
 *                            retention sweep does: the one probe that writes
 *         GET /drops?host=   the deletes of the host's sessions it has not answered yet
 *         GET /acp?sid=      what the Mac's runner answers for an ACP session (findAcpSession)
 *         GET /parses?sid=   how many CLI lines of it this process parsed (line-parse-count.ts)
 *         GET /judge?sid=    judgeOf and the judging host
 *         GET /side?host=    the leader side: on, linked to the host (and which side dialed), judging its starts
 *         GET /link?host=    is the Mac's daemon link to the host up (the host-server manager's link)
 *         GET /cursor?host=  the channel cursor in the Mac's sessions store
 *   host  GET /facts?after=  the fact log: its id, head, floor, acked, permit and records
 *         GET /row?sid=      the host's own row of a session (null: none)
 *         GET /events?sid=   the host's own bus events of a session (as above)
 *         GET /queue?sid=    the host's queue rows of a session (id, status, parkedReason, message)
 *         GET /live          is a leader linked and caught up
 *         GET /dialer        is the host's door dialer linked, and does it hold a door credential (never its token)
 *         GET /companion     is the host's link to its companion's listener door up
 *
 * `companion`: a real cloud companion too (tests/helpers/cloud-box-replica.ts), paired with the Mac
 * before the Mac boots, as a first bridge push leaves a pairing: the Mac's `cloud` remote and its
 * cached machine tokens for its own daemon and for the host. The Mac then configures both daemons'
 * bridges itself (the host's in the runtime its service holds), the Mac's heartbeat names its
 * Walnut and its switch to the companion every second (the takeover window is WINDOWS.takeoverMs),
 * and the host's service dials the companion's listener door with its bridge token. `phone(...)`
 * calls the companion's phone API with the paired phone's token; `phoneStream(sid)` holds a
 * session's SSE stream open and collects its frames.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { ROOT, WINDOWS, startReplicaCluster, waitFor, type ReplicaCluster } from './replica-cluster.js'
import { seedPrimaryPairing, startCloudBoxReplica, type CloudBoxReplica } from './cloud-box-replica.js'

const url = (f: string) => JSON.stringify('file://' + path.join(ROOT, f))

/** The bus recorder both probes run: one global subscriber, a bounded list. */
const RECORDER = `
const crypto = await import('node:crypto')
const busMod = await import(${url('src/core/event-bus.ts')})
const recorded = []
busMod.bus.subscribe('cluster-probe-recorder', (e) => {
  const d = e.data
  const sid = d && typeof d === 'object' ? (d.sessionId ?? d.claudeSessionId) : undefined
  if (typeof sid !== 'string' || !sid) return
  const text = JSON.stringify(d ?? null) ?? 'null'
  recorded.push({ name: e.name, sid, at: e.timestamp, seenAt: Date.now(), source: e.source, late: e.late === true, hash: crypto.createHash('sha256').update(text).digest('hex'), ...(text.length <= 4000 ? { data: d } : {}) })
  if (recorded.length > 50000) recorded.splice(0, 10000)
}, { global: true })
const eventsOf = (sid) => recorded.filter((r) => r.sid === sid)
`

/** A loopback JSON server for a probe: `routes[path](query)`; its port is written to `file`. */
const SERVE = (file: string) => `
const httpMod = await import('node:http')
const fsMod = await import('node:fs')
const serveProbe = (routes, extra) => new Promise((resolve) => {
  const srv = httpMod.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://probe')
    const fn = routes[u.pathname]
    let status = 200
    let body
    try { body = fn ? await fn(u.searchParams) : (status = 404, { error: 'no such probe' }) } catch (err) { status = 500; body = { error: String(err && err.stack || err) } }
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body ?? null))
  })
  srv.listen(0, '127.0.0.1', () => {
    const tmp = ${file} + '.' + process.pid + '.tmp'
    fsMod.writeFileSync(tmp, JSON.stringify({ pid: process.pid, probe: srv.address().port, ...(extra ?? {}) }))
    fsMod.renameSync(tmp, ${file})
    resolve(srv)
  })
  srv.unref()
})
`

/** The Mac's probe, run in its boot script (replica-cluster.ts macBoot `extra`; `c` is its constants module). */
export const MAC_PROBE = `
${RECORDER}
const lpc = await import(${url('src/providers/line-parse-count.ts')})
const jo = await import(${url('src/core/sessions/judge-of.ts')})
const lb = await import(${url('src/core/session-channel/leader-boot.ts')})
const sdb = await import(${url('src/core/session-db.ts')})
const trk = await import(${url('src/core/session-tracker.ts')})
const drp = await import(${url('src/core/session-channel/leader-drops.ts')})
const ccs = await import(${url('src/providers/claude-code-session.ts')})
const probeFile = (await import('node:path')).join((await import('node:path')).dirname(c.WALNUT_HOME), 'mac-probe.json')
${SERVE('probeFile')}
await serveProbe({
  '/events': (q) => eventsOf(q.get('sid')),
  '/parses': (q) => ({ parses: lpc.lineParsesOf(q.get('sid')) }),
  '/judge': (q) => ({ judge: jo.judgeOf(q.get('sid')), host: jo.judgingHostOf(q.get('sid')) }),
  '/side': (q) => { const s = lb.activeLeaderSide(); return { active: !!s, linked: !!s && s.linked(q.get('host')), kind: s ? s.linkKind(q.get('host')) : null, judges: !!s && s.hostJudges(q.get('host')) } },
  '/link': async (q) => ({ connected: (await import(${url('src/core/host-server/index.ts')})).hostServerLink(q.get('host')) !== null }),
  '/cursor': (q) => ({ cursor: sdb.loadChannelCursor(q.get('host')) }),
  '/delete': async (q) => ({ removed: await trk.deleteSessionRecords(new Set([q.get('sid')]), 'cluster-probe') }),
  '/drops': (q) => ({ sids: drp.leaderDropsOf(q.get('host')) }),
  '/acp': (q) => {
    const a = ccs.sessionRunner.findAcpSession(q.get('sid'))
    return { found: !!a, hostJudged: a?.hostJudged === true, kind: a?.kind ?? null, processStatus: a?.processStatus ?? null, workerLive: a?.workerLive ?? null, engineId: a?.engineId ?? null }
  },
})
`

/**
 * What the host's service imports once its server answers (replica-cluster.ts hostService `after`):
 * the ACP stand-in, a loopback port for the leader door, the bus recorder and the probe.
 */
export function hostJudgeServiceProbe(): string {
  return `
const { sessionRunner } = await import(${url('src/providers/claude-code-session.ts')})
const { acpWorkerBundle } = await import(${url('tests/helpers/acp-worker-bundle.ts')})
sessionRunner.setTestAcpArtifacts({ workerCmd: [process.execPath, acpWorkerBundle()], adapterCmd: [process.execPath, ${JSON.stringify(path.join(ROOT, 'tests/providers/mock-acp-agent.mjs'))}] })
;(await import('node:fs')).mkdirSync(process.env.CODEX_HOME, { recursive: true })
const { getHostReplicaLeaderDoor } = await import(${url('src/web/server.ts')})
const door = getHostReplicaLeaderDoor()
const boot = await import(${url('src/core/session-channel/host-boot.ts')})
${RECORDER}
const net = await import('node:net')
const doorPort = await new Promise((resolve) => {
  const s = net.createServer((sock) => door && door.accept(sock))
  s.listen(0, '127.0.0.1', () => resolve(s.address().port))
  s.unref()
})
const probeFile = process.env.OPEN_WALNUT_HOME + '/cluster-probe.json'
${SERVE('probeFile')}
await serveProbe({
  '/facts': async (q) => {
    const h = boot.hostSessionsRunning()
    if (!h) return { running: false }
    const recs = await h.log.read(Number(q.get('after') || 0))
    return { running: true, logId: h.log.logId, head: h.log.head, floor: h.log.floor, acked: h.log.acked, permit: h.log.permit, recs }
  },
  '/events': (q) => eventsOf(q.get('sid')),
  '/row': async (q) => ({ row: await (await import(${url('src/core/session-tracker.ts')})).getSessionByClaudeId(q.get('sid')) }),
  '/live': () => ({ live: !!boot.hostSessionsRunning()?.channel.leaderLive() }),
  '/dialer': async () => {
    const cf = await import(${url('src/core/session-channel/host-credential-file.ts')})
    const held = await cf.readHostCredential(process.env.WALNUT_WALNUT_ID ?? '')
    return { linked: !!boot.hostSessionsRunning()?.dialer.linked(), holds: !!held, doors: held ? held.doors : [] }
  },
  '/companion': () => ({ linked: !!boot.hostSessionsRunning()?.companion.linked() }),
  '/queue': async (q) => (await (await import(${url('src/core/session-message-queue.ts')})).getQueue(q.get('sid'))).map((m) => ({ id: m.id, status: m.status, parkedReason: m.parkedReason ?? null, message: m.message })),
}, { door: doorPort, hasDoor: !!door, running: !!boot.hostSessionsRunning() })
`
}

/** The launcher's env for the host: its switch on, and Codex on its direct app-server path against the scripted one. */
function hostJudgeServiceEnv(d: { hostDaemon: string }): Record<string, string> {
  return {
    WALNUT_HOST_RUNS_SESSIONS: '1',
    WALNUT_CODEX_TRANSPORT: 'app-server',
    CODEX_PATH: path.join(ROOT, 'tests/providers/mock-codex-app-server.mjs'),
    CODEX_HOME: path.join(d.hostDaemon, 'codex-home'),
    ...(process.env.REPLICA_CLUSTER_LOG_DIR ? { MOCK_CODEX_LOG: path.join(process.env.REPLICA_CLUSTER_LOG_DIR, 'codex-requests.jsonl') } : {}),
  }
}

/** `at`: the event's timestamp (a late host fact keeps when it happened); `seenAt`: when this process's bus delivered it. */
export interface ProbeEvent { name: string; sid: string; at: number; seenAt: number; source: string; late: boolean; hash: string; data?: any }
export interface HostFactRecord { seq: number; opId: string; at: number; sid: string; sseq: number; name: string; data: any; refs?: Record<string, unknown> }

function getJson(port: number, p: string, method = 'GET', body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = http.request({ host: '127.0.0.1', port, method, path: p, agent: false, timeout: 30_000, headers: data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {} }, (res) => {
      const parts: Buffer[] = []
      res.on('data', (x: Buffer) => parts.push(x))
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8')
        let json: any
        try { json = JSON.parse(text) } catch { json = { text } }
        resolve({ status: res.statusCode ?? 0, json })
      })
    })
    req.on('timeout', () => req.destroy(new Error(`${method} ${p} timed out`)))
    req.on('error', reject)
    req.end(data ?? undefined)
  })
}

/** One SSE stream held open: its frames so far, and its close. */
export interface PhoneStream { frames: Array<{ event: string; data: any }>; close(): void }

export interface HostJudgeCluster {
  c: ReplicaCluster
  /** `companion` only: the companion and the phone's calls to it. */
  companion: CloudBoxReplica | null
  phone(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }>
  phoneStream(sid: string): Promise<PhoneStream>
  /** A read of the Mac's probe. */
  mac(p: string): Promise<any>
  /** A read of the replica's probe (the replica that runs now). */
  host(p: string): Promise<any>
  /** A request to the replica's leader door itself (its /host-api routes), as the daemon relays the Mac's streams to it. */
  door(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }>
  /** The replica's probe file again (after a restart: a new pid and ports). */
  waitHostProbe(notPid?: number, timeoutMs?: number): Promise<{ pid: number; probe: number; door: number; running: boolean; hasDoor: boolean }>
  stop(): Promise<void>
}

/**
 * A companion for the cluster, paired with the Mac data dir before it boots (see the header).
 * `backupLeader: false` in the Mac's config keeps the companion from taking the hosts' daemons'
 * lead while the Mac sleeps, so only the listener path is in play.
 */
async function pairCompanion(base: string, macData: string): Promise<CloudBoxReplica> {
  const box = await startCloudBoxReplica(path.join(base, 'cb'), undefined, {
    machineOwner: 'mac-primary',
    env: { WALNUT_LEADER_TAKEOVER_MS: String(WINDOWS.takeoverMs), WALNUT_LEADER_TICK_MS: '500' },
  })
  await seedPrimaryPairing(macData, `127.0.0.1:${box.port}`, box.tokens)
  fs.writeFileSync(path.join(macData, 'sync', 'bridge-tokens.json'), JSON.stringify({ 'bridge-local': box.tokens.primaryMachine, 'bridge-devbox': box.tokens.otherMachine }), { mode: 0o600 })
  return box
}

/** An SSE response read as frames (`event:` / `data:` pairs). */
function readSse(res: http.IncomingMessage, frames: PhoneStream['frames']): void {
  let buf = ''
  res.on('data', (b: Buffer) => {
    buf += b.toString('utf8')
    let at
    while ((at = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, at); buf = buf.slice(at + 2)
      const ev = /^event: (.+)$/m.exec(block)?.[1]
      const data = /^data: (.*)$/m.exec(block)?.[1]
      if (ev) { try { frames.push({ event: ev, data: data ? JSON.parse(data) : null }) } catch { frames.push({ event: ev, data }) } }
    }
  })
}

/**
 * `linkProxy`: the Mac's daemon link to the host runs through a proxy the test can cut (replica-cluster.ts cutLink).
 * `companion`: a real cloud companion paired with the Mac (see the header).
 */
export async function startHostJudgeCluster(o: { linkProxy?: boolean; companion?: boolean } = {}): Promise<HostJudgeCluster> {
  let companion: CloudBoxReplica | null = null
  const c = await startReplicaCluster({
    twin: 'standalone',
    ...(o.linkProxy ? { linkProxy: true } : {}),
    hostService: { env: hostJudgeServiceEnv, after: hostJudgeServiceProbe() },
    macBootExtra: MAC_PROBE,
    macConfigExtra: ['experimental:', '  host_runs_sessions: true', ...(o.companion ? ['cloud_bridge:', '  backup_leader: false'] : [])],
    ...(o.companion ? {
      macEnv: { WALNUT_LEADER_HEARTBEAT_MS: '1000' },
      seedMac: async ({ base, macData }: { base: string; macData: string }) => { companion = await pairCompanion(base, macData) },
    } : {}),
  }).catch(async (err) => { await (companion as CloudBoxReplica | null)?.stop().catch(() => {}); throw err })
  const box = companion as CloudBoxReplica | null
  const phone: HostJudgeCluster['phone'] = async (method, p, body) => {
    if (!box) throw new Error('host-judge-cluster: phone() needs the companion option')
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
      const req = http.request({ host: '127.0.0.1', port: box.port, method, path: p, agent: false, timeout: 60_000, headers: { authorization: `Bearer ${box.tokens.phone}`, ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}) } }, (res) => {
        const parts: Buffer[] = []
        res.on('data', (x: Buffer) => parts.push(x))
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8')
          let json: any
          try { json = JSON.parse(text) } catch { json = { text } }
          resolve({ status: res.statusCode ?? 0, json })
        })
      })
      req.on('timeout', () => req.destroy(new Error(`${method} ${p} timed out`)))
      req.on('error', reject)
      req.end(data ?? undefined)
    })
  }
  const phoneStream: HostJudgeCluster['phoneStream'] = (sid) => new Promise((resolve, reject) => {
    if (!box) { reject(new Error('host-judge-cluster: phoneStream() needs the companion option')); return }
    const frames: PhoneStream['frames'] = []
    const req = http.get({ host: '127.0.0.1', port: box.port, path: `/api/v1/sessions/${sid}/stream`, agent: false, headers: { authorization: `Bearer ${box.tokens.phone}`, accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`stream ${sid}: ${res.statusCode}`)); res.resume(); return }
      readSse(res, frames)
      resolve({ frames, close: () => req.destroy() })
    })
    req.on('error', (err) => { if (!frames.length) reject(err) })
  })
  const macProbeFile = path.join(path.dirname(c.macData), 'mac-probe.json')
  const hostProbeFile = () => path.join(c.replicaData, 'cluster-probe.json')
  const readFile = (f: string): any => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
  const macPort = (): number => {
    const m = readFile(macProbeFile)
    if (!m?.probe) throw new Error(`no Mac probe at ${macProbeFile}`)
    return m.probe as number
  }
  const waitHostProbe: HostJudgeCluster['waitHostProbe'] = async (notPid, timeoutMs = 120_000) =>
    waitFor(() => { const h = readFile(hostProbeFile()); return h && h.probe && h.pid !== notPid ? h : null }, timeoutMs, 'the replica\'s probe')
  let host = await waitHostProbe(undefined, 180_000).catch(async (err) => { await c.stop().catch(() => {}); await box?.stop().catch(() => {}); throw err })
  const ok = (r: { status: number; json: any }, p: string) => { if (r.status !== 200) throw new Error(`probe ${p}: ${r.status} ${JSON.stringify(r.json)}`); return r.json }
  return {
    c,
    companion: box,
    phone,
    phoneStream,
    mac: async (p) => ok(await getJson(macPort(), p), p),
    host: async (p) => {
      const now = readFile(hostProbeFile())
      if (now?.probe) host = now
      return ok(await getJson(host.probe, p), p)
    },
    door: async (method, p, body) => {
      const now = readFile(hostProbeFile())
      if (now?.door) host = now
      return getJson(host.door, p, method, body)
    },
    waitHostProbe: async (notPid, timeoutMs) => { host = await waitHostProbe(notPid, timeoutMs); return host },
    stop: async () => { try { await c.stop() } finally { await box?.stop() } },
  }
}
