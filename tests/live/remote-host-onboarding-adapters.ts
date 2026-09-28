/**
 * Adapters for tests/live/remote-host-onboarding.live.test.ts: the product
 * contracts that other changes were landing while that test was written. Each
 * reads the product in ONE place, so flipping to the final shape is an edit here
 * and nowhere else. Delete a legacy branch as soon as its change is committed: a
 * legacy branch left in place would let the old failure pass again.
 *
 * Not a test file (no `.test.ts`), so no tier collects it on its own.
 */
import { expect } from 'vitest'
import type { SessionRecord } from '../../src/core/types.js'

export interface TerminalView { ok: boolean; persistent?: boolean; reason?: string; code?: string; hint: string; sshReached: boolean }

/**
 * TODO(terminal-fallback): once the no-compiler fallback in src/web/terminal/* is
 * committed, delete the `probeDtach` branch. Final terminal:open shape on this host:
 * `{ ok: true, persistent: false, reason: 'no_compiler' }` (ssh trouble would be
 * `{ ok: false, code: 'SSH_FAILED' }`). probeTerminalMode is the decision terminal:open
 * returns verbatim (ok:false) or spreads into its payload (ok:true); see register.ts.
 */
export async function probeTerminal(host: string, legacySshReached: () => boolean): Promise<TerminalView> {
  const mod = await import('../../src/web/terminal/dtach-check.js') as Record<string, unknown>
  const record = { host, claudeSessionId: 'remote-onboarding-terminal' } as unknown as SessionRecord
  if (typeof mod.probeTerminalMode === 'function') {
    const probe = mod.probeTerminalMode as (r: SessionRecord, o: { fresh: boolean }) => Promise<Record<string, any>>
    const d = await probe(record, { fresh: true })
    if (!d.ok) return { ok: false, code: d.code, hint: String(d.hint ?? d.detail ?? ''), sshReached: d.code !== 'SSH_FAILED' }
    return { ok: true, persistent: d.mode.persistent, reason: d.mode.reason, hint: String(d.mode.installHint ?? ''), sshReached: true }
  }
  // Legacy: NO_DTACH covered both "ssh failed" and "no compiler", so the ssh half
  // is proven separately: the probe's own ControlMaster must be up afterwards.
  const legacy = await (mod.probeDtach as (r: SessionRecord) => Promise<Record<string, any>>)(record)
  return { ok: legacy.ok, code: legacy.code, hint: String(legacy.installHint ?? ''), sshReached: legacySshReached() }
}

/**
 * The prebuilt dtach the SERVER would ship to this box (dist/daemon-binaries/
 * dtach-linux-<x64|arm64>), or null. `npm run build:daemon` writes one only on a
 * Linux machine with a compiler, so the amd64 CI runner has dtach-linux-x64 and
 * a Mac has none for an arm64 container. Asks the server's own lookup
 * (src/web/terminal/dtach-prebuilt.ts), never a copy of its naming rule.
 */
export async function serverPrebuiltDtach(unameMachine: string): Promise<string | null> {
  const { findPrebuiltDtach } = await import('../../src/web/terminal/dtach-prebuilt.js')
  return findPrebuiltDtach('Linux', unameMachine)
}

/**
 * Step c, two branches. With a prebuilt for the box, the terminal uploads it and
 * runs persistent although the box has no compiler (source 'prebuilt'); without
 * one it is the plain shell that names the missing compiler. Never an ssh failure.
 */
