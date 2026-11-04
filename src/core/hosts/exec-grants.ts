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
 * A task on a host the user registered (this Mac, a host in Settings > Remote
 * Hosts) asks no one (the user, 2026-11-01: "why must you ask me, can't it just use it,
 * stop asking me"): its first call makes the grant (`via: 'own-host'`), logged and
 * counted like any other, and a grant the user revokes stays revoked, so that task asks
 * by letter from then on. Each host also has a hard stop (the closed hosts, in their own file
 * beside this one so an older Walnut's writes never drop them): while it is on,
 * no task from any other host may start anything there, grant or not.
 *
 * Stored at WALNUT_HOME/host-exec-grants.json on the primary. Never on a
 * replica: the boot job is leader only and the routes need the leader.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import type { LetterRecord } from '../human-inbox/types.js'
import type { StillNeededContext } from '../human-inbox/walnut-letters/kind.js'
import type { HostExecSettleWhy } from '../human-inbox/walnut-letters/host-exec-ask.js'

export interface ExecGrant {
  id: string
  taskId: string
  host: string
  grantedAt: number
  /** Where the yes came from: the user's letter or Settings, or a task on a host he registered (no one asked). */
  via: 'letter' | 'settings' | 'own-host'
  revokedAt?: number
  /** An own-host grant made from a letter still asking: the user's Deny on it still wins. */
  letterId?: string
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
  /** The host that session runs on (asks written before 2026-11-01 lack it). */
  fromHost?: string
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
/** Whether a task may use a host now: a live grant there, and the host not closed. */
export type AccessCheck = (taskId: string, host: string) => boolean

/** Told after every change to who may use which host: a grant made or revoked, a host closed or opened. */
const accessListeners = new Set<(may: AccessCheck) => void>()

/** Hear every change to the grants and the closed hosts (a read in flight ends at a revoke); returns the removal. */
export function onAccessChange(fn: (may: AccessCheck) => void): () => void {
  accessListeners.add(fn)
  return () => { accessListeners.delete(fn) }
}

/** The live grants, as `task\nhost` keys: what a listener's check reads. */
function liveKeys(s: Store): Set<string> {
  return new Set(s.grants.filter((g) => !g.revokedAt).map((g) => `${g.taskId}\n${g.host}`))
}

function sameKeys(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const k of a) if (!b.has(k)) return false
  return true
}

/**
 * Every listener asks one answer built once a change, from the grants just written (`live`, else
 * read) and the closed hosts (2026-11-05 code review: each waiting read re-read and parsed both
 * files itself, 404 ms of the server's loop at 2000 grants and 128 waits, on every run's noteRun
 * write). Only a change to who may use a host tells them: a run noted or an ask settled does not.
 */
function accessChanged(live?: Set<string>): void {
  if (!accessListeners.size) return
  let may: AccessCheck
  try {
    const closed = new Set(closedHosts())
    const keys = live ?? liveKeys(read())
    may = (taskId, host) => !closed.has(host) && keys.has(`${taskId}\n${host}`)
  } catch { return }
  for (const fn of [...accessListeners]) {
    try { fn(may) } catch { /* one listener's fault is its own */ }
  }
}

function mutate<T>(fn: (s: Store) => T): Promise<T> {
  const next = chain.then(async () => {
    const s = read()
    // Taken whether or not anyone listens yet: a read may start listening while this write runs.
    const before = liveKeys(s)
    const out = fn(s)
    const target = file()
    const tmp = `${target}.${process.pid}.tmp`
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    await fs.promises.writeFile(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 })
    await fs.promises.rename(tmp, target)
    const after = liveKeys(s)
    if (!sameKeys(before, after)) accessChanged(after)
    return out
  })
  chain = next.catch(() => {})
  return next
}

/** The live grant for this task on this host, if any. */
export function findGrant(taskId: string, host: string): ExecGrant | undefined {
  return read().grants.find((g) => g.taskId === taskId && g.host === host && !g.revokedAt)
}

/** The grant with this id, live or revoked, if any. */
export function grantById(id: string): ExecGrant | undefined {
  return read().grants.find((g) => g.id === id)
}

/** When the user last revoked a grant of this task on this host, if ever. */
export function lastRevokedAt(taskId: string, host: string): number | undefined {
  let at: number | undefined
  for (const g of read().grants) if (g.taskId === taskId && g.host === host && g.revokedAt && (at === undefined || g.revokedAt > at)) at = g.revokedAt
  return at
}

/** Whether the user ever revoked a grant of this task on this host: then it asks by letter again. */
export function wasRevoked(taskId: string, host: string): boolean {
  return read().grants.some((g) => g.taskId === taskId && g.host === host && !!g.revokedAt)
}

// The hard stop lives in its own file: an older Walnut rewrites the grants file whole, keeping
// only the fields it knows, and would silently reopen every host.
function closedFile(): string {
  return file().replace(/\.json$/, '') + '-closed.json'
}

/** The hosts the user closed: no task from another host starts anything there. */
export function closedHosts(): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(closedFile(), 'utf8')) as { closed?: unknown }
    return Array.isArray(raw.closed) ? raw.closed.filter((h): h is string => typeof h === 'string') : []
  } catch {
    return []
  }
}

