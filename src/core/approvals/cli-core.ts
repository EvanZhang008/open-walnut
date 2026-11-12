/**
 * `walnut approve "<what>" [--biometric] [--timeout 10m] [--detail <file>|-] [--why "<line>"] [--json]
 *   [--single-use --signing-key <public key file>] [--request-only | --approval <id>]`, shared by the
 * Mac CLI (commands/approve.ts, ops through executeOp) and the remote host CLI (providers/wn-cli.ts,
 * ops through the daemon's gateway). Imports only node builtins and src/core/approvals: the daemon
 * bundles it.
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
 * `--single-use` is the strict form: Face ID / Touch ID on a device whose public key the script
 * pins (`--signing-key`, never fetched from the network; repeat it to let any one of several
 * devices sign, the set signed in the envelope as `signingKeyIds`), at most 5 minutes. Waiting only
 * reads; before exit 0 this CLI checks the signed record itself (key, digest rebuilt from the
 * fields, signature, the server's envelope around this run's detail, the clock) and then spends it
 * once with approval_consume. A failed check or a lost consume answer is exit 3: ask again.
 *
 * Exit codes: 0 approved; 1 denied; 2 not answered in time, or withdrawn; 3 could not ask or could
 * not prove the approval (bad usage, Walnut unreachable, a check failed); 4 asked with
 * --request-only, answer pending. So `walnut approve "…" && deploy` runs only on a yes.
 */
import { answerMessage, approvalDigest, keyIdOf, parsePublicKey, verifySignature } from './digest.js'
import { isApprovalId, loadToken, removeToken, saveToken, sha256Hex, sweepTokens, tokenDir, type SavedApproval } from './cli-token.js'

export const APPROVE_EXIT = { approved: 0, denied: 1, timeout: 2, error: 3, pending: 4, interrupted: 130 } as const

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
  biometric: boolean
  timeoutMs: number
  json: boolean
  cwd?: string
  command?: string
  why?: string
  /** Strict signed approval, spent once (implies biometric). */
  singleUse?: boolean
  /** The pinned signing key's file content: PEM SPKI, or base64 DER SPKI. */
  signingKey?: string
  signingKeyPath?: string
  /** Every pinned key's file content, when more than one may sign (`--signing-key` repeated). */
  signingKeys?: string[]
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

export const APPROVE_USAGE = 'usage: walnut approve "<what>" [--biometric] [--timeout 10m] [--detail <file>|-] [--why "<line>"] [--json]\n'
  + '         [--single-use --signing-key <public key file> [--signing-key <another>]] [--request-only | --approval <id>]'

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
  biometric: boolean
  timeoutMs: number
  detailFrom?: string
  json: boolean
  command?: string
  why?: string
  singleUse?: true
  /** The first --signing-key; every one is in signingKeysFrom. */
  signingKeyFrom?: string
  signingKeysFrom?: string[]
  requestOnly?: true
  approvalId?: string
}

/** argv after the word `approve`. */
export function parseApproveArgv(argv: readonly string[]): ParsedApprove | { ok: false; error: string } {
  const words: string[] = []
  let biometric = false
  let json = false
  let timeoutMs: number | undefined
  let detailFrom: string | undefined
  let command: string | undefined
  let why: string | undefined
  let singleUse = false
  const signingKeysFrom: string[] = []
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
    if (a === '--biometric' || a === '--face-id' || a === '--touch-id') { biometric = true; continue }
    if (a === '--json') { json = true; continue }
    if (a === '--single-use') { singleUse = true; biometric = true; continue }
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
      const from = valueOf('--signing-key')
      if (!from) return { ok: false, error: '--signing-key takes the path of a P-256 public key file' }
      if (signingKeysFrom.length >= 8) return { ok: false, error: '--signing-key is given at most 8 times' }
      signingKeysFrom.push(from)
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
  const signingKeyFrom = signingKeysFrom[0]
  if (signingKeyFrom && !singleUse) return { ok: false, error: '--signing-key goes with --single-use' }
  if (singleUse) {
    if (!signingKeyFrom) return { ok: false, error: '--single-use needs --signing-key <file>: the public key of the device that must sign (it is never fetched from the network)' }
    if (!detailFrom) return { ok: false, error: '--single-use needs --detail: the operation context the person signs' }
    if (timeoutMs !== undefined && timeoutMs > SINGLE_USE_MAX_MS) return { ok: false, error: '--timeout is at most 5m with --single-use' }
  }
  return {
    ok: true, what, biometric, timeoutMs: timeoutMs ?? (singleUse ? SINGLE_USE_MAX_MS : 10 * 60_000),
    ...(detailFrom ? { detailFrom } : {}), json, ...(command ? { command } : {}),
    ...(why ? { why } : {}),
    ...(singleUse ? { singleUse: true as const, signingKeyFrom, ...(signingKeysFrom.length > 1 ? { signingKeysFrom } : {}) } : {}),
    ...(requestOnly ? { requestOnly: true as const } : {}),
    ...(approvalId ? { approvalId } : {}),
  }
}

