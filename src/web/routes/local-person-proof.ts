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
 *     a call with no terminal is an automation's);
 *   - the Mac app's own native calls (quick capture, dictation, App Intents): URLSession's
 *     `Walnut/<build> CFNetwork/...` agent string.
 * A paired device (the phone) proves itself with its device token and is not loopback at all; this
 * rule never touches it. A loopback request that CLAIMS to be for one (`x-walnut-origin: remote-http`,
 * the label this server's own forwards carry) counts only with this process's forward proof
 * (lib/forward-proof.ts), never on the header alone. The iOS simulator on this Mac talks loopback
 * like the Mac app and passes the same way.
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
import { LOCAL_ORIGIN, REMOTE_HTTP_ORIGIN } from '../../lib/caller-origin.js'
import { SENDER_LABEL_HEADER } from '../../lib/cli-sender.js'
import { FORWARD_PROOF_HEADER, isForwardProof } from '../../lib/forward-proof.js'

export type LocalProofMode = 'enforce' | 'observe' | 'off'
export type LocalProof = 'browser' | 'cli' | 'mac-app'

const OP_CALL_HEADER = 'x-walnut-op-call'
/** `Walnut/<build> CFNetwork/<v> Darwin/<v>`: the agent string the Mac app's URLSession sends (lowercased). */
const MAC_APP_AGENT = /^walnut\/\S+ cfnetwork\//
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
  // The Mac app's own native calls (quick capture, dictation, App Intents): URLSession's agent string.
  if (MAC_APP_AGENT.test(one(headers, 'user-agent'))) return 'mac-app'
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

/** A route's path with its ids folded, so one kind of request logs once an hour, not once per id. */
function routeOf(url: string | undefined): string {
  return String(url ?? '').split('?')[0]!.split('/').slice(0, 6)
    .map((part) => (/\d/.test(part) || part.length > 24 ? ':id' : part)).join('/')
}

function note(kind: 'local' | 'claimed-remote' | 'no-session', req: { headers: IncomingHttpHeaders; url?: string; method?: string }): void {
  const path = routeOf(req.url)
  const ua = uaClass(req.headers)
  const key = `${mode}|${kind}|${req.method ?? ''}|${path}|${ua}`
  const now = Date.now()
  if ((logged.get(key) ?? 0) + LOG_EVERY_MS > now) return
  logged.set(key, now)
  if (logged.size > 2000) logged.clear()
  log.web.warn(mode === 'enforce' ? 'local request not counted as the person: no proof' : 'local request would not count as the person: no proof', {
    mode, kind, method: req.method ?? '', path, ua,
    ...(kind === 'no-session' ? { callerKind: one(req.headers, CALLER_KIND_HEADER) || 'none', sender: one(req.headers, SENDER_LABEL_HEADER).slice(0, 40) || 'none' } : {}),
  })
}

type ProofRequest = { headers: IncomingHttpHeaders; url?: string; method?: string }

/**
 * Whether a loopback request that the old rule calls the person still counts as the person. Logs,
 * at most once an hour per kind of client and route, what it refuses (enforce) or would (observe);
 * `quiet` for a reader that only labels (no decision rests on it).
 */
export function loopbackPersonStands(req: ProofRequest, opts: { quiet?: boolean } = {}): boolean {
  if (mode === 'off') return true
  if (localPersonProof(req.headers)) return true
  if (!opts.quiet) note('local', req)
  return mode === 'observe'
}

/** Requests whose forward proof the /api middleware checked and took off (takeForwardProof). */
const forwardProven = new WeakSet<object>()

/**
 * Check a request's forward proof and take the header off, so no route, plugin or job below ever
 * sees the secret (a plugin reads its request's headers). The verdict stays with the request.
 */
export function takeForwardProof(req: ProofRequest): void {
  if (!(FORWARD_PROOF_HEADER in req.headers)) return
  if (isForwardProof(req.headers[FORWARD_PROOF_HEADER])) forwardProven.add(req)
  delete req.headers[FORWARD_PROOF_HEADER]
}

/** Whether a loopback request claiming to be for a paired device is this server's own forward. */
export function claimedRemoteStands(req: ProofRequest, opts: { quiet?: boolean } = {}): boolean {
  if (mode === 'off') return true
  if (forwardProven.has(req) || isForwardProof(req.headers[FORWARD_PROOF_HEADER])) return true
  if (!opts.quiet) note('claimed-remote', req)
  return mode === 'observe'
}

/**
 * For a decision that read a missing session id as the person before 2026-11-28 (a caller's sid
 * handed to a core rule, a route's sender source, an action card's or inbox item's run, a socket
 * send): in enforce, the caller must be the person (`isPerson`, person-caller.ts); outside it the
 * old reading holds, so observe changes nothing, and observe logs each kind of call the switch would
 * turn away (a script marked as an automation, a call through a host's link) before it does.
 */
export function noSessionStands(req: ProofRequest, isPerson: boolean): boolean {
  if (mode === 'enforce') return isPerson
  if (mode === 'observe' && !isPerson) note('no-session', req)
  return true
}

/** The sender label a stamped request carries (cli-sender.ts SENDER_LABEL_HEADER). */
export const UNPROVEN_LOCAL_SENDER = 'unproven-local'

/**
 * Mark a loopback request with no caller mark and no proof as an automation's, as the CLI marks a
 * script's call (x-walnut-caller-kind: automation), so every reader of the caller marks downstream
 * (the host's routes, a plugin's own check) treats it as not the person: one with no proof of a
 * person's client, and one that claims to be for a paired device without this server's forward
 * proof. `origin` is requestOrigin's class; `loopback` whether the socket is this computer's own
 * trusted path (local-trust.ts). Only in enforce.
 */
export function stampUnproven(req: ProofRequest, origin: string, loopback: boolean): void {
  if (mode !== 'enforce' || !loopback) return
  if (one(req.headers, CALLER_SID_HEADER) || one(req.headers, CALLER_KIND_HEADER)) return
  const stands = origin === LOCAL_ORIGIN ? loopbackPersonStands(req)
    : origin === REMOTE_HTTP_ORIGIN ? claimedRemoteStands(req)
      : true
  if (stands) return
  req.headers[CALLER_KIND_HEADER] = 'automation'
  req.headers[SENDER_LABEL_HEADER] = UNPROVEN_LOCAL_SENDER
}
