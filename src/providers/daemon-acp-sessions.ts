/**
 * The session commands of the ACP engines (Codex, OpenCode and the rest; acp-daemon.ts runs their
 * workers): start, a prompt or another op, stop, subscribe, and the cancel of a start still
 * waiting (for a Claude session too: cancelPendingStart).
 * sid here is the Walnut runtimeId; journal = STREAMS_DIR/<sid>.acp.jsonl.
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts), at the place this code
 * had in its body; its dispatcher answers acpStart / acp ops / acpStop / acpSubscribe /
 * cancelPendingStart through what it returns, and the Claude start checks cancelledStartPath.
 * The code is the runtime's as it was; deps carry the runtime's own names.
 */
import fs from 'node:fs'
import path from 'node:path'
import { BUDGET_CHECKING_TEXT, type BudgetGate } from './daemon-core.js'
import type { AcpStartParams, createAcpDaemon } from './acp-daemon.js'
import { ensureTaskDir } from './task-dir-core.js'
import type { createUsageBudgetRuntime, BudgetVerdict } from './usage-budget-runtime.js'
import type { createHostCallTokens } from './host-call-token-core.js'
import type { SessionData, SessionGate } from './daemon-session-types.js'
import type { DaemonEnv, DaemonLog, DaemonReplies } from './daemon-module-deps.js'

export interface DaemonAcpSessionsDeps<W extends object> extends DaemonReplies<W> {
  daemonEnv: DaemonEnv
  DAEMON_DIR: string
  /** Where the task directories are (task-dir-core.ts). */
  TASK_DIR_ROOT: string
  /** The agent gateway's socket (a worker's `walnut` reaches its Walnut through it). */
  GATEWAY_SOCK_PATH: string
  /** The secrets the user shared (daemon-host-services.ts, made further down, so asked on use). */
  SECRETS_ROOT: () => string
  secretsSessionEnv: () => Record<string, string>
  sessions: Map<string, SessionData<W>>
  acp: ReturnType<typeof createAcpDaemon<W>>
  usageBudget: ReturnType<typeof createUsageBudgetRuntime>
  budgetGate: (verdict: BudgetVerdict) => BudgetGate
  sessionStartGate: SessionGate
  /** Demo's stop fence: no new worker while it holds. */
  demoQuiesce: { readonly fenced: boolean }
  hostCallTokens: ReturnType<typeof createHostCallTokens>
  /** Record whose worker this is (daemon-spawn-journal.ts): its journal stays that Walnut's to read. */
  recordAcpRuntime: (runtimeId: unknown, home: unknown) => Promise<void>
  isJournalSid: (sid: unknown) => sid is string
  walnutThroughGateway: (env: Record<string, unknown> | undefined, home: unknown) => boolean
  sessionPathWithShim: (base: string, throughGateway: boolean) => string
  sessionWalnutApiUrl: (env: Record<string, unknown> | undefined) => string | undefined
  /** The page silencer (pw-silence-core.ts). */
  pwSilenceFile: () => Promise<string | null>
  pwSilenceAcpOptions: (env: Record<string, string | null | undefined> | undefined, file: string | null) => Record<string, string>
  sendFrame: (ws: W, frame: Record<string, unknown>) => void
  logMsg: DaemonLog
}