export function expectTerminalOnHost(v: TerminalView, prebuilt: string | null): void {
  expect(v.code, `terminal reported an ssh failure: ${v.hint}`).not.toBe('SSH_FAILED')
  expect(v.sshReached, 'the terminal probe never reached the host over ssh').toBe(true)
  if (prebuilt) {
    expect(v, `the server ships ${prebuilt}, so the terminal should install it and stay persistent`)
      .toMatchObject({ ok: true, persistent: true })
    expect(v.reason).toBeUndefined()
    return
  }
  if (v.persistent !== undefined || v.reason !== undefined) {
    expect(v).toMatchObject({ ok: true, persistent: false, reason: 'no_compiler' })
  } else {
    // TODO(terminal-fallback): legacy blocking card; delete with the probeDtach branch.
    expect(v).toMatchObject({ ok: false, code: 'NO_DTACH' })
  }
  expect(v.hint).toMatch(/gcc/)
}

export type SpawnOutcome =
  | { kind: 'refused'; text: string }              // start rejected, no process ran
  | { kind: 'exited'; code: number; text: string } // a process ran and died
  | { kind: 'running' }                            // neither in the window: a real claude?

/**
 * TODO(claude-node): the spawn gate (src/providers/host-runtime-core.ts, capability
 * preflight-v1) refuses to start the npm build on a host without node, with
 * HOST_RUNTIME_MESSAGES.claudeNeedsNode. Once committed, delete the legacy branch,
 * so a daemon that spawns the npm build into a Node-less host fails this test.
 */
export function expectSpawnNamesNodeAndNativeInstall(o: SpawnOutcome, gated: boolean): void {
  if (gated) {
    expect(o.kind, `expected the start to be refused, got ${JSON.stringify(o)}`).toBe('refused')
    const text = (o as { text: string }).text
    expect(text).toMatch(/Node\.js/)
    // The sentence names the fix; the install command itself rides the readiness
    // problem's `commands` (host-readiness-problems.ts), never the sentence.
    expect(text).toMatch(/native build/)
    return
  }
  // Legacy: the daemon spawns the npm build, the kernel cannot find node, env exits
  // 127. ClaudeCodeSession renders this as "Process exited with code 127 before
  // initialization" (or "Claude CLI not found on remote host" after an init).
  expect(o, JSON.stringify(o)).toMatchObject({ kind: 'exited', code: 127 })
  expect((o as { text: string }).text).toMatch(/env: .node.: No such file or directory/)
}

export interface FixView { id: string; ok: boolean; needsPassword?: boolean; raw: string }

/**
 * The fixes step f expects, in order. A compiler matters only while dtach is
 * missing (readinessProblems, nextFixAction in src/core/hosts/): once step c
 * installed the prebuilt, Walnut tries neither gcc (so no sudo prompt) nor
 * build-dtach. A host whose terminal never ran would see build-dtach instead.
 */
export function wantedFixes(dtachInstalled: boolean): string[] {
  return dtachInstalled ? ['install-claude-native'] : ['install-claude-native', 'install-compiler']
}

/**
 * TODO(host-autofix): `host.fix` (capability hostfix-v1) is landing in another
 * change (src/core/hosts/host-autofix.ts). Its contract, read in this ONE place:
 * after a preflight with problems the server runs host.fix and appends a
 * HostFixRecord per fix to the host's readiness (getHostReadiness) as `fixes`:
 * `action` ('install-claude-native', 'install-compiler', 'build-dtach'), `ok`,
 * and `needsPassword` for a sudo step. WALNUT_HOST_AUTOFIX is read per call
 * (autofixDisabledReason). Once committed, drop this TODO; if the server ever
 * triggers fixes from anything other than wireHostReadiness, call that in the
 * live test's reconnectWithAutofix as well.
 */
export function readFixes(readiness: unknown): FixView[] {
  const fixes = (readiness as { fixes?: unknown } | undefined)?.fixes
  return (Array.isArray(fixes) ? fixes : []).map((raw) => {
    const f = (raw ?? {}) as Record<string, unknown>
    return {
      id: String(f.action ?? ''),
      ok: f.ok === true,
      ...(typeof f.needsPassword === 'boolean' ? { needsPassword: f.needsPassword } : {}),
      raw: JSON.stringify(f).slice(0, 400),
    }
  })
}
