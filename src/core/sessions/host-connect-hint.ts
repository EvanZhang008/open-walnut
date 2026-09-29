/**
 * Human wording for a remote host's connection state, shared by the folder
 * picker (list-dirs) and anything else that has to explain "why no answer yet".
 *
 * Two jobs:
 *   - a connect PHASE becomes a sentence a first-time user can act on ("the
 *     session daemon is being installed, this can take a minute" instead of a
 *     spinner that looks hung);
 *   - a connect FAILURE becomes a kind + a next step. The raw ssh text is kept
 *     (it is the greppable truth) but the hint says what to do about it.
 *
 * Pure: no I/O, so the mapping is unit-tested exhaustively.
 */

import type { DaemonConnectPhase } from '../../providers/daemon-connection.js'

/** Connect phases that mean "still working" (the client should keep polling). */
export const IN_PROGRESS_PHASES: ReadonlySet<DaemonConnectPhase> = new Set<DaemonConnectPhase>([
  'idle', 'ssh', 'probe', 'install-runtime', 'upload', 'start', 'tunnel', 'handshake', 'reconnecting',
])

export function describeConnectPhase(phase: DaemonConnectPhase, hostLabel: string): string {
  switch (phase) {
    case 'ssh': return `Opening an SSH connection to ${hostLabel}`
    case 'probe': return `Checking whether the session daemon is running on ${hostLabel}`
    case 'install-runtime': return `Installing the session daemon runtime on ${hostLabel} (first connect, usually under a minute)`
    case 'upload': return `Uploading the session daemon to ${hostLabel}`
    case 'start': return `Starting the session daemon on ${hostLabel}`
    case 'tunnel': return `Opening the tunnel to ${hostLabel}`
    case 'handshake': return `Handshaking with the session daemon on ${hostLabel}`
    case 'reconnecting': return `Reconnecting to ${hostLabel}`
    case 'connected': return `Connected to ${hostLabel}`
    case 'failed': return `Could not connect to ${hostLabel}`
    case 'idle':
    default:
      return `Connecting to ${hostLabel}`
  }
}

/**
 * The ordered, user-visible steps of a first connect. `idle`, `connected`,
 * `reconnecting` and `failed` are states, not steps, so they are deliberately
 * absent: a progress list needs exactly the things that happen in sequence.
 */
export const DAEMON_CONNECT_STEPS: readonly DaemonConnectPhase[] = [
  'ssh', 'probe', 'install-runtime', 'upload', 'start', 'tunnel', 'handshake',
]

/**
 * A connect is IN FLIGHT: the steps above plus a reconnect. Unlike
 * IN_PROGRESS_PHASES this excludes `idle`: "nothing has tried" is not work in
 * flight, and a warmup that treated it as such would never dial anything.
 */
export const CONNECT_IN_FLIGHT_PHASES: ReadonlySet<DaemonConnectPhase> = new Set<DaemonConnectPhase>([
  ...DAEMON_CONNECT_STEPS, 'reconnecting',
])

/** Short button-width labels for the steps above (the sentence form is describeConnectPhase). */
const STEP_LABELS: Record<string, string> = {
  'ssh': 'SSH',
  'probe': 'Probe',
  'install-runtime': 'Install runtime',
  'upload': 'Upload daemon',
  'start': 'Start daemon',
  'tunnel': 'Tunnel',
  'handshake': 'Handshake',
}

export interface ConnectStep {
  phase: DaemonConnectPhase
  label: string
  status: 'done' | 'active' | 'todo'
}

/**
 * The step list as a progress indicator: everything before the current phase is
 * `done`, the current phase is `active`, the rest are `todo`.
 *
 * `connected` marks every step done. `idle`, `reconnecting` and `failed` return
 * the list with NOTHING active: they are not a position in the sequence, and
 * guessing one (e.g. painting 'ssh' active while a host sits idle) is how a
 * progress bar starts lying. The caller decides how to render that.
 */
export function describeConnectSteps(phase: DaemonConnectPhase): ConnectStep[] {
  const activeIndex = DAEMON_CONNECT_STEPS.indexOf(phase)
  const allDone = phase === 'connected'
  return DAEMON_CONNECT_STEPS.map((step, i) => ({
    phase: step,
    label: STEP_LABELS[step] ?? step,
    status: allDone ? 'done'
      : activeIndex < 0 ? 'todo'
      : i < activeIndex ? 'done'
      : i === activeIndex ? 'active'
      : 'todo',
  }))
}

/**
 * Extra reassurance for the two steps that can take minutes on a fresh host.
 * Returned only for those: a note on every phase becomes wallpaper.
 */
