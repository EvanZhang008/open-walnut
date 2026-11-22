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
 *              start, task_create naming no project (filed in A's project as A's subtask by the leader's
 *              caller rule, and started on devbox, the project's host), task_update tags, task_send to B asking a reply (rq1) and one asking it by
 *              default (rq2); by the old door as B: the reply to rq1, agent_memory_write on A's
 *              task, human_inbox_send, a trigger on B's task that fires (list, test, delivery by
 *              the follower, pause, resume); one task_update sent twice at once with one call id;
 *              task_history of B. The journal holds each record once, and the daemon never
 *              answers with its own away code ("gateway: daemon offline answer used").
 *   wake       the Mac holds each exactly once (the task made with no project as A's subtask in A's
 *              project, with its session); B answers rq2 with the Mac awake; asleep and awake
 *              again, nothing changes.
 *   local      (core/replication/host-private.ts) in a project that syncs to a fixture service of
 *              the Mac: a task created Local never reaches the replica's copy, one made local
 *              after it was copied leaves it at the next round, and a host session's call about
 *              either while the Mac sleeps is `needs_leader {why:'task_kept_local'}`, by both doors,
 *              with no daemon away answer; a message to one is held for the Mac, once.
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
  callEnvOf, deliveries, delivered, entryCall, entryGiven, gatewayCall, hostJournal as journal, keepLogsOnFailure, logSince, macSessions, macTasks,
  replicaKnowsDefaultHost, replicaRows, sessionCliEnv, turnsWith, userRowsWith,
} from '../helpers/replica-cluster-reads.js'

const TWINS = (process.env.REPLICA_CLUSTER_TWINS ?? (BUN ? 'source,standalone' : 'source')).split(',').map((t) => t.trim()).filter((t): t is Twin => t === 'source' || t === 'standalone')
const NEW_TITLE = 'Book the venue from the host'
/** Made by A with no project while the Mac is away: lands beside A, as online. */
const PLACED_TITLE = 'Order the chairs'
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
  let placedTask = ''
  let placedSid = ''
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
    // No project, from inside A's task: the leader's caller rule on the follower's copy files it in A's
    // project as A's subtask, so its start runs here (Acme's host), never "needs your Mac" for the Inbox.
    const placed = okOf(await asA('task_create', { title: PLACED_TITLE, message: 'start beside the caller' }))
    show('placed create', placed)
    placedTask = String(placed.id ?? placed.task?.id ?? '')
    expect(placedTask).not.toBe('')
    expect(having(placed, 'parent_task_id', a.task).length, JSON.stringify(placed).slice(0, 2000)).toBeGreaterThan(0)
    expect(having(placed, 'project', 'Acme').length, JSON.stringify(placed).slice(0, 2000)).toBeGreaterThan(0)
    expect(JSON.stringify(placed)).not.toContain('task_runs_elsewhere')
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
    const placedRec = of('task-create', (r) => r.taskId === placedTask)
    expect(placedRec).toHaveLength(1)
    // The project it took from A rides for this host's readers only; the Mac files it under A where A is then.
    expect(placedRec[0]!.placement).toMatchObject({ inheritedProject: 'Acme', parentTaskId: a.task })
    expect(placedRec[0]!.placement).not.toHaveProperty('project')
    expect(placedRec[0]!.placement).not.toHaveProperty('groupId')
    const placedStart = of('session', (r) => r.taskId === placedTask)
    expect(placedStart).toHaveLength(1)
    placedSid = String(placedStart[0]!.sid)
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
    const all = macTasks(c)
    const tasks = all.filter((t) => t.title === NEW_TITLE)
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
      placed: all.filter((t) => t.title === PLACED_TITLE).map((t) => `${t.id === placedTask}|${t.project}|${t.parent_task_id}`),
      placedSessions: macSessions(c).filter((s) => s.task_id === placedTask).map((s) => s.claude_session_id),
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
      tasks: 1, sessions: [newSid], placed: [`true|Acme|${a.task}`], placedSessions: [placedSid], rq1: 'replied', rq2: 'pending', memory: 1, letters: 1, trigger: [true], bRq1: 1, bRq2: 1, bFire: 1,
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
      short: await gatewayCall(c, b.sid, 'task_get', { id: madeLocal.slice(0, 8) }),
    }
    show('kept local refusals', refusals)
    for (const [name, r] of Object.entries(refusals)) {
      expect(r.ok, `${name}: ${JSON.stringify(r).slice(0, 1500)}`).toBe(false)
      expect(r.error?.code, `${name}: ${JSON.stringify(r).slice(0, 1500)}`).toBe('needs_leader')
      expect(r.error?.detail?.why, `${name}: ${JSON.stringify(r).slice(0, 1500)}`).toBe('task_kept_local')
    }
    // A message to it is held for the Mac by id (the daemon's held op), never refused or lost.
    const held = okOf(await gatewayCall(c, b.sid, 'task_send', { to: bornLocal, text: 'please look at the appraisal', expect_reply: false }))
    show('kept local send', held)
    expect(held.held, JSON.stringify(held)).toBe(true)
    expect(journal(c).filter((r: Record<string, any>) => r.kind === 'op' && r.op === 'task_send' && r.args?.to === bornLocal).length, 'held once').toBe(1)
    // Another task still answers from the copy.
    okOf(answerOf(await entryCall(entry, a.sid, 'task_get', { id: b.task }), 'task_get open'))
    expect(logSince(c, slept.after).filter((l) => l.msg === OFFLINE_LINE).map((l) => `${l.op}:${l.why}`)).toEqual([])
    c.wakeMac()
    await c.waitBack(token)
  }, 600_000)

})

