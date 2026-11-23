#!/usr/bin/env bun
/**
 * The rollback of host-judged sessions (experiment `host_runs_sessions`, `hosts.<name>.runs_sessions`;
 * docs/reference/session-daemon.md "A session run and judged by its host") rehearsed against a REAL
 * older release from the registry, as "Existing users keep working" asks:
 *
 *   bun scripts/release-rehearsal/host-judged-rollback.mjs [--older <version>|latest] [--out <dir>]
 *       [--only downgrade,old-host,per-host-off,restart-control] [--old-leader-ms <ms>]
 *
 * Each cluster is tests/helpers/host-judge-cluster.ts (every piece a real process, its own HOME,
 * data, daemon dirs and ports under one temp base, mock `claude`, no auto-update), the host's row a
 * host-network machine (host-judged-leaders.mjs), the switch turned on for that host alone
 * (`runs_sessions: true`, the experiment off), as the rollout turns hosts on.
 *
 *   downgrade     (1) a host-judged turn held running; this tree's leader stopped and the older
 *                 release's leader started on the same data and port. Judged: it starts and reads the
 *                 data (a refusal fails); the host stands down within its bound (WALNUT_HOST_OLD_LEADER_MS, set by
 *                 --old-leader-ms for the run); the turn, released after that, ends with one answer
 *                 and no second turn nobody asked for; a message from the old leader is answered once.
 *   upgrade       (2) the same cluster, this tree's leader again: the task and the session read as
 *                 before, the host judges again, each host fact reaches the leader once, a send is
 *                 answered once over the channel.
 *   old-host      (3) this tree's leader with the switch on for a host whose daemon is the older
 *                 release (checked at the start and the end; the host's server is this tree's plain
 *                 one, the older release had no one-service mode): a new start takes the legacy path
 *                 and answers.
 *   per-host-off  (4) this tree only: `runs_sessions: false` while a host-judged turn runs; the turn
 *                 ends and reports over the channel; the next start there is legacy.
 *   restart-control  this tree only: the upgrade's last check (a send's turn end over the channel)
 *                 after a plain restart of the host's service, to tell a downgrade fault from a restart one.
 *
 * Evidence: <out>/<scenario>.json, and <out>/README.md with one row per scenario.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HOST_KEY, waitFor } from '../../tests/helpers/replica-cluster.ts'
import { writeClusterLogs } from '../../tests/helpers/replica-cluster-reads.ts'
import { macRows } from '../../tests/helpers/replica-cluster-reads.ts'
import { factsAtBothEnds, isHostFact, startHostJudgeCluster, untilFactsStill } from '../../tests/helpers/host-judge-cluster.ts'
import { installOlder, olderManifest } from './mixed-leader-host.mjs'
import { NET_HOST_LINES, clusterDirs, startNewLeaderAgain, startOldLeader, stopClusterMac, stopMacDaemon } from './host-judged-leaders.mjs'
import { rehearseOldHost } from './host-judged-old-host.mjs'
import { errorLines, keepLogs, leaderReads, sessionView, startOn, stopLeftovers, streamCounts, taskView } from './host-judged-reads.mjs'

const SCENARIOS = ['downgrade', 'old-host', 'per-host-off', 'restart-control']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseArgs(argv) {
  const out = { older: 'latest', out: null, only: null, oldLeaderMs: 20_000 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--older') out.older = argv[++i]
    else if (a === '--out') out.out = path.resolve(argv[++i])
    else if (a === '--only') out.only = argv[++i].split(',').filter(Boolean)
    else if (a === '--old-leader-ms') out.oldLeaderMs = Number(argv[++i])
    else throw new Error(`unknown argument ${a}`)
  }
  for (const s of out.only ?? []) if (!SCENARIOS.includes(s)) throw new Error(`--only takes ${SCENARIOS.join(', ')}, not ${s}`)
  return out
}

/**
 * What the older leader did to the host's service meanwhile: the walnut-update jobs it ran there
 * (its host server install), and the service's restarts for a changed follower spec.
 */
