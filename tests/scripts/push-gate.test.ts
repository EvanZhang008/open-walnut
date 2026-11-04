/**
 * The test gate before a push to main (scripts/push-gate.sh, run by .husky/pre-push).
 *
 * Each case builds a throwaway repository, points `walnut.testRunner` at a stub that records
 * the line it was asked to run and exits as told, and feeds the gate pre-push lines on stdin.
 * Nothing real runs: the stub never executes the test line.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')
const GATE = path.join(ROOT, 'scripts/push-gate.sh')
const ZERO = '0'.repeat(40)
const dirs: string[] = []
let verdictDirs = 0

/** The env every git and gate call gets: no global config, none of a hook's GIT_DIR and friends,
 *  and a verdict store of its own (a case that shares one passes it in `extra`). */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const verdicts = path.join(os.tmpdir(), `push-gate-verdicts-${process.pid}-${verdictDirs++}`)
  dirs.push(verdicts)
  const e: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', WALNUT_PUSH_GATE_VERDICTS: verdicts }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'WALNUT_PUSH_GATE']) delete e[k]
  return Object.assign(e, extra)
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv() })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

function write(repo: string, rel: string, body: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
  fs.writeFileSync(path.join(repo, rel), body)
}

/** A repository with one base commit, a stub runner, and the gate on unless `on` is false. */
function repo(opts: { on?: boolean; exit?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-gate-'))
  dirs.push(dir)
  const r = path.join(dir, 'repo')
  fs.mkdirSync(r)
  git(r, 'init', '-q', '-b', 'main')
  git(r, 'config', 'user.name', 'Gate Test')
  git(r, 'config', 'user.email', 'gate@example.invalid')
  write(r, 'README.md', 'base\n')
  write(r, 'tests/e2e/browser/helpers-x.ts', 'export const x = 1\n')
  write(r, 'tests/e2e/browser/uses-x.spec.ts', "import { x } from './helpers-x'\n")
  write(r, 'tests/e2e/browser/other.spec.ts', '// unrelated\n')
  write(r, 'tests/e2e/browser/fixtures/tiny.ts', 'export const t = 1\n')
  write(r, 'tests/e2e/browser/uses-tiny.spec.ts', "import { t } from './fixtures/tiny'\n")
  write(r, 'tests/e2e/browser/test-server.ts', '// the shared fixture\n')
  write(r, 'tests/e2e/browser/alone.spec.ts', "import { x } from './helpers-x.js'\n")
  write(r, 'tests/e2e/browser/alone.config.ts', "export default {\n  testMatch: ['alone.spec.ts'],\n}\n")
  git(r, 'add', '.')
  git(r, 'commit', '-q', '-m', 'base')
  const base = git(r, 'rev-parse', 'HEAD')
  const log = path.join(dir, 'runner.log')
  const stub = path.join(dir, 'runner.sh')
  fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(log)}\nexit ${opts.exit ?? 0}\n`, { mode: 0o755 })
  git(r, 'config', 'walnut.testRunner', stub)
  if (opts.on !== false) git(r, 'config', 'walnut.pushGate', 'true')
  return { r, base, log }
}

function commit(r: string, files: Record<string, string>, msg: string): string {
  for (const [rel, body] of Object.entries(files)) write(r, rel, body)
  git(r, 'add', '.')
  git(r, 'commit', '-q', '-m', msg)
  return git(r, 'rev-parse', 'HEAD')
}

function gate(r: string, stdin: string, env: Record<string, string> = {}) {
  return spawnSync('bash', [GATE], { cwd: r, input: stdin, encoding: 'utf8', env: cleanEnv(env) })
}

const line = (sha: string, remote: string, ref = 'refs/heads/main') => `refs/heads/main ${sha} ${ref} ${remote}\n`

afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

describe('push-gate.sh', () => {
  it('does nothing while it is off, and when one push turns it off', () => {
    const off = repo({ on: false })
    const tip = commit(off.r, { 'a.txt': '1\n' }, 'one')
    expect(gate(off.r, line(tip, off.base)).status).toBe(0)
    expect(fs.existsSync(off.log)).toBe(false)

    const on = repo()
    const tip2 = commit(on.r, { 'a.txt': '1\n' }, 'one')
    expect(gate(on.r, line(tip2, on.base), { WALNUT_PUSH_GATE: '0' }).status).toBe(0)
    expect(fs.existsSync(on.log)).toBe(false)
  })

  it('judges only a push to main, and not a deletion', () => {
    const { r, base, log } = repo()
    const tip = commit(r, { 'a.txt': '1\n' }, 'one')
    expect(gate(r, line(tip, base, 'refs/heads/feature')).status).toBe(0)
    expect(gate(r, line(ZERO, base)).status).toBe(0)
    expect(fs.existsSync(log)).toBe(false)
  })

  it('runs the quick and frontend tiers through the runner, and passes when they pass', () => {
    const { r, base, log } = repo()
    const tip = commit(r, { 'a.txt': '1\n' }, 'one')
    const out = gate(r, line(tip, base))
    expect(out.status, out.stdout + out.stderr).toBe(0)
    expect(out.stdout).toMatch(/Test gate passed/)
    const argv = fs.readFileSync(log, 'utf8')
    expect(argv).toMatch(/^sh\n-c\n/)
    expect(argv).toContain('scripts/test-baseline.mjs check --maxWorkers=4')
    expect(argv).toContain('test:frontend:ci')
    expect(argv).not.toContain('browser-baseline')
  })

  it('adds the browser specs the push touches: a changed spec, and one importing a changed helper', () => {
    const { r, base, log } = repo()
    const tip = commit(r, { 'tests/e2e/browser/helpers-x.ts': 'export const x = 2\n', 'tests/e2e/browser/new.spec.ts': '// new\n' }, 'browser')
    expect(gate(r, line(tip, base)).status).toBe(0)
    const argv = fs.readFileSync(log, 'utf8')
    expect(argv).toContain('bun run build >/dev/null && (cd web && bun x vite build >/dev/null)')
    expect(argv).toContain('browser-baseline.mjs check --run --retries=1')
    expect(argv).toContain('tests/e2e/browser/new.spec.ts')
    expect(argv).toContain('tests/e2e/browser/uses-x.spec.ts')
    expect(argv).not.toContain('other.spec.ts')
    // A side config's spec runs under that config, never the main one, even when its helper changed.
    expect(argv).not.toContain('alone.spec.ts')
  })

  it('maps a helper in a subfolder to its specs, and leaves the shared fixture to CI with a word', () => {
    const { r, base, log } = repo()
    const tip = commit(r, { 'tests/e2e/browser/fixtures/tiny.ts': 'export const t = 2\n', 'tests/e2e/browser/test-server.ts': '// changed\n' }, 'fixtures')
    const out = gate(r, line(tip, base))
    expect(out.status).toBe(0)
    expect(fs.readFileSync(log, 'utf8')).toContain('tests/e2e/browser/uses-tiny.spec.ts')
    expect(out.stdout).toMatch(/Left to CI's browser shards.*test-server\.ts/)
  })

  it('runs no browser spec when a helper maps to more than the cap, and says so', () => {
    const { r, base, log } = repo()
    const tip = commit(r, { 'tests/e2e/browser/helpers-x.ts': 'export const x = 3\n', 'tests/e2e/browser/new.spec.ts': '// new\n' }, 'wide')
    const out = gate(r, line(tip, base), { WALNUT_PUSH_GATE_MAX_SPECS: '1' })
    expect(out.status).toBe(0)
    expect(fs.readFileSync(log, 'utf8')).not.toContain('browser-baseline')
    expect(out.stdout).toMatch(/2 specs, over 1/)
  })

  it('refuses a push from a checkout that is not a clean copy of the pushed commit', () => {
    const { r, base, log } = repo()
    const tip = commit(r, { 'a.txt': '1\n' }, 'one')
    write(r, 'a.txt', 'uncommitted\n')
    const dirty = gate(r, line(tip, base))
    expect(dirty.status).toBe(1)
    expect(dirty.stdout).toMatch(/not a clean checkout of the commit being pushed/)
    git(r, 'checkout', '-q', '--', 'a.txt')
    expect(gate(r, line(base, base)).stdout).toMatch(/not a clean checkout/)   // HEAD is not the pushed commit
    expect(fs.existsSync(log)).toBe(false)
  })

  it('prints only the browser specs a commit touches with --specs, for the workflow browser job', () => {
    const { r, base } = repo()
    const tip = commit(r, { 'tests/e2e/browser/fixtures/tiny.ts': 'export const t = 3\n' }, 'tiny')
    const out = spawnSync('bash', [GATE, '--specs', base, tip], { cwd: r, encoding: 'utf8', env: cleanEnv() })
    expect(out.status).toBe(0)
    expect(out.stdout.trim()).toBe('tests/e2e/browser/uses-tiny.spec.ts')
  })

  it('turns on for one push with WALNUT_PUSH_GATE=1, and hands the runner no GIT_DIR', () => {
    const { r, base, log } = repo({ on: false })
    const tip = commit(r, { 'a.txt': '1\n' }, 'one')
    const stub = git(r, 'config', 'walnut.testRunner')
    fs.writeFileSync(stub, `#!/bin/sh\necho "GIT_DIR=\${GIT_DIR:-unset}" > ${JSON.stringify(log)}\n`, { mode: 0o755 })
    const out = gate(r, line(tip, base), { WALNUT_PUSH_GATE: '1', GIT_DIR: path.join(r, '.git') })
    expect(out.status, out.stdout + out.stderr).toBe(0)
    expect(fs.readFileSync(log, 'utf8')).toBe('GIT_DIR=unset\n')
  })

  it('refuses a failing push and names every commit it carries', () => {
    const { r, base } = repo({ exit: 1 })
    commit(r, { 'a.txt': '1\n' }, 'first change')
    const tip = commit(r, { 'b.txt': '2\n' }, 'second change')
    const out = gate(r, line(tip, base))
    expect(out.status).toBe(1)
    expect(out.stdout).toMatch(/Push blocked: the test gate failed/)
    expect(out.stdout).toMatch(/first change/)
    expect(out.stdout).toMatch(/second change/)
  })

  it('refuses the push when the runner cannot be reached, saying nothing was checked', () => {
    const { r, base } = repo({ exit: 255 })
    const tip = commit(r, { 'a.txt': '1\n' }, 'one')
    const out = gate(r, line(tip, base))
    expect(out.status).toBe(1)
    expect(out.stdout).toMatch(/could not run the tests \(exit 255\), so nothing was checked/)
  })

  it('still runs when GitHub main is not in this clone, naming only the tip', () => {
    const { r, log } = repo({ exit: 1 })
    const tip = commit(r, { 'a.txt': '1\n' }, 'the tip')
    const out = gate(r, line(tip, 'f'.repeat(40)))
    expect(out.status).toBe(1)
    expect(fs.existsSync(log)).toBe(true)
    expect(out.stdout).toMatch(/the tip/)
  })
})

