/**
 * Real-machine acceptance of host-judged sessions (C5e): the leader ("the Mac" role) on one dev box,
 * linked to a real remote host whose one Walnut service runs from the same commit
 * (scripts/real/host-launcher.sh). Run by scripts/real/leader-run.sh inside the dev container.
 *
 * What this adds to a plain `startServer`, the same seams tests/helpers/replica-cluster.ts (macBoot)
 * uses for its local stand-in host, pointed at a real one:
 *   - the link: a direct daemon connection to C5E_LINK_URL, the leader end of an ssh -L tunnel to
 *     the host daemon's loopback door (scripts/real/c5e.py `link`), pooled as the host's link and
 *     redialled every second (a cut tunnel leaves it refused until it is back)
 *   - the host-server manager's scripts and configure calls run on the real host: a script goes
 *     through the host daemon's exec.run (the link-host path of runRemoteScript), and every path to
 *     this process's own bun in what is sent to that host names the host's bun instead
 *     (C5E_HOST_BUN), as an install would name its own program there
 *   - a probe (127.0.0.1:C5E_LEADER_PROBE_PORT, read only) and a recorder that appends every bus
 *     event of a session to C5E_LEADER_EVENTS (JSON lines, kept across leader restarts)
 *
 * MACHINE SAFETY: the leader's own temp dirs only (its env names them); nothing here signals a
 * process. The host key names no resolvable host (`hosts.<key>.hostname` is `.invalid`), and the
 * `ssh` on this leader's PATH refuses, so no other path reaches the real host.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'

const need = (k: string): string => {
  const v = process.env[k]
  if (!v) { process.stderr.write(`leader-boot: ${k} is not set\n`); process.exit(2) }
  return v
}
const DATA = need('OPEN_WALNUT_HOME')
const HOST_KEY = need('C5E_HOST_KEY')
const LINK_URL = need('C5E_LINK_URL')
const HOST_BUN = need('C5E_HOST_BUN')
const EVENTS = need('C5E_LEADER_EVENTS')
const PORT = Number(need('C5E_LEADER_PORT'))
const PROBE_PORT = Number(need('C5E_LEADER_PROBE_PORT'))

const c = await import('../../src/constants.ts')
if (c.WALNUT_HOME !== DATA || c.CLOUD_MODE) { process.stderr.write(`REFUSING: wrong home ${c.WALNUT_HOME}\n`); process.exit(3) }

const dcm = await import('../../src/providers/daemon-connection.ts')
const OWN_RUNTIME = process.execPath
const forHost = (s: string): string => s.split(OWN_RUNTIME).join(HOST_BUN)

// Scripts meant for the host run there, through its daemon (exec.run), as on a link host.
const originalRun = dcm.DaemonConnection.prototype.runRemoteScript
dcm.DaemonConnection.prototype.runRemoteScript = async function (this: InstanceType<typeof dcm.DaemonConnection>, script: string, timeoutMs = 30_000) {
  if (this.hostKey !== HOST_KEY) return originalRun.call(this, script, timeoutMs)
  const { createNetUpdateIo } = await import('../../src/providers/daemon-net-update-io.ts')
  return createNetUpdateIo(this as never).run(forHost(script), timeoutMs)
}
// Every command sent to that host: this process's bun is the host's bun there.
const originalSend = dcm.DaemonConnection.prototype.send
dcm.DaemonConnection.prototype.send = function (this: InstanceType<typeof dcm.DaemonConnection>, cmd: string, params?: Record<string, unknown>, ...rest: unknown[]) {
  if (this.hostKey === HOST_KEY && params) {
    const text = JSON.stringify(params)
    if (text.includes(OWN_RUNTIME)) params = JSON.parse(forHost(text)) as Record<string, unknown>
  }
  return (originalSend as (...a: unknown[]) => unknown).call(this, cmd, params, ...rest)
} as typeof originalSend

// The recorder: every bus event of a session, one JSON line each (data kept when small).
const { bus } = await import('../../src/core/event-bus.ts')
const { channelClassOf } = await import('../../src/core/session-channel/event-classes.ts')
const recorded: Array<Record<string, unknown>> = []
bus.subscribe('c5e-leader-recorder', (e: { name: string; data: any; timestamp: number; source: string; late?: boolean }) => {
  const d = e.data
  const sid = d && typeof d === 'object' ? (d.sessionId ?? d.claudeSessionId) : undefined
  if (typeof sid !== 'string' || !sid) return
  const text = JSON.stringify(d ?? null) ?? 'null'
  const rec: Record<string, unknown> = {
    name: e.name, cls: channelClassOf(e.name), sid, at: e.timestamp, seenAt: Date.now(), source: e.source, late: e.late === true, pid: process.pid,
    hash: crypto.createHash('sha256').update(text).digest('hex'), ...(text.length <= 2000 ? { data: d } : { chars: text.length }),
  }
  recorded.push(rec)
  if (recorded.length > 50_000) recorded.splice(0, 10_000)
  try { fs.appendFileSync(EVENTS, JSON.stringify(rec) + '\n') } catch { /* the probe still has it */ }
}, { global: true } as never)

