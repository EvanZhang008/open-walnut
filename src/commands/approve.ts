/**
 * walnut approve "<what>" [--biometric] [--timeout 10m] [--detail <file>|-] [--json]
 * — block until a person approves (exit 0), denies (1), or nobody answers in time (2).
 * The loop is core/approvals/cli-core.ts, shared with the remote hosts' CLI (wn-cli.ts).
 */
import fs from 'node:fs'
import { executeOp } from '../ops/index.js'
import { LOCAL_ORIGIN } from '../lib/caller-origin.js'
import { APPROVE_EXIT, APPROVE_USAGE, parseApproveArgv, runApprove, type OpCallResult } from '../core/approvals/cli-core.js'

/** Codes that say the server could not answer now (the Mac away, a fault): the CLI tries again. */
const PASSING = new Set(['leader_only', 'internal'])

/** "Walnut API error (approval_used): …" -> a definite refusal with its code; anything else is the link. */
export function opFailure(message: string): OpCallResult {
  const m = /^Walnut API error \(([a-z][a-z0-9_]*)\)/.exec(message)
  if (m && !PASSING.has(m[1])) return { ok: false, message, status: 400, code: m[1] }
  return { ok: false, message }
}

export async function readDetail(from: string | undefined): Promise<string | undefined> {
  if (!from) return undefined
  if (from === '-') {
    const chunks: Buffer[] = []
    for await (const c of process.stdin) chunks.push(c as Buffer)
    return Buffer.concat(chunks).toString('utf8')
  }
  return fs.readFileSync(from, 'utf8')
}

export async function runApproveCommand(argv: string[]): Promise<void> {
  const parsed = parseApproveArgv(argv)
  if (!parsed.ok) {
    console.error(`walnut approve: ${parsed.error}\n${APPROVE_USAGE}`)
    process.exitCode = APPROVE_EXIT.error
    return
  }
  let detail: string | undefined
  try {
    detail = await readDetail(parsed.detailFrom)
  } catch (err) {
    console.error(`walnut approve: cannot read --detail ${parsed.detailFrom}: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = APPROVE_EXIT.error
    return
  }
  const { cliAutomationSender } = await import('../lib/cli-sender.js')
  const sender = cliAutomationSender()
  const code = await runApprove({
    what: parsed.what, detail, biometric: parsed.biometric, timeoutMs: parsed.timeoutMs, json: parsed.json,
    cwd: process.cwd(), ...(parsed.command ? { command: parsed.command } : {}),
  }, {
    call: async (name, args) => {
      const r = await executeOp(name, args, { origin: LOCAL_ORIGIN, ...(sender ? { sender } : {}) })
      return r.ok ? { ok: true, result: r.result } : opFailure(r.message)
    },
    say: (line) => console.error(line),
    out: (line) => console.log(line),
    onInterrupt: (fn) => {
      process.on('SIGINT', fn)
      process.on('SIGTERM', fn)
      return () => { process.off('SIGINT', fn); process.off('SIGTERM', fn) }
    },
  })
  process.exitCode = code
}

export async function runApprovalsList(all: boolean, globals: { json?: boolean }): Promise<void> {
  const r = await executeOp('approval_list', all ? { status: 'all' } : {}, { origin: LOCAL_ORIGIN })
  if (!r.ok) {
    console.error(r.message)
    process.exitCode = 1
    return
  }
  const body = r.result as { approvals: Array<Record<string, any>>; keys: Array<Record<string, any>> }
  if (globals.json) { console.log(JSON.stringify(body)); return }
  if (body.approvals.length === 0) console.log(all ? 'No approvals in the last 30 days.' : 'No approval is waiting.')
  for (const a of body.approvals) {
    const who = a.answer ? ` (${a.answer.decision} on ${a.answer.device?.name ?? '?'}, ${a.answer.mode}, ${a.answer.at})` : ''
    console.log(`${a.id}  ${a.status.padEnd(8)} ${a.mode.padEnd(9)} ${a.what}  [${a.requester?.host ?? '?'}]${who}`)
  }
  console.log(body.keys.length ? '\nDevices that sign approvals:' : '\nNo device signs approvals yet (the Walnut iPhone app or the Mac app sets one up).')
  for (const k of body.keys) console.log(`  ${k.id}  ${k.status.padEnd(7)} ${k.kind.padEnd(8)} ${k.name}`)
}
