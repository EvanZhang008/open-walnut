/**
 * The Mac and one Linux host over real SSH (tests/fleet/README.md). One fleet for
 * the file, the rows in order (each leaves the state the next starts from):
 *
 *   1  the Mac adds devbox (as Settings saves a host), deploys its daemon over SSH
 *      (nothing is preinstalled there) and a session on devbox runs a mock turn; the
 *      Mac reads that turn back from the host
 *   4  devbox keeps a copy of the Mac's notes and memory in its production copy dir,
 *      without the folder the host does not keep, and a note made after the connect
 *      reaches it too
 *   2  the lid closes mid-turn: the session's `walnut tools call task_update` is
 *      journaled on devbox, the Mac wakes and applies it exactly once
 *   3  the link is cut while the Mac stays awake (severed: the host's sshd keeps its
 *      side of the old connections): the same write is journaled, the link heals,
 *      the Mac reconnects by itself and applies it exactly once; after the person
 *      renames the task, one more drop and reconnect applies nothing again
 *   5  the lid closes right as a session starts, before its first turn's
 *      `walnut tools call task_update`: devbox's copy already names the session (the
 *      Mac pushes it with the start, not 3 s later), so the write is journaled there
 *      and applied once on wake instead of answering "hub unreachable" until then
 *
 * Each row ends on the stores themselves: the Mac's tasks.sqlite (read only) and
 * log, the host's stream, journal and copy files (docker exec).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { waitFor } from '../helpers/replica-cluster.js'
import { dockerUnavailable } from './docker.js'
import { startFleet, type Fleet } from './fleet.js'
import { appliedLines, attemptsSummary, expectControlMaster, journaledTitle, makeTask, runningTurns, startHostSession, startSession, startUpdateTurn, updateTurnsEnded, type HostSession } from './steps.js'

const unavailable = await dockerUnavailable()
if (unavailable) process.stdout.write(`\n[fleet] SKIPPED: Docker is not available here (${unavailable}). Start Docker and run npm run test:fleet.\n\n`)

const NOTE = { path: 'Acme/Runbook.md', text: 'The fleet runbook says drain before you deploy.' }
const PRIVATE = { path: 'Private/Diary.md', text: 'A private line that never leaves the Mac.' }
const LATER = { path: 'Acme/Later.md', text: 'A note written after the host connected.' }
const MEMORY = 'The user prefers small reversible changes on devbox.'
const HOST = 'devbox'

describe.skipIf(!!unavailable)('the fleet: a Mac and a Linux host over real SSH', () => {
  let f: Fleet
  let s: HostSession
  const times: Record<string, number> = {}
  const t0 = () => { const start = Date.now(); return () => Date.now() - start }
  /** The Mac logged one `queued fields applied` for the task since `before` (its log reaches the file a moment after the write). */
  const appliedOnce = async (before: number, taskId = s.taskId) => {
    await waitFor(() => appliedLines(f, taskId).length > before, 30_000, 'the Mac to log the apply')
    await new Promise((r) => setTimeout(r, 2_000))
    expect(appliedLines(f, taskId).length - before).toBe(1)
  }

  beforeAll(async () => {
    const took = t0()
    f = await startFleet({
      hosts: [HOST],
      seed: { notes: { [NOTE.path]: `# Runbook\n\n${NOTE.text}\n`, [PRIVATE.path]: `# Diary\n\n${PRIVATE.text}\n` }, memory: `# Memory\n\n${MEMORY}\n` },
    })
    times.boot = took()
    process.stdout.write(`[fleet] run ${f.run} at ${f.base}: Mac on :${f.mac.port}, ${HOST} sshd on 127.0.0.1:${f.hosts[HOST]!.sshPort} behind proxy :${f.hosts[HOST]!.proxy.port}, booted in ${times.boot} ms\n`)
  }, 600_000)

  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail' && f) process.stdout.write(`[fleet] diagnostics for "${task.name}":\n${await f.diagnostics()}\n`)
  })
  afterAll(async () => {
    process.stdout.write(`[fleet] times (ms): ${JSON.stringify(times)}\n`)
    // What the Mac did with a turn that ended while it was away (read for the report, not asserted).
    const handBacks = f?.mac.logLines(/task handed back after out-of-band session end/).map((l) => { const j = JSON.parse(l); return `${j.source} ${j.oldPhase} ${j.taskId}` }) ?? []
    if (handBacks.length) process.stdout.write(`[fleet] hand-backs: ${handBacks.join(' | ')}\n`)
    await f?.stop()
  }, 120_000)

  it('1: the Mac adds the host, deploys its daemon over SSH, and a session there runs a turn', async () => {
    const took = t0()
    // Nothing of Walnut's is on the host before the connect.
    expect((await f.hostExec(HOST, 'ls /tmp/open-walnut 2>/dev/null | wc -l')).trim()).toBe('0')
    times.connect = await f.addHost(HOST, { keep: { notes_exclude: ['Private'] } })
    // The daemon the Mac deployed runs on the host as the host's user, from the host's production dir.
    const ps = await f.hostExec(HOST, 'ps -eo user,args')
    const daemonLine = ps.split('\n').find((l) => /\/tmp\/open-walnut\/(daemon-linux-\w+|daemon\.cjs)\b.*--start/.test(l))
    expect(daemonLine, ps).toBeTruthy()
    expect(daemonLine!.trim().startsWith('walnut ')).toBe(true)
    const deployed = f.mac.logLines(/binary deployed|daemon source deployed|binary already up to date/).map((l) => JSON.parse(l).message as string)
    process.stdout.write(`[fleet] deploy: ${deployed.join(' | ')}; host daemon: ${daemonLine!.trim()}\n`)
    expect(deployed.length).toBeGreaterThan(0)
    expectControlMaster(f, HOST)
    s = await startHostSession(f, HOST, 'Fix the build on devbox', 'hello devbox')
    // The Mac reads the turn back from the host (the CLI's transcript there, through the daemon).
    await waitFor(async () => {
      const h = await f.mac.call('GET', `/api/sessions/${s.sid}/history`)
      return h.status === 200 && h.text.includes('echo: hello devbox')
    }, 60_000, 'the Mac to read the turn back')
    times.scenario1 = took()
  }, 300_000)

  it('4: the host keeps a copy of the notes and memory, without the folder it does not keep', async () => {
    const took = t0()
    await waitFor(async () => (await f.hostCopyHolds(HOST, NOTE.text)) && (await f.hostCopyHolds(HOST, MEMORY)), 90_000, 'the note and the memory to reach the host copy')
    expect(await f.hostCopyHolds(HOST, PRIVATE.text)).toBe(false)
    // A note made now (through the Mac's notes API) reaches the copy in a later round.
    const put = await f.mac.call('PUT', `/api/notes-v2/content/${encodeURI(LATER.path)}`, { content: `# Later\n\n${LATER.text}\n` })
    expect(put.status, put.text).toBeLessThan(300)
    await waitFor(() => f.hostCopyHolds(HOST, LATER.text), 90_000, 'the later note to reach the host copy')
    expect(await f.hostCopyHolds(HOST, PRIVATE.text)).toBe(false)
    times.scenario4 = took()
  }, 240_000)

  it('2: the lid closes mid-turn; the session\'s write is journaled on the host and applied once on wake', async () => {
    const took = t0()
    const title = 'Fixed while the Mac slept'
    const appliedBefore = appliedLines(f, s.taskId).length
    await startUpdateTurn(f, s, title, 4)
    const slept = t0()
    f.sleepMac()
    // The turn ends on the host without the Mac, its write journaled there.
    await updateTurnsEnded(f, s, 1)
    // The lid stays closed past the host's keepalive (8 missed beats): the daemon has
    // dropped the Mac's socket, so the wake is a reconnect over SSH, not a resumed socket.
    await new Promise((r) => setTimeout(r, Math.max(0, 12_000 - slept())))
    process.stdout.write(`[fleet] lid closed: walnut attempts ${await attemptsSummary(f, s)}\n`)
    expect((await f.hostAttempts(HOST, s.sid)).at(-1)?.code).toBe(0)
    const recs = await journaledTitle(f, s, title)
    expect(recs).toHaveLength(1)
    // The Mac is still asleep: its store has the old title.
    expect(f.macTask(s.taskId)?.title).not.toBe(title)
    const woke = t0()
    f.wakeMac()
    await waitFor(() => f.macTask(s.taskId)?.title === title, 120_000, 'the Mac to apply the write')
    times.applyAfterWake = woke()
    await waitFor(async () => (await f.hostJournal(HOST)).acked.has(recs[0]!.seq), 60_000, 'the record to be acked')
    await appliedOnce(appliedBefore)
    times.scenario2 = took()
  }, 300_000)

  it('3: a cut link (the Mac awake): the write is journaled, the Mac reconnects by itself and applies it once; a later reconnect applies nothing', async () => {
    const took = t0()
    const title = 'Fixed across a cut link'
    const appliedBefore = appliedLines(f, s.taskId).length
    await startUpdateTurn(f, s, title, 4)
    f.cutLink(HOST, 'severed')
    await updateTurnsEnded(f, s, 2)
    process.stdout.write(`[fleet] cut link: walnut attempts ${await attemptsSummary(f, s)}\n`)
    const recs = await journaledTitle(f, s, title)
    expect(recs).toHaveLength(1)
    expect(f.macTask(s.taskId)?.title).not.toBe(title)
    const healed = t0()
    f.healLink(HOST)
    await waitFor(() => f.macTask(s.taskId)?.title === title, 180_000, 'the Mac to reconnect and apply the write')
    times.applyAfterHeal = healed()
    await waitFor(async () => (await f.hostJournal(HOST)).acked.has(recs[0]!.seq), 60_000, 'the record to be acked')
    await appliedOnce(appliedBefore)
    // The person renames the task at the Mac; one more drop and reconnect applies nothing again.
    const renamed = await f.mac.call('PATCH', `/api/tasks/${s.taskId}`, { title: 'Renamed at the Mac' })
    expect(renamed.status, renamed.text).toBe(200)
    f.cutLink(HOST, 'drop')
    await waitFor(async () => !(await f.hostConnected(HOST)), 60_000, 'the Mac to see the link drop')
    f.healLink(HOST)
    const back = t0()
    await waitFor(() => f.hostConnected(HOST), 180_000, 'the Mac to reconnect again')
    times.reconnectAfterDrop = back()
    await new Promise((r) => setTimeout(r, 5_000))
    expect(f.macTask(s.taskId)?.title).toBe('Renamed at the Mac')
    expect(appliedLines(f, s.taskId).length - appliedBefore).toBe(1)
    times.scenario3 = took()
  }, 420_000)

  it('5: the lid closes right as a session starts; its first turn\'s write is journaled on the host and applied once on wake', async () => {
    const took = t0()
    const title = 'Fixed by a session started just before the lid closed'
    const taskId = await makeTask(f, 'Start, then sleep, on devbox')
    // The task's own push goes by first, so only the start can bring the host the session.
    await new Promise((r) => setTimeout(r, 4_000))
    const started = t0()
    const n = await startSession(f, HOST, taskId, `please update ${taskId} title ${title} after 8s`)
    await waitFor(async () => (await runningTurns(f, n)) > 0, 60_000, 'the CLI on devbox to start the first turn', 100)
    f.sleepMac()
    times.sleptAfterStart = started()
    const slept = t0()
    const copyAtSleep = await f.hostSliceHolds(HOST, n.sid)
    process.stdout.write(`[fleet] lid closed ${times.sleptAfterStart} ms after the start; devbox's copy named the session then: ${copyAtSleep}\n`)
    // The turn writes 8 s in, through the host's offline answer: journaled there, not refused.
    await waitFor(async () => (await journaledTitle(f, n, title)).length > 0, 60_000, 'the first turn\'s write to be journaled on devbox')
      .catch(async (err: Error) => { throw new Error(`${err.message}; walnut attempts ${await attemptsSummary(f, n)}`) })
    await updateTurnsEnded(f, n, 1)
    // Past the host's keepalive, as in row 2: the wake is a reconnect over SSH.
    await new Promise((r) => setTimeout(r, Math.max(0, 12_000 - slept())))
    process.stdout.write(`[fleet] lid closed at the start: walnut attempts ${await attemptsSummary(f, n)}\n`)
    expect(copyAtSleep).toBe(true)
    expect((await f.hostAttempts(HOST, n.sid)).at(-1)?.code).toBe(0)
    const recs = await journaledTitle(f, n, title)
    expect(recs).toHaveLength(1)
    expect(f.macTask(taskId)?.title).not.toBe(title)
    const appliedBefore = appliedLines(f, taskId).length
    const woke = t0()
    f.wakeMac()
    await waitFor(() => f.macTask(taskId)?.title === title, 120_000, 'the Mac to apply the write')
    times.applyAfterStartWake = woke()
    await waitFor(async () => (await f.hostJournal(HOST)).acked.has(recs[0]!.seq), 60_000, 'the record to be acked')
    await appliedOnce(appliedBefore, taskId)
    // When the copy left the Mac, from its log (not asserted: the copy at the lid is).
    const at = (l: string) => Date.parse(JSON.parse(l).time as string)
    const startedAt = f.mac.logLines(/"emit session:started"/).map(at).filter((t) => t <= Date.now() - woke()).at(-1)
    const pushedAt = f.mac.logLines(/host slice pushed/).filter((l) => JSON.parse(l).host === HOST).map(at).find((t) => startedAt !== undefined && t >= startedAt)
    if (startedAt !== undefined && pushedAt !== undefined) process.stdout.write(`[fleet] devbox's copy was pushed ${pushedAt - startedAt} ms after session:started\n`)
    times.scenario5 = took()
  }, 300_000)
})