/**
 * The seconds right after the Mac's link to the host daemon drops (a deploy's restart): the daemon
 * sees the Mac gone at once and hands a session's call to the follower, whose own view of the Mac (a
 * poll of follower.status) may still say it answers, so it refuses `leader_answers`. The daemon hands
 * the call to it again (follower-gateway-core.ts waitOutLag) instead of its own away answer. The
 * follower is SIGSTOPped across the cut, so its view is the one from before it when the calls reach it.
 */
describe.each(TWINS)('a call right after the Mac\'s link drops is the follower\'s, never the daemon\'s away answer (%s twin)', (twin) => {
  let c: ReplicaCluster
  let token = ''
  const a = { task: '', sid: '' }
  const LAG_LINE = 'gateway: this host\'s Walnut server does not see the leader away yet; the call goes to it again'

  beforeAll(async () => {
    c = await startReplicaCluster({ twin, linkProxy: true })
    process.stdout.write(`replica-cluster-host-calls-e2e: lag ${twin} cluster at ${c.base}\n`)
    const hostCwd = fs.realpathSync(path.join(c.base, 'hh', 'work'))
    token = await c.pairDevice('marina-phone')
    const made = await c.mac('POST', '/api/tasks', { title: 'Lag caller', project: 'Acme' })
    expect(made.status, JSON.stringify(made.json)).toBe(201)
    a.task = String(made.json.task.id)
    const st = await c.mac('POST', `/api/v1/tasks/${a.task}/start`, { host: 'devbox', cwd: hostCwd, mode: 'default', message: 'hello lag' })
    expect(st.status, JSON.stringify(st.json)).toBe(202)
    a.sid = String(st.json.sessionId)
    await waitFor(() => turnsWith(c, a.sid, 'hello lag') > 0, 120_000, 'the session to answer')
    await waitFor(() => { const h = (c.stores().sessions as { hashes?: Record<string, string> } | null)?.hashes ?? {}; return h[a.sid] ? true : null }, 120_000, 'the copy to hold the session')
    await waitFor(() => (replicaTaskIds(c).includes(a.task) ? true : null), 120_000, 'the copy to hold the task')
  }, 900_000)

  afterAll(async () => { await c?.stop() }, 120_000)

  it('the follower still sees the Mac: the calls go to it again and it answers them, the write journaled once, no daemon away answer', async () => {
    keepLogsOnFailure(() => c, `host-calls-lag-${twin}`)
    const seqMark = journal(c).reduce((m, r) => Math.max(m, r.seq as number), 0)
    c.pauseReplica()
    const at = Date.now()
    let resumed = false
    try {
      c.cutLink()
      await waitFor(() => (logSince(c, at).some((l) => l.msg === 'client disconnected') ? true : null), 15_000, 'the daemon to see the Mac\'s link close', 50)
      const write = gatewayCall(c, a.sid, 'task_update', { id: a.task, tags: ['lag-check'] })
      const read = gatewayCall(c, a.sid, 'task_get', { id: a.task })
      await waitFor(() => (logSince(c, at).filter((l) => l.msg === HANDED && l.callerSid === a.sid).length >= 2 ? true : null), 15_000, 'the daemon to hand both calls to the follower', 50)
      c.resumeReplica()
      resumed = true
      const [w, r] = await Promise.all([write, read])
      expect(w.ok, `task_update: ${JSON.stringify(w).slice(0, 1500)}`).toBe(true)
      expect(r.ok, `task_get: ${JSON.stringify(r).slice(0, 1500)}`).toBe(true)
    } finally {
      if (!resumed) c.resumeReplica()
    }
    const lines = logSince(c, at)
    show('lag lines', lines.filter((l) => l.msg === LAG_LINE || String(l.msg).includes('handed the call back') || l.msg === OFFLINE_LINE).map((l) => [l.msg, l.op, l.relayId]))
    // The race the fix is for usually happens here (the follower refuses with its stale view and the call goes
    // to it again); when its presence turns first, the calls are simply its own. Either way: no away answer.
    // The race itself is pinned by tests/providers/follower-gateway-lag.test.ts.
    show('lag race hit', lines.filter((l) => l.msg === LAG_LINE).length > 0)
    expect(lines.filter((l) => l.msg === OFFLINE_LINE).map((l) => `${l.op}:${l.why}`)).toEqual([])
    const fields = journal(c).filter((r) => (r.seq as number) > seqMark && r.kind === 'task-fields' && r.taskId === a.task)
    expect(fields.filter((r) => JSON.stringify(r.fields ?? {}).includes('lag-check')), JSON.stringify(fields).slice(0, 1500)).toHaveLength(1)

    // The Mac back: it holds the write once.
    c.mendLink()
    await c.waitBack(token, 120_000)
    await waitFor(() => (String(macTasks(c).find((t) => t.id === a.task)?.tags ?? '').includes('lag-check') ? true : null), 120_000, 'the Mac to hold the tag')
  }, 600_000)
})