function hostServiceTrace(d) {
  const read = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }
  const audit = read(path.join(d.base, 'hs', 'host-exec', 'host-exec-audit.jsonl')).split('\n').filter((l) => l.includes('"event":"start"') && l.includes('walnut-'))
  const logs = (() => { try { return fs.readdirSync(d.hostDaemon).filter((n) => /^daemon-.*\.log$/.test(n)) } catch { return [] } })()
  const restarts = logs.map((n) => read(path.join(d.hostDaemon, n))).join('\n').split('\n').filter((l) => l.includes('restarting the service')).length
  return { updateJobs: audit.length, serviceInstances: logs.length, restartsForSpec: restarts }
}

/**
 * A scenario's cleanup, every step on its own (one that throws never keeps the next from running):
 * the processes it started beside the cluster first, then the logs (files, read while the base is
 * still there), the cluster, and whatever still runs from the cluster's base. What failed is noted.
 */
async function cleanUp(r, h, { label, files, out, extra = [] }) {
  const note = (what, err) => { (r.cleanup ??= []).push(`${what}: ${String(err?.message ?? err).slice(0, 300)}`) }
  for (const [what, fn] of extra) { try { await fn() } catch (err) { note(what, err) } }
  if (!h) return
  try { r.logs = writeClusterLogs(h.c, label) } catch (err) { note('logs', err) }
  try { r.files = keepLogs(h.c.base, path.join(out, files)) } catch (err) { note('files', err) }
  const base = h.c.base
  try { await h.stop() } catch (err) { note('cluster stop', err) }
  try { const left = await stopLeftovers(base); if (left.length) r.leftovers = left } catch (err) { note('leftovers', err) }
}

/** The leader's stored channel cursor for the host (its sessions store), read while no leader runs. */
function storedCursor(h) {
  try { return Number(macRows(h.c, 'SELECT seq FROM session_channel_cursor WHERE host_id = ?', 'sessions.sqlite', HOST_KEY)[0]?.seq ?? 0) } catch { return null }
}

