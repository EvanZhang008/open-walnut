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
 * The probes only read, but for the Mac's /delete, /legacy and /hand and the host's /slow-start, /hold-sid
 * and /forge (and the host's door port is the leader door itself, for a send made on the host while
 * the Mac is away).
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
 *         GET /row?sid=      the Mac's row of a session (null: none)
 *         GET /legacy?sid=   makes a row of the Mac's own (a legacy session) under that id: a probe write
 *         GET /hands         the starts the Mac handed its hosts, still standing (handed-sessions.ts)
 *         GET /hand?host=&sid=   hands `sid` to `host` (handStart) with no start: a probe write, for a host's forged row to meet
 *         GET /hold-copy?kind=&on=1|0   while on, a store write of that copy kind brings no round (the host's
 *                            copy of it lags its write; the sweep and copyKindNow still send it)
 *         GET /acp?sid=      what the Mac's runner answers for an ACP session (findAcpSession)
 *         GET /parses?sid=   how many CLI lines of it this process parsed (line-parse-count.ts)
 *         GET /frames        how many daemon frames and session-channel frames this process parsed
 *         GET /counts?sid=   its bus events here by `name|source`, counted, and `name|chars`: a delta's text length summed
 *         GET /loop?reset=   this process's event-loop delay since the last reset (max, p99, p50, mean ms)
 *         GET /profile?start=1, then ?to=<file>   a CPU profile of this process between the two (node:inspector)
 *         GET /judge?sid=    judgeOf and the judging host
 *         GET /read?sid=&what=full|tail|plan|body[&legacy=1]   a transcript read of the session as
 *                            its readers make it (the whole history, its tail, its plan, its search
 *                            body); `legacy=1` reads it here, as before its host answered reads
 *         GET /holds?sid=    does the Mac's runner hold a live process of it (holdsLiveSession)
 *         GET /lose-answer?mode=taken|dropped   the Mac's next start or resume to a host gets no
 *                            answer: `taken`, the host gets it and its answer is lost; `dropped`, it
 *                            never reaches the host (and is no "not sent" either): the one seam of a
 *                            hand-over whose outcome is unknown here
 *         GET /handover?sid= is a hand-over of it unanswered here (host-handover.ts), and its mark on disk
 *         GET /side?host=    the leader side: on, linked to the host (and which side dialed), judging its starts,
 *                            and the host key whose service a start on it goes to (startKeyOf)
 *         GET /link?host=    is the Mac's daemon link to the host up (the host-server manager's link)
 *         GET /cursor?host=  the channel cursor in the Mac's sessions store
 *         GET /daemon-link?host=  is the Mac's pooled daemon connection to the host up (what a command would ride)
 *         GET /session-cmds?sid=  the session-process commands this process aimed at a daemon for it
 *                            (sessions/session-command-gate.ts), and every refusal by command
 *         GET /scans?sid=&host=  this process's own scans of it, each the real function: its liveness
 *                            (isSessionProcessAlive), a health monitor check, a capacity check that
 *                            must evict one idle session of the host, the orphan candidates and sweep
 *   host  GET /facts?after=  the fact log: its id, head, floor, acked, permit (its pair too) and records
 *         GET /row?sid=      the host's own row of a session (null: none)
 *         GET /task?id=      the phase of the host's own copy of a task (null: none)
 *         GET /events?sid=   the host's own bus events of a session (as above)
 *         GET /queue?sid=    the host's queue rows of a session (id, status, parkedReason, message)
 *         GET /live          is a leader linked and caught up
 *         GET /dialer        is the host's door dialer linked, and does it hold a door credential (never its token)
 *         GET /companion     is the host's link to its companion's listener door up
 *         GET /judging?sid=  does the host stand down (its leader older, old-leader-watch.ts), its read of
 *                            the leader's presence, is a leader on its channel, and does it judge `sid`
 *         GET /slow-start?ms= the host's next start answers its leader `ms` late, its session up
 *                            and its born row written (a loaded host's order): a probe write
 *         GET /hold-sid?sid=&on=1|0   the host's runner says it holds a live session of `sid` (a
 *                            resume of it is refused there, not at rest) until `on=0`
 *         GET /forge?sid=    appends a born row of `sid` to the host's fact log, as a bad host
 *                            would send one for a session it was never handed: a probe write
 *
 * `companion`: a real cloud companion too (tests/helpers/cloud-box-replica.ts), paired with the Mac
 * before the Mac boots, as a first bridge push leaves a pairing: the Mac's `cloud` remote and its
 * cached machine tokens for its own daemon and for the host. The Mac then configures both daemons'
 * bridges itself (the host's in the runtime its service holds), the Mac's heartbeat names its
 * Walnut and its switch to the companion every second (the takeover window is WINDOWS.takeoverMs),
 * and the host's service dials the companion's listener door with its bridge token. `phone(...)`
 * calls the companion's phone API with the paired phone's token; `phoneStream(sid)` holds a
 * session's SSE stream open and collects its frames.
 *
 * `standby(...)`: a second leader of the same Walnut over a copy of the Mac's data
 * (tests/helpers/standby-leader.ts) with the Mac's probe, read by its `probe(p)`. The probe takes
 * WALNUT_CLUSTER_PERMIT_NUMBER (the Mac's `macEnv`, the standby's `env`): the permit number that
 * leader tells its hosts, as the leader switch's permit system numbers two leaders of one Walnut.
 * The other options (HostJudgeClusterOptions) mix versions and shorten windows: a host whose switch
 * is forced off is one from before it (it names no session-judge-v1), a Mac with
 * WALNUT_LEADER_SESSION_CHANNELS=0 a leader from before the channel.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { HOST_KEY, ROOT, WINDOWS, startReplicaCluster, waitFor, type ReplicaCluster } from './replica-cluster.js'
import { seedPrimaryPairing, startCloudBoxReplica, type CloudBoxReplica } from './cloud-box-replica.js'
import { startStandbyLeader, type StandbyLeader } from './standby-leader.js'
import { channelClassOf } from '../../src/core/session-channel/event-classes.js'

const url = (f: string) => JSON.stringify('file://' + path.join(ROOT, f))

/**
 * The bus recorder both probes run: one global subscriber, a bounded list, and a count of each
 * session's events by name and source. `count`: the counts only (no copy, no hash of any event),
 * for a bench that measures the process it runs in (scripts/bench-host-judged-sessions.mts).
 */
const recorder = (mode: 'full' | 'count' = 'full') => `
const crypto = await import('node:crypto')
const busMod = await import(${url('src/core/event-bus.ts')})
const recorded = []
const counted = new Map()
busMod.bus.subscribe('cluster-probe-recorder', (e) => {
  const d = e.data
  const sid = d && typeof d === 'object' ? (d.sessionId ?? d.claudeSessionId) : undefined
  if (typeof sid !== 'string' || !sid) return
  const per = counted.get(sid) ?? {}
  const key = e.name + '|' + e.source
  per[key] = (per[key] ?? 0) + 1
  // A delta's text, summed (a host merges deltas: the count of events changes, the text does not).
  if (typeof d.delta === 'string') per[e.name + '|chars'] = (per[e.name + '|chars'] ?? 0) + d.delta.length
  counted.set(sid, per)
  if (${JSON.stringify(mode)} === 'count') return
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

/** The Mac's probe, run in its boot script (replica-cluster.ts macBoot `extra`; `c` is its constants module); a leader booted again over the Mac's data takes it too (scripts/release-rehearsal/host-judged-leaders.mjs). */
export const macProbe = (record: 'full' | 'count') => `
${recorder(record)}
const eld = (await import('node:perf_hooks')).monitorEventLoopDelay({ resolution: 1 })
eld.enable()
const lpc = await import(${url('src/providers/line-parse-count.ts')})
const jo = await import(${url('src/core/sessions/judge-of.ts')})
const lb = await import(${url('src/core/session-channel/leader-boot.ts')})
const sdb = await import(${url('src/core/session-db.ts')})
const trk = await import(${url('src/core/session-tracker.ts')})
const drp = await import(${url('src/core/session-channel/leader-drops.ts')})
const ccs = await import(${url('src/providers/claude-code-session.ts')})
const hho = await import(${url('src/providers/host-handover.ts')})
const hom = await import(${url('src/core/session-channel/handover-marks.ts')})
const scg = await import(${url('src/core/sessions/session-command-gate.ts')})
const hhr = await import(${url('src/core/sessions/host-history-reads.ts')})
const shm = await import(${url('src/core/session-history.ts')})
const sbd = await import(${url('src/core/search/build.ts')})
const probeFile = (await import('node:path')).join((await import('node:path')).dirname(c.WALNUT_HOME), 'mac-probe.json')
// The permit number this leader tells its hosts (leader-permit.ts), as the leader switch's permit
// system would number two leaders of one Walnut: WALNUT_CLUSTER_PERMIT_NUMBER, once the side is on.
const permitNo = Number(process.env.WALNUT_CLUSTER_PERMIT_NUMBER)
if (permitNo > 0) {
  const lp = await import(${url('src/core/session-channel/leader-permit.ts')})
  void (async () => {
    while (!lb.activeLeaderSide()) await new Promise((r) => setTimeout(r, 20))
    lp.setLeaderPermitReader(() => ({ runtime: { status: () => ({ record: { number: permitNo } }) } }))
  })()
}
${SERVE('probeFile')}
await serveProbe({
  '/events': (q) => eventsOf(q.get('sid')),
  '/parses': (q) => ({ parses: lpc.lineParsesOf(q.get('sid')) }),
  '/frames': () => lpc.frameParses(),
  '/counts': (q) => counted.get(q.get('sid')) ?? {},
  '/loop': (q) => {
    const ms = (ns) => Math.round(ns / 1e4) / 100
    const r = { maxMs: ms(eld.max), p99Ms: ms(eld.percentile(99)), p50Ms: ms(eld.percentile(50)), meanMs: ms(eld.mean), samples: eld.count }
    if (q.get('reset')) eld.reset()
    return r
  },
  '/profile': async (q) => {
    if (!globalThis.__probeProfiler) {
      const s = new (await import('node:inspector')).Session()
      s.connect()
      const post = (m) => new Promise((res, rej) => s.post(m, {}, (e, r) => (e ? rej(e) : res(r))))
      await post('Profiler.enable')
      globalThis.__probeProfiler = post
    }
    const post = globalThis.__probeProfiler
    // The stall recorder's profile may run already (its interval is the sampling's: WALNUT_STALL_PROFILE_INTERVAL_US); this one overlaps it.
    if (q.get('start')) { await post('Profiler.start'); return { started: true } }
    const { profile } = await post('Profiler.stop')
    ;(await import('node:fs')).writeFileSync(q.get('to'), JSON.stringify(profile))
    return { written: q.get('to'), samples: profile.samples.length }
  },
  '/judge': (q) => ({ judge: jo.judgeOf(q.get('sid')), host: jo.judgingHostOf(q.get('sid')) }),
  '/read': async (q) => {
    const row = await trk.getSessionByClaudeId(q.get('sid'))
    if (!row) return { error: 'no row' }
    hhr._readHistoryHereForTesting(q.get('legacy') === '1')
    try {
      const what = q.get('what')
      if (what === 'full') return { value: await shm.readSessionHistory(row.claudeSessionId, row.cwd, row.host, row.outputFile, { skipSubagents: true }) }
      if (what === 'tail') return { value: await shm.readSessionHistoryTail(row.claudeSessionId, row.cwd, row.host, row.outputFile) }
      if (what === 'plan') return { value: await shm.extractPlanContent(row.claudeSessionId, row.cwd, row.host) }
      if (what === 'body') return { value: await sbd.readSessionBody(row) }
      return { error: 'what is full, tail, plan or body' }
    } finally { hhr._readHistoryHereForTesting(false) }
  },
  '/holds': (q) => ({ live: ccs.sessionRunner.holdsLiveSession(q.get('sid')) }),
  '/lose-answer': (q) => {
    const side = lb.activeLeaderSide()
    const real = side.startOnHost
    const mode = q.get('mode')
    side.startOnHost = async (host, body) => {
      side.startOnHost = real
      if (mode === 'taken') await real.call(side, host, body)
      throw new Error('the request timed out (the cluster probe lost its answer)')
    }
    return { armed: mode }
  },
  '/handover': (q) => ({ pending: hho.handOverPending(q.get('sid')), onDisk: hom.handOverMarkStands(q.get('sid')) }),
  '/side': (q) => { const s = lb.activeLeaderSide(); return { active: !!s, linked: !!s && s.linked(q.get('host')), kind: s ? s.linkKind(q.get('host')) : null, judges: !!s && s.hostJudges(q.get('host')), startKey: s && typeof s.startKeyOf === 'function' ? s.startKeyOf(q.get('host')) : null } },
  '/link': async (q) => ({ connected: (await import(${url('src/core/host-server/index.ts')})).hostServerLink(q.get('host')) !== null }),
  '/cursor': (q) => ({ cursor: sdb.loadChannelCursor(q.get('host')) }),
  '/session-cmds': (q) => ({ aimed: scg.sessionCommandsAimedAt(q.get('sid')), refusals: scg.sessionCommandRefusals() }),
  '/daemon-link': async (q) => ({ connected: (await import(${url('src/providers/daemon-connection.ts')})).getConnectedDaemonConnection(q.get('host')) !== null }),
  '/scans': async (q) => {
    const sid = q.get('sid')
    const host = q.get('host')
    const row = await trk.getSessionByClaudeId(sid)
    const alive = await (await import(${url('src/utils/session-liveness.ts')})).isSessionProcessAlive(row)
    await new (await import(${url('src/core/session-health-monitor.ts')})).SessionHealthMonitor().check()
    const limit = await trk.checkSessionLimit(host, { [host]: 50 }, { max_idle: 1 })
    const orphans = (await trk.listOrphanCandidates()).map((s) => s.claudeSessionId)
    const swept = await (await import(${url('src/core/sessions/owner-stop.ts')})).sweepOrphansThroughOwner([row], 'cluster-probe')
    return { alive, evicted: (limit.evicted ?? []).map((s) => s.claudeSessionId), orphans, swept, row: await trk.getSessionByClaudeId(sid) }
  },
  '/delete': async (q) => ({ removed: await trk.deleteSessionRecords(new Set([q.get('sid')]), 'cluster-probe') }),
  '/drops': (q) => ({ sids: drp.leaderDropsOf(q.get('host')) }),
  '/row': async (q) => ({ row: await trk.getSessionByClaudeId(q.get('sid')) }),
  '/legacy': async (q) => { await trk.createSessionRecord(q.get('sid'), '', 'Acme', undefined, { title: 'Leader own' }); return { row: await trk.getSessionByClaudeId(q.get('sid')) } },
  '/hands': async () => ({ hands: (await import(${url('src/core/session-channel/handed-sessions.ts')})).handsNow() }),
  '/hold-copy': async (q) => { (await import(${url('src/core/replication/kinds/copy-kind.ts')}))._holdCopyWritesForTesting(q.get('on') === '1' ? q.get('kind') : null); return { held: q.get('on') === '1' ? q.get('kind') : null } },
  '/hand': async (q) => ({ id: await (await import(${url('src/core/session-channel/handed-sessions.ts')})).handStart(q.get('host'), q.get('sid')) }),
  '/acp': (q) => {
    const a = ccs.sessionRunner.findAcpSession(q.get('sid'))
    return { found: !!a, hostJudged: a?.hostJudged === true, kind: a?.kind ?? null, processStatus: a?.processStatus ?? null, workerLive: a?.workerLive ?? null, engineId: a?.engineId ?? null, controls: Array.isArray(a?.sessionControls) ? a.sessionControls.length : null }
  },
})
`

/**
 * What the host's service imports once its server answers (replica-cluster.ts hostService `after`):
 * the ACP stand-in, a loopback port for the leader door, the bus recorder and the probe.
 */
/** Boot code: this server's runner runs ACP engines through a worker built from this checkout and the scripted adapter. */
const acpStandIn = () => `
;(await import(${url('src/providers/claude-code-session.ts')})).sessionRunner.setTestAcpArtifacts({
  workerCmd: [process.execPath, (await import(${url('tests/helpers/acp-worker-bundle.ts')})).acpWorkerBundle()],
  adapterCmd: [process.execPath, ${JSON.stringify(path.join(ROOT, 'tests/providers/mock-acp-agent.mjs'))}],
})
`

export function hostJudgeServiceProbe(): string {
  return `
const { sessionRunner } = await import(${url('src/providers/claude-code-session.ts')})
${acpStandIn()}
;(await import('node:fs')).mkdirSync(process.env.CODEX_HOME, { recursive: true })
const { getHostReplicaLeaderDoor } = await import(${url('src/web/server.ts')})
const door = getHostReplicaLeaderDoor()
const boot = await import(${url('src/core/session-channel/host-boot.ts')})
${recorder()}
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
    return { running: true, logId: h.log.logId, head: h.log.head, floor: h.log.floor, acked: h.log.acked, permit: h.log.permit, permitPair: h.log.permitPair, recs }
  },
  '/events': (q) => eventsOf(q.get('sid')),
  '/row': async (q) => ({ row: await (await import(${url('src/core/session-tracker.ts')})).getSessionByClaudeId(q.get('sid')) }),
  '/task': async (q) => {
    const t = await (await import(${url('src/core/task-manager.ts')})).getTask(q.get('id')).catch(() => null)
    return { phase: t ? t.phase : null }
  },
  '/live': () => ({ live: !!boot.hostSessionsRunning()?.channel.leaderLive() }),
  // The host runner's own ACP object of a session (its runtime, and the host it reaches it on).
  '/acp': (q) => {
    const a = sessionRunner.findAcpSession(q.get('sid'))
    return { found: !!a, runtimeId: a?.runtimeId ?? null, host: a?.host ?? null, workerLive: a?.workerLive ?? null, controls: Array.isArray(a?.sessionControls) ? a.sessionControls.length : null }
  },
  '/dialer': async () => {
    const cf = await import(${url('src/core/session-channel/host-credential-file.ts')})
    const held = await cf.readHostCredential(process.env.WALNUT_WALNUT_ID ?? '')
    return { linked: !!boot.hostSessionsRunning()?.dialer.linked(), holds: !!held, doors: held ? held.doors : [] }
  },
  '/companion': () => ({ linked: !!boot.hostSessionsRunning()?.companion.linked() }),
  // Does this host judge its own sessions now (session-channel/old-leader-watch.ts), what it reads of
  // its leader, and (with sid) whether it judges that one.
  '/judging': async (q) => {
    const [j, role] = await Promise.all([import(${url('src/core/sessions/judge-of.ts')}), import(${url('src/core/server-role.ts')})])
    const sid = q.get('sid')
    return { standsDown: j.hostStandsDown(), watch: !!boot.hostSessionsRunning()?.oldLeader.standingDown(), presence: role.leaderPresence().why, live: !!boot.hostSessionsRunning()?.channel.leaderLive(), ...(sid ? { judgedHere: j.judgedHere(sid) } : {}) }
  },
  // The next start the host's runner makes answers 'ms' late, its session already up (its born row
  // already written): the order a loaded host can take. The probe's one write to the host.
  '/slow-start': (q) => {
    const ms = Number(q.get('ms') || 0)
    const own = sessionRunner.startSession
    sessionRunner.startSession = async function (...args) {
      sessionRunner.startSession = own
      const r = await own.apply(this, args)
      await new Promise((res) => setTimeout(res, ms))
      return r
    }
    return { ok: true, ms }
  },
  // The host's runner says it holds a live session of a held sid (host-boot.ts notAtRest), so a resume of it is refused.
  '/hold-sid': (q) => {
    const held = globalThis.__clusterHeldSids ??= new Set()
    if (!globalThis.__clusterHeldPatched) {
      globalThis.__clusterHeldPatched = true
      const own = sessionRunner.holdsSessionForResume
      sessionRunner.holdsSessionForResume = function (sid) { return held.has(sid) || own.call(this, sid) }
    }
    if (q.get('on') === '0') held.delete(q.get('sid'))
    else held.add(q.get('sid'))
    return { ok: true, held: [...held] }
  },
  '/forge': (q) => {
    const h = boot.hostSessionsRunning()
    const sid = q.get('sid')
    const now = new Date().toISOString()
    const rec = h.log.append(sid, 'row', { born: true, patch: { claudeSessionId: sid, taskId: '', project: 'Acme', host: ${JSON.stringify(HOST_KEY)}, judge: 'host', process_status: 'running', mode: 'default', title: 'Forged', startedAt: now, lastActiveAt: now, messageCount: 0 } })
    return { seq: rec.seq }
  },
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

