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

function sshFailed(host: string, r: Extract<DtachResolution, { kind: 'ssh_failed' }>): SshFailedResult {
  return {
    ok: false,
    code: 'SSH_FAILED',
    host,
    detail: r.stderr,
    hint: `Walnut couldn't run a command on ${host} over ssh${r.exitCode >= 0 ? ` (exit ${r.exitCode})` : ''}. Check that \`ssh ${host}\` works from this machine without a prompt (key loaded, VPN connected, host reachable), then Retry.`,
  }
}

/** Map a dtach resolution to a terminal mode (pure; exported for tests). */
export function decideTerminalMode(r: DtachResolution, host?: string): TerminalModeDecision {
  switch (r.kind) {
    case 'ok': return { ok: true, mode: { persistent: true } }
    case 'no_compiler': return { ok: true, mode: plainMode('no_compiler', host, r.os, undefined, r.packageManager) }
    case 'build_failed': return { ok: true, mode: plainMode('build_failed', host, r.os, r.stderr || undefined, r.packageManager) }
    case 'ssh_failed':
      // Locally there is no ssh; treat an unexpected local failure as a build failure.
      return host
        ? sshFailed(host, r)
        : { ok: true, mode: plainMode('build_failed', host, toHostOs(process.platform), r.stderr || undefined) }
  }
}

/**
 * A host that cannot open a terminal at all (the cloud box: no SSH door, its
 * sessions ride the companion's daemon tunnel) is refused with its own words.
 * Its session panel shows no Terminal tab; this answers an older window or an
 * API caller, which would otherwise hear "check that `ssh __cloudbox__` works".
 */
async function noTerminalOn(host: string): Promise<SshFailedResult | null> {
  const [{ getConfig }, { hostOffersTerminal }] = await Promise.all([
    import('../../core/config-manager.js'), import('../../core/hosts/host-status.js'),
  ])
  let def: Parameters<typeof hostOffersTerminal>[0] | undefined
  try { def = (await getConfig()).hosts?.[host] } catch { return null }
  if (!def || hostOffersTerminal(def)) return null
  const label = def.label ?? host
  return {
    ok: false,
    code: 'SSH_FAILED',
    host,
    detail: `A terminal is not available on ${label}: this Mac reaches it through the cloud companion, not SSH`,
    hint: `${label} runs this session through the cloud companion, which has no SSH, so there is no terminal there. Files and Changes still work.`,
  }
}

/**
 * Probe (= provision) dtach for a session and decide how its terminal runs.
 * `fresh` (the UI's Retry) re-probes even when a failure was cached moments ago.
 */
export async function probeTerminalMode(record: SessionRecord, opts: { fresh?: boolean } = {}): Promise<TerminalModeDecision> {
  const host = record.host && record.host !== '__local__' ? record.host : undefined
  const refused = host ? await noTerminalOn(host) : null
  if (refused) return refused
  const r = host ? await resolveRemoteDtach(host, opts) : await resolveLocalDtach(opts)
  const decision = decideTerminalMode(r, host)
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
