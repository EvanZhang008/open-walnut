/**
 * scripts/test-changed.mjs (`bun run test:changed` / `test:pre-commit`), without
 * running vitest.
 *
 * What it pins: narrow mode narrows EVERY vitest tier, slow and e2e included
 * (2026-10-24: only quick was narrowed, so a change under src/providers ran the
 * whole e2e and slow tiers for hours); `--tiers` runs whole tiers; each tier
 * carries the selection reporter, and a tier that selected no file, or did not
 * say what it ran, is never reported as passed. The path-reference scan adds the
 * tests that start or read a changed file by path, which vitest's import graph
 * cannot see. `--plan` drives the real script end to end on a throwaway repo.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SELECTION_REPORTER, TIER_CONFIGS, tierCommand, tierVerdict, tiersFor } from '../../scripts/test-changed.mjs'
import { pathReferenceSources } from '../../scripts/test-changed-refs.mjs'
import SelectionReporter from '../../scripts/vitest-selection-reporter.mjs'

const SCRIPT = path.resolve(import.meta.dirname, '../../scripts/test-changed.mjs')
const VITEST_TIERS = ['quick', 'slow', 'e2e'] as const

describe('which tiers a change reaches', () => {
  it.each([
    [['src/providers/local-daemon.ts'], ['quick', 'slow', 'e2e']],
    [['src/web/server.ts'], ['quick', 'slow', 'e2e']],
    [['src/core/task-manager.ts'], ['quick', 'slow']],
    [['tests/e2e/chat-persistence.test.ts'], ['e2e']],
    [['web/src/App.tsx'], ['web']],
    [['bun.lock'], ['quick', 'slow', 'web']],
    [['docs/reference/testing-pipeline.md'], []],
  ])('%j -> %j', (files, tiers) => {
    expect(tiersFor(files).tiers).toEqual(tiers)
  })

  it('runs the quick tier for a path no rule knows, and names it', () => {
    expect(tiersFor(['weird/thing.xyz'])).toEqual({ tiers: ['quick'], unmatched: ['weird/thing.xyz'] })
  })
})

describe('how each tier runs', () => {
  const related = ['src/providers/a.ts', 'tests/integration/b.test.ts']

  it.each(VITEST_TIERS)('narrow mode narrows the %s tier to the related files', (tier) => {
    const c = tierCommand(tier, { full: false, related })
    expect(c.narrowed).toBe(true)
    expect(c.args).toEqual([
      '--bun', 'vitest', 'related', '--run', '--config', TIER_CONFIGS[tier],
      '--reporter=default', `--reporter=${SELECTION_REPORTER}`, ...related,
    ])
  })

  it.each(VITEST_TIERS)('--tiers runs the whole %s tier, still counting its files', (tier) => {
    const c = tierCommand(tier, { full: true, related })
    expect(c.narrowed).toBe(false)
    expect(c.args).toEqual(['--bun', 'vitest', 'run', '--config', TIER_CONFIGS[tier], '--reporter=default', `--reporter=${SELECTION_REPORTER}`])
  })

  it('runs the frontend tier as its package script in both modes', () => {
    for (const full of [false, true]) {
      expect(tierCommand('web', { full, related })).toMatchObject({ args: ['run', 'test:frontend:ci'], narrowed: false })
    }
  })

  it('names the tier configs that exist', () => {
    for (const config of Object.values(TIER_CONFIGS)) expect(fs.existsSync(path.resolve(import.meta.dirname, '../..', config)), config).toBe(true)
  })
})

describe('what a tier run proved', () => {
  it.each([
    [0, 12, 'passed'],
    [0, 0, 'none'],
    [0, null, 'unconfirmed'],
    [1, 12, 'failed'],
    [1, null, 'failed'],
  ])('exit %s with %s file(s) selected is %s', (code, selected, verdict) => {
    expect(tierVerdict(code, selected)).toBe(verdict)
  })
})

describe('the selection reporter', () => {
  let tmp = ''
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('prints and records how many distinct files the run selected', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-reporter-'))
    const out = path.join(tmp, 'count')
    vi.stubEnv('WALNUT_SELECTION_FILE', out)
    vi.stubEnv('WALNUT_SELECTION_LABEL', 'slow')
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    new SelectionReporter().onTestRunStart([{ moduleId: '/r/a.test.ts' }, { moduleId: '/r/a.test.ts' }, { moduleId: '/r/b.test.ts' }])
    expect(write.mock.calls.map((c) => String(c[0])).join('')).toContain('[slow] 2 test files selected')
    expect(fs.readFileSync(out, 'utf-8').trim()).toBe('2')
  })
})

describe('the path-reference scan', () => {
  const files = [
    'src/a.ts',
    'src/entry.ts',
    'src/other/index.ts',
    'src/index.ts',
    'tests/fixtures/child.ts',
    'tests/spawns-entry.test.ts',
    'tests/imports-a.test.ts',
    'tests/runs-script.test.ts',
    'tests/runs-child.test.ts',
    'tests/names-index.test.ts',
  ]
  const text: Record<string, string> = {
    'src/a.ts': 'export const a = 1\n',
    'src/entry.ts': "import { a } from './a.js'\nconsole.log(a)\n",
    'src/other/index.ts': '',
    'src/index.ts': '',
    'tests/fixtures/child.ts': "import { a } from '../../src/a.js'\n",
    'tests/spawns-entry.test.ts': "spawn(bun, [path.join(ROOT, 'src/entry.ts')])\n",
    'tests/imports-a.test.ts': "import { a } from '../src/a.js'\nvi.mock('../src/entry.js')\n",
    'tests/runs-script.test.ts': "const S = path.join(ROOT, 'scripts', 'deploy.sh')\n",
    'tests/runs-child.test.ts': "spawn(bun, [path.join(import.meta.dirname, 'fixtures', 'child.ts')])\n",
    'tests/names-index.test.ts': "read('index.ts')\n",
  }
  const scan = (changed: string[]) =>
    pathReferenceSources('/nowhere', changed, { files, tracked: [...files, 'scripts/deploy.sh'], read: (f: string) => text[f] })

  it('adds a test that starts, by path, a module whose imports reach the change', () => {
    expect(scan(['src/a.ts'])).toEqual(['tests/runs-child.test.ts', 'tests/spawns-entry.test.ts'])
  })

  it('leaves imports and vi.mock to vitest, which already follows them', () => {
    expect(scan(['src/entry.ts'])).toEqual(['tests/spawns-entry.test.ts'])
  })

  it('finds a non-code file named in path.join pieces', () => {
    expect(scan(['scripts/deploy.sh'])).toEqual(['tests/runs-script.test.ts'])
  })

  it('ignores a bare name that more than one file has', () => {
    expect(scan(['src/index.ts'])).toEqual([])
  })

  it('never returns a changed file itself', () => {
    expect(scan(['src/entry.ts', 'tests/spawns-entry.test.ts'])).toEqual([])
  })
})

describe('the script, end to end with --plan', () => {
  let repo = ''
  afterEach(() => { if (repo) fs.rmSync(repo, { recursive: true, force: true }) })

  // An inherited GIT_DIR outranks cwd (git exports one while running hooks).
  function cleanEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, WALNUT_DIFF_BASE: 'HEAD' }
    for (const k of ['CI', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k]
    return env
  }
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore', env: cleanEnv() })

  function plan(extra: string[] = []) {
    const r = spawnSync(process.execPath, [SCRIPT, '--plan', ...extra], { cwd: repo, env: cleanEnv(), encoding: 'utf-8' })
    expect(r.status, r.stderr).toBe(0)
    return JSON.parse(r.stdout.slice(r.stdout.indexOf('{')))
  }

  function seed() {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-plan-'))
    const put = (f: string, s: string) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), s) }
    put('src/providers/core.ts', 'export const x = 1\n')
    put('src/providers/standalone.ts', "import { x } from './core.js'\n")
    put('tests/integration/twins.test.ts', "spawn(bun, [path.join(ROOT, 'src/providers/standalone.ts')])\n")
    git('init', '-q')
    git('add', '-A')
    git('-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-qm', 'seed')
    put('src/providers/core.ts', 'export const x = 2\n')
  }

  it('narrows quick, slow and e2e alike, the spawned twins test included', () => {
    seed()
    const p = plan()
    expect(p.files).toEqual(['src/providers/core.ts'])
    expect(p.related).toEqual(['src/providers/core.ts', 'tests/integration/twins.test.ts'])
    expect(p.commands.map((c: { tier: string }) => c.tier)).toEqual(['quick', 'slow', 'e2e'])
    for (const c of p.commands) {
      expect(c.narrowed).toBe(true)
      expect(c.args.slice(2, 4)).toEqual(['related', '--run'])
      expect(c.args.slice(-2)).toEqual(p.related)
    }
  })

  it('runs whole tiers with --tiers', () => {
    seed()
    const p = plan(['--tiers'])
    expect(p.related).toEqual([])
    for (const c of p.commands) {
      expect(c.narrowed).toBe(false)
      expect(c.args[2]).toBe('run')
    }
  })
})