export function connectPhaseNote(phase: DaemonConnectPhase, hostLabel: string): string | undefined {
  if (phase !== 'install-runtime' && phase !== 'upload') return undefined
  return `First connect installs the session daemon on ${hostLabel}; this can take a minute or two.`
}

export type HostConnectErrorKind =
  | 'auth'
  | 'host_key'
  | 'cert_expired'
  | 'agent_missing'
  // The SSH proxy (ProxyCommand) answered that ITS login expired: a login fixes it, not a retry.
  | 'proxy_login'
  | 'proxy'
  | 'shell_noise'
  | 'dns'
  | 'unreachable'
  | 'refused'
  | 'timeout'
  | 'runtime'
  | 'daemon'
  | 'ephemeral'
  | 'listing'
  | 'unknown'

export interface HostConnectHint {
  kind: HostConnectErrorKind
  /** One sentence telling the user what to do next. */
  hint: string
  /**
   * The same attempt can succeed later with nothing changed on this machine or
   * the host (a network blip, a proxy that dropped the link, a daemon still
   * booting). False means a person has to act first; for the credential kinds
   * the warmup still re-dials on its own (CREDENTIAL_WAIT_KINDS), so a login
   * done outside Walnut reconnects without a click.
   */
  retryable: boolean
}

/** Failures a person fixes OUTSIDE Walnut (a login command, an agent): re-dialled on a schedule. */
export const CREDENTIAL_WAIT_KINDS: ReadonlySet<HostConnectErrorKind> = new Set<HostConnectErrorKind>(['cert_expired', 'agent_missing', 'proxy_login'])

/**
 * 1, 2, 5 minutes, then every 5. A login Walnut can see (a file it watches, the
 * agent) redials within seconds (core/hosts/host-credential-signal.ts); this
 * clock bounds the wait after one it cannot see. It used to go hourly after 10
 * minutes, which left a host dark for up to an hour after the login (2026-09-26:
 * 412 of a 413-minute outage was spent waiting). Twelve dials an hour per host
 * is still far from the 30s loop that once hammered hosts for a night.
 */
const CREDENTIAL_RETRY_STEPS_MS = [1, 2, 5].map((m) => m * 60_000)
const CREDENTIAL_RETRY_CAP_MS = 5 * 60_000

/** Delay before credential re-dial number `attempt` (0-based). */
export function credentialRetryDelayMs(attempt: number): number {
  return CREDENTIAL_RETRY_STEPS_MS[Math.max(0, Math.floor(attempt))] ?? CREDENTIAL_RETRY_CAP_MS
}

/** Whether a plain retry of the same attempt can succeed, per kind (the API's `retryable`). */
export const RETRYABLE: Record<HostConnectErrorKind, boolean> = {
  auth: false, host_key: false, cert_expired: false, agent_missing: false, proxy_login: false, proxy: true, shell_noise: false,
  dns: false, unreachable: true, refused: true, timeout: true, runtime: false, daemon: true,
  ephemeral: false, listing: true, unknown: true,
}

/**
 * Extra facts about the target the hints quote back. The prose calls the host
 * by its `label` (the name every surface shows; the hostname when there is
 * none); `user@host` appears only inside a `backticked` command. The
 * known_hosts key needs the bare hostname and port.
 */
export interface HostConnectTarget {
  label?: string
  hostname?: string
  port?: number
  user?: string
}

/** The bare hostname inside an ssh target ("-p 2222 alice@devbox" -> "devbox"). */
function bareHostOf(sshTarget: string): string {
  const last = sshTarget.trim().split(/\s+/).pop() ?? ''
  return last.replace(/^[^@]*@/, '')
}

/** What the prose calls the host: its label, else its hostname. Never `user@host`. */
export function hintSubject(sshTarget: string, target: HostConnectTarget = {}): string {
  return target.label?.trim() || target.hostname?.trim() || bareHostOf(sshTarget) || sshTarget
}

/**
 * The `ssh-keygen -R` argument for a host: known_hosts stores a non-default
 * port as `[host]:port`, and removing the bare name would leave that entry.
 */
function knownHostsName(sshTarget: string, target: HostConnectTarget): string {
  const host = target.hostname || bareHostOf(sshTarget)
  return target.port && target.port !== 22 ? `'[${host}]:${target.port}'` : host
}

