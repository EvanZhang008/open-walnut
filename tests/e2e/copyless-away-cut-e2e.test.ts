/**
 * A host's one Walnut service without a copy (experiment service_without_copy) when its leader goes
 * in the middle of things, every piece a real process (tests/helpers/copyless-cluster.ts: the Mac
 * server with its daemon, the host under its launcher switched to its one service without a copy),
 * the Mac's link to the host's door run through a TCP proxy (`linkProxy`, silent-link-proxy.ts). Every
 * call is a host session's own `walnut` CLI, run inside the session (startSessionCaller), its wait
 * 30 s on this host (CLI_WAIT_MS; 90 s by default).
 *
 *   W2   the link cut in the middle of a write: the link made far (every chunk 2.5 s late), a
 *        board_post sent, the Mac applies it, and the link is closed before its answer comes back.
 *        The CLI says it may have run, with its call id, at the end of its wait, and the session sends
 *        it again with that id, as those lines tell it to: the leader is away at once (a closed link), so the
 *        service journals it, one record. The link back, the drain applies it under the call's op
 *        id, which the Mac's applied-ops ledger already holds from the first try: the post is on the
 *        Mac's Board once.
 *   R3   the Mac silent (SIGSTOP, no close): a read and a write sent into the silence, then a read
 *        a second for ten seconds. Every read errs with the no-copy words: one relayed to the Mac
 *        before the gateway counted its beats missed falls to the service once its first attempt
 *        goes unanswered (gateway-core.ts readFallsToService), within the hub timeout and not the
 *        CLI's whole wait; one sent later waits at most until the presence turns away; from then
 *        every read errs in well under a second. The write sent into the silence ends within the
 *        CLI's wait saying it may have run, with its call id; sent again with that id it is
 *        journaled once, and on the Mac once after it wakes. No call of that time is the daemon's
 *        own away answer (G1).
 *
 * Run time about 2.5 minutes (boot and switch about 40 s, W2 about 45 s, R3 about 45 s).
 * `bun --bun vitest run --config vitest.e2e.config.ts tests/e2e/copyless-away-cut-e2e.test.ts`
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BUN, sleep, waitFor, WINDOWS, type ReplicaCluster } from '../helpers/replica-cluster.js'
import { hostJournal, keepLogsOnFailure, logSince } from '../helpers/replica-cluster-reads.js'
import {
  boardPosts, CLI_WAIT_MS, OWN_LINES, startCopylessCluster, startOnHost, startSessionCaller, switchToCopyless,
  type CallerAnswer, type CopylessCluster, type HostTask, type SessionCaller,
} from '../helpers/copyless-cluster.js'
import { newCallId } from '../../src/lib/op-call-id.js'
import { GATEWAY_HUB_TIMEOUT_MS } from '../../src/providers/gateway-core.js'

const show = (label: string, v: unknown) => process.stdout.write(`copyless-away-cut-e2e: ${label} ${JSON.stringify(v).slice(0, 1500)}\n`)
const NO_COPY = 'keeps no copy of your data'

describe.skipIf(!BUN)('a host\'s one service without a copy, its leader cut off or silent mid-call', () => {
  let k: CopylessCluster
  let c: ReplicaCluster
  let a: HostTask
  let caller: SessionCaller
  /** A task of the Mac no session of the host has: never in the host's slice. */
  let outside = ''
  /** The journal records a call made (its op ids start with the call id: op-call-id.ts writeOpId). */
  const recordsOf = (callId: string) => hostJournal(c).filter((r) => String(r.opId ?? '').startsWith(`${callId}-`))
  const said = (r: CallerAnswer) => `${r.stdout}\n${r.stderr}`

  beforeAll(async () => {
    k = await startCopylessCluster({ linkProxy: true })
    c = k.c
    show('cluster at', c.base)
    const warm = await startOnHost(k, 'Host warmup', 'hello warmup')
    await switchToCopyless(c, warm.sid)
    // Started on the service without a copy, so the Mac's messages reach it (its caller runs in a turn).
    a = await startOnHost(k, 'Host worker', 'hello worker')
    caller = await startSessionCaller(k, a)
    const made = await c.mac('POST', '/api/tasks', { title: 'Unrelated errand', project: 'Other' })
    expect(made.status, JSON.stringify(made.json)).toBe(201)
    outside = made.json.task.id as string
    // A Board with one thread on the worker's task: a post is an append (each its own id), so one applied twice shows twice.
    const set = await c.mac('PUT', `/api/v1/tasks/${a.task}/board`, { html: '<h2>Plan</h2><walnut-thread id="away"></walnut-thread>' })
    expect(set.status, JSON.stringify(set.json)).toBeLessThan(300)
    await sleep(3_000)
  }, 900_000)

  afterAll(async () => { await c?.stop() }, 120_000)

  it('W2: the link cut in the middle of a write: one journal record, and one apply on the Mac once it is back', async () => {
    keepLogsOnFailure(() => c, 'copyless-w2')
    const text = 'posted across the cut'
    const args = { task: a.task, thread: 'away', text }
    // Far, still alive: every chunk 2.5 s late but none waits behind another (latencyOnly), so the
    // beats come a second apart, under the gateway's silent beats and the quiet window: the Mac still leads.
    // (One chunk at a time, the default, adds 2.5 s per waiting beat: the leader then reads quiet within seconds.)
    c.slowLink({ delayMs: 2_500, bytesPerSec: 50 * 1024 * 1024, latencyOnly: true })
    let lost: CallerAnswer
    let appliedMs: number
    const callId = newCallId()
    try {
      await sleep(4_000)
      const t0 = Date.now()
      const first = caller.call('board_post', args, { callId })
      // The Mac applied it (its own Board, read on its own loopback) while its answer is still on the slow link: cut now.
      appliedMs = await waitFor(async () => ((await boardPosts(c, a.task, 'away', text)) > 0 ? Date.now() - t0 : null), 60_000, 'the Mac to apply the write', 50)
      c.cutLink()
      lost = await first
    } catch (err) {
      c.mendLink()
      throw err
    }
    show('the first try', { appliedMs, ms: lost.ms, code: lost.code, said: said(lost).slice(0, 800) })
    // Never a false "done" or "nothing happened": the caller hears it may have run, and how to send it again.
    expect(lost.code, said(lost)).not.toBe(0)
    expect(said(lost)).toContain(callId)
    expect(said(lost)).toContain('it may have run')
    // The same call again with its id: the closed link is away at once, so the service journals it.
    const again = await caller.call('board_post', args, { callId })
    show('the resend', { ms: again.ms, code: again.code, json: again.json })
    expect(again.code, said(again)).toBe(0)
    expect(again.json?.queued).toBe(true)
    expect(recordsOf(callId)).toHaveLength(1)
    c.mendLink()
    await waitFor(() => (recordsOf(callId).length === 0 ? true : null), 180_000, 'the record to drain and be acked')
    // A second apply of the same record would come in the same drain or the next.
    await sleep(10_000)
    expect(await boardPosts(c, a.task, 'away', text)).toBe(1)
  }, 600_000)

  it('R3: the Mac silent: no call hangs, reads err at once once it is away, and a sent write lands once', async () => {
    keepLogsOnFailure(() => c, 'copyless-r3')
    const text = 'posted into the silence'
    const args = { task: a.task, thread: 'away', text }
    const callId = newCallId()
    const from = Date.now()
    const slept = c.sleepMac()
    const t0 = slept.after
    const answers: Array<{ name: string; at: number; r: CallerAnswer }> = []
    const timed = (name: string, a2: Record<string, unknown>, id?: string) => caller.call(name, a2, id ? { callId: id } : {})
      .then((r) => { answers.push({ name, at: r.startMs - t0, r }); return r })
    try {
      const calls: Promise<unknown>[] = [timed('task_get', { id: outside })]
      await sleep(300)
      calls.push(timed('board_post', args, callId))
      for (let i = 0; i < 10; i++) { await sleep(1_000); calls.push(timed('task_get', { id: outside })) }
      await Promise.all(calls)
      show('answers in the silence [name, sent at ms, took ms, exit code, no-copy words]', answers.map((x) => [x.name, x.at, x.r.ms, x.r.code, said(x.r).includes(NO_COPY)]))
      const reads = answers.filter((x) => x.name === 'task_get')
      expect(reads).toHaveLength(11)
      // Every read errs with the no-copy words, a read relayed into the silence too: it falls to the
      // service once its first attempt goes unanswered (the hub timeout), never held for the CLI's whole wait.
      for (const x of reads) {
        expect(x.r.code, said(x.r)).not.toBe(0)
        expect(said(x.r), JSON.stringify(x)).toContain(NO_COPY)
        expect(x.r.ms, JSON.stringify(x)).toBeLessThan(GATEWAY_HUB_TIMEOUT_MS + 4_000)
      }
      // From the flip on (the quiet window past the last beat), every read errs at once.
      const late = reads.filter((x) => x.at >= WINDOWS.quietMs + 1_000)
      expect(late.length).toBeGreaterThanOrEqual(3)
      for (const x of late) expect(x.r.ms, JSON.stringify(x)).toBeLessThan(3_000)
      // The write was sent into the silence: it may have run, so the caller hears that, and sends it again with its id.
      const sent = answers.find((x) => x.name === 'board_post')!
      expect(sent.r.code, said(sent.r)).not.toBe(0)
      expect(said(sent.r)).toContain('it may have run')
      expect(said(sent.r)).toContain(callId)
      expect(sent.r.ms).toBeLessThan(CLI_WAIT_MS + 5_000)
      const again = await caller.call('board_post', args, { callId })
      show('the resend', { ms: again.ms, json: again.json })
      expect(again.code, said(again)).toBe(0)
      expect(again.json?.queued).toBe(true)
      expect(recordsOf(callId)).toHaveLength(1)
      // G1: nothing of that time was the daemon's own away answer.
      expect(logSince(c, from).filter((l) => OWN_LINES.includes(String(l.msg))).map((l) => `${l.msg} ${l.op ?? ''}`)).toEqual([])
    } finally {
      if (c.asleep()) c.wakeMac()
    }
    await waitFor(() => (recordsOf(callId).length === 0 ? true : null), 180_000, 'the record to drain and be acked')
    // The first try, still in the Mac's socket when it woke, and the drained resend: one post.
    await sleep(10_000)
    expect(await boardPosts(c, a.task, 'away', text)).toBe(1)
  }, 600_000)
})
