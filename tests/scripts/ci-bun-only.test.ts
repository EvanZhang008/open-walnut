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
    'node-side': 'the Playwright runner (spec load), a plugin author\'s npm toolchain, the npm channel, the JS daemon on Node (every suite that starts it)',
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

describe('the Playwright fixtures start Walnut on bun', () => {
  // The runner itself stays on Node, so a spec that starts its server through tsx or node
  // runs Walnut on that Node, which has no SQLite Walnut uses: the server refuses to start.
  const CALL = String.raw`(?:\b(?:spawn|spawnSync|execFile|execFileSync|fork)|\bpromisify\(\s*(?:execFile|exec)\s*\))\(\s*`
  const SPAWNS_NODE = new RegExp(CALL + String.raw`['"\x60][^'"\x60]*\b(node|npx|tsx)['"\x60]`)
  // In a spec, process.execPath is the runner's Node: a Walnut entry started with it runs on Node.
  const WALNUT_ON_RUNNER = new RegExp(CALL + String.raw`process\.execPath\s*,\s*\[\s*['"\x60](?:\./)?(?:dist/cli\.js|src/)`)
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : /\.([cm]?[jt]s)$/.test(e.name) ? [path.join(d, e.name)] : [])
  const files = walk(path.join(REPO, 'tests', 'e2e', 'browser'))

  it('no spec or fixture spawns node, npx or tsx, or starts Walnut on the runner (bunRuntime() from tests/helpers/bun-runtime.ts)', () => {
    expect(files.length).toBeGreaterThan(50)
    const offenders = files.filter((f) => {
      const text = fs.readFileSync(f, 'utf8')
      return SPAWNS_NODE.test(text) || (/\.spec\.ts$/.test(f) && WALNUT_ON_RUNNER.test(text))
    }).map((f) => path.relative(REPO, f))
    expect(offenders).toEqual([])
  })

  it('the check catches the forms a spec used', () => {
    for (const bad of ["spawn('./node_modules/.bin/tsx', [", "execFileSync('node', [", 'spawn(`npx`, [', "promisify(execFile)('node', ["]) expect(bad).toMatch(SPAWNS_NODE)
    for (const good of ["spawn(bunRuntime(), [", "execFileSync('git', [", "spawn('nodemon-free', ["]) expect(good).not.toMatch(SPAWNS_NODE)
    for (const bad of ["promisify(execFile)(process.execPath, ['dist/cli.js', 'tools'", "spawn(process.execPath, ['src/cli.ts'", "execFileSync(process.execPath, ['./dist/cli.js'"]) expect(bad).toMatch(WALNUT_ON_RUNNER)
    for (const good of ["promisify(execFile)(bunRuntime(), ['dist/cli.js'", "args: [process.execPath, path.resolve(dir, 'mock-claude.mjs')]", "spawn(process.execPath, [MOCK_CLI"]) expect(good).not.toMatch(WALNUT_ON_RUNNER)
  })
})

