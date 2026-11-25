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
 * Not here (the design page's other rows): W2 (a cut in the middle of a write), R3 (a silent link),
 * R4 (the service ended by hand during a call), T1 (a trigger fire while away), and the small-host
 * rehearsal (scripts/release-rehearsal/).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { BUN, HOST_KEY, sleep, startReplicaCluster, waitFor, WINDOWS, type ReplicaCluster } from '../helpers/replica-cluster.js'
import { gatewayCall, keepLogsOnFailure, logSince, macTasks, turnsWith } from '../helpers/replica-cluster-reads.js'

/** The daemon's own away answers, by their log lines (follower-gateway-core.ts noteOwnOffline, daemon-standalone.ts). */
const OWN_LINES = ['gateway: daemon offline answer used', 'gateway: answered offline', 'gateway: delivered on this host', 'gateway: primary timed out, reading from the copy']
const show = (label: string, v: unknown) => process.stdout.write(`copyless-service-e2e: ${label} ${JSON.stringify(v).slice(0, 1200)}\n`)
/**
 * The cluster's test transport runs only the port probes on devbox; the manager's room probe (memory,
 * disk, system) is answered here with a roomy Linux host, so only the person's switch makes it copyless.
 */
const ROOM_PROBE = `{
  const inner = dcm.DaemonConnection.prototype.runRemoteScript
  dcm.DaemonConnection.prototype.runRemoteScript = function (script, timeoutMs) {
    if (this.hostKey === ${JSON.stringify(HOST_KEY)} && typeof script === 'string' && script.includes('mem_total_kb=')) {
      return Promise.resolve('os=Linux\\narch=x86_64\\nlibc=glibc\\ntranslated=0\\nglibc=2.26\\nmem_total_kb=16777216\\nmem_avail_kb=12582912\\ndisk_free_kb=41943040')
    }
    return inner.call(this, script, timeoutMs)
  }
}
`
/** The working program the Mac keeps for the host (host-servers.json). */
const working = (c: ReplicaCluster): { env?: Record<string, string> } | undefined => {
  try { return (JSON.parse(fs.readFileSync(path.join(c.macData, 'host-servers.json'), 'utf8')) as Record<string, { working?: { env?: Record<string, string> } }>)[HOST_KEY]?.working } catch { return undefined }
}

/** The pid of the mock CLI running session `sid`, or 0. */
function cliPid(c: ReplicaCluster, sid: string): number {
  try {
    const mock = path.join(c.base, 'bin', 'mock-claude.cjs')
    const ps = execFileSync('ps', ['-A', '-o', 'pid=', '-o', 'args='], { encoding: 'utf8', maxBuffer: 64 << 20 })
    const row = ps.split('\n').map((l) => l.trim()).find((l) => l.includes(` ${mock} `) && new RegExp(`--(session-id|resume) ${sid}(\\s|$)`).test(l))
    return row ? Number(row.slice(0, row.indexOf(' '))) : 0
  } catch { return 0 }
}

/** The host service's resident memory now (M1, measured on the source build here), in MB, or null off Linux. */
function serviceRssMb(c: ReplicaCluster): number | null {
  try {
    const pid = fs.readFileSync(path.join(c.base, 'hd', 'daemon.pid'), 'utf8').trim()
    const kb = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1]
    return kb ? Math.round(Number(kb) / 1024) : null
  } catch { return null }
}