/**
 * The GitHub path: no runner set. The remote's GitHub URL is rewritten (url.insteadOf) to a local
 * bare repository, and a stub `gh` answers from a file the case writes (the statuses before the
 * gate branch exists, and after), so nothing reaches the network.
 */
describe('push-gate.sh on GitHub', () => {
  const URL = 'https://github.com/acme/demo.git'
  const later = '2999-01-01T00:00:00Z'
  const RUN = 'https://github.com/acme/demo/actions/runs/77'
  function ghRepo(answers: { before?: unknown[]; statuses?: unknown[]; runs?: unknown[]; jobs?: unknown; log?: string; signedIn?: boolean }) {
    const g = repo()
    git(g.r, 'config', '--unset', 'walnut.testRunner')
    const dir = path.dirname(g.r)
    const bare = path.join(dir, 'remote.git')
    spawnSync('git', ['init', '-q', '--bare', bare], { env: cleanEnv() })
    git(g.r, 'config', `url.${bare}.insteadOf`, URL)
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(bin)
    const file = path.join(dir, 'answers.json')
    fs.writeFileSync(file, JSON.stringify({ before: [], statuses: [], runs: [{ id: 77, created_at: later }], jobs: { jobs: [] }, log: '', ...answers }))
    const seen = path.join(dir, 'gh-seen.log')
    const a = JSON.stringify(file)
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
[ "$1" = auth ] && { [ ${answers.signedIn === false ? 1 : 0} = 0 ]; exit $?; }
url=$2
gate=$(git --git-dir=${JSON.stringify(bare)} for-each-ref --format='%(refname)' refs/heads/gate)
echo "$url $gate" >> ${JSON.stringify(seen)}
case $url in
  *actions/runs\\?*) [ -n "$gate" ] && jq -c '{workflow_runs: .runs}' ${a} || echo '{"workflow_runs":[]}' ;;
  *statuses*) if [ -n "$gate" ]; then jq -c .statuses ${a}; else jq -c .before ${a}; fi ;;
  *jobs\\?*) jq -c .jobs ${a} ;;
  *logs) jq -r .log ${a} ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 })
    return { ...g, bare, seen, env: { PATH: `${bin}:${process.env.PATH}`, WALNUT_PUSH_GATE_POLL: '0', WALNUT_PUSH_GATE_TIMEOUT: '0' } }
  }
  const st = (context: string, state: string, description = '', target_url = RUN) => ({ context, state, description, created_at: later, target_url })
  const gateRun = (g: { r: string; base: string; env: Record<string, string> }, tip: string, url = URL) =>
    spawnSync('bash', [GATE, 'origin', url], { cwd: g.r, input: line(tip, g.base), encoding: 'utf8', env: cleanEnv(g.env) })
  const gateBranches = (bare: string) => spawnSync('git', ['--git-dir', bare, 'for-each-ref', 'refs/heads/gate'], { encoding: 'utf8' }).stdout

  it('lets the push through when its own run writes success, and deletes the gate branch', () => {
    const g = ghRepo({ statuses: [st('walnut/push-gate (quick 1/3)', 'success', 'passed'), st('walnut/push-gate', 'success', 'all 5 tiers passed')] })
    const tip = commit(g.r, { 'a.txt': '1\n' }, 'one')
    const out = gateRun(g, tip)
    expect(out.status, out.stdout + out.stderr).toBe(0)
    expect(out.stdout).toMatch(/Test gate passed\./)
    expect(fs.readFileSync(g.seen, 'utf8')).toContain(`refs/heads/gate/${tip.slice(0, 12)}`)
    expect(gateBranches(g.bare)).toBe('')
  })

  it('refuses a failing gate with the failing tests from the tier\'s job log, and the commits', () => {
    const g = ghRepo({
      statuses: [st('walnut/push-gate (quick 2/3)', 'failure', '1 NEW failure(s)'), st('walnut/push-gate (frontend)', 'success'), st('walnut/push-gate', 'failure', 'failed: quick 2/3')],
      jobs: { jobs: [{ id: 9, name: 'Gate (quick 2/3)' }] },
      log: '2026-11-04T00:00:00.0Z noise\n2026-11-04T00:00:01.0Z ✗ 1 NEW failure(s) — not in the baseline\n2026-11-04T00:00:02.0Z     tests/x.test.ts :: it breaks\n',
    })
    const tip = commit(g.r, { 'a.txt': '1\n' }, 'the breaking change')
    const out = gateRun(g, tip)
    expect(out.status).toBe(1)
    expect(out.stdout).toMatch(/failure {2}\(quick 2\/3\)/)
    expect(out.stdout).toMatch(/tests\/x\.test\.ts :: it breaks/)
    expect(out.stdout).toMatch(/the breaking change/)
    expect(gateBranches(g.bare)).toBe('')
  })

  it('decides from the tiers when the verdict job has not run: one failed tier refuses, every tier passed lets it through', () => {
    const tiers = ['quick 1/3', 'quick 2/3', 'quick 3/3', 'frontend', 'browser specs']
    const ok = ghRepo({ statuses: tiers.map((t) => st(`walnut/push-gate (${t})`, 'success', 'passed')) })
    const tip = commit(ok.r, { 'a.txt': '1\n' }, 'one')
    const pass = gateRun(ok, tip)
    expect(pass.status, pass.stdout + pass.stderr).toBe(0)
    expect(pass.stdout).toMatch(/Test gate passed\./)
    const some = ghRepo({ statuses: tiers.slice(0, 4).map((t) => st(`walnut/push-gate (${t})`, 'success', 'passed')) })
    const waiting = gateRun(some, commit(some.r, { 'a.txt': '1\n' }, 'one'))
    expect(waiting.status).toBe(1)
    expect(waiting.stdout).toMatch(/did not answer within 0 minutes/)
    const bad = ghRepo({ statuses: [st('walnut/push-gate (quick 1/3)', 'failure', '1 NEW failure(s)')], jobs: { jobs: [{ id: 9, name: 'Gate (quick 1/3)' }] }, log: 'x ✗ 1 NEW failure(s)\n    tests/y.test.ts :: it breaks\n' })
    const refused = gateRun(bad, commit(bad.r, { 'a.txt': '1\n' }, 'one'))
    expect(refused.status).toBe(1)
    expect(refused.stdout).toMatch(/tests\/y\.test\.ts :: it breaks/)
  })

  it('reads only its own run: another run\'s verdict of the same commit is no answer, and no answer in time refuses', () => {
    const g = ghRepo({ statuses: [st('walnut/push-gate', 'failure', 'from a cancelled run', 'https://github.com/acme/demo/actions/runs/76')] })
    const tip = commit(g.r, { 'a.txt': '1\n' }, 'one')
    const out = gateRun(g, tip)
    expect(out.status).toBe(1)
    expect(out.stdout).toMatch(/did not answer within 0 minutes, so nothing was judged \(gate\/[0-9a-f]{12}, run 77\)/)
  })

  it('passes at once when the commit already has a passing verdict, pushing no branch (walnut-cloud ran it first)', () => {
    const g = ghRepo({ before: [st('walnut/push-gate', 'success', 'all 5 tiers passed')] })
    const tip = commit(g.r, { 'a.txt': '1\n' }, 'one')
    const out = gateRun(g, tip)
    expect(out.status, out.stdout + out.stderr).toBe(0)
    expect(out.stdout).toMatch(/Test gate passed on [0-9a-f]+ \(https:\/\/github\.com\/acme\/demo\/actions\/runs\/77\)/)
    expect(fs.readFileSync(g.seen, 'utf8')).not.toContain('refs/heads/gate')
  })

  it('runs the gate for a commit\'s files with --run: one new commit on GitHub\'s main, never the commit\'s own history', () => {
    const g = ghRepo({ statuses: [st('walnut/push-gate', 'success', 'all 5 tiers passed')] })
    git(g.r, 'push', '-q', URL, 'main:main')
    const ghMain = git(g.r, 'rev-parse', 'HEAD')
    commit(g.r, { 'a.txt': '1\n' }, 'one')
    const tip = commit(g.r, { 'b.txt': '2\n' }, 'two')
    const out = spawnSync('bash', [GATE, '--run', URL, tip], { cwd: g.r, encoding: 'utf8', env: cleanEnv(g.env) })
    expect(out.status, out.stdout + out.stderr).toBe(0)
    expect(out.stdout).toMatch(/Test gate passed\./)
    const gated = fs.readFileSync(g.seen, 'utf8').match(/commits\/([0-9a-f]{40})\/statuses/)![1]
    expect(gated).not.toBe(tip)
    expect(git(g.r, 'rev-parse', `${gated}^`)).toBe(ghMain)
    expect(git(g.r, 'rev-parse', `${gated}^{tree}`)).toBe(git(g.r, 'rev-parse', `${tip}^{tree}`))
    expect(fs.readFileSync(g.seen, 'utf8')).toContain(`refs/heads/gate/${gated.slice(0, 12)}`)
  })

  it('passes the same files pushed as another commit at once, from the verdict --run kept', () => {
    const g = ghRepo({ statuses: [st('walnut/push-gate', 'success', 'all 5 tiers passed')] })
    git(g.r, 'push', '-q', URL, 'main:main')
    const verdicts = path.join(path.dirname(g.r), 'verdicts')
    const tip = commit(g.r, { 'a.txt': '1\n' }, 'one')
    const run = spawnSync('bash', [GATE, '--run', URL, tip], { cwd: g.r, encoding: 'utf8', env: cleanEnv({ ...g.env, WALNUT_PUSH_GATE_VERDICTS: verdicts }) })
    expect(run.status, run.stdout + run.stderr).toBe(0)
    git(g.r, 'commit', '-q', '--amend', '-m', 'the same files, replayed')
    const replay = git(g.r, 'rev-parse', 'HEAD')
    fs.rmSync(g.seen)
    const out = spawnSync('bash', [GATE, 'origin', URL], { cwd: g.r, input: line(replay, g.base), encoding: 'utf8', env: cleanEnv({ ...g.env, WALNUT_PUSH_GATE_VERDICTS: verdicts }) })
    expect(out.status, out.stdout + out.stderr).toBe(0)
    expect(out.stdout).toMatch(/Test gate passed on these files \(https:\/\/github\.com\/acme\/demo\/actions\/runs\/77\)/)
    expect(fs.existsSync(g.seen)).toBe(false)
    // Other files are judged again.
    const other = commit(g.r, { 'c.txt': '3\n' }, 'three')
    const again = spawnSync('bash', [GATE, 'origin', URL], { cwd: g.r, input: line(other, g.base), encoding: 'utf8', env: cleanEnv({ ...g.env, WALNUT_PUSH_GATE_VERDICTS: verdicts }) })
    expect(again.status, again.stdout + again.stderr).toBe(0)
    expect(fs.readFileSync(g.seen, 'utf8')).toContain('refs/heads/gate/')
  })

  it('judges nothing with --run when GitHub\'s main already has the files', () => {
    const g = ghRepo({})
    const tip = git(g.r, 'rev-parse', 'HEAD')
    git(g.r, 'push', '-q', URL, 'main:main')
    const out = spawnSync('bash', [GATE, '--run', URL, tip], { cwd: g.r, encoding: 'utf8', env: cleanEnv(g.env) })
    expect(out.status, out.stdout + out.stderr).toBe(0)
    expect(out.stdout).toMatch(/already has these files/)
    expect(fs.existsSync(g.seen)).toBe(false)
  })

  it('judges no push to a remote that is not on GitHub, and never prints a token in a URL', () => {
    const g = ghRepo({})
    const tip = commit(g.r, { 'a.txt': '1\n' }, 'one')
    const local = gateRun(g, tip, '/srv/git/demo.git')
    expect(local.status).toBe(0)
    expect(local.stdout).toMatch(/not a GitHub repository/)
    expect(fs.existsSync(g.seen)).toBe(false)
    const other = gateRun(g, tip, 'https://user:secret-token@git.example.com/acme/demo.git')
    expect(other.status).toBe(0)
    expect(other.stdout).not.toContain('secret-token')
  })

  it('refuses when gh is not signed in, before pushing anything', () => {
    const g = ghRepo({ signedIn: false })
    const tip = commit(g.r, { 'a.txt': '1\n' }, 'one')
    const out = gateRun(g, tip)
    expect(out.status).toBe(1)
    expect(out.stdout).toMatch(/not signed in/)
    expect(gateBranches(g.bare)).toBe('')
  })
})