/** The runtimes a test starts bun with: the runner's own, or the bun on PATH. */
const BUN_RUNTIME = String.raw`(?:process\.execPath|HOST_RUNTIME|bunRuntime\(\))`
/** The JS twin started on bun, in the forms the twin suites used before tests/helpers/source-twin.ts. */
const TWIN_ON_BUN = [
  // spawn(<bun>, [script, '--start']), [<bun>, [sourceDaemonScript(), '--start']], [<bun>, script, '--start'], spawn(<bun>, [twin, 'wn', ...])
  new RegExp(BUN_RUNTIME + String.raw`\s*,\s*\[?\s*[\w.]+(?:\([^()]*\))?\s*,\s*['"](?:--start|--service|--status|--stop|--version|wn|walnut)['"]`, 'g'),
  // spawn(binary ?? <bun>, [...(binary ? [] : [path.join(home, 'daemon.cjs')]), '--start'])
  new RegExp(BUN_RUNTIME + String.raw`\s*,\s*\[(?:\[\]|[^\]])*?\bdaemon[\w-]*\.cjs`, 'g'),
  // spawn(twin === 'source' ? <bun> : BUN!, args)
  new RegExp(String.raw`['"]source['"]\s*\?\s*` + BUN_RUNTIME, 'g'),
  // twin === 'standalone' ? [BUN!, [...]] : [<bun>, [script]]
  new RegExp(String.raw`\[\s*` + BUN_RUNTIME + String.raw`\s*,\s*\[\s*\w*[sS]cript\w*\s*\]\s*\]`, 'g'),
]
function twinOnBun(text: string): string[] {
  const hits: string[] = []
  for (const re of TWIN_ON_BUN) {
    for (const m of text.matchAll(re)) {
      const end = text.indexOf('\n', m.index)
      const line = text.slice(text.lastIndexOf('\n', m.index) + 1, end === -1 ? undefined : end)
      // A deliberate bun leg names itself; the standalone twin is bun's own.
      if (line.includes('source twin (bun)') || m[0].includes('daemon-standalone')) continue
      hits.push(m[0])
    }
  }
  return hits
}
/** Every script under tests (test files and the helpers they share), but this one. */
const walkScripts = (dir: string): string[] => fs.readdirSync(path.join(REPO, dir), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walkScripts(path.join(dir, e.name)) : /\.[cm]?[jt]s$/.test(e.name) ? [path.join(dir, e.name).split(path.sep).join('/')] : [])
/** Helpers that start the JS twin with SOURCE_TWIN.file, and the calls of theirs that start it. */
const TWIN_HELPERS: Record<string, RegExp> = {
  'tests/helpers/daemon-twin.ts': /\bstartDaemonTwin\(/,
  'tests/helpers/host-alone-harness.ts': /\bstartHostAloneHarness\(/,
  'tests/helpers/replica-cluster.ts': /\bstart(?:ReplicaCluster|HostDaemon)\(/,
}
const TWIN_SCRIPTS = ['test:source-twin-node', 'test:source-twin-node-suites']
/** Twin suites node-side leaves out, each for a reason. */
const TWIN_ELSEWHERE: Record<string, string> = {
  'tests/e2e/session-budget.test.ts': 'pins the daemon-darwin-arm64 build and a budget-e2e-manifest.json that no build step writes; it runs where those exist',
  'tests/e2e/session-budget-acp.test.ts': 'pins the daemon-darwin-arm64 build and a budget-e2e-manifest.json that no build step writes; it runs where those exist',
}

describe('the daemon\'s JS twin is checked on Node where CI has it', () => {
  it('test:source-twin-node requires Node and runs the node cases of the suites that run both twins', () => {
    const script = SCRIPTS['test:source-twin-node']!
    expect(vitestPartsOf(script).length).toBeGreaterThan(0)
    for (const part of vitestPartsOf(script)) expect(part).toMatch(/^WALNUT_REQUIRE_NODE=1 bun --bun vitest run .* -t 'source twin \\\(node\\\)' /)
  })

  it('test:source-twin-node-suites requires Node, and node-side runs it', () => {
    const script = SCRIPTS['test:source-twin-node-suites']!
    expect(vitestPartsOf(script).length).toBeGreaterThan(0)
    // One worker, as the other heavy tiers: these suites start servers, daemons and timed windows.
    for (const part of vitestPartsOf(script)) expect(part).toMatch(/^WALNUT_REQUIRE_NODE=1 bun --bun vitest run .*--maxWorkers=1 /)
    const runs = (workflow('ci.yml').jobs['node-side']!.steps ?? []).map((s) => s.run ?? '')
    expect(runs).toContain('bun run test:source-twin-node-suites')
  })

  it('every file those scripts name exists (vitest skips a filter that matches nothing)', () => {
    for (const name of TWIN_SCRIPTS) {
      const named = SCRIPTS[name]!.split(/\s+/).filter((w) => /^tests\/.+\.test\.ts$/.test(w))
      expect(named.length, name).toBeGreaterThan(10)
      for (const f of named) expect(fs.existsSync(path.join(REPO, f)), `${name}: ${f}`).toBe(true)
    }
  })

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

  it('no test file or helper starts the JS twin on bun (SOURCE_TWIN.file from tests/helpers/source-twin.ts)', () => {
    const twinFiles = walkScripts('tests').filter((f) => f !== 'tests/scripts/ci-bun-only.test.ts')
      .map((f) => [f, fs.readFileSync(path.join(REPO, f), 'utf8')] as const)
      .filter(([, text]) => /getDaemonSource|daemon-source|\bdaemon[\w-]*\.cjs/.test(text))
    expect(twinFiles.length).toBeGreaterThan(60)
    const offenders = twinFiles.flatMap(([f, text]) => twinOnBun(text).map((hit) => `${f}: ${hit}`))
    expect(offenders).toEqual([])
  })

  it('the check catches the forms a test used', () => {
    for (const bad of [
      "spawn(process.execPath, [script, '--start'], { env })",
      "command: () => [process.execPath, [sourceDaemonScript(dir), '--start']]",
      "daemonArgv = [process.execPath, script, '--start']",
      "spawn(process.execPath, [twin, 'wn', 'tools', 'list'])",
      "spawn(HOST_RUNTIME, [script, '--start'])",
      ": [process.execPath, [path.join(BIN, 'daemon.cjs'), '--start']]",
      "spawn(daemonBinary ?? process.execPath, [\n    ...(daemonBinary ? [] : [path.join(HOME, 'daemon.cjs')]), '--start'])",
      "spawn(twin === 'source' ? process.execPath : BUN!, args)",
      "twin === 'standalone' ? [BUN!, [standalone]] : [process.execPath, [script]]",
    ]) expect(twinOnBun(bad), bad).not.toEqual([])
    for (const good of [
      "spawn(SOURCE_TWIN.file, [script, '--start'], { env })",
      "args: [process.execPath, mock, sid]",
      "workerCmd: [process.execPath, WORKER_BUNDLE]",
      "spawn(process.execPath, [FAKE, '-p'])",
      "spawn(process.execPath, ['-e', snippet])",
      "spawn(process.execPath, [script, cfgFile])",
      "spawn(BUN!, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start'])",
      "spawn(process.execPath, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start'])",
      "{ name: 'source twin (bun)', command: () => [process.execPath, [path.join(dir, 'daemon.cjs'), '--start']] }",
    ]) expect(twinOnBun(good), good).toEqual([])
  })
})
