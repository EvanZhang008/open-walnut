/**
 * Guards the testing pipeline's own invariants. If these fail, the pipeline is
 * lying about its coverage — which is worse than a slow suite, because it looks
 * green while tests silently run nowhere.
 *
 * The three real failure modes this catches:
 *   1. A file listed as slow gets renamed/deleted → it drops out of BOTH tiers
 *      (quick excludes the old path, slow includes a path that matches nothing).
 *   2. `mergeConfig` array-concatenation regressions — the bug that made the unit
 *      and integration tiers each collect the whole 332-file suite, so `npm test`
 *      ran nearly everything twice (~750s instead of ~380s), and made
 *      tests/commands/** run in no tier at all.
 *   3. A new heavy test lands without a slow-list entry → L1 blows its budget.
 *      Can't be asserted statically (it needs a timing run), so it's covered by
 *      `npm run test:quick` printing its own duration instead.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { SLOW_TEST_FILES, SLOW_TEST_DIRS } from './slow-tests.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

describe('slow-test list hygiene', () => {
  it('every listed slow file exists on disk', () => {
    const missing = SLOW_TEST_FILES.filter((f) => !fs.existsSync(path.join(REPO_ROOT, f)))
    // A stale entry means the file is excluded from quick AND matched by nothing
    // in slow — it would run in no tier at all.
    expect(missing, `stale entries in SLOW_TEST_FILES — re-measure and update:\n${missing.join('\n')}`).toEqual([])
  })

  it('has no duplicate entries', () => {
    const dupes = SLOW_TEST_FILES.filter((f, i) => SLOW_TEST_FILES.indexOf(f) !== i)
    expect(dupes).toEqual([])
  })

  it('lists repo-root-relative paths (so vitest include/exclude match)', () => {
    const bad = [...SLOW_TEST_FILES, ...SLOW_TEST_DIRS].filter((f) => f.startsWith('/') || f.startsWith('./') || !f.startsWith('tests/'))
    expect(bad).toEqual([])
  })
})

describe('quick + slow partition the whole runnable suite', () => {
  // Verified 2026-07-25: quick 311 + slow 26 = 337 = every non-e2e, non-live,
  // non-frontend-rooted test file, with ZERO overlap. This asserts the property
  // statically (globbing the tree) rather than by booting vitest twice.
  const listTests = (dir: string): string[] => {
    const out: string[] = []
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name)
        if (e.isDirectory()) walk(full)
        else if (e.name.endsWith('.test.ts')) out.push(path.relative(REPO_ROOT, full))
      }
    }
    walk(path.join(REPO_ROOT, dir))
    return out
  }

  /**
   * Directories whose files belong to a DIFFERENT tier and must therefore be
   * excluded by both quick and slow. Derived here, asserted against the real
   * config below — an earlier version of this file hand-copied the config's
   * filter list, which is exactly how tests/web/markdown/** came to be missing
   * from the config while this guard still passed: two copies of one rule, only
   * one updated. Never re-inline these; assert the config contains them.
   */
  const FOREIGN_TIER_DIRS = [
    'tests/e2e/', // own tier (vitest.e2e.config.ts)
    'tests/web/notes-roundtrip/', // frontend-rooted (web/node_modules + DOM shim)
    'tests/web/diff-view/',
    'tests/web/markdown/',
    'tests/web/workflow-graph/',
  ]

  /** Everything the quick+slow pair is responsible for. */
  const universe = listTests('tests').filter(
    (f) => !f.endsWith('.live.test.ts') && !FOREIGN_TIER_DIRS.some((d) => f.startsWith(d)),
  )

  it('the quick config excludes every foreign-tier directory', async () => {
    const quickConfig: any = (await import('../../vitest.quick.config.js')).default
    const exclude: string[] = quickConfig.test.exclude
    // A missing entry means those files run in the quick tier under the wrong
    // config — red for reasons unrelated to the code, or silently duplicated.
    const missing = FOREIGN_TIER_DIRS.filter((d) => !exclude.some((e) => e.startsWith(d)))
    expect(missing, `foreign-tier dirs NOT excluded from the quick tier:\n${missing.join('\n')}`).toEqual([])
  })

  it('the integration config excludes every frontend-rooted directory', async () => {
    const integrationConfig: any = (await import('../../vitest.integration.config.js')).default
    const exclude: string[] = integrationConfig.test.exclude
    const frontend = FOREIGN_TIER_DIRS.filter((d) => d.startsWith('tests/web/'))
    const missing = frontend.filter((d) => !exclude.some((e) => e.startsWith(d)))
    expect(missing, `frontend dirs NOT excluded from the integration tier:\n${missing.join('\n')}`).toEqual([])
  })

  it('every slow-list entry is a file the pair is responsible for', () => {
    // A slow entry outside the universe would be excluded from quick and matched
    // by nothing meaningful in slow — e.g. someone lists a tests/e2e/ path, which
    // belongs to a different tier entirely.
    const strays = SLOW_TEST_FILES.filter((f) => !universe.includes(f))
    expect(strays, `SLOW_TEST_FILES entries outside the quick/slow universe:\n${strays.join('\n')}`).toEqual([])
  })

  // The two tests below deliberately read the REAL config files. An earlier
  // version asserted `quick.length + slow.size === universe.length`, which is
  // tautological — it is arithmetic on a set difference and true no matter what
  // the configs actually say. These import the configs so a broken glob fails.
  it('the quick config excludes exactly the slow list (no more, no less)', async () => {
    const quickConfig: any = (await import('../../vitest.quick.config.js')).default
    const exclude: string[] = quickConfig.test.exclude
    const missing = SLOW_TEST_FILES.filter((f) => !exclude.includes(f))
    expect(missing, `slow files NOT excluded from the quick tier (they would run in both):\n${missing.join('\n')}`).toEqual([])
  })

  it('the slow config includes exactly the slow list and the heavy directories but tests/e2e', async () => {
    const slowConfig: any = (await import('../../vitest.slow.config.js')).default
    const dirs = SLOW_TEST_DIRS.filter((d) => d !== 'tests/e2e/**').map((d) => `${d}/*.test.ts`)
    expect([...slowConfig.test.include].sort()).toEqual([...SLOW_TEST_FILES, ...dirs].sort())
  })

  it('the fast tier holds the bulk of the suite', () => {
    const slow = new Set<string>(SLOW_TEST_FILES)
    const quick = universe.filter((f) => !slow.has(f))
    // If this inverts, the slow list has grown into the fast tier's job and L1 is
    // no longer the cheap layer it exists to be.
    expect(quick.length).toBeGreaterThan(slow.size * 5)
    expect(quick.length).toBeGreaterThan(200)
  })
})