export function isHostClosed(host: string): boolean {
  return closedHosts().includes(host)
}

/** Close or open a host to tasks from other hosts (the user, in Settings). */
export async function setHostClosed(host: string, closed: boolean): Promise<string[]> {
  const next = chain.then(async () => {
    const set = new Set(closedHosts())
    if (closed) set.add(host)
    else set.delete(host)
    const out = [...set].sort()
    const target = closedFile()
    const tmp = `${target}.${process.pid}.tmp`
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    await fs.promises.writeFile(tmp, JSON.stringify({ closed: out }, null, 2) + '\n', { mode: 0o600 })
    await fs.promises.rename(tmp, target)
    accessChanged()
    return out
  })
  chain = next.catch(() => {})
  return next
}

export function findAsk(taskId: string, host: string): ExecAsk | undefined {
  return read().asks.find((a) => a.taskId === taskId && a.host === host)
}

/** Every grant, newest first; revoked ones only with `all`. */
export function listGrants(opts: { all?: boolean } = {}): ExecGrant[] {
  return read().grants.filter((g) => opts.all || !g.revokedAt).sort((a, b) => b.grantedAt - a.grantedAt)
}

export async function grant(taskId: string, host: string, via: ExecGrant['via']): Promise<ExecGrant> {
  const { g, replaced } = await mutate((s) => {
    const live = s.grants.find((g) => g.taskId === taskId && g.host === host && !g.revokedAt)
    const replaced = s.asks.filter((a) => a.taskId === taskId && a.host === host && a.state === 'pending')
    s.asks = s.asks.filter((a) => !(a.taskId === taskId && a.host === host))
    if (live) return { g: live, replaced }
    const g: ExecGrant = { id: `xg-${randomUUID().slice(0, 12)}`, taskId, host, grantedAt: Date.now(), via, runs: 0 }
    s.grants.push(g)
    return { g, replaced }
  })
  // A grant made in Settings answers the letter still asking for it (it used to stay open, asking).
  for (const a of replaced) await settleAskLetter(a.letterId, 'granted')
  return g
}

/** Settle an ask's letter for the user, unless someone already answered or closed it. Never throws. */
async function settleAskLetter(letterId: string, why: HostExecSettleWhy): Promise<void> {
  try {
    const letter = await letterOf(letterId)
    if (!letter || letter.settled || letter.answered || letter.archived) return
    const [{ settleLetter }, { walnutLetterLanguage }, { hostExecSettleReason }] = await Promise.all([
      import('../human-inbox/store.js'), import('../human-inbox/walnut-letters/languages.js'), import('../human-inbox/walnut-letters/host-exec-ask.js'),
    ])
    await settleLetter(letterId, { reason: hostExecSettleReason(await walnutLetterLanguage(), why) })
  } catch (err) {
    log.session.warn('host exec: a grant letter was not settled', { letterId, why, error: String(err) })
  }
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
  if (!pending) {
    if (event.actionId === DENY_ACTION) await denyOwnHostGrant(letterId)
    return
  }
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
  await tellGranted(ask, `The user allowed this task to use host "${ask.host}" (host_exec, host_mcp_*, host_http), any folder, until they revoke it.`)
}

