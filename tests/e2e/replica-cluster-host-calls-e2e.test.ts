/**
 * A host's own service answers its sessions' calls, by both doors, with the Mac awake and away,
 * end to end, every piece a real process (tests/helpers/replica-cluster.ts): the Mac server with
 * its daemon, the host daemon twin, and the follower (`web --replica`) that daemon supervises,
 * with the `host_call_entry` experiment on in the Mac's settings (its copy reaches the follower,
 * which then says its call entry's address to its daemon).
 *
 *   setup      A ("Host caller") and B ("Host target") run on devbox, both started after the
 *              follower said its address: A's CLI has the entry's address and its token (WALNUT_CALL_*).
 *              The new door: the client a session's `walnut` uses (host-call-client-core.ts) with that env; the old door:
 *              the daemon's gateway socket.
 *   awake      walnut_status by the new door is the Mac's answer, relayed; a plain same-host send
 *              A -> B by the old door is taken by the follower (online) and reaches B.
 *   away       (the Mac SIGSTOPped past its quiet window) by the new door as A: task_create with a
 *              start, task_update tags, task_send to B asking a reply (rq1) and one asking it by
 *              default (rq2); by the old door as B: the reply to rq1, agent_memory_write on A's
 *              task, human_inbox_send, a trigger on B's task that fires (list, test, delivery by
 *              the follower, pause, resume); one task_update sent twice at once with one call id;
 *              task_history of B. The journal holds each record once, and the daemon never
 *              answers with its own away code ("gateway: daemon offline answer used").
 *   wake       the Mac holds each exactly once; B answers rq2 with the Mac awake; asleep and awake
 *              again, nothing changes.
 *   local      (core/replication/host-private.ts) in a project that syncs to a fixture service of
 *              the Mac: a task created Local never reaches the replica's copy, one made local
 *              after it was copied leaves it at the next round, and a host session's call about
 *              either while the Mac sleeps is `needs_leader {why:'task_kept_local'}`, by both doors,
 *              with no daemon away answer.
 *
 * Twins: as tests/e2e/replica-cluster-e2e.test.ts (REPLICA_CLUSTER_TWINS picks).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { HostCallOutcome } from '../../src/providers/host-call-client-core.js'
import { BUN, sleep, startReplicaCluster, waitFor, WINDOWS, type ReplicaCluster, type Twin } from '../helpers/replica-cluster.js'
import {
  callEnvOf, entryCall, entryGiven, gatewayCall, hostDaemonLog, hostJournal as journal, hostStream, keepLogsOnFailure, macSessions, macTasks,
  replicaKnowsDefaultHost, replicaRows, sessionCliEnv,
} from '../helpers/replica-cluster-reads.js'

const TWINS = (process.env.REPLICA_CLUSTER_TWINS ?? (BUN ? 'source,standalone' : 'source')).split(',').map((t) => t.trim()).filter((t): t is Twin => t === 'source' || t === 'standalone')
const NEW_TITLE = 'Book the venue from the host'
const T = {
  online: 'online note for the target', rq1: 'please check the venue list', rq2: 'please confirm the caterer',
  reply1: 'the venue list is checked', reply2: 'the caterer is confirmed', memory: 'Venue list checked by the target while the Mac slept.',
  letter: 'Venue booking review', fire: 'The venue watch fired: look at e1.',
} as const
const OFFLINE_LINE = 'gateway: daemon offline answer used'
/** A fixture task service of the Mac (a no-op sync): a project that syncs to it is where a task is kept local. */
const SERVICE = 'acmesync'
const SERVICE_CONFIG = ['plugins:', `  ${SERVICE}:`, '    enabled: true', 'private_tasks:', '  providers:', `    ${SERVICE}:`, '      check: false']
function seedService({ macData }: { macData: string }): void {
  const dir = path.join(macData, 'plugins', SERVICE)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: SERVICE, name: 'Acme sync', version: '1.0.0', external: true }))
  const noops = ['deleteTask', 'updateTitle', 'updateDescription', 'updateSummary', 'updateNote', 'updateConversationLog', 'updatePriority', 'updatePhase',
    'updateDueDate', 'updateProject', 'updateDependencies', 'associateSubtask', 'disassociateSubtask', 'syncPoll']
  fs.writeFileSync(path.join(dir, 'index.mjs'), `const noop = async () => {};
export default function register(api) {
  api.registerSync({ createTask: async () => null, pushTask: async () => ({ serverTimestamp: new Date().toISOString() }), ${noops.map((n) => `${n}: noop`).join(', ')} });
}
`)
}
/** The replica's copy of the tasks, by id. */
const replicaTaskIds = (c: ReplicaCluster): string[] => replicaRows(c, 'SELECT id FROM tasks', path.join('tasks', 'tasks.sqlite')).map((r) => String(r.id))
/** The ids the replica's copy says the Mac keeps local (kinds/local-tasks.ts). */
function replicaLocalTasks(c: ReplicaCluster): string[] {
  try { return Object.keys((JSON.parse(fs.readFileSync(path.join(c.replicaData, 'cache', 'replica', 'local-tasks.json'), 'utf8')) as { rows?: Record<string, unknown> }).rows ?? {}) } catch { return [] }
}
const HANDED = 'gateway: handed to this host\'s Walnut server'

