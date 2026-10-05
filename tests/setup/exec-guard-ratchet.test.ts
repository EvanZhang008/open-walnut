/**
 * Exec-guard ratchet: no test opts out of tests/setup/exec-guard.ts by accident.
 *
 * The guard only protects a worker it was loaded into, and only a child whose
 * PATH still leads with its refusing scripts. So:
 *
 *  1. Every vitest config loads it as its FIRST setupFile, directly or through
 *     vitest.config.ts. Exempt, by name: the live tier (it runs the real claude
 *     and ssh on purpose) and infra/ (a separate package of CDK synth tests that
 *     spawn nothing).
 *  2. Only the guard's own files name its variables or consume its hits.
 *  3. A test that hands a child a literal PATH (`PATH: '/usr/bin:/bin'`) drops the
 *     guard for that child, so /usr/bin/ssh is what it runs. The ones that exist
 *     are counted per file (most are fake envs for pure functions); a new one
 *     fails here. Build the PATH with guardedPath([yourFakes], rest) instead.
 *  4. The account's real home (`os.userInfo().homedir`) is what HOME is faked to
 *     hide; only the tests of the production-data guards may read it.
 *
 * The numbers only go down. Raising one needs the reason in the comment beside it.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const GUARD = 'tests/setup/exec-guard.ts'

const EXEMPT_CONFIGS: Record<string, string> = {
  'vitest.live.config.ts': 'the live tier runs the real claude and ssh on purpose',
  'infra/vitest.config.ts': 'CDK synth tests in a separate package; they spawn nothing',
}

/** The guard's own files, the only ones that may name its variables. */
const GUARD_FILES = new Set([
  'tests/setup/exec-guard.ts',
  'tests/setup/exec-guard-core.ts',
  'tests/setup/exec-guard.test.ts',
  'tests/setup/exec-guard-ratchet.test.ts',
])

/** Unit tests of the daemon's PATH rule: the variable appears in a fake env only. */
const GUARD_VAR_UNIT_TESTS = new Set(['tests/providers/host-runtime-core.test.ts'])

/** Literal PATH values handed to code, per file, as of the guard's arrival. */
const LITERAL_PATH_BUDGET: Record<string, number> = {
  'tests/commands/web-session-identity.test.ts': 4,
  'tests/core/cloud-setup/user-data.test.ts': 1,
  'tests/core/diagnostics/fakes.ts': 1,
  'tests/core/diagnostics/local-probes.test.ts': 1,
  'tests/core/diagnostics/redact.test.ts': 1,
  'tests/core/engine-probe.test.ts': 4,
  'tests/core/local-readiness.test.ts': 1,
  'tests/core/plugins/update-status.test.ts': 2,
  'tests/core/stt-spawn-env.test.ts': 1,
  'tests/core/test-claude-guard.test.ts': 2,
  'tests/e2e/browser/session-commit.spec.ts': 1,
  'tests/e2e/remote-session-autorespawn-e2e.test.ts': 1,
  'tests/e2e/session-cron-metadata-wire.test.ts': 1,
  'tests/e2e/session-cron-supervision.test.ts': 1,
  'tests/e2e/session-transport-live.live.test.ts': 1,
  'tests/helpers/daemon-twin.ts': 1,
  'tests/model/providers/adapter-claude-cli.test.ts': 3,
  'tests/providers/acp-session-engine.test.ts': 1,
  'tests/providers/claude-check-core.test.ts': 2,
  'tests/providers/daemon-bounded-reads-twins-e2e.test.ts': 1,
  'tests/providers/daemon-bridge-slow-link-twins-e2e.test.ts': 1,
  'tests/providers/daemon-changes-memo-twins-e2e.test.ts': 1,
  'tests/providers/daemon-connection-service-guard.test.ts': 1,
  'tests/providers/daemon-external-scan-twins-e2e.test.ts': 1,
  'tests/providers/daemon-fallback-dir-twins-e2e.test.ts': 1,
  'tests/providers/daemon-fold-checkpoint-twins-e2e.test.ts': 1,
  'tests/providers/daemon-isolated-exit-reap-twins.test.ts': 1,
  'tests/providers/daemon-link-liveness-twins-e2e.test.ts': 1,
  'tests/providers/daemon-orphan-stop-real-e2e.test.ts': 2,
  'tests/providers/daemon-send-dedupe-twins-e2e.test.ts': 1,
  'tests/providers/daemon-source-fallback-loaders-e2e.test.ts': 1,
  'tests/providers/daemon-spawn-barrier.test.ts': 1,
  'tests/providers/daemon-spawn-gate-e2e.test.ts': 1,
  'tests/providers/daemon-spawn-journal-twins-e2e.test.ts': 1,
  'tests/providers/daemon-start-cmd.test.ts': 2,
  'tests/providers/daemon-workspace-twins-e2e.test.ts': 1,
  'tests/providers/git-commit-core.test.ts': 1,
  'tests/providers/host-fix-core.test.ts': 1,
  'tests/providers/host-runtime-core.test.ts': 22,
  'tests/providers/host-runtime-preflight-shell.test.ts': 5,
  'tests/providers/local-daemon-platform.test.ts': 1,
  'tests/providers/remote-daemon-dir.test.ts': 2,
  'tests/providers/remote-runtime.test.ts': 1,
  'tests/providers/remote-sh.test.ts': 2,
  'tests/providers/system-codex-path.test.ts': 5,
  'tests/scripts/cloud-ensure-harness.test.ts': 4,
  'tests/scripts/dev-prod-launchd-domain.test.ts': 1,
  'tests/scripts/dev-prod-launchd-priority.test.ts': 3,
  'tests/scripts/release-archives.test.ts': 1,
  'tests/setup/live-tier-only.test.ts': 2,
  'tests/unit/ephemeral-snapshot.test.ts': 1,
  'tests/unit/mcp-cli-args.test.ts': 2,
  'tests/unit/peers/walnut-user-shim.test.ts': 1,
  'tests/web/routes/diagnostics.test.ts': 1,
  'tests/web/terminal/dtach-probe-classifier.test.ts': 1,
}

