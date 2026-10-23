/**
 * Writes while the Mac is away, end to end (docs/plan/walnut-replica-servers-impl.md,
 * section 10 rows W1 to W14 and R4b; WP10). Every piece is a real process
 * (tests/helpers/replica-cluster.ts): a non-ephemeral Mac server child with its own
 * daemon, a host daemon twin (source under node, standalone under bun), and the
 * replica that daemon starts from the Mac's own `server.configure`. The Mac sleeps by
 * SIGSTOP (its sockets stay open and go silent) and wakes by SIGCONT.
 *
 * The phone writes through the replica while the Mac sleeps; each write lands in the
 * host daemon's journal (follower.op); the Mac drains it on wake. Each row ends with
 * the Mac's stores read on disk (its tasks.sqlite read only, its board files, its inbox
 * index), and acceptance holds for the whole run: every away write is on the Mac
 * exactly once, and the replica's copy files changed only by the Mac's puts (each
 * copy file's content after the run is a state the Mac sent, never one the replica
 * wrote: the replica's journal-held rows are an overlay, not a copy write).
 *
 *   W1  a write in flight at sleep: forwarded to the Mac that just stopped, it is 504
 *       sent:false ("Nothing was saved": a stream to the Mac opens only with its accept,
 *       link-stream.ts, so the request never left this host); retried under the same op
 *       id once away, journaled once; after wake ONE task. The late forwarded copy of a
 *       write the Mac did take (504 sent:true) is pinned where it can be made exactly:
 *       tests/web/middleware/op-id.test.ts (stale_forward, the ledger's first answer)
 *       and tests/replica/dispatch.test.ts (sent:true at the flip)
 *   W2  task edit           W3  create            W4  complete       W5  reopen
 *   W6  move (one task, anchored)                  W7  Board post and Board edit
 *   W8  a message to a session that runs on the host (follower.send)
 *   W9  an answer to that session's prompt (follower.permission)
 *   W10 a note edit: journaled once (WP11), read back from the overlaid copy, in the
 *       Mac's note after the drain
 *   W11 a duplicate drain: the same op id journaled again after its first drain applies once
 *       (a record the Mac applied whose ack was lost, drained again on the next connect,
 *       row R14, is pinned in tests/integration/offline-handover.test.ts)
 *   W12 a refused parent link: dropped, and lettered (one letter for the drain)
 *   W13 a write with one non-queueable field: refused whole, nothing journaled
 *   W14 a record that fails (its letter cannot be written) and later succeeds keeps the
 *       later records of the same task, applied after it, in order
 *   R4b wake, drain, SIGSTOP again before the copy round: the Board still shows the
 *       edit with its mark (`awaiting`)
 *
 * Twins: both (source, then standalone) when bun is on this machine, the source twin
 * alone otherwise; REPLICA_CLUSTER_TWINS=source|standalone|source,standalone picks.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import Database from '../../src/lib/sqlite.js'
import { BUN, MAC_NOTE, startReplicaCluster, waitFor, type ReplicaCluster, type Twin } from '../helpers/replica-cluster.js'

const TWINS = (process.env.REPLICA_CLUSTER_TWINS ?? (BUN ? 'source,standalone' : 'source')).split(',').map((t) => t.trim()).filter((t): t is Twin => t === 'source' || t === 'standalone')

type Row = { id: string; title: string; phase: string; project: string | null; parent_task_id: string | null; focus_tier: string | null; pinned: number | null; payload: string | null }

/** The Mac's task store on disk, read only (its own WAL readers see every commit). */
function macTasks(c: ReplicaCluster): Row[] {
  const db = new Database(path.join(c.macData, 'tasks', 'tasks.sqlite'), { readonly: true, fileMustExist: true })
  try { return db.prepare('SELECT id, title, phase, project, parent_task_id, focus_tier, pinned, payload FROM tasks').all() as Row[] } finally { db.close() }
}

/**
 * The host daemon's journal: every record (its latest line, by seq), and the seqs its
 * ack lines named. An acked record leaves the file at the next compaction
 * (offline-journal-core.ts), so a record once seen and now gone was acked: `seen`
 * keeps every record this run saw.
 */
