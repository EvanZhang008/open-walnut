/**
 * `walnut approve "<what>" [--timeout 10m] [--detail <file>|-] [--why "<line>"] [--json]
 *   [--single-use] [--request-only | --approval <id>]`, shared by the Mac CLI (commands/approve.ts,
 * ops through executeOp) and the remote host CLI (providers/wn-cli.ts, ops through the daemon's
 * gateway). Imports only node builtins and src/core/approvals: the daemon bundles it.
 *
 * It asks once (approval_request), then waits in short calls (approval_wait, 12 s each, so
 * every relay on the way holds it: the daemon gives the Mac 20 s), until the approval is
 * decided, expired or canceled. A dropped link in between is retried until the deadline.
 *
 * Two ways to use it in a script:
 *  - pause: the script runs `walnut approve …` and blocks until a person answers;
 *  - ask and stop: `--request-only` asks, saves the wait token (cli-token.ts), prints the id and
 *    exits 4, so an agent can tell the person; the same command with `--approval <id>` then waits
 *    for that answer (the what and the detail must be the same bytes) and goes on.
 *
 * Every approval is a person's tap on any device they are signed in on (types.ts). `--single-use`
 * is the strict form: bound to this run's context and spent once, at most 5 minutes. Waiting only
 * reads; before exit 0 this CLI checks the record itself (digest rebuilt from the fields, the
 * server's envelope around this run's detail, the asker, the clock) and then spends it once with
 * approval_consume. A failed check or a lost consume answer is exit 3: ask again. An older
 * script's `--biometric`, `--face-id`, `--touch-id` and `--signing-key <file>` are taken and change
 * nothing: no device key exists any more.
 *
 * Exit codes: 0 approved; 1 denied; 2 not answered in time, or withdrawn; 3 could not ask or could
 * not prove the approval (bad usage, Walnut unreachable, a check failed); 4 asked with
 * --request-only, answer pending. So `walnut approve "…" && deploy` runs only on a yes.
 */
import { definiteRefusal, waitThroughRestart } from '../../lib/wait-through-restart.js'
import { approvalDigest } from './digest.js'
import { isApprovalId, loadToken, removeToken, saveToken, sha256Hex, sweepTokens, tokenDir, type SavedApproval } from './cli-token.js'

export const APPROVE_EXIT = { approved: 0, denied: 1, timeout: 2, error: 3, pending: 4, interrupted: 130 } as const

/** The words a held refusal carries (held-asks.ts HELD_MARK; kept here so the host CLI imports no store). */
export const HELD_MARK = 'Walnut holds this ask'

export interface OpCallResult {
  ok: boolean
  result?: unknown
  message?: string
  /** HTTP status when the server answered with an error; absent for a link failure. */
  status?: number
  code?: string
}

export type OpCall = (name: string, args: Record<string, unknown>) => Promise<OpCallResult>

export interface ApproveArgs {
  what: string
  detail?: string
  timeoutMs: number
  json: boolean
  cwd?: string
  command?: string
  why?: string
  /** Strict: bound to this run's detail, spent once. */
  singleUse?: boolean
  /** Ask, save the token, print the id and exit 4. */
  requestOnly?: boolean
  /** A task terminal's session (WALNUT_TERMINAL_SESSION_ID), when no session runs this command. */
  terminalSession?: string
  /** Resume the saved ask with this id instead of asking. */
  approvalId?: string
}

export interface ApproveIo {
  call: OpCall
  /** Progress for the person running the script: stderr. */
  say: (line: string) => void
  /** The result record with --json: stdout. */
  out: (line: string) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Registers a handler for Ctrl-C / SIGTERM; returns its remover. */
  onInterrupt?: (fn: () => void) => () => void
  /** Where saved asks live (tests); default cli-token.ts tokenDir(). */
  tokenDir?: string
}

export const APPROVE_USAGE = 'usage: walnut approve "<what>" [--timeout 10m] [--detail <file>|-] [--why "<line>"] [--json]\n'
  + '         [--single-use] [--request-only | --approval <id>]'

/** The longest a single-use approval may stay open, and its default. */
export const SINGLE_USE_MAX_MS = 5 * 60_000

