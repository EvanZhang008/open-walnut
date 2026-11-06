/**
 * The kanban specs' fixture team (spec 12), built through public routes on the
 * shared Playwright fixture server: a leader `Payments resolver group triage`
 * with 37 direct subtasks, 14 open across every live state (8 idle
 * NEED_ACTION + unread, one of them handed back by its own worker and one
 * stale, 3 running, a Bash prompt, an AskUserQuestion, a sessionless WAITING
 * with a wait_until) and 23 COMPLETE, 10 of them done 8 to 10 days ago; ticket:
 * and sev: tags, 200 to 300 character summaries, one 250 character title, one
 * non Latin title, a nested worker under an open card waiting on a prompt.
 *
 * Old completions and a 3 day old stall cannot be made through a route (no
 * route backdates completed_at or phase_changed_at), so they are SEEDED before
 * boot: test-server.ts adds `kanbanSeedTasks(agoIso)` to its tasks.json and the
 * fixture adopts the rows of its engine (PATCH parent_task_id + project).
 * Without the seed, assertFixtureDensity fails loudly (C90). Each Playwright
 * worker adopts its own copy of the rows (claimSeedSlot, board-kanban-seed.ts).
 *
 * No @playwright/test import at runtime: test-server.ts imports this file.
 * Neutral invented names only.
 */
import type { BrowserContext } from '@playwright/test'
import { OLD_DONE_FIRST_TICKET, STALE_TICKET, claimSeedSlot, kanbanSeedIds, summaryFor, ticketOf } from './board-kanban-seed'

export {
  KANBAN_FIRST_TICKET, KANBAN_SEED_ENGINES, KANBAN_SEED_SLOTS, claimSeedSlot, kanbanSeedIds, kanbanSeedTasks, summaryFor, ticketOf,
} from './board-kanban-seed'

export const KANBAN_LEADER_TITLE = 'Payments resolver group triage'
export const KANBAN_TICKET_LINK = 'https://tickets.example.test/{value}'

export interface KanbanApi {
  /** `http://localhost:<port>`. */
  base: string
  /** The fixture server's root (sessions start in `<root>/projects/walnut`). */
  fixtureRoot: string
}

export function kanbanApi(port: number, fixtureRoot: string): KanbanApi {
  return { base: `http://localhost:${port}`, fixtureRoot }
}

export async function call<T>(
  api: KanbanApi, method: string, path: string, body?: unknown, headers: Record<string, string> = {},
): Promise<T> {
  const res = await fetch(`${api.base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`)
  return (res.status === 204 ? undefined : await res.json()) as T
}

/** Poll until `get()` satisfies `ok`, or throw with the last value. */
export async function pollUntil<T>(what: string, get: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const end = Date.now() + timeoutMs
  let last: T | undefined
  while (Date.now() < end) {
    last = await get().catch(() => last as T)
    if (last !== undefined && ok(last)) return last
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`${what}: timed out, last value ${JSON.stringify(last)?.slice(0, 300)}`)
}

// ── The team ──

export interface KanbanTeam {
  engine: string
  stamp: string
  project: string
  leader: string
  leaderSid: string
  perm: string
  permSid: string
  question: string
  questionSid: string
  handedBack: string
  handedBackSid: string
  stale: string
  /** All 8 idle NEED_ACTION + unread cards (handedBack and stale included). */
  idle: string[]
  running: string[]
  runningSids: string[]
  waiting: string
  /** All 23 COMPLETE cards (oldDone included). */
  done: string[]
  oldDone: string[]
  nested: string
  nestedSid: string
  nonLatin: string
  longTitle: string
  /** The 37 direct subtasks. */
  all: string[]
  /** Open cards tagged sev:1. */
  sev1: string[]
  /** Cards adopted from the boot seed (kanbanSeedTasks). */
  seeded: string[]
  titles: Record<string, string>
  /** The 200 to 300 character task summary each card was given. */
  summaries: Record<string, string>
  tickets: Record<string, string>
  sessions: Record<string, string>
}