/**
 * A P-256 public key file (PEM "-----BEGIN PUBLIC KEY-----", or base64 DER SPKI) -> its base64
 * DER SPKI in canonical form; undefined when it is not one.
 */
export function spkiFromKeyText(text: string): string | undefined {
  const pem = /-----BEGIN PUBLIC KEY-----([\s\S]*?)-----END PUBLIC KEY-----/.exec(text)
  if (!pem && text.includes('-----BEGIN')) return undefined
  const b64 = (pem ? pem[1] : text).replace(/\s+/g, '')
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return undefined
  const key = parsePublicKey(b64)
  if (!key) return undefined
  return (key.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64')
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
  downgraded?: string
  singleUse?: boolean
  signingKeyId?: string
  signingKeyIds?: string[]
  requester?: { host?: string; taskId?: string; sessionId?: string }
  answer?: { decision: string; mode: string; at: string; device?: { name?: string; kind?: string }; keyId?: string; signature?: string }
}

interface Envelope { version: string; sessionId?: string; taskId?: string; host?: string; signingKeyId?: string; signingKeyIds?: unknown; nonce: string; context: string }

/**
 * Whether a record (or its envelope) names exactly the keys this run pinned: one key as
 * `signingKeyId` and no set, or two or more as the sorted `signingKeyIds` and no single key.
 */
export function namesPinnedKeys(v: { signingKeyId?: unknown; signingKeyIds?: unknown } | undefined, ids: readonly string[]): boolean {
  if (!v || !ids.length) return false
  if (ids.length === 1) return v.signingKeyId === ids[0] && v.signingKeyIds === undefined
  const got = v.signingKeyIds
  return v.signingKeyId === undefined && Array.isArray(got) && got.length === ids.length && got.every((x, i) => x === ids[i])
}

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
  const dev = a.answer?.device?.name ?? 'a device'
  const mode = a.answer?.mode === 'biometric' ? (a.answer.device?.kind === 'iphone' ? 'Face ID' : 'Touch ID') : 'a tap'
  return `on ${dev}, with ${mode}`
}

/**
 * Why a signed single-use record cannot be used for this run, or null when every check holds.
 * `keys` (key id -> base64 DER SPKI) are every key this run pinned; `keyId`/`spki` is the one-key form.
 */
