/**
 * A request from this computer counts as the person only with something only his own clients send.
 *
 * Loopback alone proved nothing: any process of the user's on this computer (a session's own Bash
 * `curl localhost:3456`, a host_exec, a subagent, an MCP server) sent none of Walnut's caller marks
 * and passed every person-only route as the person: answering an approval, posting in his name
 * through a plugin console (2026-11-28: a Slack console route was found open this way).
 *
 * What his clients send, and a bare local process does not:
 *   - a browser (the Mac app's web view, any browser on this computer): `Sec-Fetch-Site:
 *     same-origin` or `none` on every request, and `Origin` on every WebSocket and every write. A
 *     foreign Origin is already refused before this (local-trust.ts), so a present one is ours;
 *   - the `walnut` CLI the person runs at his terminal: the op executor's `x-walnut-op-call` mark
 *     with no session and no automation mark (cli-sender.ts: a session's call names its session,
 *     a call with no terminal is an automation's).
 * A paired device (the phone, through the companion too) proves itself with its device token and is
 * not loopback at all; this rule never touches it.
 *
 * Any of these can be forged by a process that sets the header on purpose: this keeps a well-meaning
 * agent's plain request from passing as the person, and makes a forged one a deliberate act that
 * the log names. It is not a defence against a hostile program running as the user.
 *
 * The mode: `enforce` refuses an unproven loopback request as the person; `observe` lets it through
 * and logs it (what the switch would refuse, before it does); `off` is the old rule. Read once at
 * boot: `WALNUT_LOCAL_PERSON_PROOF` decides anywhere; unset, the person's own install takes
 * DEFAULT_REAL_INSTALL_MODE and every other server (fixtures, tests, the sandbox) keeps the old rule,
 * as automated-client.ts does.
 */
import type { IncomingHttpHeaders } from 'node:http'
import { log } from '../../logging/index.js'

export type LocalProofMode = 'enforce' | 'observe' | 'off'
export type LocalProof = 'browser' | 'cli'

const OP_CALL_HEADER = 'x-walnut-op-call'
const CALLER_SID_HEADER = 'x-walnut-caller-sid'
const CALLER_KIND_HEADER = 'x-walnut-caller-kind'

let mode: LocalProofMode = 'off'
/**
 * The person's own install: observe first (2026-11-28), so the log shows every client of his that
 * sends no proof before anything is refused; enforce once it shows none.
 */
export const DEFAULT_REAL_INSTALL_MODE: LocalProofMode = 'observe'

function one(headers: IncomingHttpHeaders, name: string): string {
  const raw = headers[name]
  const v = Array.isArray(raw) ? raw[0] : raw
  return typeof v === 'string' ? v.trim().toLowerCase() : ''
}

/** What proves a loopback request is one of the person's own clients, or null. */
export function localPersonProof(headers: IncomingHttpHeaders): LocalProof | null {
  const site = one(headers, 'sec-fetch-site')
  if (site === 'same-origin' || site === 'none') return 'browser'
  if (one(headers, 'origin')) return 'browser'
  if (one(headers, OP_CALL_HEADER) === '1' && !one(headers, CALLER_SID_HEADER) && !one(headers, CALLER_KIND_HEADER)) return 'cli'
  return null
}

export function parseLocalProofMode(raw: string | undefined): LocalProofMode | undefined {
  const v = (raw ?? '').trim().toLowerCase()
  if (v === 'enforce' || v === '1' || v === 'on') return 'enforce'
  if (v === 'observe') return 'observe'
  if (v === 'off' || v === '0') return 'off'
  return undefined
}

/** Read the mode once at boot (see the file comment). */
export async function initLocalPersonProof(env: NodeJS.ProcessEnv = process.env): Promise<LocalProofMode> {
  const named = parseLocalProofMode(env.WALNUT_LOCAL_PERSON_PROOF)
  if (named) mode = named
  else {
    const { isRealInstall } = await import('../../core/test-run.js')
    mode = (await isRealInstall(env)) ? DEFAULT_REAL_INSTALL_MODE : 'off'
  }
  log.web.info('local person proof', { mode })
  return mode
}

export function localProofMode(): LocalProofMode {
  return mode
}

/** Tests: set the mode directly. */
export function setLocalProofModeForTest(next: LocalProofMode): void {
  mode = next
}

const LOG_EVERY_MS = 60 * 60_000
const logged = new Map<string, number>()

function uaClass(headers: IncomingHttpHeaders): string {
  const ua = one(headers, 'user-agent')
  if (!ua) return 'none'
  if (ua.startsWith('curl/')) return 'curl'
  if (ua.startsWith('python')) return 'python'
  if (ua.startsWith('bun/') || ua.startsWith('node')) return 'node'
  if (ua.includes('cfnetwork') || ua.includes('darwin/')) return 'apple-native'
  if (ua.includes('mozilla/')) return 'browser-ua'
  return ua.slice(0, 40)
}

/**
 * Whether a loopback request that the old rule calls the person still counts as the person. Logs,
 * at most once an hour per kind of client and path, what it refuses (enforce) or would (observe).
 */
export function loopbackPersonStands(req: { headers: IncomingHttpHeaders; url?: string; method?: string }): boolean {
  if (mode === 'off') return true
  if (localPersonProof(req.headers)) return true
  const path = String(req.url ?? '').split('?')[0]!.split('/').slice(0, 4).join('/')
  const ua = uaClass(req.headers)
  const key = `${mode}|${req.method ?? ''}|${path}|${ua}`
  const now = Date.now()
  if ((logged.get(key) ?? 0) + LOG_EVERY_MS <= now) {
    logged.set(key, now)
    if (logged.size > 500) logged.clear()
    log.web.warn(mode === 'enforce' ? 'local request not counted as the person: no proof' : 'local request would not count as the person: no proof', {
      mode, method: req.method ?? '', path, ua,
    })
  }
  return mode === 'observe'
}
