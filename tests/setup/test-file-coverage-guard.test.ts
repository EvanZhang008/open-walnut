/**
 * Every test file runs somewhere automated, or it is not a test.
 *
 * 2026-11-09: six Playwright configs (cloud host, replica, host alone, session commit,
 * warm session), two Mac app Swift tests, the cloud stack's synth tests and eight specs
 * behind an environment variable ran in no CI job and no scheduled run. Several had
 * already rotted (the session commit fixture compiled its daemon for one Mac only, the
 * cloud stack test missed a port added a month before), and nothing said so.
 *
 * A file counts as picked up when what CI runs reaches it:
 *   - a vitest config that a workflow (or a package script or script file a workflow
 *     reaches) names, by its include and exclude; a live test only through a live config;
 *   - the browser suite's Playwright config (playwright.config.ts) when a workflow runs
 *     `playwright test` with no config of its own, minus the specs a side config owns;
 *   - a side Playwright config in tests/e2e/browser/ that a workflow names, by its testMatch;
 *   - its own path, named by a workflow step or a script one reaches (the Swift tests).
 * A spec whose `test.skip(...)` gate reads only environment variables needs CI to set
 * one of them (the name appears in what CI runs), or it is skipped everywhere.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { testMatchNames } from '../e2e/browser/side-config-specs'
import { QUARANTINED_TEST_FILES } from './quarantine'
import { SLOW_TEST_DIRS, SLOW_TEST_FILES } from './slow-tests'

const REPO = path.resolve(import.meta.dirname, '../..')
const BROWSER_DIR = 'tests/e2e/browser'

/** The files this guard holds to a tier. */
function isTestFile(rel: string): boolean {
  if (rel.includes('node_modules/')) return false
  if (/\.(test|spec)\.(ts|tsx|mts|mjs|cjs|js)$/.test(rel)) return rel.startsWith('tests/') || rel.startsWith('infra/test/')
  return /^tests\/desktop\/[^/]+\.swift$/.test(rel)
}

