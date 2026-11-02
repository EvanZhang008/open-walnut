/**
 * `host_exec`: a task's session runs one command on ANOTHER host Walnut knows,
 * through the link (link.ts), and gets its exit code and output back (the user,
 * 2026-10-31: "use another host's capability ... a terminal"). The way across
 * is the link's business; the run itself is the host's daemon's
 * (src/providers/host-exec-core.ts). This file is the gate, all server-side:
 *
 *   - only a task's session asks (the user runs commands in their own terminal);
 *   - never on the caller's own host (that is its own Bash tool);
 *   - only under the user's grant for this task on this host (exec-grants.ts),
 *     asked for once by letter, kept until revoked;
 *   - at most 2 runs at once per task and 4 per host;
 *   - a foreground run ends by 10 minutes (the host kills its process group), a
 *     background one by 2 hours; only the tail of the output comes back (256 KB),
 *     the whole log stays in the task's directory on that host;
 *   - a line of output that looks like a credential is replaced before it leaves
 *     this server (the git-sync scanner), which stops an accident, not a reader.
 *
 * Every run is logged here and in the host's own audit file, and counted on its grant.
 */
import { randomUUID } from 'node:crypto'
import { log } from '../../logging/index.js'

export const MAX_RUNNING_PER_TASK = 2
export const MAX_RUNNING_PER_HOST = 4
const DIAL_MS = 15_000
const REPLY_MARGIN_MS = 30_000
const LIST_MS = 5_000
const KILL_GRACE_MS = 3_000
/** The longest a call from a session on another host holds its answer (its gateway's 20 s, less the way there and back). */
export const RELAYED_HOLD_MS = 14_000
const FOREGROUND_MAX_MS = 10 * 60_000
const BACKGROUND_MAX_MS = 2 * 60 * 60_000
const LOCAL = '__local__'

export class HostExecError extends Error {
  constructor(message: string, public status: number, public code: string, public data: Record<string, unknown> = {}) {
    super(message)
    this.name = 'HostExecError'
  }
}

export interface ExecParams {
  host: string
  command?: string
  argv?: string[]
  cwd?: string
  timeout_ms?: number
  background?: boolean
}

export interface Caller { sid: string; taskId: string; taskTitle: string; host: string }

/** In flight, by job: who runs it and until when it may run (a background job that is never read again ends by itself). */
const running = new Map<string, { taskId: string; host: string; until: number; at: number }>()
/** A job the host has not confirmed (`at` set, not 0) may not have reached it yet: a refresh drops it only after this long. */
const REFRESH_GRACE_MS = 10_000

function countRunning(pred: (r: { taskId: string; host: string }) => boolean): number {
  const t = Date.now()
  let n = 0
  for (const [id, r] of running) {
    if (r.until < t) { running.delete(id); continue }
    if (pred(r)) n++
  }
  return n
}

function normHost(h: string | undefined | null): string {
  return !h || h === 'local' ? LOCAL : h
}

export async function callerOf(sid: string | undefined): Promise<Caller> {
  const { resolveCaller } = await import('../sessions/session-send-core.js')
  const c = await resolveCaller(sid)
  if (c.kind !== 'session' || !c.record.taskId) {
    throw new HostExecError('host_exec runs for a task\'s session; a person runs commands in their own terminal', 403, 'session_only')
  }
  const { getTask } = await import('../task-manager.js')
  const task = await getTask(c.record.taskId).catch(() => undefined)
  return { sid: c.record.claudeSessionId, taskId: c.record.taskId, taskTitle: task?.title ?? c.record.taskId, host: normHost(c.record.host) }
}

export async function targetHost(raw: string, caller: Caller, sameHostHint = 'run the command with your own Bash tool'): Promise<string> {
  const { parseHostSelector, pickHost, HostSelectorError } = await import('./host-select.js')
  let host: string
  try {
    const tags = parseHostSelector(raw)
    host = normHost(tags ? (await pickHost(tags)).host : raw.trim())
  } catch (err) {
    if (err instanceof HostSelectorError) throw new HostExecError(err.message, err.code === 'bad_selector' ? 400 : 409, err.code)
    throw err
  }
  if (host === caller.host) {
    throw new HostExecError(`This session already runs on ${host === LOCAL ? 'this Mac' : host}: ${sameHostHint}`, 400, 'same_host')
  }
  if (host !== LOCAL) {
    const { getConfig } = await import('../config-manager.js')
    const hosts = (await getConfig()).hosts ?? {}
    if (!Object.hasOwn(hosts, host)) throw new HostExecError(`Unknown host: ${host} (host_list names them)`, 404, 'unknown_host')
  }
  return host
}