const seen = new Map<number, Record<string, any>>()
function journal(c: ReplicaCluster): { records: Array<Record<string, any>>; acked: Set<number> } {
  const dir = path.join(c.base, 'hd', 'offline-host')
  const inFile = new Map<number, Record<string, any>>()
  const acked = new Set<number>()
  let names: string[] = []
  try { names = fs.readdirSync(dir).filter((n) => /^journal-.*\.ndjson$/.test(n)) } catch { /* none yet */ }
  for (const n of names) {
    for (const line of fs.readFileSync(path.join(dir, n), 'utf8').split('\n')) {
      if (!line.trim()) continue
      let o: Record<string, any>
      try { o = JSON.parse(line) } catch { continue }
      if (typeof o.seq === 'number') inFile.set(o.seq, o)
      if (Array.isArray(o.ack)) for (const q of o.ack) acked.add(q)
    }
  }
  for (const [q, r] of inFile) seen.set(q, r)
  for (const q of seen.keys()) if (!inFile.has(q)) acked.add(q)
  return { records: [...seen.values()].sort((a, b) => a.seq - b.seq), acked }
}
/** The Mac's Focus bar order on disk: pinned tasks by pin_order (a payload key of the row). */
function macPins(c: ReplicaCluster): string[] {
  const order = (r: Row) => { try { return Number((JSON.parse(r.payload ?? '{}') as { pin_order?: unknown }).pin_order) || 0 } catch { return 0 } }
  return macTasks(c).filter((r) => r.pinned === 1).sort((a, b) => order(a) - order(b)).map((r) => r.id)
}
const pendingOf = (c: ReplicaCluster) => { const j = journal(c); return j.records.filter((r) => !j.acked.has(r.seq)) }

/** The Mac's structured log lines (its LOG_DIR is its daemon dir) whose text matches `re`, the last `n`. */
function macLogLines(c: ReplicaCluster, re: RegExp, n = 15): string {
  const dir = path.join(c.base, 'md')
  let names: string[] = []
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.log')).sort() } catch { return '' }
  const lines = names.flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n')).filter((l) => re.test(l))
  return lines.slice(-n).map((l) => l.slice(0, 400)).join('\n')
}

/** The Mac's inbox letters (its store on disk). */
function macLetters(c: ReplicaCluster): Array<Record<string, any>> {
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(c.macData, 'human-inbox', 'index.json'), 'utf8')) as { letters?: unknown[] } | unknown[]
    return (Array.isArray(idx) ? idx : (idx.letters ?? [])) as Array<Record<string, any>>
  } catch { return [] }
}

/** The Mac's Board file of a task. */
function macBoard(c: ReplicaCluster, taskId: string): Record<string, any> | null {
  try { return JSON.parse(fs.readFileSync(path.join(c.macData, 'boards', `${taskId}.json`), 'utf8')) } catch { return null }
}

/** The host session's stream lines (the daemon's file, in this cluster's own dir). */
function hostStream(c: ReplicaCluster, sid: string): Array<Record<string, any>> {
  try {
    return fs.readFileSync(path.join(c.base, 'hd', 'streams', `${sid}.jsonl`), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as Record<string, any> } catch { return {} } })
  } catch { return [] }
}

const digest = (b: string | Buffer) => crypto.createHash('sha256').update(b).digest('hex')

/**
 * What the replica's copies hold, each by a digest: the task and session rows (read
 * only, by content: a WAL checkpoint moves bytes, not rows), every Board file, and every
 * copy state file. Not copies: this replica's own overlay of the journal
 * (cache/replica-overlay.json) and its device copy (a device removing itself is the one
 * write the replica makes there, plan section 7).
 */
function copyDigests(c: ReplicaCluster): Map<string, string> {
  const out = new Map<string, string>()
  for (const [name, file, q] of [
    ['tasks rows', path.join(c.replicaData, 'tasks', 'tasks.sqlite'), 'SELECT * FROM tasks ORDER BY id'],
    ['sessions rows', path.join(c.replicaData, 'sessions.sqlite'), 'SELECT * FROM sessions ORDER BY claude_session_id'],
  ] as const) {
    try {
      const db = new Database(file, { readonly: true, fileMustExist: true })
      try { out.set(name, digest(JSON.stringify(db.prepare(q).all()))) } finally { db.close() }
    } catch { /* none */ }
  }
  const files = (dir: string, rel: string): void => {
    let ents: fs.Dirent[] = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const r = `${rel}/${e.name}`
      if (e.isDirectory()) { files(path.join(dir, e.name), r); continue }
      if (!e.name.endsWith('.json') || r === 'cache/replica-overlay.json') continue
      out.set(r, digest(fs.readFileSync(path.join(dir, e.name))))
    }
  }
  files(path.join(c.replicaData, 'boards'), 'boards')
  files(path.join(c.replicaData, 'cache', 'replica'), 'cache/replica')
  try { out.set('cache/task-replica.json', digest(fs.readFileSync(path.join(c.replicaData, 'cache', 'task-replica.json')))) } catch { /* none */ }
  return out
}