/** Lines of the daemon log written since `from` (ms). */
const logSince = (c: ReplicaCluster, from: number) => hostDaemonLog(c).filter((l) => Date.parse(String(l.ts)) >= from)
/** How many messages holding `text` were delivered into `sid` on the host (the daemon's marker of each delivered line). */
const deliveries = (c: ReplicaCluster, sid: string, text: string) => hostStream(c, sid).filter((l) => l.type === 'user' && l.subtype === 'walnut-injected' && JSON.stringify(l.message ?? '').includes(text)).length
const delivered = (c: ReplicaCluster, sid: string, text: string) => deliveries(c, sid, text) > 0
/** How many turns of `sid` answered `text` (the mock echoes the words it got). */
const turnsWith = (c: ReplicaCluster, sid: string, text: string) => hostStream(c, sid).filter((l) => l.type === 'result' && String(l.result).includes(text)).length
/** The outermost user rows under `v` whose text holds `needle`. */
function userRowsWith(v: unknown, needle: string): number {
  if (Array.isArray(v)) return v.reduce((n, x) => n + userRowsWith(x, needle), 0)
  if (!v || typeof v !== 'object') return 0
  const o = v as Record<string, unknown>
  if ((o.role === 'user' || o.type === 'user') && JSON.stringify(o).includes(needle)) return 1
  return Object.values(o).reduce<number>((n, x) => n + userRowsWith(x, needle), 0)
}
/** Every object under `v` whose `key` is `value`. */
function having(v: unknown, key: string, value: string, out: Array<Record<string, any>> = []): Array<Record<string, any>> {
  if (Array.isArray(v)) { for (const x of v) having(x, key, value, out); return out }
  if (!v || typeof v !== 'object') return out
  const o = v as Record<string, any>
  if (o[key] === value) out.push(o)
  for (const x of Object.values(o)) having(x, key, value, out)
  return out
}
const withId = (v: unknown, id: string) => having(v, 'id', id)
/** The gateway answer the entry gave (the entry took the line). */
const answerOf = (o: HostCallOutcome, name: string) => { expect(o.kind, `${name}: ${JSON.stringify(o).slice(0, 1500)}`).toBe('answer'); return (o as Extract<HostCallOutcome, { kind: 'answer' }>).resp as Record<string, any> }
const okOf = (r: Record<string, any>) => { expect(r.ok, JSON.stringify(r).slice(0, 2000)).toBe(true); return r.result as Record<string, any> }
const show = (label: string, v: unknown) => process.stdout.write(`replica-cluster-host-calls-e2e: ${label} ${JSON.stringify(v).slice(0, 1500)}\n`)

