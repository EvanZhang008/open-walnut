/**
 * `walnut approve "<what>" [--biometric] [--timeout 10m] [--detail <file>|-] [--json]`, shared
 * by the Mac CLI (commands/approve.ts, ops through executeOp) and the remote host CLI
 * (providers/wn-cli.ts, ops through the daemon's gateway). No imports: the daemon bundles it.
 *
 * It asks once (approval_request), then waits in short calls (approval_wait, 12 s each, so
 * every relay on the way holds it: the daemon gives the Mac 20 s), until the approval is
 * decided, expired or canceled. A dropped link in between is retried until the deadline.
 *
 * Exit codes: 0 approved; 1 denied; 2 not answered in time, or withdrawn; 3 could not ask
 * (bad usage, Walnut unreachable). So `walnut approve "…" && deploy` runs only on a yes.
 */

export const APPROVE_EXIT = { approved: 0, denied: 1, timeout: 2, error: 3, interrupted: 130 } as const

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
}

export const APPROVE_USAGE = 'usage: walnut approve "<what>" [--biometric] [--timeout 10m] [--detail <file>|-] [--json]'

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

export interface ParsedApprove { ok: true; what: string; biometric: boolean; timeoutMs: number; detailFrom?: string; json: boolean; command?: string }

/** argv after the word `approve`. */
export function parseApproveArgv(argv: readonly string[]): ParsedApprove | { ok: false; error: string } {
  const words: string[] = []
  let biometric = false
  let json = false
  let timeoutMs = 10 * 60_000
  let detailFrom: string | undefined
  let command: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const valueOf = (flag: string): string | undefined => {
      if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1)
      if (a === flag) { i++; return argv[i] }
      return undefined
    }
    if (a === '--biometric' || a === '--face-id' || a === '--touch-id') { biometric = true; continue }
    if (a === '--json') { json = true; continue }
    if (a === '--timeout' || a.startsWith('--timeout=')) {
      const ms = parseApproveDuration(valueOf('--timeout'))
      if (ms === undefined || ms < 10_000 || ms > 86_400_000) return { ok: false, error: '--timeout is 10s to 24h, like 90s, 10m or 2h' }
      timeoutMs = ms
      continue
    }
    if (a === '--detail' || a.startsWith('--detail=')) {
      detailFrom = valueOf('--detail')
      if (!detailFrom) return { ok: false, error: '--detail takes a file path, or - for stdin' }
      continue
    }
    if (a === '--from' || a.startsWith('--from=')) {
      command = valueOf('--from')
      continue
    }
    if (a === '--') { words.push(...argv.slice(i + 1)); break }
    if (a.startsWith('--')) return { ok: false, error: `unknown option ${a}` }
    words.push(a)
  }
  const what = words.join(' ').trim()
  if (!what) return { ok: false, error: 'say what is to be approved' }
  if (what.length > 300) return { ok: false, error: 'what is at most 300 characters; put the rest in --detail' }
  return { ok: true, what, biometric, timeoutMs, ...(detailFrom ? { detailFrom } : {}), json, ...(command ? { command } : {}) }
}

interface ApprovalLite {
  id: string
  status: string
  what: string
  mode: string
  downgraded?: string
  answer?: { decision: string; mode: string; at: string; device?: { name?: string; kind?: string } }
}

function approvalOf(r: OpCallResult): ApprovalLite | undefined {
  const body = (r.result ?? {}) as { approval?: ApprovalLite }
  return body.approval && typeof body.approval.id === 'string' ? body.approval : undefined
}

function how(a: ApprovalLite): string {
  const dev = a.answer?.device?.name ?? 'a device'
  const mode = a.answer?.mode === 'biometric' ? (a.answer.device?.kind === 'iphone' ? 'Face ID' : 'Touch ID') : 'a tap'
  return `on ${dev}, with ${mode}`
}

export async function runApprove(args: ApproveArgs, io: ApproveIo): Promise<number> {
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = io.now ?? Date.now
  const created = await io.call('approval_request', {
    what: args.what,
    ...(args.detail ? { detail: args.detail } : {}),
    mode: args.biometric ? 'biometric' : 'tap',
    timeout_ms: args.timeoutMs,
    ...(args.cwd ? { cwd: args.cwd } : {}),
    ...(args.command ? { command: args.command } : {}),
  })
  const first = approvalOf(created)
  const token = ((created.result ?? {}) as { waitToken?: string }).waitToken
  if (!created.ok || !first || !token) {
    io.say(`walnut approve: could not ask for approval: ${created.message ?? 'no answer from Walnut'}`)
    return APPROVE_EXIT.error
  }
  if (first.downgraded) io.say(`walnut approve: ${first.downgraded}`)
  io.say(`Waiting for approval: ${args.what}`)
  io.say(`  Answer it on your Mac or phone (${first.mode === 'biometric' ? 'Face ID or Touch ID' : 'Approve or Deny'}). Id ${first.id}; gives up in ${Math.round(args.timeoutMs / 1000)}s.`)

  let interrupted = false
  let wake: () => void = () => undefined
  const interruptedP = new Promise<null>((resolve) => { wake = () => resolve(null) })
  const stop = io.onInterrupt?.(() => { interrupted = true; wake() })
  const deadline = now() + args.timeoutMs + 15_000
  let last: ApprovalLite = first
  let failures = 0
  try {
    while (!interrupted) {
      const r = await Promise.race([io.call('approval_wait', { id: first.id, token, wait_ms: 12_000 }), interruptedP])
      if (interrupted || r === null) break
      const a = approvalOf(r)
      if (r.ok && a) {
        failures = 0
        last = a
        if (a.status === 'approved') {
          io.say(`Approved ${how(a)}.`)
          if (args.json) io.out(JSON.stringify(a))
          return APPROVE_EXIT.approved
        }
        if (a.status === 'denied') {
          io.say(`Denied ${how(a)}.`)
          if (args.json) io.out(JSON.stringify(a))
          return APPROVE_EXIT.denied
        }
        if (a.status === 'expired' || a.status === 'canceled') {
          io.say(a.status === 'expired' ? 'No answer in time: not approved.' : 'The approval was withdrawn: not approved.')
          if (args.json) io.out(JSON.stringify(a))
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
        if (args.json) io.out(JSON.stringify({ ...last, status: 'expired' }))
        return APPROVE_EXIT.timeout
      }
    }
  } finally {
    stop?.()
  }
  await io.call('approval_cancel', { id: first.id, token, reason: 'the script was stopped' }).catch(() => undefined)
  io.say('Stopped: the approval was withdrawn.')
  return APPROVE_EXIT.interrupted
}