const factHash = (d: unknown): string => crypto.createHash('sha256').update(JSON.stringify(d ?? null) ?? 'null').digest('hex')

/**
 * A record of the host's log a leader says again as it is: a fact (event-classes.ts), but for
 * session:started. That one is the leader's own word, said once by whichever comes first, the start's
 * answer (source `session-runner`) or the host's born row of it (source `host-channel`; leader-side.ts,
 * claimHostStarted), so it is no record of the host's log (a native start's own names no id there).
 * Which one says it depends on timing; that it is said once does not (factsAtBothEnds `started`).
 */
export const isHostFact = (name: string): boolean => channelClassOf(name) === 'fact' && name !== 'session:started'
/** Each record as its identity: its name and a hash of its data (a cut record, `refs`, by name only). */
export const factIds = (recs: HostFactRecord[]): string[] => recs.map((r) => `${r.name}:${r.refs ? 'cut' : factHash(r.data).slice(0, 12)}`)
/** A leader's events as the identities of `recs` by position: equal to factIds(recs) when each came once and in order. */
export const seenAsFacts = (events: ProbeEvent[], recs: HostFactRecord[]): string[] => events.map((e, i) => `${e.name}:${recs[i]?.refs ? 'cut' : e.hash.slice(0, 12)}`)

/**
 * The host's facts of `s` against a leader's channel events of it (`events`: everything its probe's
 * /events heard of `s`, any source), by identity and position: `seen` equals `host` when each fact
 * reached that leader once and in order; `started` is every session:started of `s` its bus heard.
 */
