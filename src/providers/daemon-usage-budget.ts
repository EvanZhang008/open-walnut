/**
 * The usage budget of the sessions on this host (usage-budget-runtime.ts): a session over its
 * budget is paused (its CLI stopped, its owned process group proved gone), its sends refused, and
 * the proofs of a pause kept on disk so a restarted daemon finishes it.
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts), right after the session
 * owners (daemon-session-owner.ts), at the place this code had in its body; the dispatcher answers
 * usage.budget* through cmdUsageBudget / cmdUsageBudgetList, and the session code asks
 * budgetAllowance / requireBudgetAllowance before a start or a send. The code is the runtime's as
 * it was; deps carry the runtime's own names.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { BudgetGate, DaemonCore } from './daemon-core.js'
import { createUsageBudgetRuntime, type BudgetPrices, type BudgetVerdict } from './usage-budget-runtime.js'
import { createBudgetControl } from './usage-budget-control.js'
import { readCronBootId } from './daemon-cron-host.js'
import type { ChildProcessFns, ChildProcessUse } from './daemon-child-spawn.js'
import type { SessionData, DaemonCronRuntime } from './daemon-session-types.js'
import type { DaemonEnv, DaemonLog, DaemonReplies } from './daemon-module-deps.js'

export interface DaemonUsageBudgetDeps<W extends object> extends DaemonReplies<W> {
  daemonEnv: DaemonEnv
  HOME_DIR: string
  SERVICE_MODE: boolean
  /** The budgets live beside the resume records (daemon-session-owner.ts). */
  RESUME_RECORD_DIR: string
  execFile: ChildProcessFns['execFile']
  childUse: ChildProcessUse
  /** Make the budget dir (usage-budget-persistence.ts). */
  ensureUsageBudgetDirectory: (dir: string) => Promise<void>
  sessions: Map<string, SessionData<W>>
  /** The ACP workers (Codex, OpenCode): a paused one is stopped. */
  acp: { hasWorker: (runtimeId: string) => boolean; acpStop: (runtimeId: string) => Promise<unknown> }
  core: DaemonCore<SessionData<W>>
  /** The runtime's cron runtime, once Main made it. */
  cronRuntime: () => DaemonCronRuntime | null
  /** This boot's id, once known. */
  daemonBootId: () => string | undefined
  sessionStopVersions: Map<string, number>
  BG_TERMINAL_STATUSES: ReadonlySet<string>
  isJournalSid: (sid: unknown) => sid is string
  journaledIds: () => Set<string>
  journaledHome: (sid: string) => string | undefined
  isProcessGroupAlive: (pgid: number) => boolean
  killProcessGroup: (pid: number, signal: NodeJS.Signals) => unknown
  readStartTimeAsync: (pid: number) => Promise<string | null>
  persistRegistry: () => void
  reapSession: (sid: string, code: number, reason: string, groupExited?: boolean) => void
  cancelTurnRetry: (sid: string, reason: string) => void
  stopOwnerRefusal: (sid: string, cmd: Record<string, unknown>) => { reason: string; detail?: string } | null
  stopSessionProcess: (ws: W, id: number, sid: string) => unknown
  refuseForeignHome: (ws: W, id: number, cmd: Record<string, unknown>, what: string) => boolean
  isServerClient: (ws: W) => boolean
  setTimeout: typeof globalThis.setTimeout
  logMsg: DaemonLog
}

