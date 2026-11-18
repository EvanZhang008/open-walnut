/**
 * Terminal mode decision. A terminal is PERSISTENT when its shell runs under
 * dtach on the target host (it survives ssh drops and server restarts), and a
 * PLAIN, non-persistent shell otherwise. "Checking" dtach IS provisioning:
 * dtach isn't in every dev host's package repos, so resolving it may compile
 * the embedded source (see dtach-provision.ts).
 *
 * Failure policy, and WHY it changed:
 *   - no_compiler / build_failed: open a plain shell anyway, loudly labelled.
 *     The old rule ("never a silent state-losing shell") refused to open at all,
 *     so a host without gcc had NO terminal. The rule's intent was "never
 *     SILENTLY lose state"; a shell the UI badges as "Not persistent", with an
 *     inline notice naming the fix and a Retry that upgrades it, keeps that
 *     intent without leaving the user stranded.
 *   - ssh_failed: blocking card that names ssh and shows its stderr. Nothing
 *     ran on the host, so any compiler advice would be a guess (the old code
 *     told users with a broken ssh key to install gcc), and a plain shell would
 *     fail the same way.
 */

import type { SessionRecord } from '../../core/types.js'
import { resolveLocalDtach, resolveRemoteDtach, type DtachResolution, type HostOs } from './dtach-provision.js'
import { toHostOs } from './dtach-probe-script.js'
import { log } from '../../logging/index.js'
import { compilerInstallCommands, XCODE_TOOLS } from '../../core/hosts/compiler-install.js'

export type PlainReason = 'no_compiler' | 'build_failed'

/** How an open terminal runs; returned to the UI on every terminal:open. */
export type TerminalMode =
  | { persistent: true }
  | {
      persistent: false
      reason: PlainReason
      host?: string
      /** Full sentence for tooltips: what is missing and how to fix it. */
      installHint: string
      /** Just the command, so Copy copies something runnable. */
      installCommand: string
      /** Compiler stderr tail for build_failed. */
      detail?: string
    }

export interface SshFailedResult {
  ok: false
  code: 'SSH_FAILED'
  host: string
  detail: string
  hint: string
}

export type TerminalModeDecision = { ok: true; mode: TerminalMode } | SshFailedResult

/**
 * Fix command (what Copy copies) and the alternatives the tooltip lists, by the
 * TARGET's OS (`uname -s` from the probe; process.platform locally) and its package
 * manager (core/hosts/compiler-install.ts). A Mac's /usr/bin/cc is a stub until the
 * Command Line Tools exist, so package-manager advice there would be wrong. With the
 * OS unknown, the hint lists the Linux ones and the Mac's.
 */
function fixFor(os: HostOs, packageManager?: string): { command: string; alternatives: string[] } {
  const [command, ...alternatives] = compilerInstallCommands({ platform: os === 'darwin' ? 'darwin' : 'linux', packageManager })
  return { command, alternatives: os === 'unknown' ? [...alternatives, `${XCODE_TOOLS} on macOS`] : alternatives }
}

function plainMode(reason: PlainReason, host: string | undefined, os: HostOs, detail?: string, packageManager?: string): TerminalMode {
  const where = host ?? 'this machine'
  const { command, alternatives } = fixFor(os, packageManager)
  const alt = alternatives.length ? ` (or ${alternatives.join(', or ')})` : ''
  const installHint = reason === 'no_compiler'
    ? `No C compiler on ${where}, so Walnut can't build dtach and this shell won't survive a disconnect. Install one with ${command}${alt}, then Retry.`
    : `dtach failed to build on ${where} (usually missing development headers), so this shell won't survive a disconnect. Install them with ${command}${alt}, then Retry.`
  return { persistent: false, reason, host, installHint, installCommand: command, ...(detail ? { detail } : {}) }
}