export function factsAtBothEnds(recs: HostFactRecord[], events: ProbeEvent[], s: string): { log: HostFactRecord[]; mac: ProbeEvent[]; host: string[]; seen: string[]; started: ProbeEvent[] } {
  const log = recs.filter((r) => r.sid === s && isHostFact(r.name))
  const mac = events.filter((e) => e.sid === s && e.source === 'host-channel' && isHostFact(e.name))
  return { log, mac, host: factIds(log), seen: seenAsFacts(mac, log), started: events.filter((e) => e.sid === s && e.name === 'session:started') }
}

/** Until the host's log is still for a second and the reader's cursor (the Mac's by default) is at its head. */
export async function untilFactsStill(h: Pick<HostJudgeCluster, 'host' | 'mac'>, o: { cursorOf?: (p: string) => Promise<any>; timeoutMs?: number } = {}): Promise<void> {
  const cursorOf = o.cursorOf ?? h.mac
  let last = -1
  let since = 0
  await waitFor(async () => {
    const head = (await h.host('/facts?after=0')).head
    if (head !== last) { last = head; since = Date.now(); return false }
    return Date.now() - since >= 1_000 && ((await cursorOf(`/cursor?host=${HOST_KEY}`)).cursor?.seq ?? 0) >= head
  }, o.timeoutMs ?? 60_000, 'the host\'s log to be still and the reader\'s cursor at its head', 200)
}

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
  /** A standby leader over `data` (a copy of the Mac's), on `port`, with the Mac's probe (see the header). */
  standby(o: { data: string; port: number; env?: Record<string, string> }): Promise<{ leader: StandbyLeader; probe(p: string): Promise<any> }>
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