export function createDaemonUsageBudget<W extends object>(deps: DaemonUsageBudgetDeps<W>) {
  const { daemonEnv, HOME_DIR, SERVICE_MODE, RESUME_RECORD_DIR, execFile, childUse, ensureUsageBudgetDirectory, sessions, acp, core, cronRuntime, daemonBootId, sessionStopVersions, BG_TERMINAL_STATUSES, isJournalSid, journaledIds, journaledHome, isProcessGroupAlive, killProcessGroup, readStartTimeAsync, persistRegistry, reapSession, cancelTurnRetry, stopOwnerRefusal, stopSessionProcess, refuseForeignHome, isServerClient, setTimeout, logMsg, sendOk, sendError } = deps

  const BUDGET_DIR = path.join(path.dirname(RESUME_RECORD_DIR), 'usage-budgets')
  type BudgetStopProof = { pid: number; startTime: string; bootId: string; members?: Array<{ pid: number; startTime: string }> }
  const budgetStopGroups = new Map<string, BudgetStopProof>()
  const budgetStopFile = path.join(BUDGET_DIR, 'stops.map')
  const budgetBoot = readCronBootId(process.platform, AbortSignal.timeout(5000), childUse).catch(() => '')
  const budgetStopsReady = (async () => {
    let text: string
    try { text = await fs.promises.readFile(budgetStopFile, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    for (const [sid, proof] of Object.entries(JSON.parse(text) as Record<string, BudgetStopProof>)) {
      if (!isJournalSid(sid) || !proof || !Number.isSafeInteger(proof.pid) || proof.pid <= 1 || typeof proof.startTime !== 'string' || typeof proof.bootId !== 'string'
        || (proof.members !== undefined && (!Array.isArray(proof.members) || proof.members.some(member => !member || !Number.isSafeInteger(member.pid) || member.pid <= 1 || typeof member.startTime !== 'string')))) throw new Error('budget stop proof is invalid')
      budgetStopGroups.set(sid, proof)
    }
  })()
  void budgetStopsReady.catch(error => logMsg('error', 'budget stop proofs could not be read', { error: String(error) }))
  let budgetStopWrites: Promise<void> = Promise.resolve()
  function persistBudgetStops(): Promise<void> {
    const work = budgetStopWrites.catch(() => {}).then(async () => {
      await ensureUsageBudgetDirectory(BUDGET_DIR)
      const temp = budgetStopFile + '.' + crypto.randomUUID() + '.tmp'
      try {
        const handle = await fs.promises.open(temp, 'wx', 0o600)
        try { await handle.writeFile(JSON.stringify(Object.fromEntries(budgetStopGroups))); await handle.sync() } finally { await handle.close() }
        await fs.promises.rename(temp, budgetStopFile)
        const directory = await fs.promises.open(BUDGET_DIR, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
        try { await directory.sync() } finally { await directory.close() }
      } finally { await fs.promises.unlink(temp).catch(() => {}) }
    })
    budgetStopWrites = work
    return work
  }
  async function budgetGroupMembers(pgid: number): Promise<Array<{ pid: number; startTime: string }>> {
    const text = await new Promise<string>((resolve, reject) => {
      execFile('/bin/ps', ['-axo', 'pid=', '-o', 'pgid=', '-o', 'lstart='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024, env: { ...daemonEnv, LANG: 'C', LC_ALL: 'C' } }, (error, stdout) => error ? reject(error) : resolve(String(stdout)))
    })
    const members: Array<{ pid: number; startTime: string }> = []
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/)
      if (match && Number(match[2]) === pgid && Number(match[1]) > 1) members.push({ pid: Number(match[1]), startTime: match[3] })
    }
    return members
  }
  async function continueBudgetGroupStop(sid: string, proof: BudgetStopProof): Promise<void> {
    if (!isProcessGroupAlive(proof.pid)) return
    const boot = await budgetBoot
    if (!boot || boot !== proof.bootId) throw new Error('budget pause: process group boot identity is unknown')
    const current = await budgetGroupMembers(proof.pid)
    const confirmed = current.some(member => proof.members?.some(old => old.pid === member.pid && old.startTime === member.startTime))
    if (!confirmed) throw new Error('budget pause: no surviving owned process group member is confirmed')
    // The original leader may have exited on interrupt. A same-group birth proof still owns the remaining group.
    killProcessGroup(proof.pid, 'SIGTERM')
    const deadline = Date.now() + 2500
    while (isProcessGroupAlive(proof.pid) && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 200))
    if (isProcessGroupAlive(proof.pid)) throw new Error('budget pause: process group did not exit after SIGTERM')
    logMsg('info', 'budget pause: remaining owned process group stopped', { sid })
  }
  async function budgetStopPending(sid: string): Promise<boolean> {
    await budgetStopsReady
    const proof = budgetStopGroups.get(sid)
    if (!proof) return false
    const boot = await budgetBoot
    if (!(boot && proof.bootId && boot !== proof.bootId) && isProcessGroupAlive(proof.pid)) return true
    budgetStopGroups.delete(sid)
    await persistBudgetStops()
    return false
  }
  const budgetControl = createBudgetControl({
    timeoutMs: 2_000,
    writeRaw: async (sid, raw) => { const result = await core.handleSendRawCommand(sid, raw); return 'ok' in result && result.ok === true },
  })
  const usageBudget = createUsageBudgetRuntime({
    dir: BUDGET_DIR,
    projectsDir: path.join(daemonEnv.CLAUDE_CONFIG_DIR || path.join(HOME_DIR, '.claude'), 'projects'),
    codexHome: daemonEnv.CODEX_HOME || path.join(HOME_DIR, '.codex'),
    pause: (sid, engine, runtimeId) => engine === 'claude' ? pauseBudgetSession(sid) : pauseAcpBudgetSession(runtimeId ?? sid),
    active: (sid, engine, runtimeId) => engine === 'claude' ? sessions.get(sid)?.state === 'running' : acp.hasWorker(runtimeId ?? sid),
    log: (message, fields) => logMsg('warn', message, fields),
    childProcess: childUse,
  })

  /** An ACP worker (Codex, OpenCode) over its budget: stop it; its sends are refused in cmdAcpOp. */
  async function pauseAcpBudgetSession(runtimeId: string): Promise<void> {
    if (acp.hasWorker(runtimeId)) await acp.acpStop(runtimeId)
  }

  /** 'ok', or why a send is refused: 'budget_paused', or 'budget_checking' (not decided yet; the server sends it again). */
  async function budgetAllowance(sid: string): Promise<BudgetGate> {
    if (await budgetStopPending(sid)) return 'budget_paused'
    const verdict = budgetGate(await usageBudget.allow(sid))
    if (verdict !== 'ok') return verdict
    return await budgetStopPending(sid) ? 'budget_paused' : 'ok'
  }
  function budgetGate(verdict: BudgetVerdict): BudgetGate {
    return verdict === 'ok' ? 'ok' : verdict === 'paused' ? 'budget_paused' : 'budget_checking'
  }
  function budgetRefusal(reason: 'budget_paused' | 'budget_checking'): Error & { code: string } {
    return Object.assign(new Error(reason), { code: reason === 'budget_paused' ? 'BUDGET_PAUSED' : 'BUDGET_CHECKING' })
  }
  async function requireBudgetAllowance(sid: string): Promise<void> {
    const verdict = await budgetAllowance(sid)
    if (verdict !== 'ok') throw budgetRefusal(verdict)
  }

  async function pauseBudgetSession(sid: string): Promise<void> {
    cancelTurnRetry(sid, 'budget-paused')
    await budgetStopsReady
    if (cronRuntime()?.get(sid)) await cronRuntime()!.disable(sid)
    const session = sessions.get(sid)
    if (!session || session.state !== 'running' || !session.pid) {
      if (await budgetStopPending(sid)) {
        await continueBudgetGroupStop(sid, budgetStopGroups.get(sid)!)
        budgetStopGroups.delete(sid)
        await persistBudgetStops()
      }
      return
    }
    const pid = session.pid
    sessionStopVersions.set(sid, (sessionStopVersions.get(sid) ?? 0) + 1)
    const owner = journaledHome(sid)
    const refusal = stopOwnerRefusal(sid, { home: owner, strict: true, initiator: 'automatic' })
    if (!owner || refusal) throw new Error('budget pause: session ownership is not confirmed')
    let pgid = NaN
    try { pgid = Number(fs.readFileSync(session.pgidPath, 'utf8').trim()) } catch {}
    if (pgid !== session.pid) throw new Error('budget pause: process group ownership is not confirmed')
    if ((SERVICE_MODE && session.bootId !== daemonBootId()) || !session.startTime || await readStartTimeAsync(session.pid) !== session.startTime) throw new Error('budget pause: process identity is not confirmed')
    const proof = { pid, startTime: session.startTime, bootId: await budgetBoot, members: await budgetGroupMembers(pid) }
    budgetStopGroups.set(sid, proof)
    await persistBudgetStops()
    if (sessions.get(sid) !== session) throw new Error('budget pause: process identity changed')
    session.intentionalStopAt = Date.now()
    session.budgetGracefulStop = true
    persistRegistry()
    const ids = Object.keys(session.taskState.tasks).filter(id => !BG_TERMINAL_STATUSES.has(session.taskState.tasks[id].status))
    const [stoppedTasks, interrupted] = await Promise.all([
      Promise.all(ids.map(task_id => budgetControl.ask(sid, { subtype: 'stop_task', task_id }))),
      budgetControl.ask(sid, { subtype: 'interrupt', cancel_queued: true }),
    ])
    if (stoppedTasks.some(ok => !ok) || !interrupted) logMsg('warn', 'budget pause: control acknowledgement missing; confirming the whole owned process group', { sid })
    if (sessions.get(sid) !== session) throw new Error('budget pause: process identity changed')
    if (!session.pid && isProcessGroupAlive(pid)) await continueBudgetGroupStop(sid, proof)
    let reply: Record<string, unknown> | undefined
    const sink = { data: {}, readyState: 1, send(raw: string) { reply = JSON.parse(raw); return 1 }, close() {} } as unknown as W
    await stopSessionProcess(sink, 0, sid)
    if (isProcessGroupAlive(pid)) await continueBudgetGroupStop(sid, proof)
    if (!reply || (reply.stopped !== true && isProcessGroupAlive(pid))) throw new Error(String(reply?.error || 'budget pause: process stop was not confirmed'))
    if (sessions.get(sid) === session && session.state === 'running') { reapSession(sid, 0, 'budget-stop-confirmed', true); persistRegistry() }
    budgetStopGroups.delete(sid)
    await persistBudgetStops()
  }

  async function cmdUsageBudget(ws: W, id: number, cmd: Record<string, unknown>, configure: boolean) {
    if (refuseForeignHome(ws, id, cmd, configure ? 'usage.budget.configure' : 'usage.budget')) return
    const sid = cmd.sid
    const engine = typeof cmd.engine === 'string' ? cmd.engine : 'claude'
    const known = (s: string) => sessions.has(s) || journaledIds().has(s)
    // An ACP session is keyed by its provider id, which this daemon may not know while it is
    // stopped; the server names its engine.
    if (!isJournalSid(sid) || (!known(sid) && engine === 'claude')) return sendError(ws, id, 'usage.budget: session not found', { code: 'NOT_FOUND' })
    // A Claude Code session here is budgeted (and its owner checked) as one, whatever engine the asker names.
    if (known(sid) && engine !== 'claude') return sendError(ws, id, 'usage.budget: the session runs Claude Code', { code: 'BAD_REQUEST' })
    if (configure) {
      if (!isServerClient(ws)) return sendError(ws, id, 'usage.budget.configure: trusted clients only', { code: 'NOT_OWNED' })
      if (typeof cmd.home !== 'string' || !cmd.home) return sendError(ws, id, 'usage.budget.configure: home must name the asking Walnut', { code: 'BAD_REQUEST' })
      if (engine === 'claude') {
        const refusal = stopOwnerRefusal(sid, { ...cmd, strict: true, initiator: 'automatic' })
        if (refusal) return sendError(ws, id, 'usage.budget.configure: session ownership is not confirmed', { code: 'NOT_OWNED' })
      }
    }
    try {
      const result = configure
        ? await usageBudget.configure(sid, { limitUsd: cmd.limitUsd as number | null, revision: cmd.revision as number, engine, home: cmd.home as string,
          ...(typeof cmd.cwd === 'string' ? { cwd: cmd.cwd } : {}), ...(typeof cmd.runtimeId === 'string' ? { runtimeId: cmd.runtimeId } : {}),
          ...(cmd.prices ? { prices: cmd.prices as BudgetPrices } : {}) })
        : await usageBudget.read(sid)
      return sendOk(ws, id, { result })
    } catch (error) { return sendError(ws, id, String(error instanceof Error ? error.message : error), { code: (error as { code?: string }).code }) }
  }

  /** usage.budget.list: every configured budget here, with the hash of the price list it holds. */
  async function cmdUsageBudgetList(ws: W, id: number, cmd: Record<string, unknown>) {
    if (!isServerClient(ws)) return sendError(ws, id, 'usage.budget.list: trusted clients only', { code: 'NOT_OWNED' })
    try {
      if (cmd.prices) await usageBudget.setPrices(cmd.prices as BudgetPrices)
      const runtimeIds = cmd.runtimeIds && typeof cmd.runtimeIds === 'object' ? cmd.runtimeIds as Record<string, string> : undefined
      const home = typeof cmd.home === 'string' && cmd.home ? cmd.home : undefined
      return sendOk(ws, id, { result: { budgets: await usageBudget.list(runtimeIds, home), pricesHash: usageBudget.pricesHash() } })
    } catch (error) { return sendError(ws, id, String(error instanceof Error ? error.message : error)) }
  }

  return { budgetStopGroups, budgetStopsReady, budgetControl, usageBudget, budgetAllowance, budgetGate, budgetRefusal, requireBudgetAllowance, cmdUsageBudget, cmdUsageBudgetList }
}
