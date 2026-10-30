/**
 * A test that starts an ACP worker builds it from source (tests/helpers/acp-worker-bundle.ts),
 * never runs dist/daemon-binaries/acp-worker.js. 2026-10-30: the Playwright fixture ran
 * the prebuilt file, which a clean clone does not have, so 16 browser specs failed on
 * HEAD with "worker died: worker-exit"; in the shared checkout the same file is what the
 * last deploy published, not the source under test.
 *
 * Every test file naming that path is listed here with why it may. A new one fails.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..', '..')
const PREBUILT = 'dist/daemon-binaries/acp-worker.js'

const ALLOWED: Record<string, string> = {
  'tests/providers/budget-process-identity.test.ts': 'a ps line fixture: the path is text, nothing runs',
  'tests/providers/system-codex-path.test.ts': 'asserts the shipped path the server resolves',
  'tests/e2e/acp-daemon-e2e.test.ts': 'runs the built daemon sidecar with its bundle; skips with both',
  'tests/e2e/acp-session-server-e2e.test.ts': 'runs the built daemon binary with its bundle; skips with both',
  'tests/e2e/acp-codex.live.test.ts': 'live layer: the shipped artifacts against the real engine',
  'tests/live/provider-matrix/specs/codex.ts': 'live layer: the shipped artifacts against the real engine',
  'tests/live/provider-matrix/specs/gemini.ts': 'live layer: the shipped artifacts against the real engine',
  'tests/live/provider-matrix/specs/goose.ts': 'live layer: the shipped artifacts against the real engine',
  'tests/live/provider-matrix/specs/opencode.ts': 'live layer: the shipped artifacts against the real engine',
  'tests/live/provider-matrix/specs/dsh.ts': 'live layer: the shipped artifacts against the real engine',
  'tests/live/provider-matrix/specs/pi.ts': 'live layer: the shipped artifacts against the real engine',
  'tests/e2e/session-budget-acp.test.ts': 'runs the built daemon binary with its bundle; skips without the budget manifest',
  'tests/providers/acp-host-artifacts.test.ts': 'asserts the compiled file does not embed the dist path: text, nothing runs',
  'tests/providers/budget-acp-cleanup-ledger.test.ts': 'ps line fixtures: the paths are text, nothing runs',
  'tests/e2e/browser/test-server.ts': 'builds its own sidecars into its temp dir (checked below)',
}

function testFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) testFiles(p, out)
    else if (/\.(ts|tsx|mts|js|mjs|cjs)$/.test(e.name)) out.push(p)
  }
  return out
}

describe('tests start the ACP worker built from source', () => {
  it('no test file runs the prebuilt worker bundle except the listed ones', () => {
    const naming = testFiles(path.join(REPO, 'tests'))
      .filter((f) => f !== import.meta.filename)
      // The path may be one string or joined from parts (`path.join(BIN_DIR, 'acp-worker.js')`).
      .filter((f) => { const src = fs.readFileSync(f, 'utf-8'); return /acp-worker\.js/.test(src) && /daemon-binaries|DAEMON_BINARIES_DIR/.test(src) })
      .map((f) => path.relative(REPO, f).split(path.sep).join('/'))
      .filter((f) => !f.startsWith('tests/helpers/') && f !== 'tests/setup/slow-tests.ts')
    for (const f of naming) expect(ALLOWED, `${f} names ${PREBUILT}; use acpWorkerBundle() from tests/helpers/acp-worker-bundle.ts`).toHaveProperty([f])
    // A listed file that stopped naming it leaves the list.
    for (const f of Object.keys(ALLOWED)) expect(naming, `${f} no longer names ${PREBUILT}; drop it from ALLOWED`).toContain(f)
  })

  it('the browser fixture builds the daemon sidecars and names them before any server module loads', () => {
    const fixture = fs.readFileSync(path.join(REPO, 'tests/e2e/browser/test-server.ts'), 'utf-8')
    const named = fixture.indexOf('process.env.WALNUT_DAEMON_BINARIES_DIR = DAEMON_ARTIFACTS')
    const firstServerImport = fixture.search(/import\(['"]\.\.\/\.\.\/\.\.\/src\//)
    expect(named).toBeGreaterThan(-1)
    expect(fixture).toContain("WALNUT_DAEMON_SIDECARS_ONLY: '1'")
    expect(firstServerImport).toBeGreaterThan(named)
    // Nothing above that line imports Walnut's source statically.
    expect(fixture.slice(0, named)).not.toMatch(/^import .* from ['"](\.\.\/)+src\//m)
  })

  it('DAEMON_BINARIES_DIR honours WALNUT_DAEMON_BINARIES_DIR (absolute only)', async () => {
    const { spawnSync } = await import('node:child_process')
    const read = (value: string) => spawnSync(process.execPath, ['-e', "import('./src/constants.ts').then((c) => console.log(c.DAEMON_BINARIES_DIR))"], {
      cwd: REPO, encoding: 'utf-8', env: { ...process.env, WALNUT_DAEMON_BINARIES_DIR: value },
    }).stdout.trim()
    expect(read('/tmp/walnut-fixture-sidecars')).toBe('/tmp/walnut-fixture-sidecars')
    expect(read('relative/dir')).toBe(path.join(REPO, 'dist', 'daemon-binaries'))
  })

  it('the helper builds a worker that starts, from the same entry build-daemon.sh bundles', async () => {
    const { acpWorkerBundle, ACP_WORKER_ENTRY } = await import('../helpers/acp-worker-bundle.js')
    const script = fs.readFileSync(path.join(REPO, 'scripts', 'build-daemon.sh'), 'utf-8')
    expect(script).toContain('--outfile "$OUTDIR/acp-worker.js" \\\n  ' + path.relative(REPO, ACP_WORKER_ENTRY))
    const bundle = acpWorkerBundle()
    const { spawnSync } = await import('node:child_process')
    const r = spawnSync(process.execPath, [bundle], { encoding: 'utf-8', timeout: 20_000 })
    // With no arguments the worker names its one required flag and exits: it loaded.
    expect(r.stderr).toContain('missing --journal')
  })
})