/** Options of a host-judge cluster (each the cluster's default when left out). */
export interface HostJudgeClusterOptions {
  /** The Mac's daemon link to the host runs through a proxy the test can cut (replica-cluster.ts cutLink). */
  linkProxy?: boolean
  /** A real cloud companion paired with the Mac (see the header). */
  companion?: boolean
  /** The Mac's switch in its config (default on). */
  macSwitch?: boolean
  /** More experiments on in the Mac's config, beside the switch (`host_call_entry`: a same-host send is the host server's). */
  macExperiments?: readonly string[]
  /** More of the host service's env, over the cluster's own (a timing seam, the host's switch forced off: an older host). */
  hostEnv?: Record<string, string>
  /** More of the Mac's env (WALNUT_LEADER_SESSION_CHANNELS=0: a leader from before the session channel). */
  macEnv?: Record<string, string>
  /** What the Mac's recorder keeps ('count': the counts only, /events answers nothing; for a bench that measures the Mac). */
  macRecord?: 'full' | 'count'
  /** More of the Mac's config.yaml lines, and code its boot script runs after the probe. */
  macConfigExtra?: readonly string[]
  /** More lines of the host's own entry in the Mac's config.yaml (indented four spaces: `    runs_sessions: true`). */
  macHostExtra?: readonly string[]
  macBootExtra?: string
  /** The Mac runs ACP engines (its legacy sessions on the host) with the host's scripted adapter too. */
  macAcp?: boolean
  /** Called before the Mac boots, with its data dir (and the cluster's base). */
  seedMac?: (o: { base: string; macData: string }) => void | Promise<void>
}