const { startServer, stopServer, armGracefulSignalExit } = await import('../../src/web/server.ts')
const server = await startServer({ port: PORT, dev: true })

// The link: the host daemon's door at the tunnel's leader end, as an ssh link is pooled.
let directConn: InstanceType<typeof dcm.DaemonConnection> | null = null
const direct = async () => {
  const conn = await dcm.getDirectDaemonConnection(HOST_KEY, LINK_URL)
  if (directConn && directConn !== conn) directConn.disconnect()
  directConn = conn
  dcm.setPooledConnectionForTest(HOST_KEY, conn)
  return conn
}
await direct().catch((err: Error) => process.stderr.write(`leader-boot: first dial failed: ${err.message}\n`))
setInterval(() => { void direct().catch(() => {}) }, 1000).unref()

// The probe (read only).
const lpc = await import('../../src/providers/line-parse-count.ts')
const jo = await import('../../src/core/sessions/judge-of.ts')
const lb = await import('../../src/core/session-channel/leader-boot.ts')
const sdb = await import('../../src/core/session-db.ts')
const hs = await import('../../src/core/host-server/index.ts')
const routes: Record<string, (q: URLSearchParams) => unknown> = {
  '/pid': () => ({ pid: process.pid }),
  '/events': (q) => recorded.filter((r) => r.sid === q.get('sid')),
  '/parses': (q) => ({ parses: lpc.lineParsesOf(q.get('sid') ?? '') }),
  '/frames': () => lpc.frameParses(),
  '/judge': (q) => ({ judge: jo.judgeOf(q.get('sid') ?? ''), host: jo.judgingHostOf(q.get('sid') ?? '') }),
  '/side': (q) => { const s = lb.activeLeaderSide(); const h = q.get('host') ?? ''; return { active: !!s, linked: !!s && s.linked(h), kind: s ? s.linkKind(h) : null, judges: !!s && s.hostJudges(h) } },
  '/link': (q) => ({ connected: hs.hostServerLink(q.get('host') ?? '') !== null, direct: !!directConn?.connected }),
  '/cursor': (q) => ({ cursor: sdb.loadChannelCursor(q.get('host') ?? '') }),
}
http.createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', 'http://probe')
  const fn = routes[u.pathname]
  let status = 200
  let body: unknown
  try { body = fn ? await fn(u.searchParams) : (status = 404, { error: 'no such probe' }) } catch (err) { status = 500; body = { error: String((err as Error)?.stack ?? err) } }
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body ?? null))
}).listen(PROBE_PORT, '127.0.0.1').unref()

const addr = server.address()
process.stdout.write(JSON.stringify({ c5eLeader: true, pid: process.pid, port: typeof addr === 'object' && addr ? addr.port : addr, probe: PROBE_PORT, at: Date.now() }) + '\n')
let closing = false
const close = async () => { if (closing) return; closing = true; try { await stopServer() } catch { /* stopping anyway */ } process.exit(0) }
process.on('SIGTERM', close)
process.on('SIGINT', close)
armGracefulSignalExit()