export interface SeedKanbanOptions {
  engine: string
  stamp?: string
  /** Every id created, children after parents (the spec deletes them in reverse). */
  litter?: string[]
  /** Running turns last this long (ms). */
  runningMs?: number
}

/** A 250 character title (C46). */
export function longTitleFor(engine: string): string {
  const head = `${ticketOf(1)} ${engine} settlement batch stuck`
  const tail = ' because the ledger export job retries the same window after every partial failure and nobody owns the cleanup'
  let t = head
  while (t.length < 250) t += tail
  return t.slice(0, 250).trimEnd().padEnd(250, '.')
}

/** Non Latin test data, as escapes (U+652F U+4ED8 U+8D85 U+65F6 = "payment timeout" in Chinese). */
export const NON_LATIN_WORDS = '\u652f\u4ed8\u8d85\u65f6'

interface TaskView { id: string; title?: string; summary?: string; phase?: string; unread?: boolean; tags?: string[]; completed_at?: string; created_at?: string; parent_task_id?: string }

export async function getTask(api: KanbanApi, id: string): Promise<TaskView | null> {
  const res = await fetch(`${api.base}/api/tasks/${encodeURIComponent(id)}`)
  if (!res.ok) return null
  const body = (await res.json()) as { task?: TaskView } & TaskView
  return body.task ?? (body.id ? body : null)
}

interface SessionView { process_status?: string; mode?: string; pendingPermission?: { toolName?: string } | null; lastTurnSpeed?: { startedAt?: number } }

export async function getSession(api: KanbanApi, sid: string): Promise<SessionView> {
  const res = await fetch(`${api.base}/api/sessions/${encodeURIComponent(sid)}`)
  if (!res.ok) return {}
  return ((await res.json()) as { session?: SessionView }).session ?? {}
}

/**
 * A mock CLI session on a task (the fixture's MockDaemon runs tests/providers/mock-claude.mjs).
 * A task keeps one session (2026-10-21): on a task that has one, the message continues it, in
 * the mode that session's CLI was spawned with (the mock CLI never switches it live). A `mode`
 * the session does not run in is refused here, since a prompt asked in bypass mode is approved
 * for it and never reaches the user (2026-10-31: two prompt specs waited for one that never came).
 */
export async function startSession(api: KanbanApi, taskId: string, message: string, mode?: string): Promise<string> {
  const existing = mode ? (await call<{ task: { session_id?: string } }>(api, 'GET', `/api/tasks/${taskId}`)).task.session_id : undefined
  if (existing) {
    const running = (await getSession(api, existing)).mode
    if (running && running !== mode) throw new Error(`task ${taskId} already has session ${existing} in ${running} mode: a message continues it there, not in ${mode}`)
  }
  const { sessionId } = await call<{ sessionId: string }>(api, 'POST', '/api/sessions/quick-start', {
    cwd: `${api.fixtureRoot}/projects/walnut`, message, taskId, ...(mode ? { mode } : {}),
  })
  return sessionId
}

const patchTask = (api: KanbanApi, id: string, body: Record<string, unknown>) => call(api, 'PATCH', `/api/tasks/${id}`, body)

async function createCard(api: KanbanApi, title: string, opts: { project: string; parent: string; tags: string[]; summary: string }): Promise<string> {
  const { task } = await call<{ task: { id: string } }>(api, 'POST', '/api/tasks', {
    title, source: 'local', pinned: false, project: opts.project, parent_task_id: opts.parent,
  })
  if (opts.tags.length) await patchTask(api, task.id, { set_tags: opts.tags })
  if (opts.summary) await call(api, 'PUT', `/api/tasks/${task.id}/summary`, { content: opts.summary })
  return task.id
}

/** The summary the mock CLI's turn end triage writes (tests/providers/mock-claude.mjs EXEC_SUMMARY). */
const TURN_END_SUMMARY = 'The fixture turn finished.'

const waitPhase = (api: KanbanApi, id: string, phase: string, ms = 90_000) =>
  pollUntil(`task ${id} phase ${phase}`, async () => (await getTask(api, id))?.phase ?? '', (p) => p === phase, ms)
