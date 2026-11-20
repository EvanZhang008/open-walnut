/**
 * Guard: every test file that starts the daemon's JS twin runs in a script node-side runs
 * (test:source-twin-node or test:source-twin-node-suites), so the twin is checked on Node.
 *
 * It lived in tests/scripts/ci-bun-only.test.ts, a file of about 1.7 s, over the local layer's
 * 500 ms scan cap (scripts/test-layers.mjs SCAN_MAX_MS), so a land never ran it and a new
 * *-twins-e2e test landed unlisted three times in two days (2026-11-13 to 11-15), each one red
 * only in the deep test. On its own this check reads the test files once and stays cheap.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = path.resolve(__dirname, '../..')
/** This guard and ci-bun-only.test.ts name SOURCE_TWIN.file in their own examples, not to start it. */
const NOT_SUITES = ['tests/scripts/source-twin-node-listed-guard.test.ts', 'tests/scripts/ci-bun-only.test.ts']
const SCRIPTS = (JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
const TWIN_SCRIPTS = ['test:source-twin-node', 'test:source-twin-node-suites']

/** Every script under a directory (test files and the helpers they share). */
const walkScripts = (dir: string): string[] => fs.readdirSync(path.join(REPO, dir), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walkScripts(path.join(dir, e.name)) : /\.[cm]?[jt]s$/.test(e.name) ? [path.join(dir, e.name).split(path.sep).join('/')] : [])
let sources: Map<string, string> | null = null
/**
 * The test files that can start the JS twin, with their text (read once): the ones naming
 * SOURCE_TWIN.file or a twin helper, found with git grep so the check stays cheap; a walk of
 * tests/ when git cannot answer.
 */
function testSources(): Map<string, string> {
  if (sources) return sources
  const words = ['SOURCE_TWIN.file', ...Object.keys(TWIN_HELPERS).map((h) => `/helpers/${path.basename(h, '.ts')}.js'`)]
  const r = spawnSync('git', ['grep', '-l', '--untracked', '-F', ...words.flatMap((w) => ['-e', w]), '--', 'tests'], { cwd: REPO, encoding: 'utf8' })
  const found = r.status === 0 || (r.status === 1 && !r.stderr) ? r.stdout.split('\n').filter(Boolean) : walkScripts('tests')
  sources = new Map(found.filter((f) => /\.test\.tsx?$/.test(f) && !NOT_SUITES.includes(f)).map((f) => [f, fs.readFileSync(path.join(REPO, f), 'utf8')]))
  return sources
}

/** Helpers that start the JS twin with SOURCE_TWIN.file, and the calls of theirs that start it. */
const TWIN_HELPERS: Record<string, RegExp> = {
  'tests/helpers/daemon-twin.ts': /\bstartDaemonTwin\(/,
  'tests/helpers/host-alone-harness.ts': /\bstartHostAloneHarness\(/,
  'tests/helpers/live-daemon.ts': /\bspawnLiveDaemon\(/,
  'tests/helpers/replica-cluster.ts': /\bstart(?:ReplicaCluster|HostDaemon)\(/,
  'tests/helpers/startup-failure-twins.ts': /\bstartupFailureTwinsSuite\(/,
}
/** Twin suites node-side leaves out, each for a reason. */
const TWIN_ELSEWHERE: Record<string, string> = {
  'tests/e2e/routine-sleep-fallback.test.ts': 'uses only the standalone twin: portable API work requires walnut-mcp-v1, which the source twin does not advertise; refusal is covered by clock-portable.test.ts',
  'tests/e2e/session-budget.test.ts': 'needs the full daemon build and the budget-e2e-manifest.json scripts/build-daemon.sh writes beside it; it runs in the e2e tier, which builds',
  'tests/e2e/session-budget-acp.test.ts': 'needs the full daemon build and the budget-e2e-manifest.json scripts/build-daemon.sh writes beside it; it runs in the e2e tier, which builds',
  'tests/providers/daemon-startup-failure-twins.live.test.ts': 'needs a real Claude Code binary (WALNUT_TEST_REAL_CLAUDE_BIN), so it runs in the live tier; its stand-in twin, daemon-startup-failure-twins-e2e.test.ts, runs node-side',
}

describe('every suite that starts the JS twin runs node-side', () => {
  it('every test file that starts the JS twin runs in one of them: SOURCE_TWIN.file, or a helper that starts it', () => {
    for (const [helper, starts] of Object.entries(TWIN_HELPERS)) {
      expect(fs.readFileSync(path.join(REPO, helper), 'utf8'), helper).toContain('SOURCE_TWIN.file')
      expect([...testSources().values()].some((text) => starts.test(text)), `${helper}: no test file calls it`).toBe(true)
    }
    // A new helper that starts the twin (writes it and runs it with SOURCE_TWIN.file) is listed above,
    // so the files that call it are found. A helper that only names the runtime (the live walls) is not.
    const startsTwin = (text: string) => text.includes('SOURCE_TWIN.file') && /getDaemonSource|daemon-source|\bdaemon[\w-]*\.cjs/.test(text)
    const helpers = walkScripts('tests/helpers').filter((f) => f !== 'tests/helpers/source-twin.ts' && startsTwin(fs.readFileSync(path.join(REPO, f), 'utf8')))
    expect(helpers.sort()).toEqual(Object.keys(TWIN_HELPERS).sort())
    const viaHelper = (text: string) => Object.entries(TWIN_HELPERS).some(([helper, starts]) =>
      text.includes(`/helpers/${path.basename(helper, '.ts')}.js'`) && starts.test(text))
    const suites = [...testSources()].filter(([, text]) => text.includes('SOURCE_TWIN.file') || viaHelper(text)).map(([f]) => f)
    expect(suites.length).toBeGreaterThan(60)
    const listed = TWIN_SCRIPTS.map((n) => SCRIPTS[n]!).join(' ')
    // Every missing file in one failure: one at a time hid a second behind the first (2026-10-29).
    const unlisted = suites.filter((f) => !TWIN_ELSEWHERE[f] && !listed.includes(f))
    expect(unlisted, `these start the JS twin: list them in ${TWIN_SCRIPTS.join(' or ')}, which node-side runs`).toEqual([])
    for (const f of suites) {
      if (TWIN_ELSEWHERE[f]) expect(listed, `${f} is left out: ${TWIN_ELSEWHERE[f]}`).not.toContain(f)
    }
    for (const f of Object.keys(TWIN_ELSEWHERE)) expect(suites, `${f} no longer starts the JS twin: drop it from TWIN_ELSEWHERE`).toContain(f)
  })

})