/**
 * trigger_update while the Mac is away (replica/away-trigger-update.ts): a trigger the Mac made for a
 * session on devbox is changed by that session while the Mac sleeps. The follower answers it (no daemon
 * away answer), the daemon journals one `trigger_update` op record of only the changed fields and runs
 * the new time limit at once; the Mac, back, holds the change once, keeps what it did not change, and a
 * second sleep and wake changes nothing.
 */
describe.each(TWINS)('a trigger changed on its host while the Mac is away is the Mac\'s once, when it is back (%s twin)', (twin) => {
  let c: ReplicaCluster
  let token = ''
  const s = { task: '', sid: '' }
  let triggerId = ''
  let seqMark = 0
  const DESCRIPTION = 'Checks the caterer list every 30 seconds; on a new entry the session looks at it.'
  const CHANGED = 'Checks the caterer list every minute; on a new entry the session books it.'
  const macRoutine = async () => withId((await c.mac('GET', '/api/v1/routines?includeDisabled=true')).json, triggerId)[0] as Record<string, any> | undefined

  beforeAll(async () => {
    c = await startReplicaCluster({ twin })
    process.stdout.write(`replica-cluster-host-calls-e2e: trigger update ${twin} cluster at ${c.base}\n`)
    const hostCwd = fs.realpathSync(path.join(c.base, 'hh', 'work'))
    token = await c.pairDevice('marina-phone')
    const made = await c.mac('POST', '/api/tasks', { title: 'Caterer watcher', project: 'Acme' })
    expect(made.status, JSON.stringify(made.json)).toBe(201)
    s.task = String(made.json.task.id)
    const st = await c.mac('POST', `/api/v1/tasks/${s.task}/start`, { host: 'devbox', cwd: hostCwd, mode: 'default', message: 'hello watcher' })
    expect(st.status, JSON.stringify(st.json)).toBe(202)
    s.sid = String(st.json.sessionId)
    await waitFor(() => turnsWith(c, s.sid, 'hello watcher') > 0, 120_000, 'the session to answer')
    await waitFor(() => { const h = (c.stores().sessions as { hashes?: Record<string, string> } | null)?.hashes ?? {}; return h[s.sid] ? true : null }, 120_000, 'the copy to hold the session')
    // Made on the Mac while it answers, checked on devbox.
    const check = path.join(hostCwd, 'caterer-check.sh')
    fs.writeFileSync(check, 'echo \'{"fire":false}\'\n', { mode: 0o755 })
    const armed = okOf(await gatewayCall(c, s.sid, 'trigger_create', { run: `sh ${check}`, every: '30s', prompt: 'The caterer watch fired.', description: DESCRIPTION, name: 'Caterer watch' }))
    triggerId = String(armed.id ?? '')
    expect(triggerId, JSON.stringify(armed)).not.toBe('')
    expect(armed.offline, 'made by the Mac').toBeUndefined()
    await waitFor(() => (withId(c.stores().routines, triggerId).length > 0 ? true : null), 120_000, 'the routines copy to hold the trigger')
  }, 900_000)

  afterAll(async () => { await c?.stop() }, 120_000)

  it('the Mac away: the follower changes it, the daemon journals the changed fields once and runs them at once', async () => {
    keepLogsOnFailure(() => c, `host-calls-trigger-update-${twin}`)
    seqMark = journal(c).reduce((m, r) => Math.max(m, r.seq as number), 0)
    const slept = c.sleepMac()
    await c.waitAway(token)
    const quietAt = slept.after + WINDOWS.quietMs + 1_000
    if (Date.now() < quietAt) await sleep(quietAt - Date.now())
    const r = await gatewayCall(c, s.sid, 'trigger_update', { id: triggerId, timeoutSeconds: 120, description: CHANGED })
    show('trigger_update away', r)
    const out = okOf(r)
    expect(out).toMatchObject({ offline: true, queued: true, state: 'armed' })
    // A field only the Mac decides is refused by name, nothing saved.
    const big = await gatewayCall(c, s.sid, 'trigger_update', { id: triggerId, prompt: 'p'.repeat(33 * 1024) })
    expect(big.ok, JSON.stringify(big).slice(0, 800)).toBe(false)
    expect(big.error?.code).toBe('needs_leader')
    expect(JSON.stringify(big.error)).toContain('prompt')
    const listed = okOf(await gatewayCall(c, s.sid, 'trigger_list', { name: triggerId, full: true }))
    show('trigger_list away', listed)
    expect(JSON.stringify(listed)).toContain(CHANGED)
    const away = journal(c).filter((x) => (x.seq as number) > seqMark && x.kind === 'op' && x.op === 'trigger_update')
    expect(away.map((x) => x.args)).toEqual([{ id: triggerId, timeoutSeconds: 120, description: CHANGED }])
    expect(away[0]!.trigger?.check?.timeoutSeconds).toBe(120)
    expect(logSince(c, slept.after).filter((l) => l.msg === OFFLINE_LINE).map((l) => `${l.op}:${l.why}`)).toEqual([])
  }, 600_000)

  it('the Mac wakes: it holds the change once, keeps the rest; asleep and awake again, nothing changes', async () => {
    keepLogsOnFailure(() => c, `host-calls-trigger-update-${twin}`)
    c.wakeMac()
    await c.waitBack(token)
    let seen: Record<string, any> | undefined
    await waitFor(async () => {
      seen = await macRoutine()
      return seen?.check?.timeoutSeconds === 120 && seen?.description === CHANGED ? true : null
    }, 180_000, 'the Mac to hold the change').catch((e: Error) => { e.message += ` (the Mac holds ${JSON.stringify(seen)})`; throw e })
    expect(seen).toMatchObject({ id: triggerId, name: 'Caterer watch', enabled: true, schedule: { everyMs: 30_000 }, executor: { config: { prompt: 'The caterer watch fired.' } } })
    await waitFor(() => (journal(c).some((x) => x.kind === 'op' && x.op === 'trigger_update') ? null : true), 60_000, 'the record to be acked')
    const before = await macRoutine()
    c.sleepMac()
    await c.waitAway(token)
    c.wakeMac()
    await c.waitBack(token)
    await sleep(5_000)
    const after = await macRoutine()
    // The definition as stored (its run state and the engine's clock move on every check).
    const { state: _sb, updatedAtMs: _ub, ...b } = before ?? {}
    const { state: _sa, updatedAtMs: _ua, ...a } = after ?? {}
    expect(a).toEqual(b)
  }, 600_000)
})