/** Tell the asking session it may make its call again. */
async function tellGranted(ask: ExecAsk, why: string): Promise<void> {
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js')
    const record = await getSessionByClaudeId(ask.sid)
    if (!record) return
    const { deliverToSession } = await import('../sessions/session-send-core.js')
    const text = `<walnut-message kind="notification" from="Walnut" outcome="host-exec-granted">\n${why} Make the call again.\n</walnut-message>`
    await deliverToSession(record, { busText: text, enqueueText: text, source: 'walnut-notify', taskId: ask.taskId, endsWait: true })
  } catch (err) {
    log.session.warn('host exec: the asking session was not told of the grant', { taskId: ask.taskId, host: ask.host, error: String(err) })
  }
}

const hostKey = (h: string | null | undefined): string => (!h || h === 'local' ? '__local__' : h)

/**
 * The host an ask came from: recorded on it, else its session's, else where its task's latest
 * session runs (an ask written before 2026-11-01 whose session record is gone: it stayed pending,
 * and its letter open, because nothing could say where it came from).
 */
async function askFromHost(ask: ExecAsk): Promise<string | null> {
  if (ask.fromHost) return ask.fromHost
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js')
    const record = ask.sid ? await getSessionByClaudeId(ask.sid) : null
    if (record) return hostKey((record as { host?: string | null }).host)
  } catch { /* the task's sessions below */ }
  return taskHost(ask.taskId)
}

/** Where a task's latest session runs, or null when it has none. */
async function taskHost(taskId: string): Promise<string | null> {
  try {
    const { getSessionsForTask } = await import('../session-tracker.js')
    const latest = (await getSessionsForTask(taskId))
      .sort((a, b) => Date.parse(b.lastActiveAt ?? '') - Date.parse(a.lastActiveAt ?? ''))[0]
    return latest ? hostKey((latest as { host?: string | null }).host) : null
  } catch { return null }
}


/**
 * The user's Deny on a letter whose ask had already become an own-host grant (the grant was
 * made while their answer was on its way): the grant is revoked and the Deny kept.
 */
async function denyOwnHostGrant(letterId: string): Promise<void> {
  if (usersAnswer(await letterOf(letterId)) !== DENY_ACTION) return
  const g = await mutate((s) => {
    const live = s.grants.find((x) => x.letterId === letterId && x.via === 'own-host' && !x.revokedAt)
    if (!live) return null
    live.revokedAt = Date.now()
    s.asks = s.asks.filter((a) => !(a.taskId === live.taskId && a.host === live.host))
    s.asks.push({ taskId: live.taskId, host: live.host, letterId, askedAt: live.grantedAt, sid: '', state: 'denied', answeredAt: Date.now() })
    return { ...live }
  })
  if (g) log.session.info('host exec: the user denied a letter after its own-host grant; revoked', { taskId: g.taskId, host: g.host, letterId })
}

/** Turn a still-pending ask into an own-host grant, in one write; null when it is no longer pending (someone else settled it). */
async function grantFromAsk(letterId: string): Promise<ExecGrant | null> {
  return mutate((s) => {
    const a = s.asks.find((x) => x.letterId === letterId && x.state === 'pending')
    if (!a) return null
    s.asks = s.asks.filter((x) => x !== a)
    const live = s.grants.find((g) => g.taskId === a.taskId && g.host === a.host && !g.revokedAt)
    if (live) return live
    const g: ExecGrant = { id: `xg-${randomUUID().slice(0, 12)}`, taskId: a.taskId, host: a.host, grantedAt: Date.now(), via: 'own-host', letterId, runs: 0 }
    s.grants.push(g)
    return g
  })
}

/**
 * A pending letter that asks about a task on one of the user's own hosts needs no answer:
 * the grant is made, the letter settled, the asking session told. `isOwnHost` says which
 * hosts the user registered. Runs at boot (the asks written before 2026-11-01) and when
 * such a task calls again (`only`, with the caller's host), and from the letter sweep for one
 * letter (`only.letterId`, walnut-letters/sweep.ts). The user's own answer on the letter, already
 * given, wins over all of it.
 */