/** The Mac's `experimental:` block with these experiments on (none: no block). */
const experimentLines = (ids: readonly string[]): string[] => (ids.length ? ['experimental:', ...ids.map((id) => `  ${id}: true`)] : [])

export async function startHostJudgeCluster(o: HostJudgeClusterOptions = {}): Promise<HostJudgeCluster> {
  let companion: CloudBoxReplica | null = null
  const c = await startReplicaCluster({
    twin: 'standalone',
    ...(o.linkProxy ? { linkProxy: true } : {}),
    hostService: { env: (d) => ({ ...hostJudgeServiceEnv(d), ...(o.hostEnv ?? {}) }), after: hostJudgeServiceProbe() },
    macBootExtra: macProbe(o.macRecord ?? 'full') + (o.macAcp ? acpStandIn() : '') + (o.macBootExtra ?? ''),
    macConfigExtra: [
      ...experimentLines([...(o.macSwitch === false ? [] : ['host_runs_sessions']), ...(o.macExperiments ?? [])]),
      ...(o.companion ? ['cloud_bridge:', '  backup_leader: false'] : []),
      ...(o.macConfigExtra ?? []),
    ],
    ...(o.macHostExtra ? { macHostExtra: o.macHostExtra } : {}),
    macEnv: { ...(o.companion ? { WALNUT_LEADER_HEARTBEAT_MS: '1000' } : {}), ...(o.macEnv ?? {}) },
    seedMac: async ({ base, macData }: { base: string; macData: string }) => {
      if (o.companion) companion = await pairCompanion(base, macData)
      await o.seedMac?.({ base, macData })
    },
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
  const standbys: StandbyLeader[] = []
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
    standby: async (s) => {
      const leader = await startStandbyLeader(c, { data: s.data, port: s.port, extra: macProbe('full'), ...(s.env ? { env: s.env } : {}) })
      standbys.push(leader)
      const file = path.join(path.dirname(s.data), 'mac-probe.json')
      const at = await waitFor(() => { const m = readFile(file); return m?.probe && m.pid === leader.pid ? m.probe as number : null }, 60_000, 'the standby\'s probe')
      return { leader, probe: async (p: string) => ok(await getJson(at, p), p) }
    },
    stop: async () => {
      try {
        for (const s of standbys.splice(0)) await s.stop().catch(() => {})
        await c.stop()
      } finally { await box?.stop() }
    },
  }
}
