/**
 * Scenario 3 of host-judged-rollback.mjs: this tree's leader with the switch on for a host whose
 * daemon is an older release (its compiled file's `__daemon`, as a registry install leaves it:
 * replica-cluster.ts `hostRelease`; its server is the one this leader installs there). The older host names no
 * session-judge-v1, so the leader never links a session channel to it, and a new start there takes
 * the legacy path: started, answered, a second message answered once, judged by the leader.
 */
import fs from 'node:fs'
import path from 'node:path'
import { HOST_KEY, startReplicaCluster, waitFor } from '../../tests/helpers/replica-cluster.ts'
import { writeClusterLogs } from '../../tests/helpers/replica-cluster-reads.ts'
import { macProbe } from '../../tests/helpers/host-judge-cluster.ts'
import { NET_HOST_LINES } from './host-judged-leaders.mjs'
import { errorLines, keepLogs, leaderReads, startOn, streamCounts } from './host-judged-reads.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A read of the Mac's probe (its port in <base>/mh/mac-probe.json). */
function probeOf(c) {
  return async (p) => {
    const at = JSON.parse(fs.readFileSync(path.join(c.base, 'mh', 'mac-probe.json'), 'utf8')).probe
    const r = await fetch(`http://127.0.0.1:${at}${p}`, { signal: AbortSignal.timeout(30_000) })
    if (!r.ok) throw new Error(`probe ${p}: ${r.status}`)
    return r.json()
  }
}

export async function rehearseOldHost({ older, out }) {
  const r = { scenario: 'old-host', older: older.version, checks: {}, problems: [] }
  const fail = (why) => { r.problems.push(why); process.stdout.write(`  ✗ old-host: ${why}\n`) }
  let c = null
  try {
    c = await startReplicaCluster({
      twin: 'standalone', hostRelease: older.file, macBootExtra: macProbe('full'),
      macHostExtra: [...NET_HOST_LINES, '    runs_sessions: true'],
      macEnv: { WALNUT_SERVICE_LAUNCHER: '1', WALNUT_HOST_SERVICE_OFFER: '1' },
    })
    r.base = c.base
    const h = { c, mac: probeOf(c) }
    const L = leaderReads(h)
    r.checks.hostDaemon = { version: fs.readFileSync(path.join(c.base, 'hd', 'daemon.version'), 'utf8').trim(), expected: older.daemonVersion }
    if (r.checks.hostDaemon.version !== older.daemonVersion) fail(`the host's daemon is ${r.checks.hostDaemon.version}, not the release's ${older.daemonVersion}`)
    await waitFor(async () => (await h.mac(`/link?host=${HOST_KEY}`)).connected, 120_000, 'the Mac\'s link to the older host')
    // Long enough for the leader to have read the host's report and linked a channel if it were offered one.
    await sleep(35_000)
    const side = await h.mac(`/side?host=${HOST_KEY}`)
    r.checks.side = side
    r.checks.hostNamesJudge = side.judges
    if (side.linked || side.judges) fail(`the leader linked a session channel to the older host (${JSON.stringify(side)})`)
    const words = 'ROUND old host'
    const { sid } = await startOn(h, 'A start on an older host', words)
    const answered = await waitFor(() => streamCounts(h, sid, [`echo: ${words}`])[`echo: ${words}`] > 0, 120_000, 'the legacy answer').then(() => true, () => false)
    r.checks.start = { sid, answered, judge: await h.mac(`/judge?sid=${sid}`), history: await L.answers(sid, `echo: ${words}`), channelEvents: (await h.mac(`/events?sid=${sid}`)).filter((e) => e.source === 'host-channel').length }
    if (!answered) fail('the start on the older host was not answered')
    if (r.checks.start.judge.judge !== 'legacy') fail(`the start is judged ${JSON.stringify(r.checks.start.judge)}`)
    if (r.checks.start.channelEvents) fail(`the start has ${r.checks.start.channelEvents} channel events`)
    const again = 'AGAIN old host'
    const sent = await L.send(sid, again)
    const answered2 = await L.waitAnswer(sid, `echo: ${again}`, 120_000).then(() => true, () => false)
    await sleep(5_000)
    r.checks.send = { status: sent.status, answered: answered2, history: await L.answers(sid, `echo: ${again}`), stream: streamCounts(h, sid, [`echo: ${again}`]) }
    if (!answered2) fail(`a second message was not answered (send ${sent.status})`)
    else if (r.checks.send.history !== 1 || r.checks.send.stream[`echo: ${again}`] !== 1) fail(`the second message was answered ${r.checks.send.history} times (history), ${r.checks.send.stream[`echo: ${again}`]} (host)`)
    r.checks.leaderErrors = errorLines(c.logs().mac).filter((l) => /session.channel|host.judge|session-judge|leader side/i.test(l))
    if (r.checks.leaderErrors.length) fail(`the leader logged ${r.checks.leaderErrors.length} session-channel errors for the older host`)
  } catch (err) {
    fail(`run failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    if (c) {
      r.logs = writeClusterLogs(c, 'host-judged-old-host')
      r.files = keepLogs(c.base, path.join(out, 'old-host-files'))
      await c.stop().catch((err) => { r.stopError = String(err?.message ?? err).slice(0, 600) })
    }
  }
  return [r]
}
