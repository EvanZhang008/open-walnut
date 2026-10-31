/**
 * The user's grants for `host_exec` (host-exec.ts): may this task run commands
 * on that host? One grant covers one task on one host, any folder, until the
 * user revokes it (the user, 2026-10-31: "task + host, no time limit, any
 * folder"; he first picked 2 hours and one folder, then found both too tight).
 *
 * A task without a grant gets ONE letter per host asking the user (Allow /
 * Deny), never one per command; while it waits every call is refused with
 * `exec_grant_required`, and on Allow the asking session hears it may run the
 * command again. A Deny is kept: the task is refused with `exec_grant_denied`
 * and no new letter goes out (Settings lists it with an Allow).
 * Only a person grants or revokes: the routes refuse a session (`human_only`), and
 * an answer a task records in the user's place counts as none.
 *
 * Stored at WALNUT_HOME/host-exec-grants.json on the primary. Never on a
 * replica: the boot job is leader only and the routes need the leader.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'

export interface ExecGrant {
  id: string
  taskId: string
  host: string
  grantedAt: number
  /** Where the user said yes: the letter or Settings. */
  via: 'letter' | 'settings'
  revokedAt?: number
  /** Commands run under it, and the last one (its first 200 characters). */
  runs: number
  lastRunAt?: number
  lastCommand?: string
}

export interface ExecAsk {
  taskId: string
  host: string
  letterId: string
  askedAt: number
  /** The session that asked: it hears the answer. */
  sid: string
  state: 'pending' | 'denied'
  answeredAt?: number
}

interface Store { grants: ExecGrant[]; asks: ExecAsk[] }

const FILE_NAME = 'host-exec-grants.json'
export const ALLOW_ACTION = 'allow'
export const DENY_ACTION = 'deny'

let fileOverride: string | null = null
function file(): string {
  return fileOverride ?? path.join(WALNUT_HOME, FILE_NAME)
}

/** Tests: point the store at a temp file (null = back to WALNUT_HOME). */
export function setExecGrantsFileForTest(f: string | null): void {
  fileOverride = f
}

function read(): Store {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<Store>
    return { grants: Array.isArray(raw.grants) ? raw.grants : [], asks: Array.isArray(raw.asks) ? raw.asks : [] }
  } catch {
    return { grants: [], asks: [] }
  }
}

// One writer at a time in this process; the file is the primary's alone.
let chain: Promise<unknown> = Promise.resolve()
function mutate<T>(fn: (s: Store) => T): Promise<T> {
  const next = chain.then(async () => {
    const s = read()
    const out = fn(s)
    const target = file()
    const tmp = `${target}.${process.pid}.tmp`
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    await fs.promises.writeFile(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 })
    await fs.promises.rename(tmp, target)
    return out
  })
  chain = next.catch(() => {})
  return next
}

/** The live grant for this task on this host, if any. */
export function findGrant(taskId: string, host: string): ExecGrant | undefined {
  return read().grants.find((g) => g.taskId === taskId && g.host === host && !g.revokedAt)
}

export function findAsk(taskId: string, host: string): ExecAsk | undefined {
  return read().asks.find((a) => a.taskId === taskId && a.host === host)
}

/** Every grant, newest first; revoked ones only with `all`. */
export function listGrants(opts: { all?: boolean } = {}): ExecGrant[] {
  return read().grants.filter((g) => opts.all || !g.revokedAt).sort((a, b) => b.grantedAt - a.grantedAt)
}

export async function grant(taskId: string, host: string, via: ExecGrant['via']): Promise<ExecGrant> {
  return mutate((s) => {
    const live = s.grants.find((g) => g.taskId === taskId && g.host === host && !g.revokedAt)
    s.asks = s.asks.filter((a) => !(a.taskId === taskId && a.host === host))
    if (live) return live
    const g: ExecGrant = { id: `xg-${randomUUID().slice(0, 12)}`, taskId, host, grantedAt: Date.now(), via, runs: 0 }
    s.grants.push(g)
    return g
  })
}

/** Revoke a grant; a later call from the task asks the user again. */
export async function revokeGrant(id: string): Promise<ExecGrant | null> {
  return mutate((s) => {
    const g = s.grants.find((x) => x.id === id && !x.revokedAt)
    if (!g) return null
    g.revokedAt = Date.now()
    return g
  })
}

export async function noteRun(grantId: string, command: string): Promise<void> {
  await mutate((s) => {
    const g = s.grants.find((x) => x.id === grantId)
    if (!g) return
    g.runs += 1
    g.lastRunAt = Date.now()
    g.lastCommand = command.slice(0, 200)
  }).catch((err) => log.session.warn('host exec: grant run not recorded', { grantId, error: String(err) }))
}

export async function recordAsk(ask: ExecAsk): Promise<void> {
  await mutate((s) => {
    s.asks = s.asks.filter((a) => !(a.taskId === ask.taskId && a.host === ask.host))
    s.asks.push(ask)
  })
}

