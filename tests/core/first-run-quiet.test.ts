/**
 * What a brand-new user sees on the first screen of the Walnut Demo, server side (2026-11-10
 * review, U01: "How to update", "0.6.30 available / No package manager found", "Data Backup: Not
 * protected", a Demo host's "No C compiler ... Could not install gcc automatically (isolated)" and
 * "Walnut won't restart on <host> after it reboots"). The Demo is a throwaway copy of the Walnut
 * it was started from: it offers no update, keeps no backup, opens no remote terminal and never
 * sets a host up to start after a reboot, so none of those is a problem to show there.
 */
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-first-run-quiet'))
const backup = vi.hoisted(() => ({ health: { protected: false, consecutiveFailures: 0 } as Record<string, unknown> }))
vi.mock('../../src/web/server.js', () => ({ getGitAutoCommitHealth: () => backup.health }))

import { disabledReason, DEFAULT_REGISTRY_URL, isDemoEnv } from '../../src/core/self-update/update-check.js'
import { readinessProblems, parsePreflight } from '../../src/core/hosts/host-readiness-problems.js'
import { nextFixAction } from '../../src/core/hosts/host-autofix.js'
import { longRunningReasons } from '../../src/core/hosts/fleet-model.js'
import { currentSystemFailure } from '../../src/core/self-repair/host-fix-record.js'

const NPM = { kind: 'npm' as const, sourceDir: null, packageRoot: '/usr/lib/node_modules/open-walnut', manager: 'npm' as const, updateCommand: 'npm install -g open-walnut@latest' }
const SOURCE = { kind: 'source' as const, sourceDir: '/w/open-walnut', packageRoot: '/w/open-walnut', manager: null, updateCommand: null }
const DEMO_ENV = { WALNUT_DEMO_ROOT: '/u/.local/share/open-walnut-demo', WALNUT_DEMO_GENERATION: 'gen-1' }
const src = (rel: string) => fs.readFileSync(path.join(__dirname, '../../src', rel), 'utf8')

describe('the Demo offers no update of itself', () => {
  it('its update check is off with its own reason, whatever the install kind', () => {
    expect(isDemoEnv(DEMO_ENV)).toBe(true)
    expect(isDemoEnv({ WALNUT_DEMO_ROOT: '/x' })).toBe(false)
    expect(disabledReason(NPM, DEMO_ENV, true, DEFAULT_REGISTRY_URL)).toBe('demo')
    expect(disabledReason(SOURCE, DEMO_ENV, true, DEFAULT_REGISTRY_URL)).toBe('demo')
    // A normal install still checks (a stub registry, so the test guard does not answer first).
    expect(disabledReason(NPM, {}, true, 'http://127.0.0.1:1/registry')).toBeNull()
  })

  it('guard: every reason the check can be off for has its own words on the card and in diagnostics', () => {
    const union = /export type UpdateCheckDisabledReason = ([^\n]+)/.exec(src('core/self-update/update-check.ts'))![1]!
    const reasons = [...union.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!)
    expect(reasons).toContain('demo')
    const web = /export type UpdateCheckDisabledReason = ([^\n]+)/.exec(fs.readFileSync(path.join(__dirname, '../../web/src/api/update.ts'), 'utf8'))![1]!
    expect([...web.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!).sort()).toEqual([...reasons].sort())
    const card = fs.readFileSync(path.join(__dirname, '../../web/src/components/common/update-card-view.ts'), 'utf8')
    const diag = src('core/diagnostics/render.ts')
    // 'test' never reaches a person (vitest only).
    for (const r of reasons.filter((x) => x !== 'test')) {
      expect(diag, `diagnostics has no words for ${r}`).toContain(`case '${r}':`)
      if (r !== 'unknown-version') expect(card, `the update card has no words for ${r}`).toContain(`case '${r}':`)
    }
  })
})

describe('a feature the Demo turns off is no problem on its hosts', () => {
  const noCompiler = parsePreflight({
    ok: true, platform: 'linux',
    claude: { found: true, path: '/home/dev/.local/bin/claude', kind: 'native', needsNode: false, version: '2.1.280' },
    compiler: { found: false }, dtach: { found: false },
  })!

  it('no remote terminals: no dtach or compiler line, and no fix tries to build one', () => {
    expect(readinessProblems(noCompiler, { hostLabel: 'devbox' }).map((p) => p.kind)).toEqual(['compiler_missing'])
    expect(readinessProblems(noCompiler, { hostLabel: 'devbox', terminals: false })).toEqual([])
    expect(readinessProblems(noCompiler, { hostLabel: 'devbox', prebuiltDtach: true, terminals: false })).toEqual([])
    expect(nextFixAction(noCompiler, new Set())).toBe('install-compiler')
    expect(nextFixAction(noCompiler, new Set(), { terminals: false })).toBeNull()
    // Claude Code itself is still fixed there.
    const noClaude = parsePreflight({ ok: true, platform: 'linux', claude: { found: false }, compiler: { found: false }, dtach: { found: false } })!
    expect(nextFixAction(noClaude, new Set(), { agents: true, terminals: false })).toBe('install-claude-native')
    expect(readinessProblems(noClaude, { terminals: false }).length).toBeGreaterThan(0)
  })

  it('a throwaway daemon (a test server\'s, the Demo\'s) is never said to miss a reboot start', () => {
    const base = {
      local: false, connection: { kind: 'ssh-tunnel', connected: true } as never, server: null, history: null, system: null,
    }
    const daemon = { version: 'v', startedAt: 0, startup: 'on-demand', startsAfterReboot: false, runtime: 'bun', vitals: true }
    expect(longRunningReasons({ ...base, daemon } as never).some((r) => /after a reboot/.test(r))).toBe(true)
    expect(longRunningReasons({ ...base, daemon: { ...daemon, throwaway: true } } as never).some((r) => /after a reboot/.test(r))).toBe(false)
  })

  it('guard: the fleet marks every remote daemon of a throwaway server, and readiness reads the Demo rule by default', () => {
    expect(src('core/hosts/fleet.ts')).toMatch(/IS_EPHEMERAL && !e\.local \? \{ throwaway: true \}/)
    expect(src('core/hosts/remote-terminals-here.ts')).toMatch(/REMOTE_TERMINALS_HERE = !IS_DEMO/)
    // The Demo really opens no remote terminal: the rule above holds only while spawn refuses one.
    expect(src('web/terminal/spawn.ts')).toMatch(/if \(IS_DEMO && \(!persistent \|\| record\.host && record\.host !== '__local__'\)\)/)
  })
})

describe('no backup is no problem where none runs by design', () => {
  it('the backup fix has nothing to do on a server that keeps no backup', async () => {
    backup.health = { protected: false, consecutiveFailures: 0, off: 'demo' }
    expect(await currentSystemFailure('backup')).toBeNull()
    backup.health = { protected: false, consecutiveFailures: 0, error: 'git unavailable' }
    expect(await currentSystemFailure('backup')).not.toBeNull()
  })

  it('guard: the server names why no backup runs instead of reporting "not started"', () => {
    const server = src('web/server.ts')
    expect(server).toMatch(/if \(IS_DEMO\) return 'demo'/)
    expect(server).toMatch(/if \(IS_EPHEMERAL\) return 'test'/)
    expect(server).toMatch(/const off = gitBackupOff\(\)/)
  })
})