export async function hostName(host: string): Promise<string> {
  if (host === LOCAL) return 'the Mac'
  const { hostDisplayNameFor } = await import('./host-display-name.js')
  return hostDisplayNameFor(host)
}

/** One ask at a time per task and host, so two first calls at once send one letter. */
const asking = new Map<string, Promise<unknown>>()

/** The grant for this task on this host, or the refusal that asks the user (once) for one. */
export async function grantFor(caller: Caller, host: string, preview: string | null): Promise<string> {
  const key = `${caller.taskId}\u0000${host}`
  const before = asking.get(key) ?? Promise.resolve()
  const mine = before.catch(() => {}).then(() => grantOrAsk(caller, host, preview))
  const settled = mine.catch(() => {})
  asking.set(key, settled)
  void settled.then(() => { if (asking.get(key) === settled) asking.delete(key) })
  return mine
}

/**
 * A host the user registered: this Mac, or a host in Settings > Remote Hosts (the
 * cloud companion is one). A task there uses the user's other hosts without a letter.
 */
export async function isOwnHost(host: string): Promise<boolean> {
  if (host === LOCAL) return true
  const { getConfig } = await import('../config-manager.js')
  return Object.hasOwn((await getConfig()).hosts ?? {}, host)
}

async function grantOrAsk(caller: Caller, host: string, preview: string | null): Promise<string> {
  const grants = await import('./exec-grants.js')
  const name = await hostName(host)
  // The user's hard stop for this host: nothing new starts there, whatever the grant.
  if (preview !== null && grants.isHostClosed(host)) {
    throw new HostExecError(`The user closed ${name} to tasks on other hosts (Settings › Remote Hosts). Do the step another way.`, 403, 'exec_host_closed')
  }
  const g = grants.findGrant(caller.taskId, host)
  if (g) return g.id
  // Reading or stopping a job needs the grant the run had; it never asks for one.
  if (preview === null) throw new HostExecError(`This task has no grant to use ${name} (it was revoked).`, 403, 'exec_grant_required')
  let ask = grants.findAsk(caller.taskId, host)
  // A task on one of the user's own hosts asks no one; a grant he revoked, or his Deny, still stands.
  if (ask?.state !== 'denied' && !grants.wasRevoked(caller.taskId, host) && await isOwnHost(caller.host)) {
    if (ask?.state === 'pending') {
      // Its letter is settled for the user, unless the user already answered it: then that answer stands.
      await grants.settleOwnHostAsks(isOwnHost, { taskId: caller.taskId, host, fromHost: caller.host })
      ask = grants.findAsk(caller.taskId, host)
    }
    if (ask?.state !== 'denied') {
      const own = grants.findGrant(caller.taskId, host) ?? await grants.grant(caller.taskId, host, 'own-host')
      log.session.info('host exec: a task on an own host uses another, no letter', { taskId: caller.taskId, fromHost: caller.host, host, grantId: own.id })
      return own.id
    }
  }
  if (ask?.state === 'pending') {
    const now = await grants.refreshAsk(ask)
    if (now === 'granted') {
      const g2 = grants.findGrant(caller.taskId, host)
      if (g2) return g2.id
    }
    ask = now === 'dropped' ? undefined : grants.findAsk(caller.taskId, host)
  }
  if (ask?.state === 'denied') {
    throw new HostExecError(`The user declined to let this task use ${name} (commands, MCP servers, web services). Do the step another way, or ask the user in your reply.`, 403, 'exec_grant_denied')
  }
  if (ask?.state === 'pending') {
    throw new HostExecError(`Waiting for the user to allow this task to use ${name} (letter ${ask.letterId}). You will get a notice when they allow it; do other work meanwhile.`, 403, 'exec_grant_required', { letterId: ask.letterId })
  }
  const from = caller.host === LOCAL ? null : await hostName(caller.host)
  const { HOST_EXEC_ASK } = await import('../human-inbox/walnut-letters/host-exec-ask.js')
  const { walnutLetterLanguage } = await import('../human-inbox/walnut-letters/languages.js')
  const { letterOpKey } = await import('../human-inbox/walnut-letters/kind.js')
  const rendered = HOST_EXEC_ASK.render(await walnutLetterLanguage(), { title: caller.taskTitle, from, target: host === LOCAL ? null : name, preview })
  const { sendLetter } = await import('../human-inbox/store.js')
  const letter = await sendLetter({
    subject: rendered.subject,
    type: HOST_EXEC_ASK.type,
    markdown: rendered.markdown,
    actions: rendered.actions,
    taskRefs: [caller.taskId],
    sender: { sessionId: 'external', host: 'local' },
  // The mark names the task and the host, so the sweep (walnut-letters/sweep.ts) knows them without the ask record.
  }, { opKey: letterOpKey(HOST_EXEC_ASK.id, host, caller.taskId, Date.now().toString(36)) })
  await grants.recordAsk({ taskId: caller.taskId, host, letterId: letter.id, askedAt: Date.now(), sid: caller.sid, fromHost: caller.host, state: 'pending' })
  log.session.info('host exec: asked the user for a grant', { taskId: caller.taskId, host, letterId: letter.id })
  throw new HostExecError(`This task may not use ${name} yet: a letter asks the user (${letter.id}). You will get a notice when they allow it; do other work meanwhile.`, 403, 'exec_grant_required', { letterId: letter.id })
}