/** The next step for a kind. Exported so a surface holding only the kind can still say it. */
export function hintForKind(kind: HostConnectErrorKind, sshTarget: string, target: HostConnectTarget = {}): string {
  const who = hintSubject(sshTarget, target)
  const hostname = target.hostname?.trim() || bareHostOf(sshTarget) || sshTarget
  switch (kind) {
    case 'ephemeral': return 'This is a throwaway test server: it stays off shared remote hosts and never installs a daemon there. Use the main Walnut server for remote hosts, or start the test server with WALNUT_EPHEMERAL_REMOTE_HOSTS=1 to attach.'
    case 'shell_noise': return `SSH works, but the login shell on ${who} did not run Walnut's command as written (a ForceCommand, or a login shell that is not a shell). Check that \`ssh ${sshTarget} sh -c 'echo ok'\` prints just ok, then Retry.`
    case 'host_key': return `The host key of ${who} changed since this machine last saw it. If the host was rebuilt, run \`ssh-keygen -R ${knownHostsName(sshTarget, target)}\` and then \`ssh ${sshTarget}\` once to accept the new key; if nothing changed on the host, stop: a changed key can also mean someone is intercepting the connection.`
    case 'cert_expired': return 'Your SSH certificate expired; run your organization\'s login command, then Retry.'
    case 'agent_missing': return 'Walnut could not reach an SSH agent holding your key (no agent running, or no key loaded). Start your agent or run your organization\'s login command, then Retry.'
    case 'proxy_login': return `SSH to ${who} goes through a proxy (ProxyCommand), and the proxy says its own login expired. Run your organization's login command, then Retry.`
    case 'proxy': return `SSH to ${who} goes through a proxy or jump host (ProxyCommand / ProxyJump), and it closed the connection. Check that \`ssh ${sshTarget}\` works in a terminal (VPN, the jump host, or the proxy's own login), then Retry.`
    case 'auth': return `Walnut runs \`ssh ${sshTarget}\` without a password prompt. Make sure that command works from this machine on its own (an SSH key or ssh-agent, and any VPN or auth step your host needs), then Retry.`
    case 'dns': return `The hostname "${hostname}" does not resolve from this machine. Check the hostname in Settings › Remote Hosts (or your VPN / SSH config).`
    case 'refused': return `Nothing is listening for SSH on ${who}. Check the port and that sshd is running on the host.`
    case 'unreachable': return `${who} is not reachable from this machine right now (VPN down, host asleep, or a firewall). Retry once the network is back.`
    case 'timeout': return `Connecting to ${who} took too long. The host may be unreachable (VPN?), or a first-time daemon install is still running; Retry in a moment.`
    case 'runtime': return 'The session daemon needs bun or node on the host, and neither could run there. Install one (`curl -fsSL https://bun.sh/install | bash`, or Node.js from your package manager), then Retry.'
    case 'daemon': return 'SSH works but the session daemon did not come up. Retry; if it keeps failing, check daemon-start.log in the daemon directory on the host (/tmp/open-walnut, or ~/.cache/open-walnut when /tmp is unusable).'
    case 'listing': return `${who} is connected, but this directory could not be listed. Check that the path exists and is readable there, then Retry.`
    case 'unknown':
    default:
      return `Retry, and if it keeps failing run \`ssh ${sshTarget}\` from a terminal to see what SSH itself says.`
  }
}

/**
 * Sentences Walnut writes itself, checked FIRST and on the text as written.
 * The host's names are blanked out before the ssh patterns below run, and that
 * would corrupt these: a name can be one of their words (a host called `server`
 * turned "ephemeral server" into "ephemeral"). Their detail can also quote
 * words the ssh patterns would misread (shell_noise quotes what the login shell
 * printed). Global flag: every occurrence is checked against the name spans.
 */
const WALNUT_SENTENCES: Array<[HostConnectErrorKind, RegExp]> = [
  // providers/daemon-connection.ts (a test server) and providers/remote-sh.ts
  ['ephemeral', /ephemeral server|attach-only/g],
  ['shell_noise', /shell_noise:/g],
]

/**
 * Evidence in ssh and daemon output, MOST SPECIFIC FIRST: ssh output often
 * carries several of these words at once (a changed host key prints its
 * warning and then "Permission denied"; a proxy failure says "Connection
 * closed"). The `walnut-ssh-evidence:` tags come from
 * providers/ssh-credential-evidence.ts, which asks this machine's agent why ssh
 * only said "Permission denied".
 */