async function rehearseDowngradeUpgrade({ older, oldLeaderMs, out }) {
  const r1 = { scenario: 'downgrade', older: older.version, oldLeaderMs, checks: {}, problems: [] }
  const r2 = { scenario: 'upgrade', older: older.version, checks: {}, problems: [] }
  let h = null
  let old = null
  let again = null
  const fail = (r, why) => { r.problems.push(why); process.stdout.write(`  ✗ ${r.scenario}: ${why}\n`) }
  try {
    h = await startHostJudgeCluster({
      macSwitch: false, macHostExtra: [...NET_HOST_LINES, '    runs_sessions: true'],
      hostEnv: { WALNUT_HOST_RUNS_SESSIONS: '', WALNUT_HOST_OLD_LEADER_MS: String(oldLeaderMs) },
    })
    const L = leaderReads(h)
    const d = clusterDirs(h)
    const port = h.c.macPort
    r1.base = d.base
    await waitFor(async () => { const s = await h.mac(`/side?host=${HOST_KEY}`); return s.linked && s.judges }, 180_000, 'the Mac to link the host\'s session channel')
    const release = path.join(d.base, 'release-held-turn')
    const held = `please hold until ${release}`
    const { taskId, sid } = await startOn(h, 'Held through a downgrade', held)
    r1.taskId = taskId; r1.sid = sid
    await waitFor(async () => (await h.mac(`/judge?sid=${sid}`)).judge === 'host', 60_000, 'the session to be host-judged')
    await waitFor(() => streamCounts(h, sid).turns >= 1, 120_000, 'the held turn to run on the host')
    // A second message while the turn holds: the host's runner takes it (the CLI queues a line that lands mid-turn).
    const queued = 'QUEUED before the downgrade'
    const q = await L.send(sid, queued)
    r1.checks.queuedSend = q.status
    await sleep(3_000)
    r1.before = { task: taskView(await L.task(taskId)), session: sessionView(await L.session(sid)), judge: await h.mac(`/judge?sid=${sid}`), hostQueue: await h.host(`/queue?sid=${sid}`), stream: streamCounts(h, sid) }

    // 1: the downgrade, mid-turn. The older leader must start on the newer leader's data: a refusal is a FAIL.
    r1.checks.newLeaderStop = await stopClusterMac(h)
    old = await startOldLeader(h, older, { port, logFile: path.join(out, 'downgrade-old-leader.log') })
    r1.checks.oldLeaderUp = { health: !!old.health, upMs: old.upMs, exit: old.exit }
    if (!old.health) throw new Error(`the ${older.version} leader did not answer on the new leader's data (exit ${old.exit}); see downgrade-old-leader.log`)
    const upAt = Date.now()
    r1.checks.oldLeaderUp.version = (await L.api('GET', '/api/v1/status')).json?.version ?? null
    r1.checks.dataReads = { tasks: (await L.api('GET', '/api/tasks')).status, task: taskView(await L.task(taskId)), session: sessionView(await L.session(sid)) }
    if (r1.checks.dataReads.task.title !== r1.before.task.title) fail(r1, `the old leader reads the task as ${JSON.stringify(r1.checks.dataReads.task)}`)
    // The host stands down within its bound (a tick of a quarter bound, and the quiet window, past it).
    const bound = oldLeaderMs + Math.max(10_000, oldLeaderMs / 2) + 30_000
    const down = await waitFor(async () => (await h.host('/judging')).standsDown, bound, 'the host to stand down', 500).then(() => Date.now() - upAt, () => null)
    r1.checks.standDown = { afterMs: down, boundMs: bound, judging: await h.host(`/judging?sid=${sid}`) }
    if (down === null) fail(r1, `the host did not stand down within ${bound} ms of the old leader answering (${JSON.stringify(r1.checks.standDown.judging)})`)
    // The held turn ends now: one judge (the old leader, from the CLI's lines).
    fs.writeFileSync(release, 'go\n')
    const releasedText = `echo: released ${release}`
    const answered = await L.waitAnswer(sid, releasedText, 120_000).then(() => true, () => false)
    if (!answered) fail(r1, 'the released turn\'s answer never reached the old leader\'s history')
    const queuedAnswered = await L.waitAnswer(sid, `echo: ${queued}`, 60_000).then(() => true, () => false)
    await sleep(10_000)
    r1.checks.turnEnd = {
      answered, queuedAnswered,
      historyReleased: await L.answers(sid, releasedText), historyQueued: await L.answers(sid, `echo: ${queued}`),
      stream: streamCounts(h, sid, [releasedText, `echo: ${queued}`]), hostQueue: await h.host(`/queue?sid=${sid}`),
    }
    const s = r1.checks.turnEnd.stream
    if (s[releasedText] !== 1) fail(r1, `the released turn has ${s[releasedText]} results on the host`)
    if (r1.checks.turnEnd.historyReleased > 1) fail(r1, `the old leader shows the released answer ${r1.checks.turnEnd.historyReleased} times`)
    if (!queuedAnswered) fail(r1, 'the message sent before the downgrade was never answered')
    else if (s[`echo: ${queued}`] !== 1) fail(r1, `the queued message has ${s[`echo: ${queued}`]} results`)
    // No turn nobody asked for: the turns run are the two messages sent so far.
    if (s.turns !== 2 || s.results !== 2) fail(r1, `the host ran ${s.turns} turns with ${s.results} results for 2 messages (an auto-continue, a resend, or a lost message)`)
    // Usable from the old leader: a send, answered once.
    // An older leader may put its own notice in front of the words (0.6.37: "Walnut changed your default
    // instructions"), and the mock echoes the whole line: the words are counted wherever they are.
    const oldWords = 'ROUND from the old leader'
    const sent = await L.send(sid, oldWords)
    r1.checks.oldSend = { status: sent.status, body: sent.status >= 300 ? sent.text?.slice(0, 300) ?? JSON.stringify(sent.json).slice(0, 300) : undefined }
    const oldAnswered = await L.waitAnswer(sid, oldWords, 120_000).then(() => true, () => false)
    await sleep(5_000)
    r1.checks.oldSend.answered = oldAnswered
    r1.checks.oldSend.history = await L.answers(sid, oldWords)
    r1.checks.oldSend.stream = streamCounts(h, sid, [oldWords])
    r1.checks.oldLeaderErrors = errorLines(fs.readFileSync(path.join(out, 'downgrade-old-leader.log'), 'utf8'))
    if (!oldAnswered) fail(r1, `a message sent from the old leader was not answered (send ${sent.status})`)
    else if (r1.checks.oldSend.history !== 1 || r1.checks.oldSend.stream[oldWords] !== 1) fail(r1, `the old leader's message was answered ${r1.checks.oldSend.history} times in its history, ${r1.checks.oldSend.stream[oldWords]} on the host`)
    r1.checks.stillDown = (await h.host('/judging')).standsDown
    r1.after = { task: taskView(await L.task(taskId)), session: sessionView(await L.session(sid)) }
    r1.checks.hostService = hostServiceTrace(d)
    r1.hostFactsHead = (await h.host('/facts?after=0')).head

    // 2: the upgrade again.
    r2.ran = true
    // { code, sig }: a signal death has no exit code.
    r2.checks.oldExit = await old.stop()
    // Where the new leader takes the host's log up again: every fact after it must reach it once.
    r2.checks.cursorAtUpgrade = storedCursor(h)
    again = await startNewLeaderAgain(h, { port, label: 'upgrade' })
    r2.checks.newLeaderUpMs = again.upMs
    const linked = await waitFor(async () => (await h.host('/judging')).live && !(await h.host('/judging')).standsDown, 180_000, 'the host to judge again', 500).then(() => true, () => false)
    r2.checks.hostJudgesAgain = { linked, judging: await h.host(`/judging?sid=${sid}`) }
    if (!linked) fail(r2, 'the host did not take its sessions back after the new leader came back')
    r2.checks.reads = { task: taskView(await L.task(taskId)), session: sessionView(await L.session(sid)), judge: await h.mac(`/judge?sid=${sid}`) }
    // As the old leader left them (the held turn ended under it, so the phase moved on there).
    for (const k of ['title', 'project', 'phase', 'status']) if (r2.checks.reads.task[k] !== r1.after.task[k]) fail(r2, `the task's ${k} reads ${JSON.stringify(r2.checks.reads.task[k])}, under the old leader ${JSON.stringify(r1.after.task[k])}`)
    for (const k of ['taskId', 'host', 'title', 'judge']) if (r2.checks.reads.session[k] !== r1.after.session[k]) fail(r2, `the session's ${k} reads ${JSON.stringify(r2.checks.reads.session[k])}, under the old leader ${JSON.stringify(r1.after.session[k])}`)
    if (r2.checks.reads.judge.judge !== 'host') fail(r2, `the session's judge reads ${JSON.stringify(r2.checks.reads.judge)} after the upgrade, ${JSON.stringify(r1.before.judge)} before the downgrade`)
    for (const [needle, n] of [[releasedText, 1], [`echo: ${queued}`, 1], [oldWords, 1]]) {
      const c = await L.answers(sid, needle)
      if (c !== n) fail(r2, `"${needle}" is ${c} times in the history after the upgrade`)
    }
    const newWords = 'ROUND after the upgrade'
    const s2 = await L.send(sid, newWords)
    const viaChannel = await waitFor(async () => (await h.mac(`/events?sid=${sid}`)).some((e) => e.source === 'host-channel' && e.name === 'session:result' && String(e.data?.result ?? '').includes(newWords)), 120_000, 'the answer over the channel').then(() => true, () => false)
    await sleep(5_000)
    r2.checks.newSend = { status: s2.status, viaChannel, history: await L.answers(sid, `echo: ${newWords}`), stream: streamCounts(h, sid, [`echo: ${newWords}`]) }
    // Why a turn end did not reach the leader, when it did not: what the leader heard, and what the host logged of it.
    const entry = (() => { try { return fs.readFileSync(path.join(d.base, 'host-entry-stderr.log'), 'utf8') } catch { return '' } })()
    r2.checks.newSend.leaderEvents = (await h.mac(`/events?sid=${sid}`)).map((e) => `${e.name}|${e.source}`)
    r2.checks.newSend.hostFacts = (await h.host('/facts?after=0')).recs.filter((x) => x.sid === sid).map((x) => `${x.seq}:${x.name}`)
    r2.checks.newSend.hostLog = entry.split('\n').filter((l) => l.includes(sid) && /suppressing replayed result|phase proxy|not this Walnut/.test(l)).map((l) => l.slice(0, 300))
    if (!viaChannel) fail(r2, 'a send after the upgrade was not answered over the channel')
    else if (r2.checks.newSend.history !== 1 || r2.checks.newSend.stream[`echo: ${newWords}`] !== 1) fail(r2, `the send after the upgrade was answered ${r2.checks.newSend.history} times (history), ${r2.checks.newSend.stream[`echo: ${newWords}`]} (host)`)
    // Every host fact written after the stored cursor (the catch-up and the send's turn), once and in
    // order, and nothing else: a missing one fails as a doubled one does. The new leader's probe hears
    // only what came after its start, so its events are exactly the catch-up and after.
    await untilFactsStill(h).catch((err) => fail(r2, `the host's facts did not settle: ${err.message}`))
    const facts = (await h.host('/facts?after=0')).recs
    const events = await h.mac(`/events?sid=${sid}`)
    const seen = events.filter((e) => e.source === 'host-channel' && isHostFact(e.name)).map((e) => `${e.name}:${e.hash}`)
    const dupes = seen.filter((x, i) => seen.indexOf(x) !== i)
    const from = r2.checks.cursorAtUpgrade
    const fa = factsAtBothEnds(facts.filter((x) => typeof from === 'number' && x.seq > from), events, sid)
    const missing = fa.host.filter((x) => !fa.seen.includes(x))
    r2.checks.facts = { hostRecords: facts.filter((x) => x.sid === sid).length, afterCursor: fa.host.length, leaderChannelEvents: seen.length, duplicates: dupes, missing, inOrder: JSON.stringify(fa.seen) === JSON.stringify(fa.host) }
    if (typeof from !== 'number') fail(r2, 'the leader\'s stored channel cursor could not be read before the upgrade')
    else if (!fa.host.length) fail(r2, `no host fact after the cursor (${from}) to judge`)
    if (dupes.length) fail(r2, `the new leader heard ${dupes.length} host facts twice: ${dupes.slice(0, 5).join(', ')}`)
    if (missing.length) fail(r2, `${missing.length} host facts after the cursor never reached the new leader: ${missing.slice(0, 5).join(', ')}`)
    else if (!r2.checks.facts.inOrder) fail(r2, `the new leader heard the host's facts out of order or with extras:\n  host ${fa.host.join(' ')}\n  seen ${fa.seen.join(' ')}`)
    // No second start of the session under the new leader (the old one judged its turns meanwhile).
    r2.checks.started = fa.started.length
    if (fa.started.length > 1) fail(r2, `the new leader heard session:started ${fa.started.length} times`)
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    fail(r2.ran ? r2 : r1, `run failed: ${why}`)
  } finally {
    if (!r2.ran) fail(r2, 'not run: the downgrade did not get as far as the upgrade')
    await cleanUp(r1, h, {
      label: 'host-judged-downgrade', files: 'downgrade-files', out,
      extra: [['old leader', () => old?.stop()], ['new leader again', () => again?.stop()], ['Mac daemon', () => h && stopMacDaemon(h)]],
    })
  }
  return [r1, r2]
}

