/**
 * A host-judged session's turns across a restart of its host's service, when nothing of the host's
 * runner reads its CLI for a while (src/core/session-channel/host-judged-lines.ts). Every piece a
 * real process: the cluster of tests/helpers/host-judge-cluster.ts, with `host_call_entry` on so a
 * same-host send is the host server's while the Mac answers (replica/away-sends.ts, `online`), and
 * the host's boot attach held back 45 s (WALNUT_HOST_OWN_ATTACH_DELAY_MS) so each case shows the
 * mechanism it is about.
 *
 * Found on a real host (2026-11-23): after the service restarted, the host's runner had detached the
 * session and attached it again only two minutes later (its stale-row sweep), with no replay; a
 * same-host send 56 s after the restart was written into the CLI directly, the CLI answered, and no
 * runner read that turn: no session:result on the host, none on the leader, the lead never told.
 *
 *   S1  two host-judged sessions (a caller and a target) answer their first turns
 *   S2  the service restarts; the caller's same-host send to the target goes by the host's local
 *       path before any boot attach: the runner attaches first (its log says so), and the target's
 *       turn end is in the host's fact log once and reaches the Mac once; the Mac's row moves on
 *   S3  a turn of the target is running (its tool calls already on the Mac) when the service
 *       restarts, and ends while it is down; the boot attach reads on from the line the leader was
 *       told: the turn end reaches the Mac once, and its tool calls are not said again
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { BUN, HOST_KEY, sleep, waitFor } from '../helpers/replica-cluster.js'
import { gatewayCall, logSince, turnsWith, writeClusterLogs } from '../helpers/replica-cluster-reads.js'
import { startHostJudgeCluster, untilFactsStill, type HostFactRecord, type HostJudgeCluster, type ProbeEvent } from '../helpers/host-judge-cluster.js'

const RUN = !!BUN && process.platform !== 'win32'
const LOCAL = 'ROUND sent on the host after the restart'
const HANDED = 'gateway: handed to this host\'s Walnut server'
const DELIVERED_HERE = 'replica: a message to a session on this host was delivered'
const WAITED = 'host sessions: a line into an own session waited for its runner to attach'
const READS_ON = 'attachToExisting: an own session reads on from where the leader was told'
/** The boot attach waits this long after the host reads its streams again (the cluster's seam). */
const BOOT_ATTACH_DELAY_MS = 45_000
/** The host's server takes a same-host send once its link to its runtime is read again (its capabilities, the session list). */
const LINK_SETTLE_MS = 15_000

