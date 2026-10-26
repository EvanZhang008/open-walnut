/**
 * The test pipeline runs on bun alone. Only the Playwright runner stays on Node,
 * and so does the npm channel's own checks (a user's npm on a user's Node).
 *
 * Pins what a later edit could silently undo: a CI job that builds or tests
 * Walnut back on setup-node, or with the runner image's Node still on PATH (a
 * step that needs Node would then pass in CI and fail on a machine without it);
 * a package test script back on npx, node or tsx; scripts/ci-remove-node.sh
 * leaving a copy behind or running outside CI.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { bunExecutable, vitestCommand, vitestCommandLine } from '../../scripts/bun-vitest.mjs'
import { npmOnPath } from '../helpers/npm-on-path.js'

const REPO = path.resolve(__dirname, '../..')
const REMOVE_NODE = path.join(REPO, 'scripts', 'ci-remove-node.sh')

interface Step { uses?: string; run?: string; name?: string }
interface Job { steps?: Step[]; strategy?: { matrix?: { include?: Array<Record<string, unknown>> } } }
const workflow = (file: string) => parseYaml(fs.readFileSync(path.join(REPO, '.github', 'workflows', file), 'utf8')) as { jobs: Record<string, Job> }

/** Jobs that build or test Walnut: bun only, the image's Node removed first. */
const NODE_FREE: Record<string, string[]> = {
  'ci.yml': ['build', 'test', 'test-heavy', 'test-e2e', 'remote-host'],
  'flake-hunt.yml': ['hunt'],
}
/** Jobs that keep Node, each for a reason. */
const KEEPS_NODE: Record<string, Record<string, string>> = {
  'ci.yml': {
    'node-side': 'the Playwright runner (spec load), a plugin author\'s npm toolchain, the npm channel, the JS daemon on Node',
    browser: 'the Playwright runner',
    onboarding: 'the npm channel: a user installs with npm on their own Node',
    rehearsal: 'the npm channel: the release package installed with npm 12',
    field: 'the npm channel: the releases on npm today, installed and updated with npm 12',
    'archive-targets': 'the npm channel: the archive is built from the npm package',
    'old-node': 'the npm launcher on the oldest Node npm installs it with (8 and 10), and npm for its real-npm test',
  },
}
/** Jobs that start no runtime at all. */
const NO_RUNTIME: Record<string, string[]> = { 'ci.yml': ['ci-ok'] }

/**
 * A run line that starts Node or one of its tools as a command: after a separator,
 * a quote or a backtick, or by a path (`./node_modules/.bin/tsx`, `/usr/bin/node`).
 */