export function createDaemonAcpSessions<W extends object>(deps: DaemonAcpSessionsDeps<W>) {
  const { daemonEnv, DAEMON_DIR, TASK_DIR_ROOT, GATEWAY_SOCK_PATH, SECRETS_ROOT, sessions, acp, usageBudget, budgetGate, sessionStartGate, demoQuiesce, hostCallTokens, recordAcpRuntime, isJournalSid, walnutThroughGateway, sessionPathWithShim, sessionWalnutApiUrl, secretsSessionEnv, pwSilenceFile, pwSilenceAcpOptions, logMsg, sendOk, sendError, sendFrame } = deps

  async function cmdAcpStart(ws: W, id: number, cmd: Record<string, unknown>) {
    const params = cmd as unknown as AcpStartParams
    if (!params.sid || !params.cwd) return sendError(ws, id, 'acpStart: missing sid/cwd')
    // A resumed session's budget learns its new worker before the worker can take a turn.
    if (isJournalSid(params.providerSessionId)) {
      try { await usageBudget.bindRuntime(params.providerSessionId, params.sid) }
      catch (error) { return sendFrame(ws, { id, ok: false, error: 'acpStart: the session budget could not record this worker; not started yet', errorKind: 'budget_checking', code: 'BUDGET_CHECKING' }) }
    }
    // Agent gateway for ACP sessions: same wiring the native `claude` spawn gets.
    // WALNUT_SESSION_ID arrives hub-side (the runtimeId; acp.hasWorker() vouches
    // for it in handleGatewayLine); the daemon owns the socket path and the `walnut`
    // shim dir, so those are injected here, not hub-side. PATH is overridden (not
    // appended in-shell like the native spawn) because ACP workers don't run
    // through the RC-sourcing shell wrapper.
    const taskDir = ensureTaskDir(TASK_DIR_ROOT, (cmd as { taskId?: unknown }).taskId, (cmd as { home?: unknown }).home)
    // The home this start is for, as it names it (the rule and the call entry each find its Walnut from it).
    const startHome = (cmd as { home?: unknown }).home
    const throughGateway = walnutThroughGateway(params.env, startHome)
    params.env = {
      ...secretsSessionEnv(),
      ...params.env,
      WALNUT_AGENT_SOCKET: GATEWAY_SOCK_PATH,
      PATH: sessionPathWithShim(daemonEnv.PATH || '', throughGateway),
      // The task's durable working directory, as for the native spawn (task-dir-core.ts);
      // '' unsets one this daemon inherited (mergeAcpSpawnEnv drops empty values).
      WALNUT_TASK_DIR: taskDir ?? '',
      WALNUT_SECRETS_DIR: SECRETS_ROOT(),
      // The page silencer, as for the native spawn (pw-silence-core.ts).
      // An engine's env that names NODE_OPTIONS or BUN_OPTIONS (null or '' = cleared) wins over the daemon's own.
      ...pwSilenceAcpOptions(params.env, await pwSilenceFile()),
      // The address its Walnut named, or none ('' unsets this daemon's own): sessionWalnutApiUrl.
      OPEN_WALNUT_API_URL: sessionWalnutApiUrl(params.env) ?? '',
      // host-call-entry-v1, as for the native spawn ('' unsets): the worker's own WALNUT_SESSION_ID is the caller.
      WALNUT_CALL_SOCKET: '',
      WALNUT_CALL_TOKEN: '',
      ...hostCallTokens.envFor(startHome, typeof params.env?.WALNUT_SESSION_ID === 'string' && params.env.WALNUT_SESSION_ID ? params.env.WALNUT_SESSION_ID : params.sid),
    }
    return sessionStartGate.run(params.sid, async () => {
      if (!params.providerSessionId && fs.existsSync(cancelledStartPath(params.sid))) throw new Error('Initial start was cancelled; retry task_start on the same task')
      if (demoQuiesce.fenced) throw new Error('acpStart: Demo is stopping; no new worker starts')
      const resp = await acp.acpStart(ws, params)
      if (resp.ok) {
        // Whose worker this is, kept on disk: its journal stays that Walnut's to read here.
        // `ownerHome` names it for every start; a server older than that names `home`, with a task only.
        const o = cmd as { ownerHome?: unknown; home?: unknown }
        void recordAcpRuntime(params.sid, o.ownerHome ?? o.home)
        sendOk(ws, id, resp.result ?? {})
      } else sendFrame(ws, { ...resp.refusal, id, ok: false, error: resp.error, errorKind: resp.errorKind })
    })
  }

  async function cmdAcpOp(ws: W, id: number, cmd: Record<string, unknown>, op: string) {
    const { sid, ...params } = cmd as { sid?: string; cmd?: string; budgetSid?: string }
    if (!sid) return sendError(ws, id, op + ': missing sid')
    const budgetSid = (params as { budgetSid?: unknown }).budgetSid
    delete (params as Record<string, unknown>).budgetSid
    // A session over its budget takes no new turn (mirrors the Claude FIFO gate). The server
    // names the session a turn belongs to, so a worker started again is gated from its first turn.
    if (op === 'prompt' || op === 'steer') {
      let verdict: BudgetGate = 'budget_checking'
      try {
        if (isJournalSid(budgetSid)) await usageBudget.bindRuntime(budgetSid, sid)
        verdict = budgetGate(await usageBudget.allowRuntime(sid))
      } catch (error) { logMsg('warn', 'budget gate failed; turn held', { sid, error: String(error) }) }
      if (verdict === 'budget_paused') {
        return sendFrame(ws, { id, ok: false, error: 'Not sent: the session budget is paused. Raise or remove the limit to continue.', errorKind: 'budget_paused', code: 'BUDGET_PAUSED' })
      }
      if (verdict === 'budget_checking') {
        return sendFrame(ws, { id, ok: false, error: BUDGET_CHECKING_TEXT, errorKind: 'budget_checking', code: 'BUDGET_CHECKING' })
      }
    }
    delete (params as Record<string, unknown>).cmd
    delete (params as Record<string, unknown>).id
    delete (params as Record<string, unknown>).traceId
    return acp.acpOp(sid, op, params as Record<string, unknown>).then((resp) => {
      if (resp.ok) sendOk(ws, id, { result: resp.result })
      else sendFrame(ws, { id, ok: false, error: resp.error?.message ?? 'acp op failed', errorKind: resp.error?.kind })
    })
  }

  function cmdAcpStop(ws: W, id: number, cmd: Record<string, unknown>) {
    const { sid } = cmd as { sid?: string }
    if (!sid) return sendError(ws, id, 'acpStop: missing sid')
    return acp.acpStop(sid).then(() => sendOk(ws, id, { stopped: true }))
  }

  function cmdAcpSubscribe(ws: W, id: number, cmd: Record<string, unknown>) {
    const { sid, fromOffset } = cmd as { sid?: string; fromOffset?: number }
    if (!sid) return sendError(ws, id, 'acpSubscribe: missing sid')
    const ok = acp.subscribe(ws, sid, typeof fromOffset === 'number' ? fromOffset : 0)
    if (ok) sendOk(ws, id, { subscribed: true })
    else sendFrame(ws, { id, ok: false, error: 'no live ACP worker for ' + sid, errorKind: 'no_worker' })
  }

  function cancelledStartPath(sid: string): string {
    return path.join(DAEMON_DIR, 'cancelled-starts', Buffer.from(sid).toString('hex'))
  }

  async function cmdCancelPendingStart(ws: W, id: number, cmd: Record<string, unknown>) {
    const sid = cmd.sid
    if (typeof sid !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(sid)) return sendError(ws, id, 'cancelPendingStart: invalid sid')
    return sessionStartGate.run(sid, async () => {
      if (acp.hasWorker(sid)) return sendOk(ws, id, { cancelled: false, alive: true })
      const session = sessions.get(sid)
      if (session?.state === 'running' && session.pid) {
        try {
          process.kill(session.pid, 0)
          return sendOk(ws, id, { cancelled: false, alive: true, pid: session.pid })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
      const file = cancelledStartPath(sid)
      await fs.promises.mkdir(path.dirname(file), { recursive: true })
      await fs.promises.writeFile(file, '', { flag: 'a', mode: 0o600 })
      return sendOk(ws, id, { cancelled: true, alive: false })
    })
  }

  return { cmdAcpStart, cmdAcpOp, cmdAcpStop, cmdAcpSubscribe, cancelledStartPath, cmdCancelPendingStart }
}