/** push-gate-status.sh, the workflow's status writer, against a stub gh that records each write. */
describe('push-gate-status.sh', () => {
  const STATUS = path.join(ROOT, 'scripts/push-gate-status.sh')
  function stub(statuses: unknown[]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-gate-status-'))
    dirs.push(dir)
    const posts = path.join(dir, 'posts.log')
    fs.writeFileSync(path.join(dir, 'statuses.json'), JSON.stringify(statuses))
    fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/sh
if [ "$2" = -X ]; then shift 4; echo "$*" >> ${JSON.stringify(posts)}; exit 0; fi
cat ${JSON.stringify(path.join(dir, 'statuses.json'))}
`, { mode: 0o755 })
    const env = cleanEnv({ PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: 'acme/demo', GITHUB_SHA: 'a'.repeat(40), GITHUB_SERVER_URL: 'https://github.com', GITHUB_RUN_ID: '77' })
    return { dir, posts, env }
  }
  const run = (env: NodeJS.ProcessEnv, args: string[], extra: Record<string, string> = {}) =>
    spawnSync('bash', [STATUS, ...args], { encoding: 'utf8', env: { ...env, ...extra } })
  const mine = (tier: string, state: string, url = 'https://github.com/acme/demo/actions/runs/77') =>
    ({ context: `walnut/push-gate (${tier})`, state, updated_at: '2026-11-04T00:00:00Z', target_url: url })
  const five = ['quick 1/3', 'quick 2/3', 'quick 3/3', 'frontend', 'browser specs']

  it('writes a tier\'s outcome with test-baseline\'s verdict line as its description', () => {
    const s = stub([])
    const out = path.join(s.dir, 'out.txt')
    fs.writeFileSync(out, 'lots of output\n✗ 2 NEW failure(s) — not in the baseline\n::group::Full message: tests/x.test.ts :: failed to load\n')
    expect(run(s.env, [out], { OUTCOME: 'failure', CONTEXT: 'walnut/push-gate (quick 1/3)' }).status).toBe(0)
    expect(run(s.env, [out], { OUTCOME: 'skipped', CONTEXT: 'walnut/push-gate (frontend)' }).status).toBe(0)
    const posts = fs.readFileSync(s.posts, 'utf8')
    expect(posts).toMatch(/state=failure -f context=walnut\/push-gate \(quick 1\/3\) -f description=✗ 2 NEW failure/)
    expect(posts).toMatch(/state=failure -f context=walnut\/push-gate \(frontend\) -f description=did not run \(skipped\)/)
  })

  it('passes the verdict only for every tier of this run passing and every job ending well', () => {
    const ok = stub(five.map((t) => mine(t, 'success')))
    run(ok.env, ['--verdict'], { NEEDS: 'success success' })
    expect(fs.readFileSync(ok.posts, 'utf8')).toMatch(/state=success -f context=walnut\/push-gate -f description=all 5 tiers passed/)

    const other = stub([...five.slice(0, 4).map((t) => mine(t, 'success')), mine('browser specs', 'success', 'https://github.com/acme/demo/actions/runs/76')])
    run(other.env, ['--verdict'], { NEEDS: 'success success' })
    expect(fs.readFileSync(other.posts, 'utf8')).toMatch(/state=failure .*4 of 5 tiers reported/)

    const job = stub(five.map((t) => mine(t, 'success')))
    run(job.env, ['--verdict'], { NEEDS: 'success failure' })
    expect(fs.readFileSync(job.posts, 'utf8')).toMatch(/state=failure .*jobs: success failure/)

    const bad = stub(five.map((t) => mine(t, t === 'frontend' ? 'failure' : 'success')))
    run(bad.env, ['--verdict'], { NEEDS: 'success success' })
    expect(fs.readFileSync(bad.posts, 'utf8')).toMatch(/state=failure .*description=failed: frontend/)
  })
})

describe('the pre-push hook', () => {
  const hook = fs.readFileSync(path.join(ROOT, '.husky/pre-push'), 'utf8')
  it('reads the pushed refs once and gives them to the scanner and to the gate', () => {
    expect(hook).toMatch(/^refs=\$\(cat\)$/m)
    expect(hook).toMatch(/printf '%s\\n' "\$refs" \| "\$scanner"/)
    expect(hook).toMatch(/printf '%s\\n' "\$refs" \| bash scripts\/push-gate\.sh "\$@" \|\| exit 1/)
    // The gate runs after the scanner: a leak is refused before minutes of tests.
    expect(hook.indexOf('| bash scripts/push-gate.sh')).toBeGreaterThan(hook.indexOf('| "$scanner"'))
  })
})