const waitStatus = (api: KanbanApi, sid: string, status: string, ms = 90_000) =>
  pollUntil(`session ${sid} ${status}`, async () => (await getSession(api, sid)).process_status ?? '', (s) => s === status, ms)
const waitPrompt = (api: KanbanApi, sid: string, tool: string, ms = 90_000) =>
  pollUntil(`session ${sid} prompt ${tool}`, async () => (await getSession(api, sid)).pendingPermission?.toolName ?? '', (t) => t === tool, ms)

/** The tag link rule that makes a ticket chip a link (Settings, user rule). */
export async function setTicketLinkRule(api: KanbanApi): Promise<void> {
  await call(api, 'PUT', '/api/v1/tasks/meta/tag-display', { pattern: 'ticket:*', link: KANBAN_TICKET_LINK })
}

/** Card plan by ticket index (0..36). */
type Role = 'perm' | 'question' | 'running' | 'stale' | 'handed' | 'idle' | 'waiting' | 'done' | 'old'
function roleOf(n: number): Role {
  if (n === 0) return 'perm'
  if (n === 2) return 'question'
  if (n >= 3 && n <= 5) return 'running'
  if (n === STALE_TICKET) return 'stale'
  if (n === 7) return 'handed'
  if (n === 1 || (n >= 8 && n <= 12)) return 'idle'
  if (n === 13) return 'waiting'
  if (n >= OLD_DONE_FIRST_TICKET) return 'old'
  return 'done'
}

const TOPICS = ['checkout latency', 'refund queue backlog', 'card auth declines', 'ledger export lag', 'payout mismatch',
  'webhook retries', 'fraud score drift', 'currency rounding', 'invoice sync gap', 'settlement delay', 'chargeback spike',
  'wallet top up errors', 'tax calc mismatch', 'statement render slow']

/**
 * Builds spec 12 on the fixture server and returns the ids by role. Sessions
 * are started last so the running turns are still running when the page opens.
 */
export async function seedKanbanTeam(api: KanbanApi, opts: SeedKanbanOptions): Promise<KanbanTeam> {
  const engine = opts.engine
  const stamp = opts.stamp ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const project = `${engine}-kanban ${stamp}`
  const litter = opts.litter ?? []
  await setTicketLinkRule(api)
  const { task: lead } = await call<{ task: { id: string } }>(api, 'POST', '/api/tasks', {
    title: `${KANBAN_LEADER_TITLE} ${engine} ${stamp}`, source: 'local', pinned: false, project,
  })
  litter.push(lead.id)
  const leader = lead.id
  const seeds = kanbanSeedIds(engine, await claimSeedSlot(api.fixtureRoot, engine))
  const team: KanbanTeam = {
    engine, stamp, project, leader, leaderSid: '', perm: '', permSid: '', question: '', questionSid: '', handedBack: '',
    handedBackSid: '', stale: '', idle: [], running: [], runningSids: [], waiting: '', done: [], oldDone: [], nested: '',
    nestedSid: '', nonLatin: '', longTitle: '', all: [], sev1: [], seeded: [], titles: {}, summaries: {}, tickets: {}, sessions: {},
  }
  const roles = new Map<string, Role>()
  for (let n = 0; n < 37; n++) {
    const role = roleOf(n)
    const ticket = ticketOf(n)
    let id: string
    let title: string
    if (role === 'old' || role === 'stale') {
      id = role === 'stale' ? seeds.stale : seeds.oldDone[n - OLD_DONE_FIRST_TICKET]
      const seeded = await getTask(api, id)
      if (seeded) {
        await patchTask(api, id, { parent_task_id: leader, project })
        title = seeded.title ?? ''
        team.seeded.push(id)
      } else {
        // No seed (test-server.ts without kanbanSeedTasks): a stand in, so the team still has 37 cards;
        // assertFixtureDensity then fails on the missing old completions or the missing stall.
        title = `${ticket} ${TOPICS[n % TOPICS.length]} unseeded`
        id = await createCard(api, title, { project, parent: leader, tags: [`ticket:${ticket}`, 'sev:2'], summary: summaryFor(n, ticket) })
        litter.push(id)
        if (role === 'old') await patchTask(api, id, { phase: 'COMPLETE' })
      }
    } else {
      title = n === 1 ? longTitleFor(engine) : n === 8 ? `${ticket} ${NON_LATIN_WORDS} refund queue backlog` : `${ticket} ${TOPICS[n % TOPICS.length]}`
      const sev = role === 'perm' || role === 'question' ? 'sev:1' : 'sev:2'
      id = await createCard(api, title, { project, parent: leader, tags: [`ticket:${ticket}`, sev], summary: summaryFor(n, ticket) })
      litter.push(id)
      if (sev === 'sev:1') team.sev1.push(id)
    }
    roles.set(id, role)
    if (!team.seeded.includes(id)) team.summaries[id] = summaryFor(n, ticket)
    team.all.push(id)
    team.tickets[id] = ticket
    if (title) team.titles[id] = title
    if (n === 1) team.longTitle = id
    if (n === 8) team.nonLatin = id
  }
  return finishTeam(api, team, roles, litter, opts.runningMs ?? 900_000)
}