describe.each(TWINS)('a host\'s own service answers its sessions\' calls by both doors (%s twin)', (twin) => {
  let c: ReplicaCluster
  let token = ''
  let hostCwd = ''
  const a = { task: '', sid: '' }
  const b = { task: '', sid: '' }
  /** The entry env A's CLI was given (its address and its token, WALNUT_CALL_*). */
  let entry: Record<string, string> = {}
  let newTask = ''
  let newSid = ''
  let rq1 = ''
  let rq2 = ''
  let triggerId = ''
  let seqMark = 0
  /** Files that end B's held turns (the mock's "please hold until <path>"). */
  let gate1 = ''
  let gate2 = ''

  async function startSession(title: string, words: string): Promise<{ task: string; sid: string }> {
    const made = await c.mac('POST', '/api/tasks', { title, project: 'Acme' })
    expect(made.status, JSON.stringify(made.json)).toBe(201)
    const st = await c.mac('POST', `/api/v1/tasks/${made.json.task.id}/start`, { host: 'devbox', cwd: hostCwd, mode: 'default', message: words })
    expect(st.status, JSON.stringify(st.json)).toBe(202)
    const sid = st.json.sessionId as string
    await waitFor(() => turnsWith(c, sid, words) > 0, 120_000, `${title} to answer`)
    return { task: made.json.task.id as string, sid }
  }

  beforeAll(async () => {
    c = await startReplicaCluster({ twin, seedMac: seedService, macConfigExtra: ['experimental:', '  host_call_entry: true', ...SERVICE_CONFIG] })
    process.stdout.write(`replica-cluster-host-calls-e2e: ${twin} cluster at ${c.base}\n`)
    hostCwd = fs.realpathSync(path.join(c.base, 'hh', 'work'))
    gate1 = path.join(hostCwd, 'gate-rq1')
    gate2 = path.join(hostCwd, 'gate-rq2')
    token = await c.pairDevice('marina-phone')
    const meta = await c.mac('PUT', `/api/v1/projects/${encodeURIComponent('Acme')}/metadata`, { default_host: 'devbox', default_cwd: hostCwd })
    expect(meta.status, JSON.stringify(meta.json)).toBeLessThan(300)
    // The experiment reaches the follower in its config copy; it says its socket at its next report (5 s).
    await waitFor(() => { try { return fs.readFileSync(path.join(c.replicaData, 'cache', 'replica', 'config.json'), 'utf8').includes('host_call_entry') } catch { return false } }, 120_000, 'the experiment in the follower\'s config copy')
    await sleep(12_000)
    Object.assign(a, await startSession('Host caller', 'hello caller'))
    Object.assign(b, await startSession('Host target', 'hello target'))
    await waitFor(() => { const h = (c.stores().sessions as { hashes?: Record<string, string> } | null)?.hashes ?? {}; return h[a.sid] && h[b.sid] ? true : null }, 120_000, 'the copies to hold both sessions')
    await waitFor(() => (replicaKnowsDefaultHost(c, 'Acme', 'devbox') ? true : null), 60_000, 'the follower\'s copy to hold the project\'s default host')
  }, 900_000)

  afterAll(async () => { await c?.stop() }, 120_000)

  it('setup: a session started after the follower said its address has the entry\'s address and its own token', () => {
    keepLogsOnFailure(() => c, `host-calls-${twin}`)
    const env = sessionCliEnv(c, a.sid)
    expect(env, 'the caller session\'s CLI process').not.toBeNull()
    entry = callEnvOf(env!)
    // Taken by the very client a session's `walnut` uses, whatever the address's shape.
    expect(entryGiven(entry), `the entry env A was given: ${JSON.stringify(entry)} (WALNUT_* names: ${Object.keys(env!).filter((k) => k.startsWith('WALNUT_')).join(', ')})`).toBe(true)
    expect(entry.WALNUT_CALL_TOKEN ?? '').toMatch(/^[0-9a-f]{64}$/)
    expect(env!.WALNUT_AGENT_SOCKET ?? '').not.toBe('')
    // B's token is its own.
    expect(sessionCliEnv(c, b.sid)?.WALNUT_CALL_TOKEN).not.toBe(entry.WALNUT_CALL_TOKEN)
  })

  it('the Mac awake: the new door relays a read to the Mac; a same-host send by the old door is the follower\'s', async () => {
    keepLogsOnFailure(() => c, `host-calls-${twin}`)
    const from = Date.now()
    // A token the daemon did not give: refused before anything runs.
    const wrong = await entryCall({ ...entry, WALNUT_CALL_TOKEN: 'f'.repeat(64) }, a.sid, 'walnut_status', {})
    expect(wrong.kind, JSON.stringify(wrong)).toBe('not_taken')
    const st = okOf(answerOf(await entryCall(entry, a.sid, 'walnut_status', {}), 'walnut_status'))
    show('walnut_status awake', st)
    expect(JSON.stringify(st)).not.toContain('HOST_OFFLINE')
    const sent = okOf(await gatewayCall(c, a.sid, 'task_send', { to: b.task, text: T.online, expect_reply: false }))
    show('online send', sent)
    await waitFor(() => turnsWith(c, b.sid, T.online) > 0, 60_000, 'the online send to reach B')
    const lines = logSince(c, from)
    expect(lines.some((l) => l.msg === HANDED && l.op === 'task_send' && l.callerSid === a.sid), 'the follower took the same-host send').toBe(true)
    expect(lines.filter((l) => l.msg === HANDED && l.op === 'walnut_status'), 'a read is the Mac\'s while it answers').toHaveLength(0)
    expect(lines.filter((l) => String(l.msg).includes('did not answer a same-host send') || l.msg === 'gateway: delivered on this host')).toHaveLength(0)
    expect(lines.filter((l) => l.msg === OFFLINE_LINE).map((l) => l.op)).toEqual([])
  }, 300_000)

  it('the Mac away: every call by either door is the follower\'s, journaled once, with no daemon away answer', async () => {
    keepLogsOnFailure(() => c, `host-calls-${twin}`)
    seqMark = journal(c).reduce((m, r) => Math.max(m, r.seq as number), 0)
    const slept = c.sleepMac()
    await c.waitAway(token)
    const quietAt = slept.after + WINDOWS.quietMs + 1_000
    if (Date.now() < quietAt) await sleep(quietAt - Date.now())
    const asA = async (name: string, args: Record<string, unknown>, callId?: string) => {
      const t0 = Date.now()
      const r = answerOf(await entryCall(entry, a.sid, name, args, callId), name)
      show(`${name} took ${Date.now() - t0} ms`, r.ok)
      return r
    }

    // By the new door, as A.
    const created = okOf(await asA('task_create', { title: NEW_TITLE, project: 'Acme', message: 'start on the host' }))
    newTask = String(created.id ?? created.task?.id ?? '')
    expect(newTask).not.toBe('')
    okOf(await asA('task_update', { id: newTask, tags: ['team:acme'] }))
    // B's turn on rq1 runs until B replied (as a model's turn does): a turn that ends unanswered
    // settles the request as `notified` (the asker is told), here and on the Mac alike.
    const s1 = okOf(await asA('task_send', { to: b.task, text: `${T.rq1} please hold until ${gate1}`, expect_reply: true }))
    show('rq1 send', s1)
    rq1 = String(s1.requestId ?? s1.request_id ?? '')
    expect(rq1, 'rq1 asks a reply').toMatch(/^rq-[a-f0-9]{6,}$/)
    await waitFor(() => delivered(c, b.sid, T.rq1), 60_000, 'rq1 to reach B')

    // By the old door, as B.
    okOf(await gatewayCall(c, b.sid, 'task_send', { to: a.task, in_reply_to: rq1, text: T.reply1, result: 'Checked.' }))
    await waitFor(() => delivered(c, a.sid, T.reply1), 60_000, 'the reply to reach A')
    fs.writeFileSync(gate1, '')
    await waitFor(() => turnsWith(c, b.sid, `released ${gate1}`) > 0, 60_000, 'B\'s turn on rq1 to end')
    okOf(await gatewayCall(c, b.sid, 'agent_memory_write', { task: a.task, content: T.memory, mode: 'append' }))
    okOf(await gatewayCall(c, b.sid, 'human_inbox_send', { subject: T.letter, type: 'review', markdown: 'The venue list was checked on devbox.' }))
    const check = path.join(hostCwd, 'venue-check.sh')
    fs.writeFileSync(check, 'echo \'{"fire":true,"items":[{"id":"e1"}]}\'\n', { mode: 0o755 })
    const armedAt = Date.now()
    const armedT0 = Date.now()
    const armedAnswer = await gatewayCall(c, b.sid, 'trigger_create', { run: `sh ${check}`, every: '10s', prompt: T.fire, description: 'Checks the venue list every 10 seconds; on a new entry the session looks at it.', name: 'Venue watch' })
    show(`trigger_create took ${Date.now() - armedT0} ms`, armedAnswer)
    expect.soft(armedAnswer.ok, `trigger_create: ${JSON.stringify(armedAnswer).slice(0, 1500)}`).toBe(true)
    const listed = okOf(await gatewayCall(c, b.sid, 'trigger_list', {}))
    triggerId = String(armedAnswer.result?.id ?? having(listed, 'name', 'Venue watch')[0]?.id ?? '')
    expect(triggerId, JSON.stringify(listed).slice(0, 1500)).not.toBe('')
    expect(withId(listed, triggerId).length, JSON.stringify(listed).slice(0, 1500)).toBeGreaterThan(0)
    const tested = okOf(await gatewayCall(c, b.sid, 'trigger_test', { run: `sh ${check}` }))
    show('trigger_test', tested)
    expect(JSON.stringify(tested)).toContain('"fire":true')
    await waitFor(() => delivered(c, b.sid, T.fire), 120_000, 'the fire to reach B')
    const fireLines = logSince(c, armedAt)
    expect(fireLines.some((l) => l.msg === 'trigger: delivery offered to this host\'s Walnut server' && l.triggerId === triggerId), 'the follower picked the session').toBe(true)
    expect(fireLines.filter((l) => String(l.msg).includes('this daemon delivers the fire itself'))).toHaveLength(0)
    for (const op of ['trigger_pause', 'trigger_resume']) {
      const r = await gatewayCall(c, b.sid, op, { id: triggerId })
      expect.soft(r.ok, `${op}: ${JSON.stringify(r).slice(0, 1500)}`).toBe(true)
    }
    await waitFor(() => turnsWith(c, b.sid, T.fire) > 0, 60_000, 'B\'s turn on the fire to end')

    // A send across asks a reply by default (rq2); B's turn on it stays open over the wake.
    const s2 = okOf(await asA('task_send', { to: b.task, text: `${T.rq2} please hold until ${gate2}` }))
    show('rq2 send', s2)
    rq2 = String(s2.requestId ?? s2.request_id ?? '')
    expect(rq2, 'a send across asks a reply by default').toMatch(/^rq-[a-f0-9]{6,}$/)
    await waitFor(() => delivered(c, b.sid, T.rq2), 60_000, 'rq2 to reach B')

    // One call sent twice at once (a retry racing its first try): one record.
    const callId = `oc-${crypto.randomBytes(8).toString('hex')}`
    const twice = await Promise.all([0, 1].map(() => asA('task_update', { id: newTask, tags: ['team:acme', 'venue'] }, callId)))
    for (const r of twice) okOf(r)
    let history: unknown = null
    await waitFor(async () => {
      history = okOf(await gatewayCall(c, a.sid, 'task_history', { id: b.task }))
      return [T.rq1, T.rq2, T.fire].every((t) => JSON.stringify(history).includes(t)) ? true : null
    }, 30_000, 'task_history of B to hold rq1, rq2 and the fire').catch((e: Error) => { e.message += ` (it holds ${JSON.stringify(history).slice(0, 1500)})`; throw e })

    const away = journal(c).filter((r) => (r.seq as number) > seqMark)
    show('away journal', away.map((r) => [r.kind, r.op ?? r.row?.id ?? r.requestId ?? r.taskId ?? '', r.opId, r.rev, r.row?.status ?? '']))
    const who = (sid: unknown) => (sid === a.sid ? 'A' : sid === b.sid ? 'B' : String(sid))
    const of = (kind: string, pick: (r: Record<string, any>) => boolean = () => true) => away.filter((r) => r.kind === kind && pick(r))
    expect(of('task-create', (r) => r.taskId === newTask)).toHaveLength(1)
    const start = of('session', (r) => r.taskId === newTask)
    expect(start).toHaveLength(1)
    newSid = String(start[0]!.sid)
    expect(of('task-fields', (r) => r.taskId === newTask)).toHaveLength(2)
    expect(of('task-fields', (r) => r.taskId === newTask && JSON.stringify(r.fields ?? {}).includes('venue'))).toHaveLength(1)
    // A request this host owns: its row when asked, and again when answered here (the reply's
    // row, settled), each with its delivery: the ask into B, the reply into A.
    expect(of('row').map((r) => r.row?.id).sort()).toEqual([rq1, rq1, rq2].sort())
    expect(of('row', (r) => r.row?.id === rq1).at(-1)?.row?.status).toBe('replied')
    expect(of('delivery').map((r) => `${r.requestId}>${who(r.toSessionId)}`).sort()).toEqual([`${rq1}>A`, `${rq1}>B`, `${rq2}>B`].sort())
    expect(of('settle')).toEqual([])
    expect(of('agent-memory')).toHaveLength(1)
    expect(of('letter')).toHaveLength(1)
    expect.soft(of('op').map((r) => r.op).sort()).toEqual(['trigger_create', 'trigger_pause', 'trigger_resume'])
    expect([...new Set(away.map((r) => r.kind))].filter((k) => !['task-create', 'session', 'task-fields', 'row', 'settle', 'delivery', 'agent-memory', 'letter', 'op'].includes(k))).toEqual([])
    // Each record once: a task's field changes fold into one op id, a revision each.
    expect(new Set(away.map((r) => `${r.opId}#${r.rev ?? 1}`)).size).toBe(away.length)
    // The fallback counter's line: none while away.
    expect(logSince(c, slept.after).filter((l) => l.msg === OFFLINE_LINE).map((l) => `${l.op}:${l.why}`)).toEqual([])
  }, 600_000)

  /** What the Mac holds of the away work, counted. */
  async function macHolds(): Promise<Record<string, unknown>> {
    const tasks = macTasks(c).filter((t) => t.title === NEW_TITLE)
    const r1 = await c.mac('GET', `/api/v1/requests/${rq1}`)
    const r2 = await c.mac('GET', `/api/v1/requests/${rq2}`)
    const memory = await c.mac('GET', `/api/v1/tasks/${a.task}/agent-memory`)
    const inbox = await c.mac('GET', '/api/v1/human-inbox')
    const routines = await c.mac('GET', '/api/v1/routines')
    const transcript = await c.mac('GET', `/api/v1/sessions/${b.sid}/transcript?fresh=1`)
    const trig = withId(routines.json, triggerId)
    return {
      tasks: tasks.length, tags: String(tasks[0]?.tags ?? ''),
      sessions: macSessions(c).filter((s) => s.task_id === newTask).map((s) => s.claude_session_id),
      rq1: r1.json.request?.status ?? r1.status, rq2: r2.json.request?.status ?? r2.status,
      memory: JSON.stringify(memory.json).split(T.memory).length - 1,
      letters: having(inbox.json, 'subject', T.letter).length,
      trigger: trig.map((j) => j.enabled),
      bRq1: userRowsWith(transcript.json, T.rq1), bRq2: userRowsWith(transcript.json, T.rq2), bFire: userRowsWith(transcript.json, T.fire),
    }
  }

  it('the Mac wakes: it holds each away write once; B answers rq2 with the Mac awake; a second drain changes nothing', async () => {
    keepLogsOnFailure(() => c, `host-calls-${twin}`)
    c.wakeMac()
    await c.waitBack(token)
    const want = {
      tasks: 1, sessions: [newSid], rq1: 'replied', rq2: 'pending', memory: 1, letters: 1, trigger: [true], bRq1: 1, bRq2: 1, bFire: 1,
    }
    let seen: Record<string, unknown> = {}
    await waitFor(async () => {
      seen = await macHolds()
      const { tags, ...rest } = seen
      return String(tags).includes('venue') && JSON.stringify(rest) === JSON.stringify(want) ? true : null
    }, 180_000, 'the Mac to hold the away work').catch((e: Error) => { e.message += ` (the Mac holds ${JSON.stringify(seen)}, want ${JSON.stringify(want)})`; throw e })

    okOf(await gatewayCall(c, b.sid, 'task_send', { to: a.task, in_reply_to: rq2, text: T.reply2, result: 'Confirmed.' }))
    await waitFor(async () => ((await c.mac('GET', `/api/v1/requests/${rq2}`)).json.request?.status === 'replied' ? true : null), 60_000, 'rq2 replied on the Mac')
    await waitFor(() => delivered(c, a.sid, T.reply2), 60_000, 'the reply to rq2 to reach A')
    fs.writeFileSync(gate2, '')
    await waitFor(() => turnsWith(c, b.sid, `released ${gate2}`) > 0, 60_000, 'B\'s turn on rq2 to end')
    const before = { ...(await macHolds()), reply2: deliveries(c, a.sid, T.reply2) }
    expect(before).toMatchObject({ ...want, rq2: 'replied', reply2: 1 })

    c.sleepMac()
    await c.waitAway(token)
    c.wakeMac()
    await c.waitBack(token)
    await sleep(5_000)
    expect({ ...(await macHolds()), reply2: deliveries(c, a.sid, T.reply2) }).toEqual(before)
  }, 600_000)

  it('a task kept local never reaches the host\'s copy, one made local leaves it, and a call about it while the Mac sleeps is needs_leader task_kept_local', async () => {
    keepLogsOnFailure(() => c, `host-calls-${twin}`)
    const project = await c.mac('POST', '/api/v1/projects', { name: 'Vault', source: SERVICE })
    expect(project.status, JSON.stringify(project.json)).toBeLessThan(300)
    // Created Local: the Mac holds it, the copy never does.
    const born = await c.mac('POST', '/api/v1/tasks', { title: 'Appraisal notes for the review', project: 'Vault', local: true })
    expect(born.status, JSON.stringify(born.json)).toBe(201)
    const bornLocal = String(born.json.task.id)
    expect(born.json.task.sync_hold?.state, JSON.stringify(born.json.task)).toBe('chosen')
    const later = await c.mac('POST', '/api/v1/tasks', { title: 'Vault inventory', project: 'Vault' })
    expect(later.status, JSON.stringify(later.json)).toBe(201)
    const madeLocal = String(later.json.task.id)
    expect(later.json.task.sync_hold, 'a task of the service, not held').toBeUndefined()
    await waitFor(() => (replicaTaskIds(c).includes(madeLocal) ? true : null), 120_000, 'the synced task to reach the copy')
    expect(replicaTaskIds(c), 'the Local task never reached the copy').not.toContain(bornLocal)
    await waitFor(() => (replicaLocalTasks(c).includes(bornLocal) ? true : null), 120_000, 'the copy to name the Local task kept on the Mac')
    // Made local after it was copied: it leaves the copy at the next round.
    const ml = await c.mac('POST', `/api/v1/tasks/${madeLocal}/make-local`, {})
    expect(ml.status, JSON.stringify(ml.json)).toBe(200)
    await waitFor(() => (!replicaTaskIds(c).includes(madeLocal) && replicaLocalTasks(c).includes(madeLocal) ? true : null), 120_000, 'the task made local to leave the copy')
    expect(replicaTaskIds(c)).not.toContain(bornLocal)
    expect(macTasks(c).map((t) => t.id)).toEqual(expect.arrayContaining([bornLocal, madeLocal]))

    // The Mac sleeps: a host session's call about either is the follower's needs_leader, by both doors.
    const slept = c.sleepMac()
    await c.waitAway(token)
    const quietAt = slept.after + WINDOWS.quietMs + 1_000
    if (Date.now() < quietAt) await sleep(quietAt - Date.now())
    const refusals = {
      read: answerOf(await entryCall(entry, a.sid, 'task_get', { id: madeLocal }), 'task_get'),
      write: answerOf(await entryCall(entry, a.sid, 'task_update', { id: bornLocal, tags: ['vault'] }), 'task_update'),
      send: await gatewayCall(c, b.sid, 'task_send', { to: bornLocal, text: 'please look at the appraisal', expect_reply: false }),
      short: await gatewayCall(c, b.sid, 'task_get', { id: madeLocal.slice(0, 8) }),
    }
    show('kept local refusals', refusals)
    for (const [name, r] of Object.entries(refusals)) {
      expect(r.ok, `${name}: ${JSON.stringify(r).slice(0, 1500)}`).toBe(false)
      expect(r.error?.code, `${name}: ${JSON.stringify(r).slice(0, 1500)}`).toBe('needs_leader')
      expect(r.error?.detail?.why, `${name}: ${JSON.stringify(r).slice(0, 1500)}`).toBe('task_kept_local')
    }
    // Another task still answers from the copy.
    okOf(answerOf(await entryCall(entry, a.sid, 'task_get', { id: b.task }), 'task_get open'))
    expect(logSince(c, slept.after).filter((l) => l.msg === OFFLINE_LINE).map((l) => `${l.op}:${l.why}`)).toEqual([])
    c.wakeMac()
    await c.waitBack(token)
  }, 600_000)

})