const PATTERNS: Array<[HostConnectErrorKind, RegExp]> = [
  ['host_key', /remote host identification has changed|host key verification failed|host key for \S+ has changed|you have requested strict checking|offending \S+ key in|disabled to avoid man-in-the-middle/],
  ['cert_expired', /walnut-ssh-evidence: cert-expired|certificate (has )?expired|expired certificate|certificate invalid: expired/],
  ['agent_missing', /walnut-ssh-evidence: agent-(missing|empty)|could not open a connection to your authentication agent|error connecting to agent|ssh_auth_sock is not set/],
  // A proxy that says its sign-in is invalid or expired (a cookie, a token, a session).
  // Before 'proxy': the same failure also prints "Connection closed by UNKNOWN port 65535".
  ['proxy_login', /walnut-ssh-evidence: proxy-login|proxy[\s\S]{0,300}?\b(cookie|token|login|session|credential)s?\b[^\n]{0,40}?\b(invalid|expired)\b/],
  ['proxy', /kex_exchange_identification|ssh_exchange_identification|connection closed by unknown port 65535|proxycommand|proxyjump|proxy (connect|error|failed)|stdio forwarding failed|jump host/],
  // ssh's own refusal shapes only: a bare "permission denied" is also what an
  // EACCES in a daemon start log says, and that is not a key problem.
  ['auth', /permission denied \([a-z0-9@.,-]+\)|too many authentication failures|no supported authentication methods|unprotected private key file/],
  ['dns', /could not resolve hostname|name or service not known|nodename nor servname|no address associated|temporary failure in name resolution/],
  ['refused', /connection refused/],
  ['unreachable', /no route to host|network is unreachable|connection reset|broken pipe|connection closed by/],
  ['timeout', /timed out|timeout|etimedout/],
  ['runtime', /bun|node|runtime|glibc|command not found|exec format error|illegal instruction/],
  ['daemon', /daemon|handshake|capabilit|hello|tunnel|websocket/],
]

/**
 * The tag summarizeConnectFailure adds when ssh output says the proxy's login
 * expired: the proxy's own sentence runs past the 160-character summary, and a
 * summary cut before "cookie is invalid" read as a plain proxy failure, so every
 * fail-fast re-throw put the host back on the fast transient retry.
 */
export const PROXY_LOGIN_EVIDENCE = 'walnut-ssh-evidence: proxy-login (the SSH proxy says its own login is invalid or expired)'

/**
 * Map a connect failure (the one-line summary from summarizeConnectFailure, or a
 * raw ssh/daemon error) to a kind, a next step and whether a plain retry can
 * work.
 *
 * `hostNames` are the user's own words for the host (alias, label, hostname,
 * user): the failure text embeds them ("Connection to nodedev failed …"), and a
 * name like `nodedev` or `bun-box` must not read as a runtime problem, so the
 * ssh patterns read the text with every name blanked out. Walnut's own
 * sentences are read before that, on the text as written; there a name only
 * disqualifies an occurrence that lies wholly inside it (a host labelled
 * "Ephemeral server" is still just a host). The echoed ssh command line is
 * dropped too: Walnut's own `-o StrictHostKeyChecking=no` must never read as a
 * host key problem.
 */
export function classifyHostConnectError(
  message: string,
  sshTarget: string,
  hostNames: readonly string[] = [],
  target: HostConnectTarget = {},
): HostConnectHint {
  const text = message.toLowerCase()
    .split('\n').filter((line) => !line.trim().startsWith('command failed:')).join('\n')
    .replace(/(^|\s)-o\s*\S+/g, ' ')
  const names = hostNames.map((name) => name.trim().toLowerCase()).filter(Boolean).map(nameToken)
  const spans = names.flatMap((re) => [...text.matchAll(re)].map((hit): [number, number] => [hit.index, hit.index + hit[0].length]))
  const said = (re: RegExp) => [...text.matchAll(re)].some((hit) => {
    const start = hit.index
    const end = start + hit[0].length
    return !spans.some(([s, e]) => s <= start && end <= e)
  })
  let kind = WALNUT_SENTENCES.find(([, re]) => said(re))?.[0]
  if (!kind) {
    const blanked = names.reduce((m, re) => m.replace(re, ' '), text)
    kind = PATTERNS.find(([, re]) => re.test(blanked))?.[0] ?? 'unknown'
  }
  return { kind, hint: hintForKind(kind, sshTarget, target), retryable: RETRYABLE[kind] }
}

/** A host name as a whole token: a user named `me` must not punch a hole in "permission". */
function nameToken(lowerName: string): RegExp {
  const escaped = lowerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![a-z0-9_.-])${escaped}(?![a-z0-9_-])`, 'g')
}

/**
 * The host IS connected; listing the directory itself failed (EACCES, a daemon
 * RPC error). Not an SSH problem, so none of the connect hints apply: an
 * "EACCES: permission denied" here used to be read as an SSH key problem.
 */
export function describeListingError(hostLabel: string): HostConnectHint {
  return { kind: 'listing', hint: hintForKind('listing', hostLabel, { label: hostLabel }), retryable: RETRYABLE.listing }
}