/** The link to `host`, by `within` ms, with the daemon capability the call needs. */
export async function dial(host: string, within = DIAL_MS, capability = 'host-exec-v1', what = 'run commands') {
  const { link } = await import('./link.js')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const conn = await Promise.race([
      link(host),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('dial timeout')), Math.max(1, Math.min(within, DIAL_MS))) }),
    ])
    if (!conn.hasCapability(capability)) {
      throw new HostExecError(`The Walnut daemon on ${await hostName(host)} needs an update before it can ${what} for other hosts (it updates on its next connect).`, 409, 'daemon_upgrade')
    }
    return conn
  } catch (err) {
    if (err instanceof HostExecError) throw err
    throw new HostExecError(`Walnut cannot reach ${await hostName(host)} right now (${err instanceof Error ? err.message : String(err)}).`, 503, 'host_offline')
  } finally {
    clearTimeout(timer)
  }
}

const REDACT_BLOCK_LINES = 200
const FINDINGS_CAP = 20 // findSecretsInText stops at this many
const PEM_BEGIN_RE = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/
const PEM_END_RE = /-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/

/**
 * Lines that look like a credential leave as a note; the count says how many. The
 * scanner stops at 20 findings, so the text is scanned in blocks of lines and a block
 * that hits the cap again one line at a time; a private key hides every line from its
 * BEGIN to its END (its body is plain base64 the scanner would not flag), and a window
 * that starts inside one hides up to its END. Known limit: a token split across two
 * windows inside one very long line with no newline passes as two halves; this stops
 * an accident, not a reader.
 */
