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
 * IN_PROGRESS_PHASES this excludes `idle` — "nothing has tried" is not work in
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
 * the list with NOTHING active — they are not a position in the sequence, and
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
}

/**
 * Map a connect failure (the one-line summary from summarizeConnectFailure, or a
 * raw ssh/daemon error) to a next step. Order matters: the more specific
 * patterns come first because ssh text often contains several of these words.
 *
 * `hostNames` are the user's own words for the host (alias, label, hostname,
 * user): the failure text embeds them ("Connection to nodedev failed …"), and a
 * name like `nodedev` or `bun-box` must not read as a runtime problem.
 */
export function classifyHostConnectError(message: string, sshTarget: string, hostNames: readonly string[] = []): HostConnectHint {
  let m = message.toLowerCase()
  for (const name of hostNames) {
    const n = name.trim().toLowerCase()
    if (!n) continue
    // Whole tokens only: a user named `me` must not punch a hole in "permission".
    const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    m = m.replace(new RegExp(`(?<![a-z0-9_.-])${escaped}(?![a-z0-9_-])`, 'g'), ' ')
  }

  if (/ephemeral server|attach-only/.test(m)) {
    return { kind: 'ephemeral', hint: 'This is a throwaway test server: it stays off shared remote hosts and never installs a daemon there. Use the main Walnut server for remote hosts, or start the test server with WALNUT_EPHEMERAL_REMOTE_HOSTS=1 to attach.' }
  }
  if (/permission denied|publickey|authentication failed|too many authentication failures|host key verification failed|no supported authentication/.test(m)) {
    return {
      kind: 'auth',
      hint: `Walnut runs \`ssh ${sshTarget}\` without a password prompt. Make sure that command works from this machine on its own (an SSH key or ssh-agent, and any VPN or auth step your host needs), then retry.`,
    }
  }
  if (/could not resolve hostname|name or service not known|nodename nor servname|no address associated|temporary failure in name resolution/.test(m)) {
    return { kind: 'dns', hint: `The hostname "${sshTarget}" does not resolve from this machine. Check the host's hostname in Settings › Hosts (or your VPN / SSH config).` }
  }
  if (/connection refused/.test(m)) {
    return { kind: 'refused', hint: `Nothing is listening for SSH at ${sshTarget}. Check the port and that sshd is running on the host.` }
  }
  if (/no route to host|network is unreachable|connection reset|broken pipe|connection closed by/.test(m)) {
    return { kind: 'unreachable', hint: `${sshTarget} is not reachable from this machine right now (VPN down, host asleep, or a firewall). Retry once the network is back.` }
  }
  if (/timed out|timeout|etimedout/.test(m)) {
    return { kind: 'timeout', hint: `Connecting to ${sshTarget} took too long. The host may be unreachable (VPN?), or a first-time daemon install is still running; retry in a moment.` }
  }
  if (/bun|node|runtime|glibc|command not found/.test(m)) {
    return { kind: 'runtime', hint: 'The session daemon needs bun or node on the host. Install one there (curl -fsSL https://bun.sh/install | bash) and retry.' }
  }
  if (/daemon|handshake|capabilit|hello|tunnel|websocket/.test(m)) {
    return { kind: 'daemon', hint: 'SSH works but the session daemon did not come up. Retry; if it keeps failing, check the daemon log under /tmp/open-walnut on the host.' }
  }
  return { kind: 'unknown', hint: `Retry, and if it keeps failing run \`ssh ${sshTarget}\` from a terminal to see what SSH itself says.` }
}

/**
 * The host IS connected; listing the directory itself failed (EACCES, a daemon
 * RPC error). Not an SSH problem, so none of the connect hints apply — an
 * "EACCES: permission denied" here used to be read as an SSH key problem.
 */
export function describeListingError(hostLabel: string): HostConnectHint {
  return {
    kind: 'listing',
    hint: `${hostLabel} is connected, but this directory could not be listed. Check that the path exists and is readable there, then retry.`,
  }
}