/** A source with its comment lines dropped: a path or a name in a comment runs nothing. */
const code = (text: string) => text.split('\n').filter((l) => !/^\s*(#|\/\/|\*|\/\*)/.test(l)).join('\n')

/**
 * Everything CI runs, as one text: every workflow, then (transitively) each package
 * script a run line reaches with `bun run <name>`, each script file under scripts/ it
 * names, and each config file it names.
 */
function reachedText(workflows: string[], scripts: Record<string, string>, read: (rel: string) => string | null): string {
  const out: string[] = []
  const seenScripts = new Set<string>()
  const seenFiles = new Set<string>()
  const todo = workflows.map(code)
  while (todo.length) {
    const text = todo.pop()!
    out.push(text)
    for (const m of text.matchAll(/\b(?:bun|npm) run ([\w:.-]+)/g)) {
      const name = m[1]!
      if (seenScripts.has(name) || !(name in scripts)) continue
      seenScripts.add(name)
      todo.push(scripts[name]!)
    }
    for (const m of text.matchAll(/(?<![\w.-])((?:scripts|tests|infra)\/[\w./-]+\.(?:sh|mjs|cjs|js|ts|mts))/g)) {
      const rel = m[1]!
      if (seenFiles.has(rel) || !(rel.startsWith('scripts/') || rel.endsWith('.config.ts'))) continue
      seenFiles.add(rel)
      const body = read(rel)
      if (body != null) todo.push(code(body))
    }
  }
  return out.join('\n')
}

interface VitestTier { name: string; root: string; include: string[]; exclude: string[] }
interface SideConfig { file: string; specs: string[] }

/** One matcher for a list of globs: exact paths by a set lookup, the rest compiled once. */
function matcher(patterns: string[]): (rel: string) => boolean {
  const exact = new Set(patterns.filter((p) => !/[*?[\]{}]/.test(p)))
  const globs = patterns.filter((p) => !exact.has(p)).map((p) => new Bun.Glob(p))
  return (rel) => exact.has(rel) || globs.some((g) => g.match(rel))
}

/** The `test.skip(` gates of a spec that read only environment variables: the names each reads. */
function envOnlyGates(source: string): string[][] {
  const gates: string[][] = []
  // A condition, not a titled `test.skip('name', ...)`; one statement at most.
  for (const m of source.matchAll(/\btest(?:\.describe)?\.skip\(\s*(?!['"`)])([^;]{1,300}?)(?:,\s*['"`]|\)\s*(?:;|$))/gm)) {
    const cond = m[1]!
    if (!cond.includes('process.env.') || /process\.platform|testInfo|\binfo\.|browserName|project/.test(cond)) continue
    gates.push([...cond.matchAll(/process\.env\.(\w+)/g)].map((x) => x[1]!))
  }
  return gates
}

/** Each test file that nothing CI runs picks up, with why. */
function unpicked(input: {
  files: string[]
  ci: string
  vitest: VitestTier[]
  sideConfigs: SideConfig[]
  read: (rel: string) => string
}): string[] {
  const { files, ci, vitest, sideConfigs, read } = input
  const mainPlaywright = /\bplaywright test\b(?![^\n]*(?:\s-c\s|--config))/.test(ci)
  const sideOwned = new Set(sideConfigs.flatMap((c) => c.specs))
  const sideRun = new Set(sideConfigs.filter((c) => ci.includes(c.file)).flatMap((c) => c.specs))
  const named = (word: string) => new RegExp(`\\b${word}\\b`).test(ci)
  const tiers = vitest.map((t) => ({ ...t, live: t.include.some((p) => p.includes('.live.')), inc: matcher(t.include), exc: matcher(t.exclude) }))
  const bad: string[] = []
  for (const rel of files) {
    const live = rel.endsWith('.live.test.ts')
    const byVitest = tiers.some((t) => {
      if (live && !t.live) return false
      const r = t.root === '.' ? rel : path.posix.relative(t.root, rel)
      return t.inc(r) && !t.exc(r)
    })
    const isSpec = rel.startsWith(`${BROWSER_DIR}/`) && /\.spec\.[cm]?[jt]sx?$/.test(rel)
    const byPlaywright = isSpec && (sideOwned.has(rel) ? sideRun.has(rel) : mainPlaywright)
    if (!byVitest && !byPlaywright && !(!live && ci.includes(rel))) {
      bad.push(`${rel}: no CI tier, config or workflow step runs it`)
      continue
    }
    if (isSpec) {
      for (const names of envOnlyGates(read(rel))) {
        if (!names.some(named)) bad.push(`${rel}: skipped unless ${names.join(' or ')} is set, and nothing CI runs sets it`)
      }
    }
  }
  return bad
}

// The vitest configs CI can run, each with what names it in a run line. Their globs are
// read from the config files (importing one loads vite: a quarter second), with the
// lists they spread taken from the modules that export them. vitest.focus.config.ts
// collects every file on purpose and runs only the files a command names, so it counts
// through those names instead. infra/ has its own dependencies, so `test:infra` runs
// its config with `vitest run --root infra`.
const VITEST_CONFIGS: Array<{ file: string; named: RegExp }> = [
  'vitest.quick.config.ts', 'vitest.slow.config.ts', 'vitest.e2e.config.ts', 'vitest.live.config.ts',
  'vitest.unit.config.ts', 'vitest.integration.config.ts', 'vitest.diff-view.config.ts',
  'vitest.markdown.config.ts', 'vitest.workflow-graph.config.ts', 'vitest.notes-roundtrip.config.ts',
].map((file) => ({ file, named: new RegExp(`\\b${file.replace(/\./g, '\\.')}\\b`) }))
  .concat({ file: 'infra/vitest.config.ts', named: /vitest run --root infra\b/ })

// The names a config's include or exclude spreads. SLOW_DIR_GLOBS is vitest.slow.config.ts's
// own export, built the same way (tests/setup/quick-tier.test.ts pins the config to it).
const SPREADS: Record<string, readonly string[]> = {
  SLOW_TEST_DIRS,
  SLOW_TEST_FILES,
  QUARANTINED_TEST_FILES,
  SLOW_DIR_GLOBS: SLOW_TEST_DIRS.filter((d) => d !== 'tests/e2e/**').map((d) => `${d}/*.test.ts`),
}

/** The last `key: [...]` or `.key = [...]` array of a config's text, its spreads resolved. */
function configArray(text: string, key: 'include' | 'exclude'): string[] {
  const bare = text.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
  const all = [...bare.matchAll(new RegExp(`(?:\\b${key}:|\\.${key}\\s*=)\\s*\\[([^\\]]*)\\]`, 'g'))]
  if (!all.length) return []
  return all.at(-1)![1]!.split(',').map((x) => x.trim()).filter(Boolean).flatMap((item) => {
    const spread = item.match(/^\.\.\.(\w+)$/)
    if (spread) {
      const list = SPREADS[spread[1]!]
      if (!list) throw new Error(`a config spreads ${spread[1]}, which this guard does not know: add it to SPREADS`)
      return [...list]
    }
    const lit = item.match(/^(['"`])([^'"`]+)\1$/)
    if (!lit) throw new Error(`cannot read the ${key} entry ${item}`)
    return [lit[2]!]
  })
}

function vitestTiers(ci: string): VitestTier[] {
  return VITEST_CONFIGS.filter((c) => c.named.test(ci)).map(({ file }) => {
    const text = fs.readFileSync(path.join(REPO, file), 'utf8')
    const dir = path.posix.dirname(file)
    const rootArg = text.match(/\broot:\s*path\.resolve\(import\.meta\.dirname,\s*'([^']+)'\)/)?.[1]
    const root = path.posix.normalize(path.posix.join(dir, rootArg ?? '.'))
    return { name: file, root, include: configArray(text, 'include'), exclude: configArray(text, 'exclude') }
  })
}

function repoState() {
  const read = (rel: string): string | null => {
    try { return fs.readFileSync(path.join(REPO, rel), 'utf8') } catch { return null }
  }
  const wfDir = path.join(REPO, '.github/workflows')
  const workflows = fs.readdirSync(wfDir).filter((f) => f.endsWith('.yml')).map((f) => fs.readFileSync(path.join(wfDir, f), 'utf8'))
  const scripts = (JSON.parse(read('package.json')!) as { scripts: Record<string, string> }).scripts
  const ci = reachedText(workflows, scripts, read)
  // Tracked and new (not ignored) files that are still on disk: another change may be
  // mid-rename in this checkout.
  const ls = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'tests', 'infra/test'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 << 20 })
  const files = [...new Set(ls.stdout.split('\n'))].filter((f) => isTestFile(f) && fs.existsSync(path.join(REPO, f))).sort()
  const sideConfigs: SideConfig[] = fs.readdirSync(path.join(REPO, BROWSER_DIR))
    .filter((f) => f.endsWith('.config.ts'))
    .map((f) => ({ file: `${BROWSER_DIR}/${f}`, specs: testMatchNames(read(`${BROWSER_DIR}/${f}`)!).map((n) => `${BROWSER_DIR}/${n}`) }))
  return { ci, files, sideConfigs, read: (rel: string) => read(rel) ?? '' }
}

describe('every test file is picked up by something CI runs', () => {
  it('no test file runs nowhere', () => {
    const state = repoState()
    expect(state.files.length).toBeGreaterThan(3000)
    const bad = unpicked({ ...state, vitest: vitestTiers(state.ci) })
    expect(bad, `wire each into a tier (a vitest config CI runs, a Playwright config a workflow runs, or a workflow step), or delete it:\n${bad.join('\n')}`).toEqual([])
  })
})

describe('the guard itself, on samples', () => {
  const tiers: VitestTier[] = [
    { name: 'quick', root: '.', include: ['tests/**/*.test.ts'], exclude: ['**/*.live.test.ts', 'tests/e2e/**'] },
    { name: 'live', root: '.', include: ['tests/**/*.live.test.ts'], exclude: [] },
    { name: 'infra', root: 'infra', include: ['test/**/*.test.ts'], exclude: [] },
  ]
  const side: SideConfig[] = [
    { file: 'tests/e2e/browser/run.config.ts', specs: ['tests/e2e/browser/run-side.spec.ts'] },
    { file: 'tests/e2e/browser/idle.config.ts', specs: ['tests/e2e/browser/idle-side.spec.ts'] },
  ]
  const sources: Record<string, string> = {
    'tests/e2e/browser/gated.spec.ts': "test.skip(process.env.PW_NEVER !== '1', 'needs it')\n",
    'tests/e2e/browser/gated-set.spec.ts': "test.skip(!process.env.PW_NIGHTLY, 'needs it')\n",
    'tests/e2e/browser/platform.spec.ts': "test.skip(process.platform !== 'darwin' && !process.env.PW_VIDEO, 'mac')\n",
  }
  const files = [
    'tests/core/a.test.ts', 'tests/e2e/x.test.ts', 'tests/core/b.live.test.ts', 'infra/test/stack.test.ts',
    'tests/e2e/browser/plain.spec.ts', 'tests/e2e/browser/run-side.spec.ts', 'tests/e2e/browser/idle-side.spec.ts',
    'tests/desktop/named-tests.swift', 'tests/desktop/orphan-tests.swift', ...Object.keys(sources),
  ]
  const run = (ci: string, vitest = tiers) => unpicked({ files, ci, vitest, sideConfigs: side, read: (f) => sources[f] ?? '' })
    .map((l) => l.split(':')[0])

  it('flags what no tier, config or step runs, and an environment gate CI never opens', () => {
    const ci = 'bun x playwright test --project=chromium\nbun x playwright test -c tests/e2e/browser/run.config.ts\nPW_NIGHTLY: 1\nswiftc tests/desktop/named-tests.swift'
    expect(run(ci)).toEqual(['tests/e2e/x.test.ts', 'tests/e2e/browser/idle-side.spec.ts', 'tests/desktop/orphan-tests.swift', 'tests/e2e/browser/gated.spec.ts'])
  })

  it('without the browser suite run, its specs run nowhere; a live test counts only through a live config', () => {
    const bad = run('', [tiers[0]!])
    expect(bad).toContain('tests/e2e/browser/plain.spec.ts')
    expect(bad).toContain('tests/core/b.live.test.ts')
    expect(bad).toContain('infra/test/stack.test.ts')
    expect(bad).not.toContain('tests/core/a.test.ts')
  })

  it('reaches package scripts and script files from a workflow, skipping comments', () => {
    const read = (rel: string) => ({ 'scripts/a.sh': 'swiftc tests/desktop/x.swift\n# tests/desktop/commented.swift', 'scripts/b.sh': 'echo b' } as Record<string, string>)[rel] ?? null
    const text = reachedText(['run: bun run test:x\n# run: bash scripts/b.sh'], { 'test:x': 'bash scripts/a.sh' }, read)
    expect(text).toContain('tests/desktop/x.swift')
    expect(text).not.toContain('commented.swift')
    expect(text).not.toContain('echo b')
  })

  it('reads a config\'s include and exclude, its spreads resolved and its comments skipped', () => {
    const text = "base: { test: { include: ['x/**'] } }\nconfig.test!.include = ['tests/**/*.test.ts'];\nconfig.test!.exclude = [\n  ...SLOW_TEST_DIRS,\n  // can't run twice\n  '**/*.live.test.ts',\n];\n"
    expect(configArray(text, 'include')).toEqual(['tests/**/*.test.ts'])
    expect(configArray(text, 'exclude')).toEqual([...SLOW_TEST_DIRS, '**/*.live.test.ts'])
    expect(() => configArray('exclude: [...UNKNOWN_LIST]', 'exclude')).toThrow(/UNKNOWN_LIST/)
  })

  it('reads the environment-only gates of a spec', () => {
    expect(envOnlyGates("test.skip(!process.env.A || !process.env.B,\n  'why')")).toEqual([['A', 'B']])
    expect(envOnlyGates("test.skip(process.platform === 'linux' && !process.env.A, 'why')")).toEqual([])
    expect(envOnlyGates("test.skip(testInfo.project.name === 'chromium' && !!process.env.A, 'why')")).toEqual([])
  })
})
