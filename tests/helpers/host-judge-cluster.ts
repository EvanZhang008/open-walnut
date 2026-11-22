/**
 * A replica cluster (replica-cluster.ts) whose leader and host both run with the switch on
 * (src/core/session-channel/switch.ts), so a session on the host is run and judged by the host's
 * own service (docs/plan/one-service-every-host.md, phase 2):
 *
 *   the Mac      config `experimental.host_runs_sessions: true` (a config value, not the variable, so a
 *                test can turn it off while the Mac runs), and a probe in its process
 *   the replica  its app's dist/cli.js boots it as `web --replica` with WALNUT_HOST_RUNS_SESSIONS=1
 *                and WALNUT_IN_PROCESS_DAEMON=1, then hands its runner the in-process runtime
 *                (setTestDaemonUrl), the seam tests/e2e/host-runs-sessions-e2e.test.ts uses until
 *                the one-service host does that itself; and a probe in its process
 *
 * The probes only read (and the host's door port is the leader door itself, for a send made on the
 * host while the Mac is away). Each listens on 127.0.0.1:0 and names its port in a file of the
 * cluster's own base: `<base>/mh/mac-probe.json`, `<replica data>/cluster-probe.json`.
 *
 *   Mac   GET /events?sid=   the bus events of a session this process saw: name, when, source,
 *                            late, and a hash of the data (its data too when small)
 *         GET /parses?sid=   how many CLI lines of it this process parsed (line-parse-count.ts)
 *         GET /judge?sid=    judgeOf and the judging host
 *         GET /side?host=    the leader side: on, linked to the host, judging its starts
 *         GET /cursor?host=  the channel cursor in the Mac's sessions store
 *   host  GET /facts?after=  the fact log: its id, head, floor, acked, permit and records
 *         GET /events?sid=   the host's own bus events of a session (as above)
 *         GET /live          is a leader linked and caught up
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { ROOT, startReplicaCluster, waitFor, type ReplicaCluster, type Twin } from './replica-cluster.js'

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
  recorded.push({ name: e.name, sid, at: e.timestamp, source: e.source, late: e.late === true, hash: crypto.createHash('sha256').update(text).digest('hex'), ...(text.length <= 4000 ? { data: d } : {}) })
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
const probeFile = (await import('node:path')).join((await import('node:path')).dirname(c.WALNUT_HOME), 'mac-probe.json')
${SERVE('probeFile')}
await serveProbe({
  '/events': (q) => eventsOf(q.get('sid')),
  '/parses': (q) => ({ parses: lpc.lineParsesOf(q.get('sid')) }),
  '/judge': (q) => ({ judge: jo.judgeOf(q.get('sid')), host: jo.judgingHostOf(q.get('sid')) }),
  '/side': (q) => { const s = lb.activeLeaderSide(); return { active: !!s, linked: !!s && s.linked(q.get('host')), judges: !!s && s.hostJudges(q.get('host')) } },
  '/cursor': (q) => ({ cursor: sdb.loadChannelCursor(q.get('host')) }),
})
`

/**
 * The replica's dist/cli.js: anything but `web --replica` runs this tree's CLI as before. The
 * replica boots with the switch and the in-process runtime on, then its runtime (its own streams
 * dir, spawn journal and no legacy streams dir: nothing outside its run dir; its sessions kept
 * across a restart, as a production runtime keeps them) and its probe.
 */
export function hostJudgeAppCli(): string {
  return `
const argv = process.argv.slice(2)
if (!(argv[0] === 'web' && argv.includes('--replica'))) {
  await import(${url('src/cli.ts')})
} else {
  process.env.WALNUT_HOST_RUNS_SESSIONS = '1'
  process.env.WALNUT_IN_PROCESS_DAEMON = '1'
  const { runWeb } = await import(${url('src/commands/web.ts')})
  await runWeb({ replica: true })
  const rt = process.env.WALNUT_DAEMON_DIR
  const ipd = await import(${url('src/providers/in-process-daemon.ts')})
  await ipd.startInProcessDaemon({ dir: rt, env: { ...process.env, WALNUT_STREAMS_DIR: rt + '/streams', WALNUT_LEGACY_STREAMS_DIR: rt + '/no-legacy', WALNUT_SPAWN_JOURNAL: rt + '/spawn-journal.jsonl', WALNUT_DAEMON_KEEP_SESSIONS: '1' } })
  const { sessionRunner } = await import(${url('src/providers/claude-code-session.ts')})
  sessionRunner.setTestDaemonUrl(ipd.IN_PROCESS_DAEMON_URL)
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
    '/live': () => ({ live: !!boot.hostSessionsRunning()?.channel.leaderLive() }),
  }, { door: doorPort, hasDoor: !!door, running: !!boot.hostSessionsRunning() })
}
`
}

export interface ProbeEvent { name: string; sid: string; at: number; source: string; late: boolean; hash: string; data?: any }
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

export interface HostJudgeCluster {
  c: ReplicaCluster
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

export async function startHostJudgeCluster(o: { twin: Twin }): Promise<HostJudgeCluster> {
  const c = await startReplicaCluster({
    twin: o.twin,
    appCli: hostJudgeAppCli(),
    macBootExtra: MAC_PROBE,
    macConfigExtra: ['experimental:', '  host_runs_sessions: true'],
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
  let host = await waitHostProbe(undefined, 180_000).catch(async (err) => { await c.stop().catch(() => {}); throw err })
  const ok = (r: { status: number; json: any }, p: string) => { if (r.status !== 200) throw new Error(`probe ${p}: ${r.status} ${JSON.stringify(r.json)}`); return r.json }
  return {
    c,
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
    stop: () => c.stop(),
  }
}