describe('every test file runs in exactly one tier', () => {
  // The configs the tiers run, each through its own include/exclude. CI runs
  // quick, slow, e2e and the four frontend configs; live is opt-in. A file in
  // none of them runs nowhere, as tests/commands and tests/mcp did until
  // 2026-10-24 (excluded from quick, never included by slow); a file in two runs
  // twice. vitest.focus.config.ts collects everything on purpose and is left out.
  // One literal import each: vite resolves an import by its own file name, and a
  // template (`vitest.${name}.config.js`) globs for .js files that do not exist.
  const TIER_CONFIGS: Record<string, () => Promise<{ default: any }>> = {
    quick: () => import('../../vitest.quick.config.js'),
    slow: () => import('../../vitest.slow.config.js'),
    e2e: () => import('../../vitest.e2e.config.js'),
    live: () => import('../../vitest.live.config.js'),
    'diff-view': () => import('../../vitest.diff-view.config.js'),
    markdown: () => import('../../vitest.markdown.config.js'),
    'workflow-graph': () => import('../../vitest.workflow-graph.config.js'),
    'notes-roundtrip': () => import('../../vitest.notes-roundtrip.config.js'),
  }

  /** The files a config collects, matched the way vitest globs: include, minus exclude, from its root. */
  async function collects(name: string): Promise<(file: string) => boolean> {
    let cfg: any = (await TIER_CONFIGS[name]()).default
    if (typeof cfg === 'function') cfg = await cfg({ mode: 'test', command: 'serve' })
    const t = cfg.test ?? {}
    const root = path.resolve(REPO_ROOT, t.root ?? cfg.root ?? '.')
    const include = (t.include ?? []).map((p: string) => new Bun.Glob(p))
    const exclude = (t.exclude ?? []).map((p: string) => new Bun.Glob(p))
    return (file) => {
      const rel = path.relative(root, path.join(REPO_ROOT, file))
      return include.some((g: any) => g.match(rel)) && !exclude.some((g: any) => g.match(rel))
    }
  }

  it('no test file is collected by no tier or by two', async () => {
    const matchers = await Promise.all(Object.keys(TIER_CONFIGS).map(async (n) => [n, await collects(n)] as const))
    const files: string[] = []
    const walk = (d: string) => {
      for (const e of fs.readdirSync(path.join(REPO_ROOT, d), { withFileTypes: true })) {
        if (e.name === 'node_modules') continue
        const rel = `${d}/${e.name}`
        if (e.isDirectory()) walk(rel)
        else if (/\.test\.tsx?$/.test(e.name)) files.push(rel)
      }
    }
    walk('tests')
    const wrong = files
      .map((f) => [f, matchers.filter(([, m]) => m(f)).map(([n]) => n)] as const)
      .filter(([, owners]) => owners.length !== 1)
      .map(([f, owners]) => `${f}: ${owners.length ? owners.join(' + ') : 'no tier'}`)
    expect(files.length).toBeGreaterThan(2000)
    expect(wrong, `test files not in exactly one tier:\n${wrong.join('\n')}`).toEqual([])
  })
})

describe('tier configs do not silently collect the whole suite', () => {
  // mergeConfig CONCATENATES arrays, so `include` inside its second argument
  // appends to the base's 'tests/**' instead of replacing it. Every tier config
  // that narrows the file set must therefore ASSIGN include/exclude after the
  // merge. Enforced textually: importing 8 vite configs here would be slow and
  // would execute their side effects.
  const NARROWING_CONFIGS = [
    'vitest.unit.config.ts',
    'vitest.integration.config.ts',
    'vitest.quick.config.ts',
    'vitest.slow.config.ts',
  ]

  it.each(NARROWING_CONFIGS)('%s assigns include after mergeConfig instead of merging it', (file) => {
    const src = fs.readFileSync(path.join(REPO_ROOT, file), 'utf-8')
    expect(src, `${file} must set include via post-merge assignment`).toMatch(/config\.test!?\.include\s*=/)

    // And must NOT pass include through the merged object literal.
    const merged = src.slice(src.indexOf('mergeConfig'), src.indexOf('config.test'))
    expect(merged, `${file} passes include through mergeConfig — it will CONCATENATE with the base`).not.toMatch(
      /^\s*include:/m,
    )
  })
})