describe.skipIf(!RUN)('a host-judged session\'s turns across a restart of its host\'s service, read on from where the leader was told', () => {
  let h: HostJudgeCluster
  let hostCwd = ''
  const caller = { task: '', sid: '' }
  const target = { task: '', sid: '' }

  const channelEvents = async (s: string) => ((await h.mac(`/events?sid=${s}`)) as ProbeEvent[]).filter((e) => e.source === 'host-channel')
  const named = (events: ProbeEvent[], name: string, text?: string) => events.filter((e) => e.name === name && (text === undefined || String(e.data?.result ?? '').includes(text)))
  const say = (why: string) => `${why}\n--- mac ---\n${h.c.logs().mac.slice(-6000)}\n--- replica ---\n${h.c.logs().replica.slice(-8000)}`
  const fail = (err: unknown) => { throw new Error(say(String(err))) }
  /** The host server's own log lines (its run dir, JSON lines) of `s` from `from` on. */
  const hostServerLog = (s: string, from: number): string[] => {
    const run = path.join(path.dirname(h.c.replicaData), 'run')
    let names: string[] = []
    try { names = fs.readdirSync(run).filter((n) => /^open-walnut-.*\.log$/.test(n)) } catch { /* none yet */ }
    return names.flatMap((n) => fs.readFileSync(path.join(run, n), 'utf8').split('\n'))
      .filter((l) => l.includes(s) && Date.parse(String((() => { try { return JSON.parse(l).time } catch { return '' } })())) >= from)
  }
  const macRow = async (s: string) => ((await h.mac(`/row?sid=${s}`)) as { row: { lastActiveAt?: string } | null }).row

  async function startOnHost(title: string, words: string): Promise<{ task: string; sid: string }> {
    const t = await h.c.mac('POST', '/api/tasks', { title, project: 'Acme' })
    expect(t.status, JSON.stringify(t.json)).toBe(201)
    const st = await h.c.mac('POST', `/api/v1/tasks/${t.json.task.id}/start`, { host: HOST_KEY, cwd: hostCwd, mode: 'bypass', message: words })
    expect(st.status, JSON.stringify(st.json)).toBe(202)
    const sid = st.json.sessionId as string
    await waitFor(async () => named(await channelEvents(sid), 'session:result', `echo: ${words}`).length > 0, 120_000, `${title}'s first answer on the Mac`).catch(fail)
    expect(await h.mac(`/judge?sid=${sid}`)).toEqual({ judge: 'host', host: HOST_KEY })
    return { task: t.json.task.id as string, sid }
  }

  /** The host read its own session's stream after `from`, and swallowed no result. */
  function readItsStream(s: string, from: number): void {
    const since = hostServerLog(s, from)
    expect(since.filter((l) => l.includes('suppressing replayed result')), 'replay suppression').toEqual([])
    expect(since.filter((l) => l.includes('falls back to phase proxy') && /"reason":"(no-stream-file|stream-stat-failed|stream-read-failed)"/.test(l)), 'its own stream unread').toEqual([])
  }

  beforeAll(async () => {
    h = await startHostJudgeCluster({ macExperiments: ['host_call_entry'], hostEnv: { WALNUT_HOST_OWN_ATTACH_DELAY_MS: String(BOOT_ATTACH_DELAY_MS) } })
    process.stdout.write(`host-judge-restart-local-send-e2e: cluster at ${h.c.base}\n`)
    hostCwd = fs.realpathSync(path.join(h.c.base, 'hh', 'work'))
    // The experiment reaches the host's server in its config copy; it says so at its next report (5 s).
    await waitFor(() => { try { return fs.readFileSync(path.join(h.c.replicaData, 'cache', 'replica', 'config.json'), 'utf8').includes('host_call_entry') } catch { return false } }, 120_000, 'the experiment in the host\'s config copy')
    await sleep(12_000)
  }, 900_000)
  afterEach(({ task }) => {
    if (!h || (task.result?.state !== 'fail' && process.env.HOST_JUDGED_KEEP_LOGS !== '1')) return
    const out = writeClusterLogs(h.c, 'restart-local-send')
    // The host server's own log (its run dir), which the cluster's logs leave out.
    const run = path.join(path.dirname(h.c.replicaData), 'run')
    try { for (const n of fs.readdirSync(run).filter((f) => /^open-walnut-.*\.log$/.test(f))) fs.copyFileSync(path.join(run, n), `${out}.host-${n}`) } catch { /* none */ }
    process.stdout.write(`restart-local-send: logs at ${out} (host server: ${out}.host-*)\n`)
  })
  afterAll(async () => { await h?.stop() }, 120_000)

  it('S1: a caller and a target, both host-judged, answer their first turns', async () => {
    await waitFor(async () => { const s = await h.mac(`/side?host=${HOST_KEY}`); return s.active && s.linked && s.judges }, 120_000, 'the Mac to link the host\'s session channel').catch(fail)
    Object.assign(caller, await startOnHost('Local caller', 'ROUND caller before the restart'))
    Object.assign(target, await startOnHost('Local target', 'ROUND target before the restart'))
  }, 400_000)

  it('S2: after the restart, a same-host send by the host\'s local path lets the runner attach first: its turn end reaches the Mac once', async () => {
    const before = await macRow(target.sid)
    const restartAt = Date.now()
    await h.c.restartReplica().catch(fail)
    await waitFor(async () => (await h.host('/judging')).live, 180_000, 'the Mac back on the restarted host\'s channel').catch(fail)
    await sleep(LINK_SETTLE_MS)
    const from = Date.now()
    // Well before the boot attach: only the attach before the write can take the session.
    expect(from - restartAt, 'the send goes before the boot attach').toBeLessThan(BOOT_ATTACH_DELAY_MS)
    const sent = await gatewayCall(h.c, caller.sid, 'task_send', { to: target.task, text: LOCAL, expect_reply: false })
    expect(sent.ok, JSON.stringify(sent)).toBe(true)
    expect(logSince(h.c, from).some((l) => l.msg === HANDED && l.op === 'task_send' && l.callerSid === caller.sid), 'the daemon handed the same-host send to the host\'s server').toBe(true)
    // ...which wrote it into the CLI itself (not handed back to the Mac, whose send goes by the host's runner),
    // after its runner attached. (The log is written a moment after the answer.)
    await waitFor(() => hostServerLog(target.sid, from).some((l) => l.includes(DELIVERED_HERE)), 15_000, 'the host\'s server to say it delivered the send on this host').catch(fail)
    await waitFor(() => hostServerLog(target.sid, from).some((l) => l.includes(WAITED) && l.includes('"attached":true')), 15_000, 'the runner to have attached before the line').catch(fail)
    await waitFor(async () => named(await channelEvents(target.sid), 'session:result', LOCAL).length > 0, 75_000, 'the turn end of the same-host send on the Mac').catch(fail)
    await untilFactsStill(h).catch(fail)
    expect(turnsWith(h.c, target.sid, LOCAL), 'turns on the host').toBe(1)
    const recs = (await h.host('/facts?after=0')).recs as HostFactRecord[]
    expect(recs.filter((r) => r.sid === target.sid && r.name === 'session:result' && String(r.data?.result ?? '').includes(LOCAL)), 'session:result in the host\'s log').toHaveLength(1)
    expect(named(await channelEvents(target.sid), 'session:result', LOCAL), 'session:result on the Mac').toHaveLength(1)
    // The Mac's row moved on with the turn (it stood still at the first turn's end).
    await waitFor(async () => {
      const row = await macRow(target.sid)
      return row?.lastActiveAt && row.lastActiveAt !== before?.lastActiveAt && Date.parse(row.lastActiveAt) >= from ? row : null
    }, 60_000, 'the Mac\'s row of the target to move on').catch(fail)
    readItsStream(target.sid, restartAt)
  }, 500_000)

  it('S3: a turn running at the restart that ends while the service is down is said once, its told part not again', async () => {
    const gate = path.join(hostCwd, `gate-mid-turn-${Date.now()}`)
    const RELEASED = `then released`
    const sent = await h.c.mac('POST', `/api/v1/sessions/${target.sid}/messages`, { text: `please stream 26 lines at 50 per second then hold until ${gate}` })
    expect(sent.status, JSON.stringify(sent.json)).toBeLessThan(300)
    // Its two tool calls reached the Mac live, before the restart.
    await waitFor(async () => named(await channelEvents(target.sid), 'session:tool-use').length >= 2, 120_000, 'the running turn\'s tool calls on the Mac').catch(fail)
    await untilFactsStill(h).catch(fail)
    const toolsBefore = named(await channelEvents(target.sid), 'session:tool-use').length
    expect(named(await channelEvents(target.sid), 'session:result', RELEASED), 'the turn is still running').toHaveLength(0)
    const restartAt = Date.now()
    // The turn ends while the service is down.
    await h.c.restartReplica(120_000, () => { fs.writeFileSync(gate, 'go') }).catch(fail)
    await waitFor(() => turnsWith(h.c, target.sid, RELEASED) > 0, 120_000, 'the CLI to end the held turn').catch(fail)
    // The boot attach (held back BOOT_ATTACH_DELAY_MS) reads on from the told line: the turn end once.
    await waitFor(async () => named(await channelEvents(target.sid), 'session:result', RELEASED).length > 0, BOOT_ATTACH_DELAY_MS + 90_000, 'the turn end on the Mac').catch(fail)
    await untilFactsStill(h).catch(fail)
    expect(named(await channelEvents(target.sid), 'session:result', RELEASED), 'session:result on the Mac').toHaveLength(1)
    const recs = (await h.host('/facts?after=0')).recs as HostFactRecord[]
    expect(recs.filter((r) => r.sid === target.sid && r.name === 'session:result' && String(r.data?.result ?? '').includes(RELEASED)), 'session:result in the host\'s log').toHaveLength(1)
    expect(named(await channelEvents(target.sid), 'session:tool-use').length, 'the tool calls the Mac had heard are not said again').toBe(toolsBefore)
    // (The host's log is written a moment late.)
    const readsOn = await waitFor(() => { const l = hostServerLog(target.sid, restartAt).filter((x) => x.includes(READS_ON)); return l.length ? l : null }, 15_000, 'the attach to say it read on from the told line').catch(fail)
    expect(readsOn[0], 'from the told line').toContain('"from":"told"')
    readItsStream(target.sid, restartAt)
  }, 500_000)
})