async function rehearsePerHostOff({ out }) {
  const r = { scenario: 'per-host-off', checks: {}, problems: [] }
  const fail = (why) => { r.problems.push(why); process.stdout.write(`  ✗ per-host-off: ${why}\n`) }
  let h = null
  try {
    h = await startHostJudgeCluster({ macSwitch: false, macHostExtra: [...NET_HOST_LINES, '    runs_sessions: true'], hostEnv: { WALNUT_HOST_RUNS_SESSIONS: '' } })
    const L = leaderReads(h)
    r.base = h.c.base
    await waitFor(async () => { const s = await h.mac(`/side?host=${HOST_KEY}`); return s.linked && s.judges }, 180_000, 'the Mac to link the host\'s session channel')
    const release = path.join(h.c.base, 'release-per-host')
    const { sid } = await startOn(h, 'Held through a per-host rollback', `please hold until ${release}`)
    r.sid = sid
    await waitFor(async () => (await h.mac(`/judge?sid=${sid}`)).judge === 'host', 60_000, 'the session to be host-judged')
    await waitFor(() => streamCounts(h, sid).turns >= 1, 120_000, 'the held turn to run on the host')
    const off = await h.c.mac('PUT', '/api/config', { hosts: { [HOST_KEY]: { runs_sessions: false } } })
    r.checks.offWrite = off.status
    const offAt = Date.now()
    await waitFor(async () => !(await h.mac(`/side?host=${HOST_KEY}`)).judges, 30_000, 'the Mac to stop handing starts to the host')
    r.checks.offTookMs = Date.now() - offAt
    fs.writeFileSync(release, 'go\n')
    const releasedText = `echo: released ${release}`
    const viaChannel = await waitFor(async () => (await h.mac(`/events?sid=${sid}`)).some((e) => e.source === 'host-channel' && e.name === 'session:result' && String(e.data?.result ?? '').includes(releasedText)), 120_000, 'the held turn\'s end over the channel').then(() => true, () => false)
    await sleep(5_000)
    r.checks.turnEnd = { viaChannel, judge: await h.mac(`/judge?sid=${sid}`), history: await L.answers(sid, releasedText), stream: streamCounts(h, sid, [releasedText]) }
    if (!viaChannel) fail('the held turn did not report its end over the channel after the host was turned off')
    if (r.checks.turnEnd.stream[releasedText] !== 1 || r.checks.turnEnd.history !== 1) fail(`the held turn's answer: ${r.checks.turnEnd.stream[releasedText]} on the host, ${r.checks.turnEnd.history} in the history`)
    if (r.checks.turnEnd.judge.judge !== 'host') fail(`the running session's judge became ${JSON.stringify(r.checks.turnEnd.judge)}`)
    const next = await startOn(h, 'After the per-host rollback', 'ROUND legacy next')
    const legacyAnswer = await waitFor(() => streamCounts(h, next.sid, ['ROUND legacy next'])['ROUND legacy next'] > 0, 120_000, 'the legacy answer').then(() => true, () => false)
    r.checks.nextStart = { sid: next.sid, judge: await h.mac(`/judge?sid=${next.sid}`), answered: legacyAnswer, channelEvents: (await h.mac(`/events?sid=${next.sid}`)).filter((e) => e.source === 'host-channel').length }
    if (r.checks.nextStart.judge.judge !== 'legacy') fail(`the next start is judged ${JSON.stringify(r.checks.nextStart.judge)}`)
    if (!legacyAnswer) fail('the next start was not answered')
    if (r.checks.nextStart.channelEvents) fail(`the legacy start has ${r.checks.nextStart.channelEvents} channel events`)
  } catch (err) {
    fail(`run failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    await cleanUp(r, h, { label: 'host-judged-per-host-off', files: 'per-host-off-files', out })
  }
  return [r]
}

/**
 * The control for the upgrade's turn end: this tree alone, a host-judged session whose turn ended,
 * the host's service restarted (as its update restarts it), then a send. Tells a fault of the
 * downgrade apart from one of any service restart.
 */
async function rehearseRestartControl({ out }) {
  const r = { scenario: 'restart-control', checks: {}, problems: [] }
  const fail = (why) => { r.problems.push(why); process.stdout.write(`  ✗ restart-control: ${why}\n`) }
  let h = null
  const channelResults = async (sid, words) => (await h.mac(`/events?sid=${sid}`)).filter((e) => e.source === 'host-channel' && e.name === 'session:result' && String(e.data?.result ?? '').includes(words)).length
  const channelResult = async (sid, words) => (await channelResults(sid, words)) > 0
  try {
    h = await startHostJudgeCluster({ macSwitch: false, macHostExtra: [...NET_HOST_LINES, '    runs_sessions: true'], hostEnv: { WALNUT_HOST_RUNS_SESSIONS: '' } })
    const L = leaderReads(h)
    r.base = h.c.base
    await waitFor(async () => { const s = await h.mac(`/side?host=${HOST_KEY}`); return s.linked && s.judges }, 180_000, 'the Mac to link the host\'s session channel')
    const { taskId, sid } = await startOn(h, 'Across a service restart', 'ROUND before the restart')
    r.sid = sid
    await waitFor(() => channelResult(sid, 'ROUND before the restart'), 120_000, 'the first answer over the channel')
    await waitFor(async () => (await L.task(taskId)).phase === 'NEED_ACTION', 60_000, 'the task to wait on the person')
    // The host's own copy too: the condition under which its runner, attaching again, read the turn as handled.
    await waitFor(async () => (await h.host(`/task?id=${taskId}`)).phase === 'NEED_ACTION', 60_000, 'the host\'s copy of the task to wait on the person')
    r.checks.restartedPid = await h.c.restartReplica()
    await waitFor(async () => (await h.host('/judging')).live, 180_000, 'the Mac back on the restarted host\'s channel')
    r.checks.hostCopyAtSend = (await h.host(`/task?id=${taskId}`)).phase
    // The control means something only when the host's copy reads the turn handled at the send.
    if (r.checks.hostCopyAtSend !== 'NEED_ACTION') fail(`the host's task copy reads ${JSON.stringify(r.checks.hostCopyAtSend)} at the send, not NEED_ACTION`)
    const sent = await L.send(sid, 'ROUND after the restart')
    if (sent.status < 200 || sent.status >= 300) fail(`the send after the restart answered ${sent.status}`)
    const via = await waitFor(() => channelResult(sid, 'ROUND after the restart'), 120_000, 'the answer over the channel').then(() => true, () => false)
    await sleep(3_000)
    const entry = (() => { try { return fs.readFileSync(path.join(h.c.base, 'host-entry-stderr.log'), 'utf8') } catch { return '' } })()
    r.checks.send = { status: sent.status, viaChannel: via, channelResults: await channelResults(sid, 'ROUND after the restart'), history: await L.answers(sid, 'ROUND after the restart'), stream: streamCounts(h, sid, ['ROUND after the restart']), task: taskView(await L.task(taskId)),
      hostLog: entry.split('\n').filter((l) => l.includes(sid) && /suppressing replayed result|phase proxy/.test(l)).map((l) => l.slice(0, 300)) }
    if (!via) fail('after a plain service restart, the next turn\'s end did not reach the leader over the channel')
    else if (r.checks.send.channelResults !== 1 || r.checks.send.history !== 1 || r.checks.send.stream['ROUND after the restart'] !== 1) {
      fail(`the send after the restart was answered ${r.checks.send.history} times (history), ${r.checks.send.stream['ROUND after the restart']} (host), with ${r.checks.send.channelResults} turn ends over the channel`)
    }
  } catch (err) {
    fail(`run failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    await cleanUp(r, h, { label: 'host-judged-restart-control', files: 'restart-control-files', out })
  }
  return [r]
}

/** One README row per scenario: its verdict and the numbers it was judged on. */
function readme(results, older) {
  const key = (r) => {
    const c = r.checks
    if (r.scenario === 'downgrade') return `old leader up ${c.oldLeaderUp?.upMs ?? '?'} ms (${c.oldLeaderUp?.version ?? 'no health'}); host stood down ${c.standDown?.afterMs ?? 'never'} ms after it (bound ${c.standDown?.boundMs} ms, WALNUT_HOST_OLD_LEADER_MS=${r.oldLeaderMs}; the old leader's host-server install restarted the service ${c.hostService?.restartsForSpec ?? '?'}x); held turn: ${c.turnEnd?.stream?.turns ?? "?"} turns, ${c.turnEnd?.stream?.results ?? "?"} results for 2 messages, history ${c.turnEnd?.historyReleased ?? '?'}x; old-leader send answered ${c.oldSend?.history ?? '?'}x`
    if (r.scenario === 'upgrade') return `host judges again: ${c.hostJudgesAgain?.linked}; judge ${c.reads?.judge?.judge ?? '?'}; facts after the cursor ${c.facts?.afterCursor ?? '?'}, missing ${c.facts?.missing?.length ?? '?'}, duplicates ${c.facts?.duplicates?.length ?? '?'}, in order ${c.facts?.inOrder}; send answered ${c.newSend?.history ?? '?'}x in the history, its turn end over the channel: ${c.newSend?.viaChannel}`
    if (r.scenario === 'old-host') return `host daemon ${c.hostDaemon?.version ?? '?'} (pid ${c.hostDaemon?.pid ?? '?'}, the same at the end: ${c.hostDaemon?.sameAtEnd}); the leader judges there: ${c.leaderJudges}; start judged ${c.start?.judge?.judge ?? '?'}, answered ${c.start?.answered}`
    if (r.scenario === 'restart-control') return `service restarted (pid ${c.restartedPid ?? '?'}); host's task copy at the send: ${c.hostCopyAtSend ?? '?'}; next turn's end over the channel: ${c.send?.viaChannel}; answered ${c.send?.stream?.['ROUND after the restart'] ?? '?'}x on the host, ${c.send?.history ?? '?'}x in the history, ${c.send?.channelResults ?? '?'} turn end(s) over the channel`
    if (r.scenario === 'per-host-off') return `off took ${c.offTookMs ?? '?'} ms; held turn over the channel: ${c.turnEnd?.viaChannel}, ${c.turnEnd?.stream?.results ?? '?'} results; next start judged ${c.nextStart?.judge?.judge ?? '?'}`
    return ''
  }
  // What the cleanup found still running from a cluster's base, or could not do, is on the row too.
  const after = (r) => [r.leftovers?.length ? `left running and stopped: ${r.leftovers.length}` : '', ...(r.cleanup ?? []).map((x) => `cleanup ${x}`)].filter(Boolean)
  const rows = results.map((r) => `| ${r.scenario} | ${r.problems.length ? 'FAIL' : 'PASS'} | ${[key(r), ...after(r), ...r.problems].join('<br>')} |`)
  return [`# Host-judged sessions: rollback against ${older.version}`, '', `Run ${new Date().toISOString()}; older release open-walnut@${older.version} (${older.printed}, daemon ${older.daemonVersion}).`, '',
    '| Scenario | Verdict | Key numbers |', '|---|---|---|', ...rows, ''].join('\n')
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const out = opts.out ?? fs.mkdtempSync(path.join(os.tmpdir(), 'host-judged-rollback-'))
  fs.mkdirSync(out, { recursive: true })
  process.env.REPLICA_CLUSTER_LOG_DIR ??= out
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hjr-'))
  const results = []
  try {
    const manifest = await olderManifest(opts.older)
    const older = await installOlder(work, manifest)
    process.stdout.write(`older: ${older.printed} (daemon ${older.daemonVersion}); out: ${out}\n`)
    const names = opts.only ?? SCENARIOS
    const run = async (name, fn) => {
      process.stdout.write(`\n▶ ${name}\n`)
      const at = Date.now()
      for (const r of await fn()) {
        r.secs = Math.round((Date.now() - at) / 1000)
        fs.writeFileSync(path.join(out, `${r.scenario}.json`), JSON.stringify(r, null, 2))
        results.push(r)
        process.stdout.write(`  ${r.problems.length ? '✗' : '✓'} ${r.scenario}\n`)
      }
    }
    if (names.includes('downgrade')) await run('downgrade + upgrade', () => rehearseDowngradeUpgrade({ older, oldLeaderMs: opts.oldLeaderMs, out }))
    if (names.includes('old-host')) await run('old-host', () => rehearseOldHost({ older, out }))
    if (names.includes('per-host-off')) await run('per-host-off', () => rehearsePerHostOff({ out }))
    if (names.includes('restart-control')) await run('restart-control', () => rehearseRestartControl({ out }))
    fs.writeFileSync(path.join(out, 'README.md'), readme(results, older))
    process.stdout.write(`\nevidence: ${out}\n`)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
  process.exit(results.length > 0 && results.every((r) => r.problems.length === 0) ? 0 : 1)
}

if (import.meta.main) await main()