async function finishTeam(api: KanbanApi, team: KanbanTeam, roles: Map<string, Role>, litter: string[], runningMs: number): Promise<KanbanTeam> {
  const byRole = (r: Role) => team.all.filter((id) => roles.get(id) === r)
  const waitUntil = new Date(Date.now() + 2 * 86_400_000).toISOString()
  for (const id of [...byRole('done'), ...byRole('old')]) {
    if ((await getTask(api, id))?.phase !== 'COMPLETE') await patchTask(api, id, { phase: 'COMPLETE' })
  }
  team.done = [...byRole('done'), ...byRole('old')]
  team.oldDone = byRole('old')
  team.waiting = byRole('waiting')[0]
  await patchTask(api, team.waiting, { phase: 'WAITING', wait_until: waitUntil })

  // A nested worker under an open idle card, waiting on a Bash prompt (rolls up into its parent, C60).
  const nestedParent = team.all[9]
  const nested = await createCard(api, `${ticketOf(9)} nested ledger probe`, { project: team.project, parent: nestedParent, tags: [], summary: '' })
  litter.push(nested)
  team.nested = nested
  team.titles[nested] = `${ticketOf(9)} nested ledger probe`

  const sid = async (id: string, message: string, mode?: string) => {
    const s = await startSession(api, id, message, mode)
    team.sessions[id] = s
    return s
  }
  // The question comes before the leader has a session: a worker's question goes to its leader's
  // session when there is one (worker-question.ts), and stays with the user, on its card, when not.
  team.question = byRole('question')[0]
  team.questionSid = await sid(team.question, 'status-permission-test:AskUserQuestion', 'default')
  await waitPrompt(api, team.questionSid, 'AskUserQuestion')
  // `default`: a prompt the leader asks later (C39) must reach the user, and its one session keeps this mode.
  team.leaderSid = await sid(team.leader, 'snapshot-clean-turn:Kanban leader ready', 'default')
  const stale = byRole('stale')[0]
  team.stale = stale
  const seededStale = team.seeded.includes(stale)
  const plainIdle = [...byRole('idle'), ...(seededStale ? [] : [stale])]
  for (const id of plainIdle) await sid(id, `snapshot-clean-turn:${team.tickets[id]} worker reported`)
  team.handedBack = byRole('handed')[0]
  team.handedBackSid = await sid(team.handedBack, `snapshot-clean-turn:${team.tickets[team.handedBack]} worker hands back`)
  team.perm = byRole('perm')[0]
  team.permSid = await sid(team.perm, 'status-permission-test:Bash', 'default') // `default`: the fixture's mode would approve it
  team.nestedSid = await sid(nested, 'status-permission-test:Bash', 'default')

  const turnEnded = [team.leader, ...plainIdle, team.handedBack]
  for (const id of turnEnded) await waitPhase(api, id, 'NEED_ACTION')
  // A finished turn's triage writes the task summary a moment after the turn ends (its side
  // question to the mock CLI): wait for it before the long summaries go back (keepSummaries).
  await pollUntil('turn end summaries', async () => (await Promise.all(turnEnded.map((id) => getTask(api, id))))
    .filter((t) => t?.summary !== TURN_END_SUMMARY).map((t) => t?.id), (left) => left.length === 0, 120_000)
  // A top level task whose turn ended asking nothing needs the user (its hand back,
  // src/core/user-status.ts), and every Needs you count of a team adds a leader that needs the
  // user. This leader carries on, collecting its workers' reports: the line a person sets through
  // the task's report (2026-10-31: its hand back made every such count one more than the cards).
  await leaderCarriesOn(api, team)
  // The worker itself hands its task back (its own sid as the caller): handed_back_at, red (G2).
  await patchTask(api, team.handedBack, { phase: 'IN_PROGRESS' })
  await call(api, 'PATCH', `/api/v1/tasks/${team.handedBack}`, { phase: 'NEED_ACTION' }, { 'x-walnut-caller-sid': team.handedBackSid })
  team.idle = [...byRole('idle'), team.handedBack, stale]
  for (const id of team.idle) await patchTask(api, id, { unread: true })
  await waitPrompt(api, team.permSid, 'Bash')
  await waitPrompt(api, team.nestedSid, 'Bash')

  // Running last, so the turns are still running when the page opens.
  team.running = byRole('running')
  for (const id of team.running) team.runningSids.push(await sid(id, `slow:${runningMs} ${team.tickets[id]} long probe`))
  for (const s of team.runningSids) {
    await waitStatus(api, s, 'running')
    await call(api, 'PATCH', `/api/sessions/${s}`, { activity: 'Reading logs' })
  }
  await keepSummaries(api, team, [...plainIdle, team.handedBack].filter((id) => team.summaries[id]))
  await waitUserStatuses(api, team)
  return team
}