/** The ask a letter answers, marked with the answer; null when the letter is not one of ours. */
async function settleAsk(letterId: string, allowed: boolean): Promise<ExecAsk | null> {
  return mutate((s) => {
    const a = s.asks.find((x) => x.letterId === letterId && x.state === 'pending')
    if (!a) return null
    if (allowed) {
      s.asks = s.asks.filter((x) => x !== a)
      if (!s.grants.some((g) => g.taskId === a.taskId && g.host === a.host && !g.revokedAt)) {
        s.grants.push({ id: `xg-${randomUUID().slice(0, 12)}`, taskId: a.taskId, host: a.host, grantedAt: Date.now(), via: 'letter', runs: 0 })
      }
    } else {
      a.state = 'denied'
      a.answeredAt = Date.now()
    }
    return { ...a }
  })
}

type LetterView = { archived?: boolean; archivedReason?: string; settled?: unknown; answered?: { actionId?: string; by?: { taskId?: string } } } | null

async function letterOf(letterId: string): Promise<LetterView> {
  const { getLetter } = await import('../human-inbox/store.js')
  return await getLetter(letterId).catch(() => null) as LetterView
}

/** The user's own answer on the letter: allow, deny, or none (unanswered, or answered by a task in their place). */
function usersAnswer(letter: LetterView): 'allow' | 'deny' | null {
  const a = letter?.answered
  if (!a || a.by) return null
  return a.actionId === ALLOW_ACTION ? 'allow' : a.actionId === DENY_ACTION ? 'deny' : null
}

/**
 * Before a pending ask refuses again: the letter may have been answered while we missed
 * the event (the answer is applied now), or may no longer reach the user (gone, settled
 * or archived by Walnut, answered by a task in their place): then the ask is dropped and
 * the caller writes a new letter. A letter the user archived stays the ask: re-asking at
 * every command would flood them.
 */
export async function refreshAsk(ask: ExecAsk): Promise<'pending' | 'granted' | 'denied' | 'dropped'> {
  if (ask.state !== 'pending') return ask.state
  const letter = await letterOf(ask.letterId)
  const answer = usersAnswer(letter)
  if (answer) {
    await onLetterAnswered({ letterId: ask.letterId, actionId: answer })
    return answer === 'allow' ? 'granted' : 'denied'
  }
  const gone = !letter || !!letter.settled || !!letter.answered || (letter.archived === true && !!letter.archivedReason)
  if (!gone) return 'pending'
  await mutate((s) => { s.asks = s.asks.filter((a) => a.letterId !== ask.letterId) })
  log.session.info('host exec: a grant letter no longer reaches the user; asking again', { taskId: ask.taskId, host: ask.host, letterId: ask.letterId })
  return 'dropped'
}

/**
 * A letter answer. Only the user's own Allow makes a grant and tells the asking session;
 * only their own Deny is kept. An answer a task recorded in their place (`answered.by`), or
 * a letter that cannot be read back, counts as no answer: the ask stays pending, so the
 * user's answer over it (the inbox lets a person answer over a task's) still settles it. A
 * withdrawn letter drops the ask, so the next command asks again.
 */
export async function onLetterAnswered(event: { letterId?: unknown; actionId?: unknown }): Promise<void> {
  if (typeof event.letterId !== 'string') return
  const letterId = event.letterId
  const pending = read().asks.find((a) => a.letterId === letterId && a.state === 'pending')
  if (!pending) return
  if (event.actionId === 'withdrawn') {
    await mutate((s) => { s.asks = s.asks.filter((a) => a.letterId !== letterId) })
    return
  }
  if (event.actionId !== ALLOW_ACTION && event.actionId !== DENY_ACTION) return
  const answer = usersAnswer(await letterOf(letterId))
  if (answer !== event.actionId) {
    log.session.warn('host exec: a grant letter answered by a task, not the user; ignored', { taskId: pending.taskId, host: pending.host, letterId })
    return
  }
  const allowed = answer === ALLOW_ACTION
  const ask = await settleAsk(letterId, allowed)
  if (!ask) return
  log.session.info('host exec: the user answered a grant letter', { taskId: ask.taskId, host: ask.host, allowed })
  if (!allowed) return
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js')
    const record = await getSessionByClaudeId(ask.sid)
    if (!record) return
    const { deliverToSession } = await import('../sessions/session-send-core.js')
    const text = `<walnut-message kind="notification" from="Walnut" outcome="host-exec-granted">\n`
      + `The user allowed this task to run commands on host "${ask.host}" (host_exec), any folder, until they revoke it. `
      + `Run the command again.\n</walnut-message>`
    await deliverToSession(record, { busText: text, enqueueText: text, source: 'walnut-notify', taskId: ask.taskId, endsWait: true })
  } catch (err) {
    log.session.warn('host exec: the asking session was not told of the grant', { taskId: ask.taskId, host: ask.host, error: String(err) })
  }
}

/** Every ask the user declined, newest first (Settings lists them with an Allow). */
export function listDenied(): ExecAsk[] {
  return read().asks.filter((a) => a.state === 'denied').sort((a, b) => (b.answeredAt ?? b.askedAt) - (a.answeredAt ?? a.askedAt))
}

let wired = false
/** Listen for answers to grant letters (boot job `host-exec-grants`, leader only). */
export async function startExecGrantAnswers(): Promise<void> {
  if (wired) return
  wired = true
  const { bus } = await import('../event-bus.js')
  bus.subscribe('host-exec-grants', (event) => {
    if (event.name !== 'human-inbox:answered') return
    void onLetterAnswered(event.data as Record<string, unknown>)
  }, { global: true, interest: ['human-inbox:answered'] })
}
