/**
 * The isolated host's probe in the C5e real-machine run: what the host's one Walnut service imports
 * once its server answers (one-service-runner.ts WALNUT_TEST_SERVICE_AFTER, set by
 * scripts/real/host-launcher.sh). Read only, like tests/helpers/host-judge-cluster.ts's host probe
 * without its engine stand-ins (the sessions here run the real CLI):
 *
 *   GET /pid            this process
 *   GET /facts?after=&sid=  the fact log: id, head, floor, acked, the permit pair, and its records
 *                       (of one session with sid), each with its event class and a hash of its data
 *   GET /events?sid=    this service's bus events of a session since it started
 *   GET /row?sid=       the host's own row of a session
 *   GET /queue?sid=     the host's queue rows of a session
 *   GET /live           a leader linked and caught up
 *   GET /dialer         the door dialer linked, and whether a door credential is held (never its key)
 *
 * It listens on 127.0.0.1:C5E_HOST_PROBE_PORT (the run reads it through an ssh -L of its own, never
 * the Walnut link), and appends every bus event of a session to C5E_HOST_EVENTS as a JSON line.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'

const PORT = Number(process.env.C5E_HOST_PROBE_PORT)
const EVENTS = process.env.C5E_HOST_EVENTS ?? ''
const boot = await import('../../src/core/session-channel/host-boot.ts')
const tracker = await import('../../src/core/session-tracker.ts')
const queue = await import('../../src/core/session-message-queue.ts')
const credFile = await import('../../src/core/session-channel/host-credential-file.ts')
const { bus } = await import('../../src/core/event-bus.ts')
const { channelClassOf } = await import('../../src/core/session-channel/event-classes.ts')
const hashOf = (d: unknown): string => crypto.createHash('sha256').update(JSON.stringify(d ?? null) ?? 'null').digest('hex')

const recorded: Array<Record<string, unknown>> = []
bus.subscribe('c5e-host-recorder', (e: { name: string; data: any; timestamp: number; source: string; late?: boolean }) => {
  const d = e.data
  const sid = d && typeof d === 'object' ? (d.sessionId ?? d.claudeSessionId) : undefined
  if (typeof sid !== 'string' || !sid) return
  const text = JSON.stringify(d ?? null) ?? 'null'
  const rec: Record<string, unknown> = {
    name: e.name, cls: channelClassOf(e.name), sid, at: e.timestamp, seenAt: Date.now(), source: e.source, pid: process.pid,
    hash: crypto.createHash('sha256').update(text).digest('hex'), ...(text.length <= 2000 ? { data: d } : { chars: text.length }),
  }
  recorded.push(rec)
  if (recorded.length > 50_000) recorded.splice(0, 10_000)
  if (EVENTS) { try { fs.appendFileSync(EVENTS, JSON.stringify(rec) + '\n') } catch { /* the probe still has it */ } }
}, { global: true } as never)

const routes: Record<string, (q: URLSearchParams) => unknown> = {
  '/pid': () => ({ pid: process.pid, running: !!boot.hostSessionsRunning() }),
  '/facts': async (q) => {
    const h = boot.hostSessionsRunning()
    if (!h) return { running: false }
    const all = await h.log.read(Number(q.get('after') || 0))
    const sid = q.get('sid')
    // Each record with its class and the hash of its data (the leader recorder hashes the same text).
    const recs = (all as any[]).filter((r) => !sid || r.sid === sid).map((r) => ({ ...r, cls: channelClassOf(r.name), h: hashOf(r.data) }))
    return { running: true, logId: h.log.logId, head: h.log.head, floor: h.log.floor, acked: h.log.acked, permit: h.log.permit, permitPair: h.log.permitPair, recs }
  },
  '/events': (q) => recorded.filter((r) => r.sid === q.get('sid')),
  '/row': async (q) => ({ row: await tracker.getSessionByClaudeId(q.get('sid') ?? '') }),
  '/queue': async (q) => (await queue.getQueue(q.get('sid') ?? '')).map((m: any) => ({ id: m.id, status: m.status, parkedReason: m.parkedReason ?? null, message: m.message })),
  '/live': () => ({ live: !!boot.hostSessionsRunning()?.channel.leaderLive() }),
  '/dialer': async () => {
    const held = await credFile.readHostCredential(process.env.WALNUT_WALNUT_ID ?? '')
    return { linked: !!boot.hostSessionsRunning()?.dialer.linked(), holds: !!held, doors: held ? held.doors : [] }
  },
}
http.createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', 'http://probe')
  const fn = routes[u.pathname]
  let status = 200
  let body: unknown
  try { body = fn ? await fn(u.searchParams) : (status = 404, { error: 'no such probe' }) } catch (err) { status = 500; body = { error: String((err as Error)?.stack ?? err) } }
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body ?? null))
}).listen(PORT, '127.0.0.1').unref()
process.stderr.write(`c5e host probe: pid ${process.pid} on 127.0.0.1:${PORT}, sessions running: ${!!boot.hostSessionsRunning()}\n`)