function sshFailed(host: string, r: Extract<DtachResolution, { kind: 'ssh_failed' }>, via: 'ssh' | 'link'): SshFailedResult {
  // A host with no SSH route ran nothing because its daemon link could not: never an ssh hint.
  const hint = via === 'link'
    ? `Walnut couldn't run a command on ${host} through its connection. Check that ${host} is on and connected (Settings > Remote Hosts), then Retry.`
    : `Walnut couldn't run a command on ${host} over ssh${r.exitCode >= 0 ? ` (exit ${r.exitCode})` : ''}. Check that \`ssh ${host}\` works from this machine without a prompt (key loaded, VPN connected, host reachable), then Retry.`
  return { ok: false, code: 'SSH_FAILED', host, detail: r.stderr, hint }
}

/** Map a dtach resolution to a terminal mode (pure; exported for tests). `via`: how the host is reached. */
export function decideTerminalMode(r: DtachResolution, host?: string, via: 'ssh' | 'link' = 'ssh'): TerminalModeDecision {
  switch (r.kind) {
    case 'ok': return { ok: true, mode: { persistent: true } }
    case 'no_compiler': return { ok: true, mode: plainMode('no_compiler', host, r.os, undefined, r.packageManager) }
    case 'build_failed': return { ok: true, mode: plainMode('build_failed', host, r.os, r.stderr || undefined, r.packageManager) }
    case 'ssh_failed':
      // Locally there is no ssh; treat an unexpected local failure as a build failure.
      return host
        ? sshFailed(host, r, via)
        : { ok: true, mode: plainMode('build_failed', host, toHostOs(process.platform), r.stderr || undefined) }
  }
}

/**
 * How a terminal reaches `host` (spawn.ts resolveTerminalRoute's kind), and the
 * refusal when it cannot now: a host reached over its daemon link whose connected
 * daemon has no terminal streams ('pty-stream-v1': an older build, or one on Node).
 * Its session panel shows no Terminal tab; this answers an older window or an API
 * caller, in the daemon's words, never "check that `ssh <host>` works".
 */
async function terminalWay(host: string): Promise<{ via: 'ssh' | 'link'; refused: SshFailedResult | null }> {
  const [{ getConfig }, { terminalRouteKind, hostTerminalNow }, { getDaemonConnectState }] = await Promise.all([
    import('../../core/config-manager.js'), import('../../core/hosts/host-status.js'), import('../../providers/daemon-connection.js'),
  ])
  let def: Parameters<typeof hostTerminalNow>[0] | undefined
  try { def = (await getConfig()).hosts?.[host] } catch { return { via: 'ssh', refused: null } }
  if (!def) return { via: 'ssh', refused: null }
  const via = terminalRouteKind(def)
  const label = def.label ?? host
  const now = hostTerminalNow(def, getDaemonConnectState(host), label)
  if (now === true) return { via, refused: null }
  return { via, refused: { ok: false, code: 'SSH_FAILED', host, detail: now, hint: `${now}. Files and Changes still work meanwhile.` } }
}

/**
 * Probe (= provision) dtach for a session and decide how its terminal runs.
 * `fresh` (the UI's Retry) re-probes even when a failure was cached moments ago.
 */
export async function probeTerminalMode(record: SessionRecord, opts: { fresh?: boolean } = {}): Promise<TerminalModeDecision> {
  const host = record.host && record.host !== '__local__' ? record.host : undefined
  const way = host ? await terminalWay(host) : { via: 'ssh' as const, refused: null }
  if (way.refused) return way.refused
  const r = host ? await resolveRemoteDtach(host, opts) : await resolveLocalDtach(opts)
  const decision = decideTerminalMode(r, host, way.via)
  if (r.kind !== 'ok') {
    log.web.warn('terminal dtach probe failed', {
      sessionId: record.claudeSessionId,
      host: record.host,
      kind: r.kind,
      outcome: decision.ok ? 'plain-shell' : 'ssh-failed',
      detail: 'stderr' in r ? r.stderr.slice(-300) : undefined,
    })
  }
  return decision
}
