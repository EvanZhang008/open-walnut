/**
 * Which hosts can run the one Walnut service (one-service-mode.ts), by system and by link: the one
 * table every path that puts the walnut file in a daemon slot reads, so a system the service runs on
 * is the same answer on the SSH link (daemon-connection.ts deployWalnutFile, the connect probe's
 * system gate), the host network link (daemon-net-update.ts) and a service set's install
 * (service-set-provision.ts). tests/providers/one-service-targets.test.ts enumerates every walnut
 * file target (host-target.ts HOST_FILE_TARGETS) on every link: a new target or link that cannot
 * reach the service fails there.
 *
 *   Linux (glibc or musl)  every link, always (the service started there).
 *   macOS                  every link, with the experiment macos_one_service on. Off: a host network
 *                          Mac keeps its two programs (the daemon, its follower child), and an SSH
 *                          host must be Linux (the connect says not_linux, as before).
 *
 * Pure but for the flag's reader.
 */
import { experimentalEnabled } from '../core/experimental.js'
import type { HostFileTarget } from '../core/host-server/host-target.js'

/** The links a host's daemon is updated over (daemon-update-paths.ts): each puts the walnut file in the slot its own way. */
export const SERVE_LINKS = ['ssh', 'net'] as const
export type ServeLink = typeof SERVE_LINKS[number]

export interface ServeTargetOpts {
  /** The experiment macos_one_service (macosOneServiceWanted). */
  macos: boolean
}

/** Walnut Health's words for a Mac while the experiment is off. */
export const MACOS_OFF_WHY = 'it is a Mac, and Macs run the one Walnut service only with the experiment "Macs you add as hosts run one Walnut service" on'

/** The system part of a target or a probe's word, lower case: `linux`, `darwin`, or what else it said. */
function systemOf(targetOrOs: string): string {
  const s = targetOrOs.trim().toLowerCase()
  return s.startsWith('linux') ? 'linux' : s.startsWith('darwin') ? 'darwin' : s
}

/**
 * Why the daemon slot over `link` does not take this target's walnut file (so the host is not
 * offered the service), or null when it does. `link` is here for the guard test's sake: both links
 * answer alike today, and a link that ever differs says so in this one place.
 */
export function serveSlotWhy(target: string, link: ServeLink, o: ServeTargetOpts): string | null {
  void link
  const system = systemOf(target)
  if (system === 'linux') return null
  if (system === 'darwin') return o.macos ? null : MACOS_OFF_WHY
  return `the walnut file is not built for ${target}`
}

/**
 * The same answer for a host whose system is known only as a word (a hello's or a probe's
 * `platform`: `linux`, `darwin`): null when the service may be offered there. For the mode
 * decision's system check (one-service-mode.ts wantedNow).
 */
export function servePlatformWhy(platform: string, o: ServeTargetOpts): string | null {
  const system = systemOf(platform)
  if (system === 'linux') return null
  if (system === 'darwin') return o.macos ? null : MACOS_OFF_WHY
  return `it runs ${platform}, and the one Walnut service runs on Linux and macOS hosts only`
}

/**
 * Whether the SSH link sets up a host of this system (`uname -s`, any case): Linux always, macOS
 * with the experiment on. Every other system is refused at the connect (not_linux).
 */
export function sshTakesSystem(os: string, o: ServeTargetOpts): boolean {
  const system = systemOf(os)
  return system === 'linux' || (system === 'darwin' && o.macos)
}

/** The system word of the SSH daemon slot's name (`daemon-<system>-<arch>`): `linux` unless the host is a Mac. */
export function slotSystemOf(os: string | null | undefined): 'linux' | 'darwin' {
  return os && systemOf(os) === 'darwin' ? 'darwin' : 'linux'
}

/** `uname -m` as a slot's arch: arm64 for aarch64 (Linux) and arm64 (macOS), else x64. */
export function slotArchOf(machine: string): 'arm64' | 'x64' {
  const m = machine.trim()
  return m === 'aarch64' || m === 'arm64' ? 'arm64' : 'x64'
}

/**
 * A Mac's slot arch from the same probe the walnut file's target comes from (host-target.ts: an
 * x86_64 shell under Rosetta on Apple silicon is the arm64 Mac it runs on), so the slot and the file
 * in it agree; `uname -m` only when that probe gives no answer.
 */
export async function macSlotArch(run: (command: string, timeoutMs?: number) => Promise<string>, machine: string): Promise<'arm64' | 'x64'> {
  try {
    const { parseHostTarget, targetProbeScript } = await import('../core/host-server/host-target.js')
    const { target } = parseHostTarget(await run(targetProbeScript(), 15_000))
    if (target.startsWith('darwin-')) return target.endsWith('-arm64') ? 'arm64' : 'x64'
  } catch { /* no answer: uname's */ }
  return slotArchOf(machine)
}

/** The daemon slot's file for a walnut file target: `daemon-<system>-<arch>` (a musl file goes in its arch's Linux slot). */
export function daemonSlotName(target: HostFileTarget): string {
  return `daemon-${target.replace(/-musl$/, '')}`
}

/**
 * The experiment macos_one_service, from the config on each call (src/core/experimental.ts).
 * WALNUT_MACOS_ONE_SERVICE=1 or 0 decides for one process (a test, a rehearsal).
 */
export async function macosOneServiceWanted(): Promise<boolean> {
  const forced = process.env.WALNUT_MACOS_ONE_SERVICE
  if (forced === '1' || forced === '0') return forced === '1'
  try {
    const { getConfig } = await import('../core/config-manager.js')
    return experimentalEnabled((await getConfig()).experimental, 'macos_one_service')
  } catch {
    return false
  }
}