export function singleUseProblem(rec: ApprovalLite, want: { id: string; keyId?: string; spki?: string; keys?: Record<string, string>; detail: string; nonce?: string; now: number }): string | null {
  const keys = want.keys ?? (want.keyId && want.spki ? { [want.keyId]: want.spki } : {})
  const ids = Object.keys(keys).sort()
  if (rec.id !== want.id) return 'the answer is for another approval'
  if (rec.singleUse !== true) return 'the approval is not single-use'
  if (rec.mode !== 'biometric' || rec.downgraded) return 'the approval was not asked with Face ID or Touch ID'
  if (rec.status !== 'approved' || rec.answer?.decision !== 'approve') return 'the approval is not approved'
  if (rec.answer.mode !== 'biometric') return 'the answer was not given with Face ID or Touch ID'
  const signer = rec.answer.keyId
  if (!signer || !Object.prototype.hasOwnProperty.call(keys, signer) || !namesPinnedKeys(rec, ids)) return 'the answer was not signed by the pinned key'
  const req = rec.requester
  if (!req || typeof req.host !== 'string' || !req.taskId || !req.sessionId) return 'the approval names no asking task session'
  if (typeof rec.digest !== 'string' || typeof rec.createdAt !== 'string' || typeof rec.expiresAt !== 'string') return 'the approval record is incomplete'
  const digest = approvalDigest({
    id: rec.id, mode: 'biometric', createdAt: rec.createdAt, expiresAt: rec.expiresAt,
    host: req.host, taskId: req.taskId, what: rec.what, detail: rec.detail,
  })
  if (digest !== rec.digest) return 'the record does not match what was signed'
  if (typeof rec.answer.signature !== 'string' || !verifySignature(keys[signer]!, answerMessage(rec.digest, 'approve'), rec.answer.signature)) {
    return 'the signature does not verify with the pinned key'
  }
  const env = envelopeOf(rec.detail)
  if (!env) return 'the signed detail is not a single-use envelope'
  if (!namesPinnedKeys(env, ids)) return 'the envelope names another signing key'
  if (want.nonce !== undefined && env.nonce !== want.nonce) return 'the envelope is not the one this request was given'
  if (env.context !== want.detail) return 'the signed detail is not this run\'s detail'
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
  const biometric = singleUse || args.biometric

  // Every pinned key, by id; one key keeps today's `signing_key_id`, two or more ask for a set.
  const pinned: Record<string, string> = {}
  let keyId: string | undefined
  let keyIds: string[] = []
  if (singleUse) {
    const texts = args.signingKeys?.length ? args.signingKeys : args.signingKey ? [args.signingKey] : []
    if (!texts.length) { io.say('walnut approve: --single-use needs --signing-key <file>; not asked.'); return APPROVE_EXIT.error }
    for (const text of texts) {
      const spki = spkiFromKeyText(text)
      if (!spki) {
        io.say(`walnut approve: ${texts.length === 1 && args.signingKeyPath ? args.signingKeyPath : 'a signing key'} is not a P-256 public key (PEM or base64 DER SPKI); not asked.`)
        return APPROVE_EXIT.error
      }
      pinned[keyIdOf(spki)] = spki
    }
    keyIds = Object.keys(pinned).sort()
    if (keyIds.length === 1) keyId = keyIds[0]
    if (!args.detail) { io.say('walnut approve: --single-use needs --detail, the operation context; not asked.'); return APPROVE_EXIT.error }
  }

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
    if (saved.what !== args.what || saved.detailSha256 !== sha256Hex(args.detail) || saved.singleUse !== singleUse
      || (saved.signingKeyId ?? undefined) !== keyId
      || JSON.stringify(saved.signingKeyIds ?? []) !== JSON.stringify(keyIds.length > 1 ? keyIds : [])) {
      io.say('walnut approve: the request changed since it was asked: ask again.')
      return APPROVE_EXIT.error
    }
    if (singleUse) {
      nonce = envelopeOf(saved.envelope)?.nonce
      if (!nonce) { io.say('walnut approve: the saved request has no signed envelope: ask again.'); return APPROVE_EXIT.error }
    }
    id = saved.id
    token = saved.waitToken
    first = { id, status: 'pending', what: saved.what, mode: biometric ? 'biometric' : 'tap' }
    const expires = Date.parse(saved.expiresAt)
    deadline = (Number.isFinite(expires) ? expires : now() + args.timeoutMs) + 15_000
    io.say(`Waiting for approval: ${args.what}`)
    io.say(`  Answer it on your Mac or phone (${biometric ? 'Face ID or Touch ID' : 'Approve or Deny'}). Id ${id}, asked before.`)
  } else {
    const created = await io.call('approval_request', {
      what: args.what,
      ...(args.detail ? { detail: args.detail } : {}),
      ...(args.why ? { why: args.why } : {}),
      mode: biometric ? 'biometric' : 'tap',
      timeout_ms: args.timeoutMs,
      ...(singleUse ? { single_use: true, ...(keyIds.length > 1 ? { signing_key_ids: keyIds } : { signing_key_id: keyId }) } : {}),
      ...(args.cwd ? { cwd: args.cwd } : {}),
      ...(args.command ? { command: args.command } : {}),
      ...(args.requestOnly ? { request_only: true } : {}),
      ...(args.terminalSession ? { terminal_session: args.terminalSession } : {}),
    })
    const asked = approvalOf(created)
    const tok = ((created.result ?? {}) as { waitToken?: string }).waitToken
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
      if (asked.singleUse !== true || !env || env.context !== args.detail || !namesPinnedKeys(env, keyIds) || !namesPinnedKeys(asked, keyIds)) {
        await io.call('approval_cancel', { id, token, reason: 'not made as a single-use approval' }).catch(() => undefined)
        io.say('walnut approve: Walnut did not make it a single-use approval (an older Walnut?); withdrawn, not approved.')
        return APPROVE_EXIT.error
      }
      nonce = env.nonce
    }
    if (asked.downgraded) io.say(`walnut approve: ${asked.downgraded}`)
    if (args.requestOnly) {
      try {
        saveToken({
          id, waitToken: token, what: args.what, ...(args.detail !== undefined ? { detail: args.detail } : {}),
          detailSha256: sha256Hex(args.detail), singleUse, ...(keyId ? { signingKeyId: keyId } : {}),
          ...(keyIds.length > 1 ? { signingKeyIds: keyIds } : {}),
          ...(args.signingKeyPath ? { signingKeyPath: args.signingKeyPath } : {}),
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
    io.say(`  Answer it on your Mac or phone (${biometric ? 'Face ID or Touch ID' : 'Approve or Deny'}). Id ${id}; gives up in ${Math.round(args.timeoutMs / 1000)}s.`)
    deadline = now() + args.timeoutMs + 15_000
  }

  const finishSingleUse = async (rec: ApprovalLite): Promise<number> => {
    const problem = singleUseProblem(rec, { id, keys: pinned, detail: args.detail!, nonce, now: now() })
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
    let failures = 0
    try {
      while (!interrupted) {
        const r = await Promise.race([io.call('approval_wait', { id, token, wait_ms: 12_000 }), interruptedP])
        if (interrupted || r === null) break
        const a = approvalOf(r)
        if (r.ok && a) {
          failures = 0
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
        } else if (r.status !== undefined && r.status >= 400 && r.status < 500) {
          // A definite refusal (used already, unknown id, bad token): never approved.
          io.say(`walnut approve: ${r.message ?? 'refused'}; not approved.`)
          return r.code === 'approval_used' ? APPROVE_EXIT.denied : APPROVE_EXIT.error
        } else {
          failures++
          if (failures === 1) io.say(`walnut approve: lost Walnut for a moment (${r.message ?? 'no answer'}); still waiting.`)
          // Ctrl-C during the pause withdraws at once, as it does mid-wait.
          await Promise.race([sleep(Math.min(10_000, 1_000 * failures)), interruptedP])
          if (interrupted) break
        }
        if (now() > deadline) {
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