export async function redact(text: string): Promise<{ text: string; redacted: number }> {
  if (!text) return { text, redacted: 0 }
  const { findSecretsInText } = await import('../../integrations/git-sync-secrets.js')
  const lines = text.split('\n')
  const hit = new Map<number, string>() // 0-based line -> kind
  for (let from = 0; from < lines.length; from += REDACT_BLOCK_LINES) {
    const block = lines.slice(from, from + REDACT_BLOCK_LINES)
    let found = findSecretsInText(block.join('\n'))
    if (found.length >= FINDINGS_CAP) {
      found = block.flatMap((l, i) => findSecretsInText(l).map((f) => ({ ...f, line: i + 1 })))
    }
    for (const f of found) if (!hit.has(from + f.line - 1)) hit.set(from + f.line - 1, f.kind)
    if (from + REDACT_BLOCK_LINES < lines.length) await new Promise<void>((r) => setImmediate(r))
  }
  for (const [i, kind] of [...hit]) {
    if (kind !== 'private-key' || PEM_END_RE.test(lines[i])) continue
    // To its END line, or (a key cut off) to the end of the output.
    for (let j = i + 1; j < lines.length && !(j === lines.length - 1 && lines[j] === ''); j++) {
      if (!hit.has(j)) hit.set(j, 'private-key')
      if (PEM_END_RE.test(lines[j])) break
    }
  }
  // A window that starts inside a key (a tail, or the next page) has its END and no BEGIN:
  // everything up to that END is the key's body.
  const firstEnd = lines.findIndex((l) => PEM_END_RE.test(l))
  if (firstEnd !== -1 && !lines.slice(0, firstEnd).some((l) => PEM_BEGIN_RE.test(l))) {
    for (let j = 0; j <= firstEnd; j++) hit.set(j, 'private-key')
  }
  if (!hit.size) return { text, redacted: 0 }
  for (const [i, kind] of hit) if (i < lines.length) lines[i] = `[Walnut hid this line: it looks like a credential (${kind})]`
  return { text: lines.join('\n'), redacted: hit.size }
}

function daemonError(reply: Record<string, unknown>, fallback: string): HostExecError {
  const code = typeof reply.code === 'string' ? reply.code : 'host_failed'
  const msg = typeof reply.error === 'string' ? reply.error.replace(/^exec\.\w+ failed: /, '') : fallback
  return new HostExecError(msg, code === 'cwd_missing' || code === 'bad_request' ? 400 : code === 'unknown_job' ? 404 : 502, code)
}

/** A failed or timed-out send to the host: the host is away, never a server error. */
async function ask(conn: Awaited<ReturnType<typeof dial>>, host: string, cmd: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  try {
    return await conn.send(cmd, params, timeoutMs) as Record<string, unknown>
  } catch (err) {
    throw new HostExecError(`Walnut lost ${await hostName(host)} while it answered (${err instanceof Error ? err.message : String(err)}).`, 503, 'host_offline')
  }
}

/** How long one call may hold its answer: a session on another host reaches us through its gateway, which gives up at 20 s. */
function holdBudget(caller: Caller, wanted: number, since: number): number {
  return Math.max(0, Math.min(wanted, budgetLeft(caller, since)))
}

/** What is left of a call's answer time: unbounded for a caller on the Mac. */
export function budgetLeft(caller: Caller, since: number): number {
  return caller.host === LOCAL ? Number.POSITIVE_INFINITY : RELAYED_HOLD_MS - (Date.now() - since)
}

/** Below this much time left, a relayed call starts nothing: its answer could not get back. */
const START_MIN_LEFT_MS = 4_000

const HOST_WAIT_MAX_MS = 60_000 // the host holds one read at most this long

/** At a cap, ask the hosts which of our jobs still run: a background job nobody read again may have ended. */
async function refreshRunning(pred: (r: { taskId: string; host: string }) => boolean, within: number): Promise<void> {
  if (within < 2_000) return
  const hosts = new Set([...running.values()].filter(pred).map((r) => r.host))
  const asked = Date.now()
  await Promise.all([...hosts].map(async (h) => {
    try {
      const conn = await dial(h, within / 2)
      const reply = await conn.send('exec.list', {}, Math.max(1, Math.min(LIST_MS, within - (Date.now() - asked)))) as { ok?: boolean; jobs?: Array<{ jobId: string; running: boolean }> }
      if (!reply.ok || !Array.isArray(reply.jobs)) return
      const live = new Set(reply.jobs.filter((j) => j.running).map((j) => j.jobId))
      for (const [id, r] of running) if (r.host === h && !live.has(id) && r.at < asked - REFRESH_GRACE_MS) running.delete(id)
    } catch { /* the host away: its count stands until the jobs' own deadlines */ }
  }))
}