/**
 * Puts each card's long task summary back over its turn end's, and holds it until none was
 * rewritten for `quietMs`. A snapshot that sees a turn end may run the turn end hooks again
 * (SESSION_TURN_SETTLED, src/core/session-hooks/derive/session.ts), and so the triage, which
 * rewrites the summary up to about 40 s later (2026-10-31: cards read "The fixture turn
 * finished." over their seeded summary in the middle of a test).
 */
async function keepSummaries(api: KanbanApi, team: KanbanTeam, ids: readonly string[], quietMs = 45_000): Promise<void> {
  const end = Date.now() + 240_000
  let quietSince = Date.now()
  while (Date.now() - quietSince < quietMs) {
    const off = (await Promise.all(ids.map((id) => getTask(api, id)))).filter((t) => t && t.summary !== team.summaries[t.id])
    for (const t of off) await call(api, 'PUT', `/api/tasks/${t!.id}/summary`, { content: team.summaries[t!.id] })
    if (off.length) quietSince = Date.now()
    if (Date.now() > end) throw new Error(`task summaries kept being rewritten: ${off.map((t) => t!.id).join(', ')}`)
    await new Promise((r) => setTimeout(r, 1000))
  }
}

type StatusRow = { id: string; phase: string; user_status?: { state: string } }

/** The leader's own line: it carries on, collecting its workers' reports (finishTeam). */
const leaderCarriesOn = (api: KanbanApi, team: Pick<KanbanTeam, 'leader'>) => call(api, 'PUT', `/api/v1/tasks/${team.leader}/report`, { state: 'working', next: "Collect the workers' reports" })

/**
 * Run `act` (a worker errs) and keep the leader carrying on: the error wakes the idle leader, whose turn
 * end hands it back and moves its status under the chips 20 s later (HANDBACK_SETTLE_MS; 2026-11-01: C33
 * read 1 on 4 of 11 CI runs). The mock CLI ends its process after that turn, and carrying on needs a live
 * one (report-set.ts): wait for the end, run one clean turn, set the line.
 */