describe.skipIf(!BUN)('a host\'s one service without a copy, end to end', () => {
  let c: ReplicaCluster
  let hostCwd = ''
  const a = { task: '', sid: '', pid: 0 }
  const b = { task: '', sid: '', pid: 0 }
  /** A task of the Mac no session of the host has: never in the host's slice. */
  let outside = ''

  /** A task started on the host, answered once: its ids and its CLI's pid. */
  async function startOnHost(title: string, words: string): Promise<{ task: string; sid: string; pid: number }> {
    const made = await c.mac('POST', '/api/tasks', { title, project: 'Acme' })
    expect(made.status, JSON.stringify(made.json)).toBe(201)
    const task = made.json.task.id as string
    const st = await c.mac('POST', `/api/v1/tasks/${task}/start`, { host: HOST_KEY, cwd: hostCwd, mode: 'default', message: words })
    expect(st.status, JSON.stringify(st.json)).toBe(202)
    const sid = st.json.sessionId as string
    await waitFor(() => turnsWith(c, sid, words) > 0, 120_000, `"${title}" to answer`)
    expect(turnsWith(c, sid, words)).toBe(1)
    return { task, sid, pid: await waitFor(() => cliPid(c, sid), 30_000, `the CLI of "${title}"`) }
  }

  beforeAll(async () => {
    c = await startReplicaCluster({ hostService: {}, macBootExtra: ROOM_PROBE, macConfigExtra: ['experimental:', '  service_without_copy: true'] })
    show('cluster at', c.base)
    hostCwd = fs.realpathSync(path.join(c.base, 'hh', 'work'))
    const meta = await c.mac('PUT', `/api/v1/projects/${encodeURIComponent('Acme')}/metadata`, { default_host: HOST_KEY, default_cwd: hostCwd })
    expect(meta.status, JSON.stringify(meta.json)).toBeLessThan(300)
    Object.assign(a, await startOnHost('Host worker', 'hello worker'))
    const made = await c.mac('POST', '/api/tasks', { title: 'Unrelated errand', project: 'Other' })
    expect(made.status, JSON.stringify(made.json)).toBe(201)
    outside = made.json.task.id as string
  }, 900_000)

  afterAll(async () => { await c?.stop() }, 120_000)

  it('F1 on: the switch turned off runs the service without a copy, and the session is not cut', async () => {
    keepLogsOnFailure(() => c, 'copyless-on')
    const off = await c.mac('PUT', `/api/host-servers/${HOST_KEY}`, { enabled: false })
    expect(off.status, JSON.stringify(off.json)).toBeLessThan(300)
    await waitFor(() => (working(c)?.env?.WALNUT_COPIES === 'none' ? true : null), 180_000, 'the Mac to send the spec without a copy')
    const view = await waitFor(async () => {
      const r = await c.mac('GET', '/api/host-servers')
      const row = JSON.stringify(r.json).includes('"copyless":true') ? r.json : null
      return row
    }, 180_000, 'the host card to say it runs without a copy')
    show('host servers', view)
    // The service took the new spec (it starts again from it): a call through it answers.
    await waitFor(async () => ((await gatewayCall(c, a.sid, 'walnut_status', {})).ok === true ? true : null), 180_000, 'the service to answer again')
    // The session that ran across the switch: the same CLI, alive (the new service adopted it).
    expect(cliPid(c, a.sid)).toBe(a.pid)
    // A session started on the service without a copy runs and answers.
    Object.assign(b, await startOnHost('Host helper', 'hello helper'))
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
    const posts = await waitFor(async () => {
      const r = await c.mac('GET', `/api/v1/tasks/${a.task}/board`)
      const list = ((r.json?.threads ?? {}) as Record<string, Array<{ text?: string }>>).away ?? []
      const mine = list.filter((m) => m.text === 'posted while the Mac was away')
      return mine.length ? mine : null
    }, 120_000, 'the away post to land on the Mac')
    // A while more: a second apply of the same record would come in the same drain or the next.
    await sleep(10_000)
    const again = await c.mac('GET', `/api/v1/tasks/${a.task}/board`)
    const all = (((again.json?.threads ?? {}) as Record<string, Array<{ text?: string }>>).away ?? []).filter((m) => m.text === 'posted while the Mac was away')
    show('the away posts on the Mac', { first: posts.length, later: all.length })
    expect(all).toHaveLength(1)
  }, 600_000)

  it('F1 off: the switch turned on again keeps a copy, and the sessions are still not cut', async () => {
    keepLogsOnFailure(() => c, 'copyless-off')
    const on = await c.mac('PUT', `/api/host-servers/${HOST_KEY}`, { enabled: true })
    expect(on.status, JSON.stringify(on.json)).toBeLessThan(300)
    await waitFor(() => (working(c) && working(c)?.env?.WALNUT_COPIES === undefined ? true : null), 180_000, 'the Mac to send the spec with a copy again')
    await waitFor(async () => ((await gatewayCall(c, a.sid, 'walnut_status', {})).ok === true ? true : null), 180_000, 'the service to answer again')
    expect(cliPid(c, a.sid)).toBe(a.pid)
    expect(cliPid(c, b.sid)).toBe(b.pid)
    await startOnHost('Host helper again', 'hello again')
    show('service resident MB with a copy', serviceRssMb(c))
  }, 600_000)
})