/** "90", "90s", "10m", "2h", "1d" -> ms; undefined when it is none of those. */
export function parseApproveDuration(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/i.exec(raw)
  if (!m) return undefined
  const n = Number(m[1])
  const unit = (m[2] ?? 's').toLowerCase()
  const mult = unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
  return Math.round(n * mult)
}

export interface ParsedApprove {
  ok: true
  what: string
  timeoutMs: number
  detailFrom?: string
  json: boolean
  command?: string
  why?: string
  singleUse?: true
  requestOnly?: true
  approvalId?: string
}

/** argv after the word `approve`. */
export function parseApproveArgv(argv: readonly string[]): ParsedApprove | { ok: false; error: string } {
  const words: string[] = []
  let json = false
  let timeoutMs: number | undefined
  let detailFrom: string | undefined
  let command: string | undefined
  let why: string | undefined
  let singleUse = false
  let signingKeys = 0
  let requestOnly = false
  let approvalId: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const valueOf = (flag: string): string | undefined => {
      if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1)
      if (a === flag) { i++; return argv[i] }
      return undefined
    }
    const is = (flag: string) => a === flag || a.startsWith(`${flag}=`)
    // An older script's way to ask for Face ID or Touch ID: every approval is a tap now.
    if (a === '--biometric' || a === '--face-id' || a === '--touch-id') continue
    if (a === '--json') { json = true; continue }
    if (a === '--single-use') { singleUse = true; continue }
    if (a === '--request-only') { requestOnly = true; continue }
    if (is('--timeout')) {
      const ms = parseApproveDuration(valueOf('--timeout'))
      if (ms === undefined || ms < 10_000 || ms > 86_400_000) return { ok: false, error: '--timeout is 10s to 24h, like 90s, 10m or 2h' }
      timeoutMs = ms
      continue
    }
    if (is('--detail')) {
      detailFrom = valueOf('--detail')
      if (!detailFrom) return { ok: false, error: '--detail takes a file path, or - for stdin' }
      continue
    }
    if (is('--from')) {
      command = valueOf('--from')
      continue
    }
    if (is('--why')) {
      why = valueOf('--why')?.trim()
      if (!why || /[\r\n]/.test(why) || why.length > 300) return { ok: false, error: '--why takes one line of at most 300 characters' }
      continue
    }
    if (is('--signing-key')) {
      // An older script's pinned device (the Git gate passes its files): taken and not read.
      if (!valueOf('--signing-key')) return { ok: false, error: '--signing-key takes a file path (it changes nothing now: any device you are signed in on approves)' }
      signingKeys++
      continue
    }
    if (is('--approval')) {
      approvalId = valueOf('--approval')
      if (!isApprovalId(approvalId)) return { ok: false, error: '--approval takes an approval id, like apr-Ab3_x' }
      continue
    }
    if (a === '--') { words.push(...argv.slice(i + 1)); break }
    if (a.startsWith('--')) return { ok: false, error: `unknown option ${a}` }
    words.push(a)
  }
  const what = words.join(' ').trim()
  if (!what) return { ok: false, error: 'say what is to be approved' }
  if (what.length > 300) return { ok: false, error: 'what is at most 300 characters; put the rest in --detail' }
  if (requestOnly && approvalId) return { ok: false, error: '--request-only asks; --approval waits for an ask made before: use one of them' }
  if (signingKeys && !singleUse) return { ok: false, error: '--signing-key goes with --single-use' }
  if (singleUse) {
    if (!detailFrom) return { ok: false, error: '--single-use needs --detail: the operation context the person approves' }
    if (timeoutMs !== undefined && timeoutMs > SINGLE_USE_MAX_MS) return { ok: false, error: '--timeout is at most 5m with --single-use' }
  }
  return {
    ok: true, what, timeoutMs: timeoutMs ?? (singleUse ? SINGLE_USE_MAX_MS : 10 * 60_000),
    ...(detailFrom ? { detailFrom } : {}), json, ...(command ? { command } : {}),
    ...(why ? { why } : {}),
    ...(singleUse ? { singleUse: true as const } : {}),
    ...(requestOnly ? { requestOnly: true as const } : {}),
    ...(approvalId ? { approvalId } : {}),
  }
}

interface ApprovalLite {
  id: string
  status: string
  what: string
  mode: string
  detail?: string
  digest?: string
  createdAt?: string
  expiresAt?: string
  singleUse?: boolean
  requester?: { host?: string; taskId?: string; sessionId?: string }
  answer?: { decision: string; mode: string; at: string; device?: { name?: string; kind?: string } }
}