/**
 * On a failure: the cluster's logs, its journal and the replica's overlay file copied to
 * REPLICA_CLUSTER_DIAG_DIR (when set). The cluster's own temp dir goes with the run.
 */
function keepLogs(c: ReplicaCluster, name: string): void {
  const out = process.env.REPLICA_CLUSTER_DIAG_DIR
  if (!out || !c) return
  const dest = path.join(out, `${c.twin}-${name.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40)}`)
  fs.mkdirSync(dest, { recursive: true })
  const pick: Array<[string, RegExp]> = [['hr/logs', /\.log$/], ['hd', /\.log$/], ['md', /\.log$/], ['hd/offline-host', /\.(ndjson|json)$/], ['hr/data/cache', /^replica-overlay\.json$/]]
  for (const [rel, re] of pick) {
    let names: string[] = []
    try { names = fs.readdirSync(path.join(c.base, rel)).filter((n) => re.test(n)) } catch { continue }
    for (const n of names) { try { fs.copyFileSync(path.join(c.base, rel, n), path.join(dest, `${rel.replace(/\//g, '_')}_${n}`)) } catch { /* went */ } }
  }
  process.stdout.write(`replica-cluster-e2e: logs of "${name}" kept in ${dest}\n`)
}

describe.each(TWINS)('writes while the Mac is away (%s twin)', (twin) => {
  let c: ReplicaCluster
  let token = ''
  let oldPhone = ''
  let tablet = ''
  let hostCwd = ''
  /** Tasks this run makes on the Mac before it sleeps. */
  const ids = { reopen: '', close: '', one: '', two: '', three: '', link: '', chat: '', chatSid: '', w1: '', w3: '' }
  const W1_OP = 'op-w1-inflight-0001'
  const W3_OP = 'op-w3-create-00001'
  const NOTE_AWAY = 'An away edit of the note.'
  let lettersBefore = 0
  let copiesAway: Map<string, string> | null = null
  const opOf = (title: string) => journal(c).records.filter((r) => r.kind === 'task-create' && r.fields?.title === title)
  const phone = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
    c.replica(method, p, { token, ...(body === undefined ? {} : { body }), headers })
  /** The three tasks W6 orders, out of every pinned one. */
  const mine = (list: string[]) => list.filter((id) => [ids.one, ids.two, ids.three].includes(id))
  /** Away for writes too: the quiet window has passed (`away`), not one failed stream (`suspect`, still forwarded). */
  const reallyAway = async () => {
    await c.waitAway(token)
    await waitFor(async () => ((await phone('GET', '/api/tasks')).headers['x-walnut-offline-why'] === 'away' ? true : null), 60_000, 'the replica to say away', 250)
  }
  /** What the journal still holds, for a failure's message. */
  const pendingSays = () => JSON.stringify(pendingOf(c).map((r) => ({ seq: r.seq, kind: r.kind, taskId: r.taskId, op: r.op, opId: r.opId })))
  const made = async (title: string, project = 'Acme'): Promise<string> => {
    const r = await c.mac('POST', '/api/tasks', { title, project })
    expect(r.status, JSON.stringify(r.json)).toBe(201)
    return r.json.task.id as string
  }

  beforeAll(async () => {
    c = await startReplicaCluster({ twin })
    seen.clear()
    process.stdout.write(`replica-cluster-e2e: ${twin} cluster at ${c.base}\n`)
    hostCwd = fs.realpathSync(path.join(c.base, 'hh', 'work'))
    token = await c.pairDevice('marina-phone')
    oldPhone = await c.pairDevice('acme-old-phone')
    tablet = await c.pairDevice('acme-tablet')
    ids.reopen = await made('Reopen the venue booking')
    expect((await c.mac('POST', `/api/tasks/${ids.reopen}/complete`)).status).toBe(200)
    ids.close = await made('Close the drill checklist')
    // Three tasks on the Focus bar, in this order (W6 moves one of them away).
    ids.one = await made('Order one', 'Marina')
    ids.two = await made('Order two', 'Marina')
    ids.three = await made('Order three', 'Marina')
    for (const id of [ids.one, ids.two, ids.three]) expect((await c.mac('POST', `/api/focus/tasks/${id}`)).status).toBe(200)
    expect(mine(macPins(c))).toEqual([ids.one, ids.two, ids.three])
    ids.link = await made('Link me under nothing')
    ids.chat = await made('Host chat')
    // A session that runs on the host, in default mode (its prompts wait for a person).
    const st = await c.mac('POST', `/api/v1/tasks/${ids.chat}/start`, { host: 'devbox', cwd: hostCwd, mode: 'default', message: 'hello host' })
    expect(st.status, JSON.stringify(st.json)).toBe(202)
    ids.chatSid = st.json.sessionId as string
    await waitFor(() => hostStream(c, ids.chatSid).some((l) => l.type === 'result' && String(l.result).includes('hello host')), 120_000, 'the host session to answer')
    // Every one of them in the replica's copies before the lid closes.
    await waitFor(() => {
      const rows = c.stores().taskRows as Array<{ id: string; phase: string }>
      const sess = (c.stores().sessions as { hashes?: Record<string, string> } | null)?.hashes ?? {}
      return rows.some((t) => t.id === ids.reopen && t.phase === 'COMPLETE') && rows.some((t) => t.id === ids.chat) && ids.chatSid in sess
    }, 120_000, 'the copies to hold the new tasks and the host session')
    lettersBefore = macLetters(c).length
  }, 900_000)

  afterEach(({ task }) => { if (task.result?.state === 'fail') keepLogs(c, task.name) })
  afterAll(async () => { await c?.stop() }, 120_000)

  it('W1: a write in flight when the lid closes is 504; the same op id once away is journaled once', async () => {
    c.sleepMac()
    // Forwarded to the Mac (it was answering a moment ago); the quiet window flips presence and cuts it.
    const cut = await phone('POST', '/api/tasks', { title: 'In flight at sleep', project: 'Acme' }, { 'x-walnut-op-id': W1_OP })
    expect(cut.status, cut.text).toBe(504)
    // The stream to the stopped Mac was never accepted: provably not sent, nothing kept anywhere.
    expect(cut.json.error).toMatchObject({ code: 'primary_timeout', sent: false, message: 'Your Mac did not answer in time. Nothing was saved; try again.' })
    await reallyAway()
    // The copies as the Mac last sent them: from here to the wake nothing but a put may change them.
    copiesAway = copyDigests(c)
    expect(copiesAway.size).toBeGreaterThan(3)
    // The person tries again (the web keeps the op id): journaled under it.
    const again = await phone('POST', '/api/tasks', { title: 'In flight at sleep', project: 'Acme' }, { 'x-walnut-op-id': W1_OP })
    expect(again.status, again.text).toBe(201)
    expect(again.json.task).toMatchObject({ title: 'In flight at sleep', replica_sync: 'pending' })
    expect(again.headers['x-walnut-offline']).toBeDefined()
    ids.w1 = again.json.task.id as string
    expect(journal(c).records.filter((r) => r.opId === W1_OP)).toHaveLength(1)
  }, 120_000)

  it('W2 to W7: an edit, a create, a complete, a reopen, a Focus move, a Board post and edit each journal once and read back with their marks', async () => {
    const before = journal(c).records.length
    const edit = await phone('PATCH', `/api/tasks/${c.ids.other}`, { title: 'Fix the flaky build on devbox' })
    expect(edit.status, edit.text).toBe(200)
    expect(edit.json.task).toMatchObject({ id: c.ids.other, title: 'Fix the flaky build on devbox', replica_sync: 'pending' })
    const made = await phone('POST', '/api/tasks', { title: 'Book the rollback room', project: 'Acme' }, { 'x-walnut-op-id': W3_OP })
    expect(made.status, made.text).toBe(201)
    ids.w3 = made.json.task.id as string
    const done = await phone('POST', `/api/tasks/${ids.close}/complete`)
    expect(done.status, done.text).toBe(200)
    const reopened = await phone('POST', `/api/tasks/${ids.reopen}/toggle-complete`)
    expect(reopened.status, reopened.text).toBe(200)
    expect(reopened.json.task).toMatchObject({ phase: 'TODO', replica_sync: 'pending' })
    const moved = await phone('PUT', '/api/focus/reorder', { task_ids: [ids.three, ids.one, ids.two] })
    expect(moved.status, moved.text).toBe(200)
    expect(mine(moved.json.pinned_tasks)).toEqual([ids.three, ids.one, ids.two])
    expect(moved.json).toHaveProperty('satellite_tasks')
    const post = await phone('POST', `/api/v1/tasks/${c.ids.board}/board/threads/build`, { text: 'The drill ran green on devbox' })
    expect(post.status, post.text).toBe(201)
    const bedit = await phone('POST', `/api/v1/tasks/${c.ids.board}/board/edits`, { edits: [{ old: 'Build: green', new: 'Build: red' }] })
    expect(bedit.status, bedit.text).toBe(200)
    const recs = journal(c).records.slice(before)
    expect(recs.map((r) => r.kind)).toEqual(['task-fields', 'task-create', 'task-fields', 'task-fields', 'task-move', 'board', 'board'])
    for (const r of recs) expect(r.actor, JSON.stringify(r)).toMatchObject({ kind: 'device', name: 'marina-phone' })
    expect(recs[0].fields.title).toEqual({ base: 'Fix the flaky build \u00e9t\u00e9', value: 'Fix the flaky build on devbox' })
    expect(recs[4]).toMatchObject({ taskId: ids.three, anchor: { before: ids.one } })
    // Read back from the copies, each with its mark; a row nothing touched has none.
    const list = await phone('GET', '/api/tasks')
    expect(list.headers['x-walnut-offline']).toBeDefined()
    const byId = new Map((list.json.tasks as Array<Record<string, any>>).map((t) => [t.id, t]))
    expect(byId.get(c.ids.other)).toMatchObject({ title: 'Fix the flaky build on devbox', replica_sync: 'pending' })
    expect(byId.get(ids.w3)).toMatchObject({ title: 'Book the rollback room', replica_sync: 'pending' })
    expect(byId.get(ids.w1)).toMatchObject({ title: 'In flight at sleep', replica_sync: 'pending' })
    expect(byId.get(ids.close)).toMatchObject({ phase: 'COMPLETE', replica_sync: 'pending' })
    expect(byId.get(ids.reopen)).toMatchObject({ phase: 'TODO', replica_sync: 'pending' })
    expect(byId.get(ids.two)).not.toHaveProperty('replica_sync')
    expect(mine((await phone('GET', '/api/focus/tasks')).json.pinned_tasks)).toEqual([ids.three, ids.one, ids.two])
    const board = await phone('GET', `/api/v1/tasks/${c.ids.board}/board`)
    expect(board.status, board.text).toBe(200)
    expect(board.json.board.html).toContain('Build: red')
    expect(board.json.replica_sync).toBe('pending')
    expect(JSON.stringify(board.json.threads)).toContain('The drill ran green on devbox')
  }, 120_000)

  it('W10, W13: a note edit journals once and reads back; a write with one field the journal does not take needs the Mac and journals nothing', async () => {
    const before = journal(c).records.length
    const note = await phone('PUT', `/api/notes-v2/content/${encodeURI(MAC_NOTE.path)}`, { content: NOTE_AWAY })
    expect(note.status, note.text).toBe(200)
    const noteRecs = journal(c).records.slice(before)
    expect(noteRecs.map((r) => r.kind)).toEqual(['note'])
    expect(noteRecs[0]).toMatchObject({ path: MAC_NOTE.path })
    const readBack = await phone('GET', `/api/notes-v2/content/${encodeURI(MAC_NOTE.path)}`)
    expect(readBack.status, readBack.text).toBe(200)
    expect(readBack.text).toContain(NOTE_AWAY)
    const mixed = await phone('PATCH', `/api/tasks/${c.ids.other}`, { title: 'Half of a change', walnut_agent: true })
    expect(mixed.status, mixed.text).toBe(503)
    expect(mixed.json.error).toMatchObject({ code: 'needs_leader', why: 'fields' })
    expect(journal(c).records.length).toBe(before + 1)
    const row = (await phone('GET', `/api/tasks/${c.ids.other}`)).json.task
    expect(row.title).toBe('Fix the flaky build on devbox')
  }, 60_000)

  it('W8, W9: a message to the session on this host and the answer to its prompt act on the host at once; a Mac session needs the Mac', async () => {
    const sid = ids.chatSid
    // AskUserQuestion: a prompt the daemon never answers by itself, in any mode (daemon-core.ts shouldAutoRespond).
    const q = 'Which day is the drill?'
    const sent = await phone('POST', `/api/v1/sessions/${sid}/messages`, { text: `please ask ${q}` })
    expect(sent.status, sent.text).toBe(202)
    expect(sent.json).toMatchObject({ delivered: true })
    const ask = await waitFor(() => hostStream(c, sid).find((l) => l.type === 'control_request' && l.request?.tool_name === 'AskUserQuestion'), 60_000, 'the session to ask')
    // The CLI writes its stream file itself; the daemon takes the prompt from it a moment
    // later (its tailer), and only then knows it: a person sees it only from then on.
    const answer = await waitFor(async () => {
      const a = await phone('POST', `/api/sessions/${sid}/permission`, { requestId: ask.request_id, allow: true, answers: { [q]: 'Friday' } })
      if (a.status === 404) return null
      return a
    }, 15_000, 'the daemon to know the prompt', 200)
    expect(answer.status, answer.text).toBe(200)
    expect(answer.json).toMatchObject({ status: 'resolved', allow: true })
    await waitFor(() => hostStream(c, sid).some((l) => l.type === 'result' && String(l.result).includes('echo: answered Friday')), 60_000, 'the answered turn to end')
    // Asked again (an answer lost): resolved again with the first answer (the phone shows no
    // error for a prompt it answered), never a second line to the CLI.
    const twice = await phone('POST', `/api/sessions/${sid}/permission`, { requestId: ask.request_id, allow: true, answers: { [q]: 'Friday' } })
    expect(twice.status, twice.text).toBe(200)
    expect(twice.json).toMatchObject({ status: 'resolved', allow: true })
    await new Promise((r) => setTimeout(r, 500))
    expect(hostStream(c, sid).filter((l) => l.type === 'result' && String(l.result).includes('echo: answered Friday'))).toHaveLength(1)
    // A prompt this host never had: still not found.
    const never = await phone('POST', `/api/sessions/${sid}/permission`, { requestId: 'req-never-asked-0001', allow: true })
    expect(never.status).toBe(404)
    const mac = await phone('POST', `/api/v1/sessions/${c.ids.macSid}/messages`, { text: 'hello' })
    expect(mac.status, mac.text).toBe(503)
    expect(mac.json.error).toMatchObject({ code: 'needs_leader', why: 'session_on_mac' })
  }, 180_000)

  it('a device revoke while away is that device\'s own sign-out only: off the replica at once, journaled for the Mac; removing another device needs the Mac', async () => {
    const r = await c.replica('DELETE', `/api/devices/${encodeURIComponent('acme-old-phone')}`, { token: oldPhone })
    expect(r.status, r.text).toBe(200)
    expect((await c.replica('GET', '/api/tasks', { token: oldPhone })).status).toBe(401)
    expect(journal(c).records.filter((x) => x.kind === 'device-revoke')).toEqual([expect.objectContaining({ actor: expect.objectContaining({ name: 'acme-old-phone' }) })])
    // Another device cannot remove this phone while the Mac is away.
    const other = await phone('DELETE', `/api/devices/${encodeURIComponent('acme-old-phone')}`)
    expect(other.status).toBe(503)
  }, 60_000)

  it('W12, W14 (written last): a parent link the Mac will refuse, then a later edit of the same task from another device', async () => {
    const link = await phone('PATCH', `/api/tasks/${ids.link}`, { parent_task_id: 'no-such-task-00000000' })
    expect(link.status, link.text).toBe(200)
    // Another device: one device's later field write of the same task folds into its earlier record.
    const later = await c.replica('PATCH', `/api/tasks/${ids.link}`, { token: tablet, body: { title: 'Linked later, kept' } })
    expect(later.status, later.text).toBe(200)
    expect(later.json.task).toMatchObject({ title: 'Linked later, kept', parent_task_id: 'no-such-task-00000000' })
    // Acceptance: while away the replica's copies changed only by the Mac's puts, and none came.
    expect([...copyDigests(c)]).toEqual([...copiesAway!])
  }, 60_000)

  it('wake: the Mac drains each away write once; W12 waits while its letter cannot be written, and W14 waits behind it', async () => {
    const all = journal(c).records
    const w12 = all.find((r) => r.taskId === ids.link && r.fields?.parent_task_id)!
    const w14 = all.find((r) => r.taskId === ids.link && r.fields?.title)!
    expect(w12.seq).toBeLessThan(w14.seq)
    expect(Math.max(...all.map((r) => r.seq))).toBe(w14.seq)
    // The Mac's conflict log cannot be written: the refused link's letter entry fails.
    const conflicts = path.join(c.macData, 'offline-conflicts')
    fs.mkdirSync(conflicts, { recursive: true })
    fs.chmodSync(conflicts, 0o500)
    try {
      c.wakeMac()
      await waitFor(() => {
        const p = pendingOf(c).map((r) => r.seq).sort((a, b) => a - b)
        return p.length === 2 && p[0] === w12.seq && p[1] === w14.seq ? true : null
      }, 120_000, 'every record but the two of the linked task to be acked', 100).catch((err: Error) => { throw new Error(`${err.message}; pending: ${pendingSays()}; mac log: ${macLogLines(c, /offline handover|conflict log|offline merge/)}`) })
      // W14 has not run ahead of W12: the Mac still has the task's own title.
      expect(macTasks(c).find((r) => r.id === ids.link)).toMatchObject({ title: 'Link me under nothing', parent_task_id: null })
    } finally {
      fs.chmodSync(conflicts, 0o700)
    }
    // Its backoff (5 s) runs out: the letter is written, the link dropped, W14 applied after it.
    await waitFor(() => (pendingOf(c).length === 0 ? true : null), 240_000, 'the two records to be acked after the backoff').catch((err: Error) => { throw new Error(`${err.message}; pending: ${pendingSays()}; mac log: ${macLogLines(c, /offline handover|conflict log|offline merge/)}`) })
    expect(macTasks(c).find((r) => r.id === ids.link)).toMatchObject({ title: 'Linked later, kept', parent_task_id: null })
    await waitFor(() => (macLetters(c).length > lettersBefore ? true : null), 60_000, 'the letter')
  }, 420_000)

  it('W11, R4b: away again, the same create op id is journaled again; a Board edit drained with the lid closed before its copy round still shows, marked awaiting', async () => {
    await c.waitBack(token)
    // The copies catch up with the first drain before the lid closes again.
    const boardCopy = path.join(c.replicaData, 'boards', `${c.ids.board}.json`)
    await waitFor(() => (fs.existsSync(boardCopy) && fs.readFileSync(boardCopy, 'utf8').includes('Build: red') ? true : null), 120_000, 'the Board copy round')
    await waitFor(() => ((c.stores().taskRows as Array<{ title?: string }>).some((t) => t.title === 'Linked later, kept') ? true : null), 120_000, 'the task copy round')
    c.sleepMac()
    await reallyAway()
    const copies = copyDigests(c)
    const dup = await phone('POST', '/api/tasks', { title: 'Book the rollback room', project: 'Acme' }, { 'x-walnut-op-id': W3_OP })
    expect(dup.status, dup.text).toBe(201)
    expect(journal(c).records.filter((r) => r.opId === W3_OP)).toHaveLength(2)
    const amber = await phone('POST', `/api/v1/tasks/${c.ids.board}/board/edits`, { edits: [{ old: 'Build: red', new: 'Build: amber' }] })
    expect(amber.status, amber.text).toBe(200)
    const amberSeq = Math.max(...journal(c).records.map((r) => r.seq))
    expect([...copyDigests(c)]).toEqual([...copies])
    // Wake, and close the lid the moment the edit is acked (its copy round waits 3 s: copy-kind.ts COPY_DEBOUNCE_MS).
    c.wakeMac()
    await waitFor(() => (journal(c).acked.has(amberSeq) ? true : null), 120_000, 'the Board edit to be drained', 20)
    c.sleepMac()
    await reallyAway()
    expect(fs.readFileSync(boardCopy, 'utf8')).not.toContain('Build: amber')
    // Every read shows the edit with its mark. The lid may close within a second of the
    // ack, before the replica's overlay asks the daemon again (once a second): until then
    // the mark is still `pending`, then `awaiting` (the record left the journal, its copy
    // has not come).
    const marks: string[] = []
    await waitFor(async () => {
      const board = await phone('GET', `/api/v1/tasks/${c.ids.board}/board`)
      const shows = board.status === 200 && String(board.json?.board?.html ?? '').includes('Build: amber')
      marks.push(shows ? String(board.json.replica_sync) : `${board.status} without the edit`)
      return shows && board.json.replica_sync === 'awaiting' ? true : null
    }, 10_000, 'the Board edit to be marked awaiting its copy', 250).catch((err) => {
      // On a failure: what the replica's overlay last said about its writes.
      const says = c.logs().replica.split('\n').filter((l) => /replica overlay|follower\.pending/.test(l)).slice(-20).map((l) => l.slice(0, 400)).join('\n')
      throw new Error(`${String(err)}\nmarks read: ${marks.join(', ')}\namber seq ${amberSeq}\n${says}`)
    })
    expect(marks.every((m) => m === 'pending' || m === 'awaiting')).toBe(true)
    expect(fs.readFileSync(boardCopy, 'utf8')).not.toContain('Build: amber')
  }, 420_000)

  it('back: every away write is on the Mac exactly once, in its stores on disk; forwarded reads carry no mark; the marks go', async () => {
    c.wakeMac()
    await c.waitBack(token)
    await waitFor(() => (pendingOf(c).length === 0 ? true : null), 120_000, 'the journal to be drained')
    const rows = macTasks(c)
    const titled = (t: string) => rows.filter((r) => r.title === t)
    // W1: one task (the 504 never reached the Mac; its retry, journaled under the same op id, drained once); W3 and W11: one task.
    expect(titled('In flight at sleep')).toHaveLength(1)
    expect(titled('Book the rollback room')).toHaveLength(1)
    expect(rows.find((r) => r.id === c.ids.other)?.title).toBe('Fix the flaky build on devbox')
    expect(rows.find((r) => r.id === ids.close)?.phase).toBe('COMPLETE')
    expect(rows.find((r) => r.id === ids.reopen)?.phase).toBe('TODO')
    expect(mine(macPins(c))).toEqual([ids.three, ids.one, ids.two])
    expect(rows.find((r) => r.id === ids.link)).toMatchObject({ title: 'Linked later, kept', parent_task_id: null })
    // W10: the note edit is in the Mac's note (nobody changed it there, so no conflict copy).
    expect(fs.readFileSync(path.join(c.macData, 'notes', MAC_NOTE.path), 'utf8')).toContain(NOTE_AWAY)
    // W13 changed nothing.
    expect(titled('Half of a change')).toHaveLength(0)
    // W7 and R4b: the Board file holds both edits and the post once.
    const board = macBoard(c, c.ids.board)!
    expect(board.html).toContain('Build: amber')
    expect(JSON.stringify(board).split('The drill ran green on devbox').length - 1).toBe(1)
    // W12: one letter for the drain that dropped the link.
    const letters = macLetters(c).slice(lettersBefore).filter((l) => /made while your Mac was away did not merge cleanly/.test(String(l.subject ?? '')))
    expect(letters).toHaveLength(1)
    // The device that removed itself is gone from the Mac's store; the other is kept.
    const auth = fs.readFileSync(path.join(c.macData, 'auth.json'), 'utf8')
    expect(auth).not.toContain('acme-old-phone')
    expect(auth).toContain('marina-phone')
    // Every record of the run was acked exactly by the Mac's drains.
    const j = journal(c)
    expect(j.records.every((r) => j.acked.has(r.seq))).toBe(true)
    // Forwarded reads are the Mac's: no mark.
    const list = await phone('GET', '/api/tasks')
    expect(list.headers['x-walnut-answered-via']).toBe('leader')
    expect(list.text).not.toContain('replica_sync')
    // The overlay lets go once the copies hold the Mac's rows (a manifest after each ack).
    const overlayFile = path.join(c.replicaData, 'cache', 'replica-overlay.json')
    await waitFor(() => {
      try { return (JSON.parse(fs.readFileSync(overlayFile, 'utf8')) as { entries: unknown[] }).entries.length === 0 ? true : null } catch { return null }
    }, 120_000, 'every mark to go')
  }, 420_000)
})