async function checkCaps(caller: Caller, host: string, since: number): Promise<void> {
  const mine = (r: { taskId: string }) => r.taskId === caller.taskId
  const theirs = (r: { host: string }) => r.host === host
  // A refresh may use at most half of what is left, so the run itself still fits.
  const share = () => Math.min(DIAL_MS + LIST_MS, (budgetLeft(caller, since) - START_MIN_LEFT_MS) / 2)
  if (countRunning(mine) >= MAX_RUNNING_PER_TASK) await refreshRunning(mine, share())
  if (countRunning(mine) >= MAX_RUNNING_PER_TASK) {
    throw new HostExecError(`This task already runs ${MAX_RUNNING_PER_TASK} commands on other hosts; wait for one (host_exec_read) or stop one (host_exec_stop).`, 429, 'busy')
  }
  if (countRunning(theirs) >= MAX_RUNNING_PER_HOST) await refreshRunning(theirs, share())
  if (countRunning(theirs) >= MAX_RUNNING_PER_HOST) {
    throw new HostExecError(`${await hostName(host)} already runs ${MAX_RUNNING_PER_HOST} commands for other hosts; try again in a moment.`, 429, 'busy')
  }
}

/** The answer an agent reads: the run's state and its output, credential-looking lines hidden. */
async function jobAnswer(host: string, jobId: string, reply: Record<string, unknown>): Promise<Record<string, unknown> & { redactedLines?: number }> {
  if (reply.running !== true) running.delete(jobId)
  const { text, redacted } = await redact(typeof reply.output === 'string' ? reply.output : '')
  return {
    host, jobId, running: reply.running === true, exitCode: reply.exitCode ?? null, signal: reply.signal ?? null,
    timedOut: reply.timedOut === true, ms: reply.ms, cwd: reply.cwd, output: text,
    truncated: typeof reply.offset === 'number' ? reply.offset > 0 : reply.truncated === true,
    offset: reply.offset, nextOffset: reply.nextOffset,
    outputBytes: reply.outputBytes, logFile: reply.logFile, ...(redacted ? { redactedLines: redacted } : {}),
  }
}

/**
 * Run one command on another host for the caller's task. The host always runs it as a
 * job; a foreground call then waits for it to end, at most until its deadline, or 15 s
 * for a session on another host (its gateway gives up at 20 s, and a retry after that
 * would run the command twice). A run still going comes back `running` with its jobId.
 */
export async function execOnHost(params: ExecParams, callerSid: string | undefined): Promise<Record<string, unknown>> {
  const t0 = Date.now()
  const hasCommand = typeof params.command === 'string' && params.command.trim() !== ''
  const hasArgv = Array.isArray(params.argv) && params.argv.length > 0
  if (hasCommand === hasArgv) throw new HostExecError('Give exactly one of command (a shell line) or argv (a program and its arguments)', 400, 'bad_request')
  const caller = await callerOf(callerSid)
  const host = await targetHost(String(params.host ?? ''), caller)
  const preview = hasCommand ? params.command! : params.argv!.join(' ')
  const grantId = await grantFor(caller, host, preview)
  await checkCaps(caller, host, t0)

  const background = params.background === true
  const cap = background ? BACKGROUND_MAX_MS : FOREGROUND_MAX_MS
  const timeoutMs = Math.min(typeof params.timeout_ms === 'number' && params.timeout_ms > 0 ? params.timeout_ms : (background ? cap : 2 * 60_000), cap)
  const conn = await dial(host, budgetLeft(caller, t0) - START_MIN_LEFT_MS)
  if (budgetLeft(caller, t0) < START_MIN_LEFT_MS) {
    throw new HostExecError(`${await hostName(host)} answered too slowly to start the command in time; nothing ran. Try again.`, 503, 'host_offline')
  }
  const jobId = `hx-${randomUUID()}`
  running.set(jobId, { taskId: caller.taskId, host, until: Date.now() + timeoutMs + REPLY_MARGIN_MS, at: Date.now() })
  let reply: Record<string, unknown>
  try {
    reply = await ask(conn, host, 'exec.run', {
      jobId, taskId: caller.taskId,
      ...(hasCommand ? { command: params.command } : { argv: params.argv }),
      ...(params.cwd ? { cwd: params.cwd } : {}),
      // A foreground run keeps its own deadline on the host; only our wait for it is bounded.
      timeoutMs, background: true, caller: { task: caller.taskId, host: caller.host },
    }, Math.min(REPLY_MARGIN_MS, budgetLeft(caller, t0)))
  } catch (err) {
    // The host may have started it: the job keeps its slot until its deadline, and the
    // answer names it, so the session reads it instead of running the command again.
    if (err instanceof HostExecError) {
      err.message += ` It may have started there as job ${jobId}: read it with host_exec_read before running it again.`
      err.data = { ...err.data, jobId, mayHaveStarted: true }
    }
    throw err
  }
  if (!reply.ok) {
    running.delete(jobId)
    throw daemonError(reply, 'the host refused the command')
  }
  // The host has it now: a refresh may judge it by the host's list from here on.
  const entry = running.get(jobId)
  if (entry) entry.at = 0
  void import('./exec-grants.js').then((g) => g.noteRun(grantId, preview))
  let last = reply
  if (!background) {
    const until = Date.now() + holdBudget(caller, timeoutMs + KILL_GRACE_MS + 2_000, t0)
    while (last.running === true && Date.now() < until) {
      const wait = Math.min(until - Date.now(), HOST_WAIT_MAX_MS)
      // A read that fails leaves the run as it was: running, with its jobId to read later.
      const read = await ask(conn, host, 'exec.read', { jobId, taskId: caller.taskId, wait }, wait + Math.min(REPLY_MARGIN_MS, Math.max(1_000, budgetLeft(caller, t0) - wait)))
        .catch(() => null)
      if (!read?.ok) break
      last = { ...read, cwd: reply.cwd }
    }
  }
  const out = await jobAnswer(host, jobId, last)
  log.session.info('host exec', {
    taskId: caller.taskId, fromHost: caller.host, host, jobId, cwd: reply.cwd, background, running: out.running,
    exitCode: out.exitCode, timedOut: out.timedOut, ms: Date.now() - t0, bytes: out.outputBytes, redacted: out.redactedLines ?? 0,
    command: preview.slice(0, 200),
  })
  return out
}