interface Envelope { version: string; sessionId?: string; taskId?: string; host?: string; nonce: string; context: string }

function approvalOf(r: OpCallResult): ApprovalLite | undefined {
  const body = (r.result ?? {}) as { approval?: ApprovalLite }
  return body.approval && typeof body.approval.id === 'string' ? body.approval : undefined
}

function envelopeOf(detail: string | undefined): Envelope | undefined {
  if (typeof detail !== 'string') return undefined
  try {
    const v = JSON.parse(detail) as Envelope
    if (!v || typeof v !== 'object' || v.version !== 'walnut-single-use-v1') return undefined
    if (typeof v.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(v.nonce) || typeof v.context !== 'string') return undefined
    return v
  } catch {
    return undefined
  }
}

function how(a: ApprovalLite): string {
  if (a.answer?.device?.kind === 'setting') return 'with nobody asked: approvals are off (Settings, General)'
  return `on ${a.answer?.device?.name ?? 'a device'}`
}

/** Why a single-use record cannot be used for this run, or null when every check holds. */
export function singleUseProblem(rec: ApprovalLite, want: { id: string; detail: string; nonce?: string; now: number }): string | null {
  if (rec.id !== want.id) return 'the answer is for another approval'
  if (rec.singleUse !== true) return 'the approval is not single-use'
  if (rec.status !== 'approved' || rec.answer?.decision !== 'approve') return 'the approval is not approved'
  if (rec.answer.device?.kind === 'setting') return 'nobody approved it (approvals were off)'
  const req = rec.requester
  if (!req || typeof req.host !== 'string' || !req.taskId || !req.sessionId) return 'the approval names no asking task session'
  if (typeof rec.digest !== 'string' || typeof rec.createdAt !== 'string' || typeof rec.expiresAt !== 'string') return 'the approval record is incomplete'
  if (rec.mode !== 'tap' && rec.mode !== 'biometric') return 'the approval record is incomplete'
  const digest = approvalDigest({
    id: rec.id, mode: rec.mode, createdAt: rec.createdAt, expiresAt: rec.expiresAt,
    host: req.host, taskId: req.taskId, what: rec.what, detail: rec.detail,
  })
  if (digest !== rec.digest) return 'the record does not match what was approved'
  const env = envelopeOf(rec.detail)
  if (!env) return 'the detail is not a single-use envelope'
  if (want.nonce !== undefined && env.nonce !== want.nonce) return 'the envelope is not the one this request was given'
  if (env.context !== want.detail) return 'the approved detail is not this run\'s detail'
  if (env.sessionId !== req.sessionId || env.taskId !== req.taskId || env.host !== req.host) return 'the envelope names another asker'
  const expires = Date.parse(rec.expiresAt)
  if (!Number.isFinite(expires) || want.now >= expires) return 'the approval has expired'
  return null
}