/** May read the account home: they test the guards that keep real data safe. */
const ACCOUNT_HOME_READERS = new Set([
  'tests/core/sessions/ephemeral-guard.test.ts',
  'tests/providers/daemon-ownership-prod-claim.test.ts',
  'tests/setup/exec-guard.test.ts',
])

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|mts|cts|js|mjs|cjs|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}

const testFiles = walk(path.join(repoRoot, 'tests')).map((p) => path.relative(repoRoot, p).split(path.sep).join('/'))
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8')

/**
 * `PATH: '...'`, `PATH = "..."`, `vi.stubEnv('PATH', '...')`, a template: any
 * literal not built from process.env.PATH or guardedPath().
 */
function literalPathCount(text: string): number {
  let n = 0
  for (const line of text.split('\n')) {
    if (!/\bPATH\s*[:=]\s*['"`]|stubEnv\(\s*['"]PATH['"]\s*,\s*['"`]/.test(line)) continue
    if (/process\.env\.PATH|guardedPath\(/.test(line)) continue
    n++
  }
  return n
}

describe('every vitest config loads the exec guard first', () => {
  const configs = [
    ...fs.readdirSync(repoRoot).filter((f) => /^vitest(\.[\w-]+)?\.config\.(ts|mts|js|mjs)$/.test(f)),
    ...(fs.existsSync(path.join(repoRoot, 'infra', 'vitest.config.ts')) ? ['infra/vitest.config.ts'] : []),
  ]

  it('finds the configs', () => {
    expect(configs).toContain('vitest.config.ts')
    expect(configs).toContain('vitest.e2e.config.ts')
  })

  it.each(configs)('%s', (rel) => {
    if (EXEMPT_CONFIGS[rel]) {
      expect(read(rel)).not.toContain('exec-guard')
      return
    }
    const text = read(rel)
    const m = text.match(/setupFiles\s*:\s*\[([\s\S]*?)\]/)
    if (!m) {
      // Inherits vitest.config.ts's setupFiles through mergeConfig.
      expect(text, `${rel} has no setupFiles of its own, so it must merge vitest.config.ts`).toMatch(/mergeConfig\(/)
      expect(text).toMatch(/from '\.\/vitest\.config(\.js|\.ts)?'/)
      return
    }
    const first = m[1].match(/['"]([^'"]+)['"]/)
    expect(first?.[1] && path.normalize(first[1]).endsWith(path.normalize(GUARD)), `${rel}: the first setupFile must be ${GUARD}`).toBe(true)
  })
})

describe('no test opts out', () => {
  it('only the guard\'s own files name its variables or consume its hits', () => {
    const offenders = testFiles.filter((rel) => !GUARD_FILES.has(rel) && !GUARD_VAR_UNIT_TESTS.has(rel)
      && /WALNUT_TEST_EXEC_GUARD|takeExecGuardHits|failOnExecGuardHits/.test(read(rel)))
    expect(offenders, 'a test may not disable, re-point or drain the exec guard').toEqual([])
  })

  it('literal PATH values stay within their per-file budget', () => {
    const over: string[] = []
    for (const rel of testFiles) {
      if (GUARD_FILES.has(rel)) continue
      const n = literalPathCount(read(rel))
      const budget = LITERAL_PATH_BUDGET[rel] ?? 0
      if (n > budget) {
        over.push(`${rel}: ${n} literal PATH value(s), budget ${budget}. A child given a literal PATH runs `
          + 'the real /usr/bin/ssh; build it with guardedPath([fakeBin], rest) from tests/setup/exec-guard.ts.')
      }
    }
    expect(over).toEqual([])
  })

  it('the budget only lists files that still use it', () => {
    const stale = Object.entries(LITERAL_PATH_BUDGET)
      .filter(([rel, budget]) => !fs.existsSync(path.join(repoRoot, rel)) || literalPathCount(read(rel)) < budget)
      .map(([rel]) => rel)
    expect(stale, 'lower (or drop) these budgets: the ratchet only tightens').toEqual([])
  })

  it('only the production-data guard tests read the account\'s real home', () => {
    const offenders = testFiles.filter((rel) => !ACCOUNT_HOME_READERS.has(rel) && !GUARD_FILES.has(rel) && /userInfo\(\)\.homedir/.test(read(rel)))
    expect(offenders, 'HOME is faked to keep tests away from the real one; use os.homedir()').toEqual([])
  })
})