export async function withLeaderCarryingOn<T>(api: KanbanApi, team: Pick<KanbanTeam, 'leader'>, act: () => Promise<T>): Promise<T> {
  const leaderTask = async () => (await call<{ task: StatusRow }>(api, 'GET', `/api/tasks/${team.leader}`)).task
  // Carrying on first, so the leader's next NEED_ACTION is the end of the turn `act` wakes.
  await leaderCarriesOn(api, team)
  await waitPhase(api, team.leader, 'IN_PROGRESS', 15_000)
  const out = await act()
  await waitPhase(api, team.leader, 'NEED_ACTION')
  const restartAt = Date.now()
  const sid = await startSession(api, team.leader, 'snapshot-clean-turn:Kanban leader carries on', 'default')
  await pollUntil('leader turn settled', () => getSession(api, sid),
    (s) => (s.lastTurnSpeed?.startedAt ?? 0) >= restartAt && s.process_status === 'idle', 60_000)
  await waitPhase(api, team.leader, 'NEED_ACTION')
  await pollUntil('leader carries on', async () => {
    if ((await leaderTask()).phase !== 'IN_PROGRESS') await leaderCarriesOn(api, team)
    return leaderTask()
  }, (t) => t.phase === 'IN_PROGRESS' && t.user_status?.state !== 'needs', 30_000)
  return out
}

/**
 * The server derives each task's user status a moment after its facts move (a debounced pass,
 * src/core/user-status-sync.ts); until then a surface reads the phase. Wait for the derived
 * values, so no test reads that first guess: every open card has one, the prompts need the
 * user, the hand back waits on its lead, and the leader does not need the user (finishTeam).
 */
async function waitUserStatuses(api: KanbanApi, team: KanbanTeam): Promise<void> {
  // The leader carries on with no turn running, so it reads Waiting (on its workers), never Needs you.
  const want: Record<string, string> = { [team.perm]: 'needs', [team.handedBack]: 'waiting' }
  for (const id of team.running) want[id] = 'working'
  await pollUntil('derived user statuses', async () => {
    const rows = await Promise.all([team.leader, ...team.all].map(async (id) => (await call<{ task: StatusRow }>(api, 'GET', `/api/tasks/${id}`)).task))
    const off = (t: StatusRow) => !t.user_status || (t.id === team.leader ? t.user_status.state === 'needs' : !!want[t.id] && t.user_status.state !== want[t.id])
    return rows.filter((t) => t.phase !== 'COMPLETE' && off(t)).map((t) => `${t.id} ${t.phase} ${t.user_status?.state ?? 'none'} want ${t.id === team.leader ? 'not needs' : want[t.id] ?? 'any'}`)
  }, (missing) => missing.length === 0, 90_000)
}

/** Running activity every `intervalMs` (default 2s), rotating texts (G9, G36). Returns stop(). */
export function startStatusPulse(
  api: KanbanApi, sids: readonly string[], opts: { intervalMs?: number; texts?: readonly string[] } = {},
): { stop: () => Promise<void>; ticks: () => number } {
  const texts = opts.texts ?? ['Reading logs', 'Reading config', 'Running tests', 'Reading metrics']
  let n = 0
  let inFlight: Promise<unknown> = Promise.resolve()
  const timer = setInterval(() => {
    n++
    const text = texts[n % texts.length]
    inFlight = Promise.all(sids.map((s) => call(api, 'PATCH', `/api/sessions/${s}`, { activity: text }).catch(() => undefined)))
  }, opts.intervalMs ?? 2000)
  return {
    stop: async () => { clearInterval(timer); await inFlight },
    ticks: () => n,
  }
}