const NODE_COMMAND = /(^|[\s;&|(`'"/])(node|npm|npx|tsx|corepack)(?=[\s`'";&|)]|$)/
/** One command of a package script: its parts between &&, ||, ; and |. */
const commandsOf = (script: string) => script.split(/&&|\|\||;|\|/).map((p) => p.trim()).filter(Boolean)
const SCRIPTS = (JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
/** The package scripts a job's run lines reach through `bun run <name>`, and the ones those reach. */
function scriptsReached(texts: string[]): string[] {
  const seen = new Set<string>()
  const todo = texts.flatMap((t) => [...t.matchAll(/\bbun run ([\w:.-]+)/g)].map((m) => m[1]!))
  while (todo.length) {
    const name = todo.pop()!
    if (seen.has(name) || !(name in SCRIPTS)) continue
    seen.add(name)
    todo.push(...[...SCRIPTS[name]!.matchAll(/\bbun run ([\w:.-]+)/g)].map((m) => m[1]!))
  }
  return [...seen].sort()
}

describe('CI jobs that build or test run on bun alone', () => {
  for (const [file, jobs] of Object.entries(NODE_FREE)) {
    const doc = workflow(file)
    it(`${file}: every job is classified`, () => {
      const known = [...jobs, ...Object.keys(KEEPS_NODE[file] ?? {}), ...(NO_RUNTIME[file] ?? [])].sort()
      expect(Object.keys(doc.jobs).sort(), `a new job in ${file} must be listed here: Node-free, or keeping Node for a reason`).toEqual(known)
    })
    for (const name of jobs) {
      it(`${file} ${name}: setup-bun, then ci-remove-node.sh, then bun install, and no setup-node`, () => {
        const steps = doc.jobs[name]!.steps ?? []
        expect(steps.some((s) => s.uses?.startsWith('actions/setup-node')), name).toBe(false)
        const bun = steps.findIndex((s) => s.uses?.startsWith('oven-sh/setup-bun'))
        const remove = steps.findIndex((s) => s.run === 'bash scripts/ci-remove-node.sh')
        const install = steps.findIndex((s) => s.run === 'bun install --frozen-lockfile')
        expect(bun, name).toBeGreaterThan(-1)
        expect(remove, name).toBeGreaterThan(bun)
        expect(install, name).toBeGreaterThan(remove)
      })
      const job = doc.jobs[name]!
      // `run: ${{ matrix.cmd }}`: the command lives in the matrix.
      const matrixValues = (job.strategy?.matrix?.include ?? []).flatMap((leg) => Object.values(leg).filter((v): v is string => typeof v === 'string'))
      const texts = [...(job.steps ?? []).map((s) => s.run ?? ''), ...matrixValues]
      it(`${file} ${name}: no step (nor a matrix value a step runs) starts node, npm, npx, tsx or corepack`, () => {
        for (const text of texts) {
          for (const line of text.split('\n')) {
            if (line.trim().startsWith('#')) continue
            expect(line, `${name}: ${line}`).not.toMatch(NODE_COMMAND)
          }
        }
      })
      it(`${file} ${name}: nor does any package script it runs, or one those run`, () => {
        for (const script of scriptsReached(texts)) {
          for (const part of commandsOf(SCRIPTS[script]!)) expect(part, `${name} runs \`bun run ${script}\`: ${part}`).not.toMatch(NODE_COMMAND)
        }
      })
    }
  }

  it('the jobs that keep Node really install it (else they belong in the Node-free list)', () => {
    for (const [file, jobs] of Object.entries(KEEPS_NODE)) {
      const doc = workflow(file)
      for (const name of Object.keys(jobs)) {
        expect(doc.jobs[name]?.steps?.some((s) => s.uses?.startsWith('actions/setup-node')), `${file} ${name}`).toBe(true)
      }
    }
  })
})

describe('package test scripts start bun, never Node', () => {
  const testScripts = Object.entries(SCRIPTS).filter(([k]) => /^(test|docs:check|search:)/.test(k))

  it('finds them', () => {
    expect(testScripts.map(([k]) => k)).toEqual(expect.arrayContaining(['test', 'test:quick', 'test:slow', 'test:e2e', 'test:baseline', 'test:frontend:ci']))
  })

  it.each(testScripts)('%s', (_name, cmd) => {
    for (const part of commandsOf(cmd)) {
      expect(part).not.toMatch(NODE_COMMAND)
      // vitest itself on bun: `bun --bun vitest` (bare name). `bun x vitest` and
      // `npx vitest` start it on Node, and `bun --bun ./node_modules/.bin/vitest`
      // leaves the children it starts on the Node on PATH.
      if (/\bvitest\b/.test(part) && !part.startsWith('bash ')) expect(part).toMatch(/(^|\s)bun --bun vitest(\s|$)/)
    }
  })
})

/** Test files that run npm: by name in a spawn, `command -v npm`, or npm-packages.mjs's packPackages. */
const RUNS_NPM = /\b(spawn|spawnSync|execFile|execFileSync|exec|execSync)\(\s*['"`](npm|npx)['"`]|\)\(\s*['"`](npm|npx)['"`]|command -v (npm|npx)\b|\bpackPackages\(/
const walkTests = (dir: string): string[] => fs.readdirSync(path.join(REPO, dir), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walkTests(path.join(dir, e.name)) : /\.test\.tsx?$/.test(e.name) ? [path.join(dir, e.name).split(path.sep).join('/')] : [])
let sources: Map<string, string> | null = null
/** Every test file but this one, with its text (read once). */
function testSources(): Map<string, string> {
  sources ??= new Map(walkTests('tests').filter((f) => f !== 'tests/scripts/ci-bun-only.test.ts').map((f) => [f, fs.readFileSync(path.join(REPO, f), 'utf8')]))
  return sources
}
const vitestPartsOf = (script: string) => commandsOf(script).filter((p) => /\bbun --bun vitest\b/.test(p))

describe('the npm tests: skipped where there is no npm, required where CI runs them', () => {
  const NPM_SCRIPTS = ['test:plugin-packages', 'test:npm-channel']

  it('the node-side job\'s scripts require npm, so their npm tests can never skip there', () => {
    for (const name of NPM_SCRIPTS) {
      expect(vitestPartsOf(SCRIPTS[name]!).length, name).toBeGreaterThan(0)
      for (const part of vitestPartsOf(SCRIPTS[name]!)) expect(part, name).toMatch(/^WALNUT_REQUIRE_NPM=1 bun --bun vitest run /)
    }
  })

  it('every test file that runs npm skips without it (npm-on-path.ts) and runs in a node-side script', () => {
    const users = [...testSources()].filter(([, text]) => RUNS_NPM.test(text))
    expect(users.length).toBeGreaterThan(3)
    const listed = NPM_SCRIPTS.map((n) => SCRIPTS[n]!).join(' ')
    for (const [f, text] of users) {
      expect(text, `${f} runs npm: gate it with npmOnPath() or userNode() from tests/helpers/npm-on-path.ts`).toMatch(/from '\.\.\/helpers\/npm-on-path\.js'/)
      expect(listed, `${f} runs npm: list it in ${NPM_SCRIPTS.join(' or ')}, which node-side runs`).toContain(f)
    }
  })

  it('npmOnPath: an executable npm on PATH, none, and none while required', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-on-path-'))
    try {
      const withNpm = path.join(root, 'with')
      const without = path.join(root, 'without')
      fs.mkdirSync(withNpm)
      fs.mkdirSync(without)
      fs.writeFileSync(path.join(withNpm, process.platform === 'win32' ? 'npm.cmd' : 'npm'), '#!/bin/sh\n', { mode: 0o755 })
      expect(npmOnPath({ PATH: [without, withNpm].join(path.delimiter) })).toBe(true)
      expect(npmOnPath({ PATH: without })).toBe(false)
      expect(() => npmOnPath({ PATH: without, WALNUT_REQUIRE_NPM: '1' })).toThrow(/WALNUT_REQUIRE_NPM=1, and there is no npm on PATH/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('scripts/bun-vitest.mjs', () => {
  it('starts vitest with the bun this script runs on, or the bun on PATH from Node', () => {
    expect(bunExecutable({ bun: '1.4.4' } as NodeJS.ProcessVersions, '/opt/bun/bin/bun')).toBe('/opt/bun/bin/bun')
    expect(bunExecutable({ node: '22.0.0' } as NodeJS.ProcessVersions, '/usr/bin/node')).toBe('bun')
  })

  it('always `bun --bun vitest <args>`', () => {
    expect(vitestCommand(['run', '--config', 'vitest.quick.config.ts']).args).toEqual(['--bun', 'vitest', 'run', '--config', 'vitest.quick.config.ts'])
    expect(vitestCommandLine(['run'])).toBe('bun --bun vitest run')
  })
})

describe('scripts/ci-remove-node.sh', () => {
  const tmp: string[] = []
  afterEach(() => {
    for (const d of tmp.splice(0)) {
      // A read-only dir from the cannot-remove case: writable again so it can go.
      for (const sub of fs.existsSync(d) ? fs.readdirSync(d) : []) fs.chmodSync(path.join(d, sub), 0o755)
      fs.rmSync(d, { recursive: true, force: true })
    }
  })

  /** A scratch tree: fake tool dirs, and a tools dir with rm, dirname and a sudo that only records. */
  function scratch(): { root: string; dir: (name: string, tools: string[]) => string; tools: string; sudoLog: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-remove-node-'))
    tmp.push(root)
    const tools = path.join(root, 'tools')
    fs.mkdirSync(tools)
    for (const name of ['rm', 'dirname']) {
      const real = ['/bin', '/usr/bin'].map((d) => path.join(d, name)).find((p) => fs.existsSync(p))
      if (!real) throw new Error(`no ${name} in /bin or /usr/bin`)
      fs.symlinkSync(real, path.join(tools, name))
    }
    const sudoLog = path.join(root, 'sudo.log')
    // Never the real sudo: this one writes its arguments down and does nothing.
    fs.writeFileSync(path.join(tools, 'sudo'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(sudoLog)}\n`, { mode: 0o755 })
    const dir = (name: string, names: string[]) => {
      const d = path.join(root, name)
      fs.mkdirSync(d)
      for (const n of names) fs.writeFileSync(path.join(d, n), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      return d
    }
    return { root, dir, tools, sudoLog }
  }

  const run = (dirs: string[], env: Record<string, string>) => spawnSync('/bin/bash', [REMOVE_NODE], {
    encoding: 'utf8',
    env: { PATH: dirs.join(path.delimiter), ...env },
    timeout: 30_000,
  })

  it('refuses to run anywhere but a GitHub-hosted runner (not self-hosted, not an emulator), and removes nothing', () => {
    const s = scratch()
    const a = s.dir('a', ['node', 'npm'])
    for (const env of [{}, { CI: 'true' }, { GITHUB_ACTIONS: 'true' }, { CI: '1', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' }, { CI: 'true', GITHUB_ACTIONS: 'true' }, { CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' }]) {
      const r = run([a, s.tools], env)
      expect(r.status, JSON.stringify(env)).toBe(2)
      expect(r.stderr).toContain('runs on GitHub-hosted runners only')
    }
    expect(fs.readdirSync(a).sort()).toEqual(['node', 'npm'])
  })

  it('removes every copy of node, npm, npx and corepack on PATH, and nothing else', () => {
    const s = scratch()
    const a = s.dir('a', ['node', 'npm', 'npx', 'corepack', 'bun'])
    const b = s.dir('b', ['node', 'npm', 'nodemon'])
    const r = run([a, b, s.tools], { CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' })
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(fs.readdirSync(a)).toEqual(['bun'])
    expect(fs.readdirSync(b)).toEqual(['nodemon'])
    expect(r.stdout).toContain(`removing node at ${path.join(b, 'node')}`)
    expect(r.stdout).toContain('no node, npm, npx or corepack on PATH: this job runs on bun alone')
    expect(fs.existsSync(s.sudoLog)).toBe(false)
  })

  it.skipIf(process.getuid?.() === 0)('fails the step when a copy stays on PATH', () => {
    const s = scratch()
    const locked = s.dir('locked', ['node'])
    fs.chmodSync(locked, 0o555)
    const r = run([locked, s.tools], { CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain(`::error::node is still on PATH (${path.join(locked, 'node')}) after removing it`)
    // A dir this user cannot write goes through sudo, a bounded number of times.
    const asked = fs.readFileSync(s.sudoLog, 'utf8').trim().split('\n')
    expect(asked[0]).toBe(`rm -f ${path.join(locked, 'node')}`)
    expect(asked.length).toBe(6)
  })
})

describe('the daemon\'s JS twin is checked on Node where CI has it', () => {
  it('test:source-twin-node requires Node and runs every suite whose source twin follows tests/helpers/source-twin.ts', () => {
    const script = SCRIPTS['test:source-twin-node']!
    expect(vitestPartsOf(script).length).toBeGreaterThan(0)
    for (const part of vitestPartsOf(script)) expect(part).toMatch(/^WALNUT_REQUIRE_NODE=1 bun --bun vitest run .* -t 'source twin \\\(node\\\)' /)
    const suites = [...testSources()].filter(([, text]) => text.includes('SOURCE_TWIN.file')).map(([f]) => f)
    expect(suites.length).toBeGreaterThan(10)
    for (const f of suites) expect(script, f).toContain(f)
  })
})