/** Read a job's output (from `offset`, or its tail), waiting up to `wait_ms` for it to end. */
export async function readHostJob(params: { host: string; job_id: string; offset?: number; wait_ms?: number }, callerSid: string | undefined): Promise<Record<string, unknown>> {
  const t0 = Date.now()
  const caller = await callerOf(callerSid)
  const host = await targetHost(String(params.host ?? ''), caller)
  await grantFor(caller, host, null)
  const conn = await dial(host, budgetLeft(caller, t0) - 2_000)
  // The host's answer needs a moment to get back: the wait leaves it 2 s.
  const wait = typeof params.wait_ms === 'number' && params.wait_ms > 0 ? Math.max(0, Math.min(params.wait_ms, HOST_WAIT_MAX_MS, budgetLeft(caller, t0) - 2_000)) : 0
  const reply = await ask(conn, host, 'exec.read', {
    jobId: params.job_id, taskId: caller.taskId, ...(typeof params.offset === 'number' ? { offset: params.offset } : {}), ...(wait ? { wait } : {}),
  }, wait + Math.min(REPLY_MARGIN_MS, Math.max(2_000, budgetLeft(caller, t0) - wait)))
  if (!reply.ok) throw daemonError(reply, 'the host could not read the job')
  return jobAnswer(host, params.job_id, reply)
}

/** Stop a running job (its whole process group). */
export async function stopHostJob(params: { host: string; job_id: string }, callerSid: string | undefined): Promise<Record<string, unknown>> {
  const t0 = Date.now()
  const caller = await callerOf(callerSid)
  const host = await targetHost(String(params.host ?? ''), caller)
  await grantFor(caller, host, null)
  const conn = await dial(host, budgetLeft(caller, t0) - 2_000)
  const reply = await ask(conn, host, 'exec.kill', { jobId: params.job_id, taskId: caller.taskId }, Math.min(REPLY_MARGIN_MS, Math.max(2_000, budgetLeft(caller, t0))))
  if (!reply.ok) throw daemonError(reply, 'the host could not stop the job')
  return { host, jobId: params.job_id, running: reply.running === true, stopping: reply.running === true }
}

/** Tests: forget the in-flight runs. */
export function resetHostExecForTest(): void {
  running.clear()
}
