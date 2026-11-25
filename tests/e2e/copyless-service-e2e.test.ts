/**
 * A host's one Walnut service without a copy of the leader's data (experiment
 * service_without_copy), every piece a real process (tests/helpers/replica-cluster.ts with
 * `hostService`: the Mac server with its daemon, the host under its launcher, switched to its one
 * service):
 *
 *   F1 on    a session runs on the host; the person turns the host's Walnut off with the experiment
 *            on: the Mac sends the spec with WALNUT_COPIES=none, the service starts again without a
 *            copy, the session's CLI is the same process after it (adopted, not cut), and a session
 *            started after the switch runs and answers. (A message to the first session after the
 *            switch is not asserted here: the cluster's test transport pins each session's own link
 *            to the door port of its start, which a service restart changes; over ssh it does not.)
 *   S1, R1   the Mac away (SIGSTOP past its quiet window): the session's own task answers from the
 *            slice; a read outside it (another task, memory_read, search) answers the `no_copy`
 *            words in under a second.
 *   W1       a task_update and a Board post (an append) while away are journaled and land once on
 *            the Mac when it is back; the team's Board is found from the slice.
 *   G1       no call of that time was answered by the daemon's own away code.
 *   F1 off   the switch turned on again: the spec loses the line, the service keeps a copy again,
 *            both sessions' CLIs are still the same processes, and a new session answers.
 *
 * Elsewhere: W2 (a cut in the middle of a write) and R3 (a silent link) in
 * tests/e2e/copyless-away-cut-e2e.test.ts, R4 (the service ended by hand during a call) and T1 (a
 * trigger fire while away) in tests/e2e/copyless-away-restart-e2e.test.ts, and the small-host
 * rehearsal (scripts/release-rehearsal/).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BUN, HOST_KEY, sleep, waitFor, WINDOWS, type ReplicaCluster } from '../helpers/replica-cluster.js'
import { gatewayCall, keepLogsOnFailure, logSince, macTasks, sessionCliPid } from '../helpers/replica-cluster-reads.js'
import { boardPosts, OWN_LINES, serviceRssMb, startCopylessCluster, startOnHost, switchToCopyless, workingProgram, type CopylessCluster, type HostTask } from '../helpers/copyless-cluster.js'

const show = (label: string, v: unknown) => process.stdout.write(`copyless-service-e2e: ${label} ${JSON.stringify(v).slice(0, 1200)}\n`)

describe.skipIf(!BUN)('a host\'s one service without a copy, end to end', () => {
  let k: CopylessCluster
  let c: ReplicaCluster
  const a: HostTask = { task: '', sid: '', pid: 0 }
  const b: HostTask = { task: '', sid: '', pid: 0 }
  /** A task of the Mac no session of the host has: never in the host's slice. */
  let outside = ''

  beforeAll(async () => {
    k = await startCopylessCluster()
    c = k.c
    show('cluster at', c.base)
    Object.assign(a, await startOnHost(k, 'Host worker', 'hello worker'))
    const made = await c.mac('POST', '/api/tasks', { title: 'Unrelated errand', project: 'Other' })
    expect(made.status, JSON.stringify(made.json)).toBe(201)
    outside = made.json.task.id as string
  }, 900_000)

  afterAll(async () => { await c?.stop() }, 120_000)

  it('F1 on: the switch turned off runs the service without a copy, and the session is not cut', async () => {
    keepLogsOnFailure(() => c, 'copyless-on')
    show('host servers', await switchToCopyless(c, a.sid))
    // The session that ran across the switch: the same CLI, alive (the new service adopted it).
    expect(sessionCliPid(c, a.sid)).toBe(a.pid)
    // A session started on the service without a copy runs and answers.
    Object.assign(b, await startOnHost(k, 'Host helper', 'hello helper'))
    show('service resident MB without a copy', serviceRssMb(c))
  }, 600_000)

  it('S1, R1, W1, G1: the Mac away, slice reads answer, the rest is no_copy at once, a write lands once', async () => {
    keepLogsOnFailure(() => c, 'copyless-away')
    // A Board on the worker's task, with one thread: an away post is an append (the Mac gives each
    // post its own id), so a post applied twice would show twice.
    const set = await c.mac('PUT', `/api/v1/tasks/${a.task}/board`, { html: '<h2>Plan</h2><walnut-thread id="away"></walnut-thread>' })
    expect(set.status, JSON.stringify(set.json)).toBeLessThan(300)
    await sleep(3_000)
    const from = Date.now()
    const slept = c.sleepMac()
    try {
      const quietAt = slept.after + WINDOWS.quietMs + 2_000
      if (Date.now() < quietAt) await sleep(quietAt - Date.now())
      // S1: the session's own task, and the seeded host session's, from the slice (the service may still be seating itself: retried).
      for (const id of [a.task, c.ids.other]) {
        const own = await waitFor(async () => {
          const r = await gatewayCall(c, a.sid, 'task_get', { id })
          return r.ok === true ? r : null
        }, 60_000, `the host session's task ${id} to answer while the Mac is away`)
        expect(JSON.stringify(own)).toContain(id)
      }
      // R1: a read outside the slice (a task no host session has, memory, search) answers no_copy at once.
      for (const [name, args] of [['memory_read', { doc: 'user' }], ['task_get', { id: outside }], ['search', { query: 'drill' }]] as const) {
        const t0 = Date.now()
        const r = await gatewayCall(c, a.sid, name, args)
        const ms = Date.now() - t0
        show(`${name} away (${ms} ms)`, r)
        expect(r.ok, JSON.stringify(r)).toBe(false)
        // The why stays on the follower (replica/local-calls.ts awayReply): the caller hears its words.
      expect(JSON.stringify(r)).toContain('keeps no copy of your data')
        expect(ms).toBeLessThan(1_000)
      }
      // W1: a write while away is journaled.
      const w = await gatewayCall(c, a.sid, 'task_update', { id: a.task, tags: ['copyless-away'] })
      show('task_update away', w)
      expect(w.ok, JSON.stringify(w)).toBe(true)
      // The team's Board is found from the slice (its owner and its page), and a post on it is journaled.
      const board = await waitFor(async () => {
        const r = await gatewayCall(c, a.sid, 'board_get', { task: a.task })
        return r.ok === true ? r : null
      }, 30_000, 'the Board to answer from the slice')
      expect(JSON.stringify(board)).toContain('walnut-thread')
      const post = await gatewayCall(c, a.sid, 'board_post', { task: a.task, thread: 'away', text: 'posted while the Mac was away' })
      show('board_post away', post)
      expect(post.ok, JSON.stringify(post)).toBe(true)
      // G1: nothing of that time was the daemon's own away answer.
      expect(logSince(c, from).filter((l) => OWN_LINES.includes(String(l.msg))).map((l) => `${l.msg} ${l.op ?? ''}`)).toEqual([])
    } finally {
      if (c.asleep()) c.wakeMac()
    }
    await waitFor(() => (String(macTasks(c).find((t) => t.id === a.task)?.tags ?? '').includes('copyless-away') ? true : null), 180_000, 'the write to land on the Mac')
    const tags = String(macTasks(c).find((t) => t.id === a.task)?.tags ?? '')
    show('the task\'s tags on the Mac', tags)
    expect(tags.match(/copyless-away/g) ?? []).toHaveLength(1)
    // Once: the post, an append, is on the Mac's Board one time.
    const first = await waitFor(async () => (await boardPosts(c, a.task, 'away', 'posted while the Mac was away')) || null, 120_000, 'the away post to land on the Mac')
    // A while more: a second apply of the same record would come in the same drain or the next.
    await sleep(10_000)
    const later = await boardPosts(c, a.task, 'away', 'posted while the Mac was away')
    show('the away posts on the Mac', { first, later })
    expect(later).toBe(1)
  }, 600_000)

  it('F1 off: the switch turned on again keeps a copy, and the sessions are still not cut', async () => {
    keepLogsOnFailure(() => c, 'copyless-off')
    const on = await c.mac('PUT', `/api/host-servers/${HOST_KEY}`, { enabled: true })
    expect(on.status, JSON.stringify(on.json)).toBeLessThan(300)
    await waitFor(() => (workingProgram(c) && workingProgram(c)?.env?.WALNUT_COPIES === undefined ? true : null), 180_000, 'the Mac to send the spec with a copy again')
    await waitFor(async () => ((await gatewayCall(c, a.sid, 'walnut_status', {})).ok === true ? true : null), 180_000, 'the service to answer again')
    expect(sessionCliPid(c, a.sid)).toBe(a.pid)
    expect(sessionCliPid(c, b.sid)).toBe(b.pid)
    await startOnHost(k, 'Host helper again', 'hello again')
    show('service resident MB with a copy', serviceRssMb(c))
  }, 600_000)
})
