/**
 * Readiness judged against a model floor with no RPC: C90 (the configured
 * model changes -> every stored answer is reworded from its cached version and
 * each changed host is notified), C53 (the gate reads the answer for the
 * launch's own model), C52 (the preflight RPC carries the host's shell_setup).
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  clearHostReadiness, hostReadinessForLaunch, hostReadinessForModel, onHostReadinessChange, recomputeHostReadinessFloors, refreshHostReadiness,
  setHostReadinessForTest, setReadinessProbeSkip,
} from '../../../src/core/hosts/host-readiness.js'
import { parsePreflight, readinessProblems } from '../../../src/core/hosts/host-readiness-problems.js'
import type { HostPreflightResult } from '../../../src/providers/host-runtime-core.js'

const pre = (version: string): HostPreflightResult => ({
  claude: { found: true, path: '/home/alice/.local/bin/claude', kind: 'native', needsNode: false, version, auth: 'ok', installMethod: 'native' },
  compiler: { found: true, name: 'gcc' }, dtach: { found: true, path: '/usr/bin/dtach' },
})
const FLOOR = { minVersion: '2.1.280', model: 'Opus 5.5' }

afterEach(() => { clearHostReadiness(); setReadinessProbeSkip(null) })

describe('readiness against a floor', () => {
  it('C90: raising the floor rewords a healthy host with no RPC, and notifies it', async () => {
    setHostReadinessForTest('devbox', pre('2.1.281'), { hostLabel: 'Dev box', sshTarget: 'alice@devbox.example.com', floor: FLOOR })
    setHostReadinessForTest('buildbox', pre('2.1.220'), { hostLabel: 'Build box', floor: FLOOR })
    const seen: string[] = []
    const off = onHostReadinessChange((h) => seen.push(h))
    const changed = await recomputeHostReadinessFloors({ minVersion: '2.1.300', model: 'Opus 5.5' })
    off()
    expect(changed).toEqual(['devbox', 'buildbox'])
    expect(seen).toEqual(['devbox', 'buildbox'])
    const r = hostReadinessForModel('devbox', undefined)!
    expect(r.problems.map((p) => p.kind)).toEqual(['claude_outdated'])
    expect(r.problems[0].message).toBe('Claude Code on Dev box is 2.1.281, but Opus 5.5 needs 2.1.300 or newer.')
    // Same floor again: nothing changes, nobody is notified.
    expect(await recomputeHostReadinessFloors({ minVersion: '2.1.300', model: 'Opus 5.5' })).toEqual([])
  })

  it('C53: the answer for a model with a lower floor has no outdated line; a higher one names that model', () => {
    setHostReadinessForTest('buildbox', pre('2.1.220'), { hostLabel: 'Build box', floor: FLOOR })
    expect(hostReadinessForModel('buildbox', 'claude-sonnet-4-5')!.problems).toEqual([])
    const opus = hostReadinessForModel('buildbox', 'global.anthropic.claude-opus-5-5')!
    expect(opus.problems[0]).toMatchObject({ kind: 'claude_outdated' })
    expect(opus.problems[0].message).toContain('Opus 5.5 needs 2.1.280')
  })

  it('C52: the preflight RPC carries the host shell_setup', async () => {
    const sent: Array<Record<string, unknown>> = []
    const conn = {
      hasCapability: () => true,
      send: async (_cmd: string, params?: Record<string, unknown>) => { sent.push(params ?? {}); return { ok: true, ...pre('2.1.281') } },
    }
    await refreshHostReadiness('buildbox', {
      getConnection: () => conn, force: true, autofix: false, findPrebuilt: async () => null,
      hostContext: async () => ({ label: 'Build box', sshTarget: 'alice@build.example.com', floor: FLOOR, shellSetup: 'export PATH=/opt/claude/bin:$PATH' }),
    })
    expect(sent[0]).toEqual({ minClaudeVersion: '2.1.280', shellSetup: 'export PATH=/opt/claude/bin:$PATH' })
  })

  it('a launch with no model is judged by the CLI default it will run, never by Walnut\'s configured model', () => {
    // Stored against the configured Opus 5.5 floor: the banner says outdated.
    setHostReadinessForTest('buildbox', pre('2.1.220'), { hostLabel: 'Build box', floor: FLOOR })
    expect(hostReadinessForLaunch('buildbox', 'claude-opus-4-6')!.problems).toEqual([])
    expect(hostReadinessForLaunch('buildbox', 'global.anthropic.claude-opus-5-5')!.problems[0]).toMatchObject({ kind: 'claude_outdated' })
    // The CLI default is unknown: no floor at all, so no outdated refusal.
    expect(hostReadinessForLaunch('buildbox', null)!.problems).toEqual([])
    expect(hostReadinessForModel('buildbox', undefined)!.problems.map((p) => p.kind)).toEqual(['claude_outdated'])
  })

  it('a host the fixture owns is never probed over the wire (a MockDaemon has no host.preflight)', async () => {
    setHostReadinessForTest('buildbox', pre('2.1.281'), { hostLabel: 'Build box', floor: FLOOR })
    setReadinessProbeSkip((h) => h === 'buildbox')
    let sent = 0
    const conn = { hasCapability: () => true, send: async () => { sent++; return { ok: false, error: 'unknown command: host.preflight' } } }
    const r = await refreshHostReadiness('buildbox', { getConnection: () => conn, force: true, autofix: false })
    expect(sent).toBe(0)
    expect(r?.checkError).toBeUndefined()
    expect(r?.claude.version).toBe('2.1.281')
  })

  it('an unknown claude answer (the login shell ran out of time) is kept and never reads as not installed', () => {
    const parsed = parsePreflight({ claude: { found: false, unknown: 'the login shell did not answer in time' }, compiler: { found: true }, dtach: { found: true } })!
    expect(parsed.claude).toEqual({ found: false, unknown: 'the login shell did not answer in time' })
    expect(readinessProblems(parsed, { hostLabel: 'Build box' })).toEqual([])
    expect(readinessProblems({ ...parsed, claude: { found: false } }, { hostLabel: 'Build box' }).map((p) => p.kind)).toEqual(['claude_missing'])
  })
})