export async function settleOwnHostAsks(
  isOwnHost: (host: string) => Promise<boolean>,
  only?: { taskId: string; host: string; fromHost: string } | { letterId: string },
): Promise<number> {
  const pending = read().asks.filter((a) => a.state === 'pending' && (!only
    || ('letterId' in only ? a.letterId === only.letterId : a.taskId === only.taskId && a.host === only.host)))
  const caller = only && 'fromHost' in only ? only : undefined
  let n = 0
  for (const ask of pending) {
    const from = caller?.fromHost ?? await askFromHost(ask)
    if (!from || !(await isOwnHost(from)) || isHostClosed(ask.host) || wasRevoked(ask.taskId, ask.host)) continue
    const letter = await letterOf(ask.letterId)
    const answer = usersAnswer(letter)
    if (answer) { await onLetterAnswered({ letterId: ask.letterId, actionId: answer }); continue }
    if (!(await grantFromAsk(ask.letterId))) continue
    // One someone already closed keeps its own record.
    await settleAskLetter(ask.letterId, 'own-host')
    log.session.info('host exec: an own-host ask granted without the user', { taskId: ask.taskId, host: ask.host, fromHost: from, letterId: ask.letterId })
    // A task settling its own ask is mid-call and gets its answer there; only a waiting one is told.
    if (!caller) await tellGranted(ask, `Walnut allowed this task to use host "${ask.host}" (host_exec, host_mcp_*, host_http): it runs on one of the user's own hosts, so it needs no letter.`)
    n++
  }
  return n
}

/** A letter this young may not have its ask recorded yet (grantOrAsk sends, then records). */
const ASK_RECORD_GRACE_MS = 2 * 60_000

/**
 * The letter sweep's rule for a grant letter (walnut-letters/host-exec-ask.ts): the reason to settle
 * it, in the user's words, or null while it still asks for something. Covers the letters the ask
 * path never reaches: an ask whose task never calls again, an ask written before its host was
 * recorded, a letter whose ask is gone (granted in Settings, replaced, or rewritten away by an older
 * Walnut, after which its Allow would do nothing).
 */
export async function execAskSettleReason(letter: LetterRecord, ctx: StillNeededContext): Promise<string | null> {
  if (letter.answered || letter.archived || ctx.now - letter.createdAt < ASK_RECORD_GRACE_MS) return null
  const { hostExecSettleReason } = await import('../human-inbox/walnut-letters/host-exec-ask.js')
  const say = (why: HostExecSettleWhy) => hostExecSettleReason(ctx.lang, why)
  const marked = (letter.createdByOp ?? '').split(':')
  const host = marked[0] === 'host-exec-ask' && marked[1] ? decodeURIComponent(marked[1]) : undefined
  const taskId = (marked[0] === 'host-exec-ask' && marked[2] ? decodeURIComponent(marked[2]) : undefined) ?? letter.taskRefs?.[0]
  if (!taskId) return null
  const task = await ctx.task(taskId)
  if (!task) return say('task-gone')
  if (task.phase === 'COMPLETE') return say('task-done')
  const pending = read().asks.find((a) => a.letterId === letter.id && a.state === 'pending')
  if (pending) {
    // The ask path's own rule, for a task that has not called again: grant, settle, tell it.
    const { isOwnHost } = await import('./host-exec.js')
    await settleOwnHostAsks(isOwnHost, { letterId: letter.id })
    return null
  }
  const grants = read().grants.filter((g) => !g.revokedAt && g.taskId === taskId)
  if (grants.some((g) => g.letterId === letter.id || (host !== undefined && g.host === host))) return say('granted')
  const from = await taskHost(taskId)
  if (from) {
    const { isOwnHost } = await import('./host-exec.js')
    if (await isOwnHost(from) && (host === undefined || (!isHostClosed(host) && !wasRevoked(taskId, host)))) return say('own-host-now')
  }
  // No ask holds this letter: an Allow on it would grant nothing (onLetterAnswered finds no ask).
  return say('no-ask')
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
  // The letters still waiting for tasks on the user's own hosts are settled now (2026-11-01).
  void import('./host-exec.js').then((m) => settleOwnHostAsks(m.isOwnHost)).then((n) => {
    if (n) log.session.info('host exec: own-host asks settled at boot', { count: n })
  }).catch((err) => log.session.warn('host exec: own-host asks not settled at boot', { error: String(err) }))
  const { bus } = await import('../event-bus.js')
  bus.subscribe('host-exec-grants', (event) => {
    if (event.name !== 'human-inbox:answered') return
    void onLetterAnswered(event.data as Record<string, unknown>)
  }, { global: true, interest: ['human-inbox:answered'] })
}