export async function runApprove(args: ApproveArgs, io: ApproveIo): Promise<number> {
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = io.now ?? Date.now
  const dir = io.tokenDir ?? tokenDir()
  try { sweepTokens(dir) } catch { /* nothing saved yet */ }
  const singleUse = args.singleUse === true
  if (singleUse && !args.detail) { io.say('walnut approve: --single-use needs --detail, the operation context; not asked.'); return APPROVE_EXIT.error }

  let id: string
  let token: string
  let first: ApprovalLite
  let nonce: string | undefined
  let deadline: number
  let saved: SavedApproval | undefined
  if (args.approvalId) {
    if (!isApprovalId(args.approvalId)) { io.say(`walnut approve: ${JSON.stringify(args.approvalId)} is not an approval id.`); return APPROVE_EXIT.error }
    saved = loadToken(args.approvalId, dir)
    if (!saved) { io.say(`walnut approve: no saved request ${args.approvalId} on this machine: ask again.`); return APPROVE_EXIT.error }
    if (saved.what !== args.what || saved.detailSha256 !== sha256Hex(args.detail) || saved.singleUse !== singleUse) {
      io.say('walnut approve: the request changed since it was asked: ask again.')
      return APPROVE_EXIT.error
    }
    if (singleUse) {
      nonce = envelopeOf(saved.envelope)?.nonce
      if (!nonce) { io.say('walnut approve: the saved request has no single-use envelope: ask again.'); return APPROVE_EXIT.error }
    }
    id = saved.id
    token = saved.waitToken
    first = { id, status: 'pending', what: saved.what, mode: 'tap' }
    const expires = Date.parse(saved.expiresAt)
    deadline = (Number.isFinite(expires) ? expires : now() + args.timeoutMs) + 15_000
    io.say(`Waiting for approval: ${args.what}`)
    io.say(`  Answer it on your Mac or phone (Approve or Deny, on any device you are signed in on). Id ${id}, asked before.`)
  } else {
    const created = await io.call('approval_request', {
      what: args.what,
      ...(args.detail ? { detail: args.detail } : {}),
      ...(args.why ? { why: args.why } : {}),
      timeout_ms: args.timeoutMs,
      ...(singleUse ? { single_use: true } : {}),
      ...(args.cwd ? { cwd: args.cwd } : {}),
      ...(args.command ? { command: args.command } : {}),
      ...(args.requestOnly ? { request_only: true } : {}),
      ...(args.terminalSession ? { terminal_session: args.terminalSession } : {}),
    })
    const asked = approvalOf(created)
    const tok = ((created.result ?? {}) as { waitToken?: string }).waitToken
    if (!created.ok && created.message?.includes(HELD_MARK)) {
      // Not now (the person is away, or another single-use ask is on his devices): Walnut holds it
      // and tells this session when to take the step again (held-asks.ts). Asked, not answered: 4.
      io.say(`walnut approve: not asked yet: ${created.message}`)
      // No approval id (nothing was asked): a --json reader tells it from --request-only's by its status.
      const heldId = /\((held-[\w-]+)\)/.exec(created.message)?.[1]
      if (args.json) io.out(JSON.stringify({ status: 'held', ...(heldId ? { held: heldId } : {}) }))
      return APPROVE_EXIT.pending
    }
    if (!created.ok || !asked || !tok) {
      io.say(`walnut approve: could not ask for approval: ${created.message ?? 'no answer from Walnut'}`)
      return APPROVE_EXIT.error
    }
    id = asked.id
    token = tok
    first = asked
    if (!isApprovalId(id)) {
      await io.call('approval_cancel', { id, token, reason: 'the asker could not read its id' }).catch(() => undefined)
      io.say('walnut approve: Walnut answered with an id this CLI cannot use; not asked.')
      return APPROVE_EXIT.error
    }
    if (singleUse) {
      const env = envelopeOf(asked.detail)
      // Which check failed, in the record and to the script: one reason for all three read as "not
      // single-use" while the record said single-use (2026-11-23, apr-kCUkpVWwmbBH: a cut answer).
      const problem = asked.singleUse !== true ? 'Walnut did not mark it single-use (an older Walnut?)'
        : !env ? `the answer did not carry its single-use record whole (${typeof asked.detail === 'string' ? asked.detail.length : 0} characters of detail)`
          : env.context !== args.detail ? 'the context Walnut kept differs from this run\'s'
            : null
      if (problem || !env) {
        await io.call('approval_cancel', { id, token, reason: `not checked as single-use: ${problem}` }).catch(() => undefined)
        io.say(`walnut approve: ${problem}; withdrawn, not approved.`)
        return APPROVE_EXIT.error
      }
      nonce = env.nonce
    }
    if (args.requestOnly) {
      try {
        saveToken({
          id, waitToken: token, what: args.what, ...(args.detail !== undefined ? { detail: args.detail } : {}),
          detailSha256: sha256Hex(args.detail), singleUse,
          createdAt: asked.createdAt ?? new Date(now()).toISOString(),
          expiresAt: asked.expiresAt ?? new Date(now() + args.timeoutMs).toISOString(),
          ...(singleUse && asked.detail ? { envelope: asked.detail } : {}),
        }, dir)
      } catch (err) {
        await io.call('approval_cancel', { id, token, reason: 'the asker could not save its request' }).catch(() => undefined)
        io.say(`walnut approve: could not save the request (${err instanceof Error ? err.message : String(err)}); withdrawn.`)
        return APPROVE_EXIT.error
      }
      io.out(args.json ? JSON.stringify({ id, status: 'pending' }) : id)
      io.say(`Asked for approval ${id}; to wait for the answer and go on, rerun the same command with --approval ${id}.`)
      return APPROVE_EXIT.pending
    }
    io.say(`Waiting for approval: ${args.what}`)
    io.say(`  Answer it on your Mac or phone (Approve or Deny, on any device you are signed in on). Id ${id}; gives up in ${Math.round(args.timeoutMs / 1000)}s.`)
    deadline = now() + args.timeoutMs + 15_000
  }

  const finishSingleUse = async (rec: ApprovalLite): Promise<number> => {
    const problem = singleUseProblem(rec, { id, detail: args.detail!, nonce, now: now() })
    if (problem) {
      io.say(`walnut approve: ${problem}; not approved, do not run. Ask again.`)
      return APPROVE_EXIT.error
    }
    const r = await io.call('approval_consume', { id, token, digest: rec.digest, detail: args.detail })
    const body = (r.result ?? {}) as { approval?: ApprovalLite; used?: unknown }
    if (!r.ok || body.used !== true || body.approval?.id !== id) {
      // No retry: a consume whose answer was lost may have spent it. Ask again, never run.
      io.say(`walnut approve: could not use the approval (${r.ok ? 'Walnut did not mark it used' : r.message ?? 'no answer'}); not approved, ask again.`)
      return APPROVE_EXIT.error
    }
    io.say(`Approved ${how(rec)}; used once.`)
    if (args.json) io.out(JSON.stringify({ approval: body.approval, used: true }))
    return APPROVE_EXIT.approved
  }
  const record = (a: ApprovalLite) => (singleUse ? JSON.stringify({ approval: a, used: false }) : JSON.stringify(a))

  const waitLoop = async (): Promise<number> => {
    let interrupted = false
    let wake: () => void = () => undefined
    const interruptedP = new Promise<null>((resolve) => { wake = () => resolve(null) })
    const stop = io.onInterrupt?.(() => { interrupted = true; wake() })
    let last: ApprovalLite = first
    // Walnut away for a moment (a deploy restarts it): the same approval is waited on again.
    const away = waitThroughRestart({ who: 'walnut approve', say: io.say, sleep, now, deadline, stop: interruptedP })
    try {
      while (!interrupted) {
        const r = await Promise.race([io.call('approval_wait', { id, token, wait_ms: 12_000 }), interruptedP])
        if (interrupted || r === null) break
        const a = approvalOf(r)
        if (r.ok && a) {
          away.answered()
          last = a
          if (a.status === 'approved') {
            if (singleUse) return await finishSingleUse(a)
            io.say(`Approved ${how(a)}.`)
            if (args.json) io.out(JSON.stringify(a))
            return APPROVE_EXIT.approved
          }
          if (a.status === 'denied') {
            io.say(`Denied ${how(a)}.`)
            if (args.json) io.out(record(a))
            return APPROVE_EXIT.denied
          }
          if (a.status === 'expired' || a.status === 'canceled') {
            io.say(a.status === 'expired' ? 'No answer in time: not approved.' : 'The approval was withdrawn: not approved.')
            if (args.json) io.out(record(a))
            return APPROVE_EXIT.timeout
          }
        } else if (definiteRefusal(r)) {
          // A definite refusal (used already, unknown id, bad token): never approved.
          io.say(`walnut approve: ${r.message ?? 'refused'}; not approved.`)
          return r.code === 'approval_used' ? APPROVE_EXIT.denied : APPROVE_EXIT.error
        } else {
          // Ctrl-C during the pause withdraws at once, as it does mid-wait.
          await away.lost(r.message)
          if (interrupted) break
        }
        if (now() >= deadline) {
          io.say('No answer in time: not approved.')
          if (args.json) io.out(record({ ...last, status: 'expired' }))
          return APPROVE_EXIT.timeout
        }
      }
    } finally {
      stop?.()
    }
    await io.call('approval_cancel', { id, token, reason: 'the script was stopped' }).catch(() => undefined)
    io.say('Stopped: the approval was withdrawn.')
    return APPROVE_EXIT.interrupted
  }

  const code = await waitLoop()
  // A resumed ask has reached its end whichever way this run ended: its token is no use any more.
  if (saved) removeToken(saved.id, dir)
  return code
}