/** The variant with cards the user placed (G2, G10): through the human card route, no caller header. */
export async function presetHumanPlacement(
  api: KanbanApi, team: Pick<KanbanTeam, 'leader'>, placements: ReadonlyArray<{ task: string; lane: string; summary?: string; waiting_on?: string }>,
): Promise<void> {
  for (const p of placements) {
    const { task, ...body } = p
    await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${task}`, body)
  }
}

export interface KanbanDensity {
  direct: number
  open: number
  complete: number
  completeOlderThan7d: number
  idleNeedActionUnread: number
  running: number
  openSev1: number
  /** Direct cards whose task summary is 200 to 300 characters. */
  summaries200to300: number
  /** Length of the board payload's `team` (null when the server does not send it). */
  payloadTeam: number | null
}

/** Counts the team as the server sees it (individual task reads, then the board payload). */
export async function measureFixtureDensity(api: KanbanApi, team: KanbanTeam): Promise<KanbanDensity> {
  const tasks = await Promise.all(team.all.map((id) => getTask(api, id)))
  const direct = tasks.filter((t) => t?.parent_task_id === team.leader)
  const weekAgo = Date.now() - 7 * 86_400_000
  const complete = direct.filter((t) => t?.phase === 'COMPLETE')
  const idle = team.idle.map((id) => direct.find((t) => t?.id === id))
  const sessions = await Promise.all(team.runningSids.map((s) => getSession(api, s)))
  const board = await fetch(`${api.base}/api/v1/tasks/${team.leader}/board?team=1`).then((r) => (r.ok ? r.json() : null)).catch(() => null) as
    { team?: unknown[] } | null
  return {
    direct: direct.length,
    open: direct.length - complete.length,
    complete: complete.length,
    completeOlderThan7d: complete.filter((t) => Date.parse(t?.completed_at ?? '') < weekAgo).length,
    idleNeedActionUnread: idle.filter((t) => t?.phase === 'NEED_ACTION' && t.unread === true).length,
    running: sessions.filter((s) => s.process_status === 'running').length,
    openSev1: direct.filter((t) => t?.phase !== 'COMPLETE' && (t?.tags ?? []).includes('sev:1')).length,
    summaries200to300: direct.filter((t) => (t?.summary?.length ?? 0) >= 200 && (t?.summary?.length ?? 0) <= 300).length,
    payloadTeam: Array.isArray(board?.team) ? board.team.length : null,
  }
}

export const EXPECTED_DENSITY: KanbanDensity = {
  direct: 37, open: 14, complete: 23, completeOlderThan7d: 10, idleNeedActionUnread: 8, running: 3, openSev1: 2, summaries200to300: 37, payloadTeam: 37,
}

/** C90: the spec's first assertion. Any mismatch throws, naming every count that is off. */
export async function assertFixtureDensity(api: KanbanApi, team: KanbanTeam): Promise<KanbanDensity> {
  const got = await measureFixtureDensity(api, team)
  const off = (Object.keys(EXPECTED_DENSITY) as Array<keyof KanbanDensity>)
    .filter((k) => got[k] !== EXPECTED_DENSITY[k])
    .map((k) => `${k}: expected ${EXPECTED_DENSITY[k]}, got ${got[k]}`)
  if (team.seeded.length < 11) off.push(`seeded rows adopted: expected 11, got ${team.seeded.length} (add kanbanSeedTasks to test-server.ts)`)
  if (off.length) throw new Error(`kanban fixture density is off:\n  ${off.join('\n  ')}`)
  return got
}

/**
 * The Board opens on Status (BoardStatusView, the default since 2026-10-25). The kanban
 * specs test Cards, so their windows open the way a user who picked Cards before does:
 * the remembered pick (board-view-pref.ts) is set before the page loads, once, so a pick
 * the test itself makes still wins after a reload.
 */
export async function pickCardsView(target: Pick<BrowserContext, 'addInitScript'>, ...ownerIds: string[]): Promise<void> {
  await target.addInitScript((ids: string[]) => {
    try {
      for (const id of ids) {
        const key = `walnut:board-view.v1:${id}`
        if (!localStorage.getItem(key)) localStorage.setItem(key, 'cards')
      }
    } catch { /* storage blocked: the spec's own Cards click still picks it */ }
  }, ownerIds)
}
