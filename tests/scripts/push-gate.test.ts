/**
 * The test gate before a push to main (scripts/push-gate.sh, run by .husky/pre-push).
 *
 * Each case builds a throwaway repository, points `walnut.testRunner` at a stub that records
 * the line it was asked to run and exits as told, and feeds the gate pre-push lines on stdin.
 * Nothing real runs: the stub never executes the test line.
 */
import { spawn, spawnSync } from 'node:child_process'
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
  const e: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', WALNUT_PUSH_GATE_VERDICTS: verdicts, WALNUT_FLAKY_LOG: path.join(verdicts, 'flaky.jsonl'),
    // No real wait between GitHub reads: a fixture's job list is empty unless the test names jobs.
    WALNUT_PUSH_GATE_LOG_RETRY_SECS: '0' }
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
  function ghRepo(answers: { before?: unknown[]; statuses?: unknown[]; runs?: unknown[]; jobs?: unknown; log?: string; logAfter?: number; signedIn?: boolean; dispatch?: 'ok' | '422' | '500'; annotations?: unknown[] }) {
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
gate=$(git --git-dir=${JSON.stringify(bare)} for-each-ref --format='%(refname)' refs/heads/gate refs/gate)
hidden=$(git --git-dir=${JSON.stringify(bare)} for-each-ref --format='%(objectname)' refs/gate | head -1)
echo "$url $gate" >> ${JSON.stringify(seen)}
case $url in
  *dispatches) echo "dispatch $*" >> ${JSON.stringify(seen)}
    case ${JSON.stringify(answers.dispatch ?? 'ok')} in
      422) echo "HTTP 422: Workflow does not have 'workflow_dispatch' trigger" >&2; exit 1 ;;
      500) echo "HTTP 500: Server Error" >&2; exit 1 ;;
    esac ;;
  *workflows/push-gate.yml/runs\\?*) [ -n "$hidden" ] && jq -c --arg t "Push gate $hidden" '{workflow_runs: [.runs[] | . + {display_title: (.display_title // $t)}]}' ${a} || echo '{"workflow_runs":[]}' ;;
  *actions/runs\\?*) [ -n "$gate" ] && jq -c '{workflow_runs: .runs}' ${a} || echo '{"workflow_runs":[]}' ;;
  *statuses*) if [ -n "$gate" ]; then jq -c .statuses ${a}; else jq -c .before ${a}; fi ;;
  *jobs\\?*) jq -c .jobs ${a} ;;
  *annotations*) jq -c '.annotations // []' ${a} ;;
  *logs) n=$(cat ${JSON.stringify(path.join(dir, 'log-asks'))} 2>/dev/null || echo 0); echo $((n + 1)) > ${JSON.stringify(path.join(dir, 'log-asks'))}
    [ "$n" -lt "$(jq -r '.logAfter // 0' ${a})" ] || jq -r .log ${a} ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 })
    return { ...g, bare, seen, env: { PATH: `${bin}:${process.env.PATH}`, WALNUT_PUSH_GATE_POLL: '0', WALNUT_PUSH_GATE_TIMEOUT: '0', WALNUT_GATE_SWEEP: '0' } }
  }
  const st = (context: string, state: string, description = '', target_url = RUN) => ({ context, state, description, created_at: later, target_url })
  const gateRun = (g: { r: string; base: string; env: Record<string, string> }, tip: string, url = URL) =>
    spawnSync('bash', [GATE, 'origin', url], { cwd: g.r, input: line(tip, g.base), encoding: 'utf8', env: cleanEnv(g.env) })
  /** Every gate ref on the remote: the hidden `refs/gate/*` and the older `gate/*` branches. */
  const gateBranches = (bare: string) => spawnSync('git', ['--git-dir', bare, 'for-each-ref', 'refs/heads/gate', 'refs/gate'], { encoding: 'utf8' }).stdout

  it('lets the push through when its own run writes success, and deletes the gate ref', () => {
    const g = ghRepo({ statuses: [st('walnut/push-gate (quick 1/3)', 'success', 'passed'), st('walnut/push-gate', 'success', 'all 5 tiers passed')] })
    const tip = commit(g.r, { 'a.txt': '1\n' }, 'one')
    const out = gateRun(g, tip)
    expect(out.status, out.stdout + out.stderr).toBe(0)
    expect(out.stdout).toMatch(/Test gate passed\./)
    expect(fs.readFileSync(g.seen, 'utf8')).toContain(`refs/gate/${tip.slice(0, 12)}`)
    expect(gateBranches(g.bare)).toBe('')
  })

  // 2026-11-07, the user, of the repository's page: "why has so many of this" (a "gate/<sha> had
  // recent pushes / Compare & pull request" banner per gate run).
  it('runs on a hidden ref GitHub shows nowhere, dispatching the gate workflow on main for its commit', () => {
    // A newer dispatched run of another commit is not this one's: only run 77 wrote the statuses.
    const g = ghRepo({
      statuses: [st('walnut/push-gate', 'success', 'all 5 tiers passed')],
      runs: [{ id: 77, created_at: later }, { id: 78, created_at: '2999-06-01T00:00:00Z', display_title: `Push gate ${'f'.repeat(40)}` }],
    })
    const tip = commit(g.r, { 'a.txt': '1\n' }, 'one')
    const out = gateRun(g, tip)
    expect(out.status, out.stdout + out.stderr).toBe(0)
    const seen = fs.readFileSync(g.seen, 'utf8')
    expect(seen).toContain(`dispatch api repos/acme/demo/actions/workflows/push-gate.yml/dispatches -X POST -f ref=main -f inputs[sha]=${tip}`)
    expect(seen).toMatch(new RegExp(`refs/gate/${tip.slice(0, 12)}-\\d{10}\\b`))
    expect(seen).not.toContain('refs/heads/gate')
    expect(gateBranches(g.bare)).toBe('')
  })

  it('falls back to the gate branch only when GitHub\'s main takes no dispatch yet, and deletes it', () => {
    const g = ghRepo({ dispatch: '422', statuses: [st('walnut/push-gate', 'success', 'all 5 tiers passed')] })
    const tip = commit(g.r, { 'a.txt': '1\n' }, 'one')
    const out = gateRun(g, tip)
    expect(out.status, out.stdout + out.stderr).toBe(0)
    expect(fs.readFileSync(g.seen, 'utf8')).toContain(`refs/heads/gate/${tip.slice(0, 12)}`)
    expect(gateBranches(g.bare)).toBe('')
  })

  it('records a run\'s flaky tests, and refuses the push once the same file was flaky twice in a week', () => {
    const flaky = { title: 'Flaky test', message: 'tests/t.test.ts :: races its timer' }
    const g = ghRepo({ statuses: [st('walnut/push-gate', 'success', 'all 10 tiers passed')], jobs: { jobs: [{ id: 9, name: 'Gate (quick 1/8)' }] }, annotations: [flaky] })
    fs.mkdirSync(path.join(g.r, 'scripts'), { recursive: true })
    fs.copyFileSync(path.join(ROOT, 'scripts/flaky-log.mjs'), path.join(g.r, 'scripts/flaky-log.mjs'))
    const flakyLog = path.join(path.dirname(g.r), 'flaky.jsonl')
    const env = { ...g.env, WALNUT_FLAKY_LOG: flakyLog }
    const run = (tip: string) => spawnSync('bash', [GATE, 'origin', URL], { cwd: g.r, input: line(tip, g.base), encoding: 'utf8', env: cleanEnv(env) })
    const first = run(commit(g.r, { 'tests/t.test.ts': 'it("races its timer")\n', 't.txt': '1\n' }, 'one'))
    expect(first.status, first.stdout + first.stderr).toBe(0)
    expect(first.stdout).toMatch(/Flaky in this run[\s\S]*tests\/t\.test\.ts :: races its timer/)
    expect(fs.readFileSync(flakyLog, 'utf8')).toContain('"file":"tests/t.test.ts"')
    const second = run(commit(g.r, { 't.txt': '2\n' }, 'two'))
    expect(second.status).toBe(1)
    expect(second.stdout).toMatch(/failed and then passed alone 2 or more times in 7 days[\s\S]*tests\/t\.test\.ts/)
  })

  it('tries a failed dispatch once more and stays off the branch (a timeout may have started the run)', () => {
    const g = ghRepo({ dispatch: '500', statuses: [st('walnut/push-gate', 'success', 'all 5 tiers passed')] })
    const tip = commit(g.r, { 'a.txt': '1\n' }, 'one')
    const out = gateRun(g, tip)
    expect(out.status, out.stdout + out.stderr).toBe(0)
    const seen = fs.readFileSync(g.seen, 'utf8')
    expect(seen.match(/^dispatch /gm)).toHaveLength(2)
    expect(seen).not.toContain('refs/heads/gate')
    expect(gateBranches(g.bare)).toBe('')
  })

  it('runs a commit that changes the gate workflow on its own copy, on the gate branch (a dispatch runs main\'s)', () => {
    const g = ghRepo({ statuses: [st('walnut/push-gate', 'success', 'all 5 tiers passed')] })
    const tip = commit(g.r, { '.github/workflows/push-gate.yml': 'name: Push gate\n# a sixth tier\n' }, 'gate: a new tier')
    const out = gateRun(g, tip)
    expect(out.status, out.stdout + out.stderr).toBe(0)
    const seen = fs.readFileSync(g.seen, 'utf8')
    expect(seen).not.toMatch(/^dispatch /m)
    expect(seen).toContain(`refs/heads/gate/${tip.slice(0, 12)}`)
    expect(gateBranches(g.bare)).toBe('')
  })

  it('deletes its gate ref when a signal stops it mid-wait (a land stopped mid-gate left its branch)', async () => {
    const g = ghRepo({})
    const tip = commit(g.r, { 'a.txt': '1\n' }, 'one')
    const child = spawn('bash', [GATE, 'origin', URL], { cwd: g.r, env: cleanEnv({ ...g.env, WALNUT_PUSH_GATE_POLL: '30', WALNUT_PUSH_GATE_TIMEOUT: '30' }) })
    child.stdin.end(line(tip, g.base))
    const ended = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)))
    const deadline = Date.now() + 20_000
    while (!gateBranches(g.bare) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
    expect(gateBranches(g.bare)).toContain(`refs/gate/${tip.slice(0, 12)}`)
    const stopped = Date.now()
    child.kill('SIGTERM')
    expect(await ended).toBe(130)
    // At once, not after the 30 s poll sleep.
    expect(Date.now() - stopped).toBeLessThan(10_000)
    expect(gateBranches(g.bare)).toBe('')
  }, 40_000)

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

  it('reads a land tier\'s failures from test-layers\' list in its job log, and a land\'s frontend tier from its first job', () => {
    const g = ghRepo({
      statuses: [st('walnut/push-gate (land 1/1)', 'failure', '[test-layers] failed: 9 file(s) in 30 s'), st('walnut/push-gate (frontend)', 'failure', 'failed')],
      jobs: { jobs: [{ id: 9, name: 'Gate (land 1/1)' }] },
      log: [' FAIL  tests/x.test.ts > it breaks', 'noise', '[test-layers] FAILED: 1 test(s) failed twice:', '  tests/x.test.ts :: it breaks', '[test-layers] failed: 9 file(s) in 30 s',
        '##[group]Run set -o pipefail', 'bun run test:frontend:ci 2>&1 | tee x', ' FAIL  web markdown > renders', '##[group]Run bash scripts/push-gate-status.sh'].map((l) => `2026-11-09T00:00:00.0Z ${l}`).join('\n') + '\n',
    })
    const out = gateRun(g, commit(g.r, { 'a.txt': '1\n' }, 'one'))
    expect(out.status).toBe(1)
    // Each tier's section runs to the next one (the tiers come in name order).
    const section = (name: string) => out.stdout.slice(out.stdout.indexOf(`── ${name}`)).split(/\n(?=── )/)[0]!
    const land = section('land 1/1')
    expect(land).toMatch(/^\[test-layers\] FAILED: 1 test\(s\) failed twice:\n {2}tests\/x\.test\.ts :: it breaks\n\[test-layers\] failed: 9 file\(s\)/m)
    expect(land).not.toMatch(/noise|web markdown/)
    expect(section('frontend')).toMatch(/FAIL {2}web markdown > renders/)
    expect(section('frontend')).not.toMatch(/tests\/x\.test\.ts/)
  })

  it('refuses a commit whose iOS app does not build, naming the compiler errors from the iOS build job', () => {
    // 2026-11-09: a Swift compile error reached main; the gate's iOS build names no test, only errors.
    const err = '/Users/runner/work/demo/demo/ios-native/Walnut/Board.swift:12:5: error: value of type \'Row\' has no member \'pinned\''
    const g = ghRepo({
      statuses: [st('walnut/push-gate (iOS build)', 'failure', 'the iOS app failed to build: Walnut/Board.swift:12:5: error: x'), st('walnut/push-gate', 'failure', 'failed: iOS build')],
      jobs: { jobs: [{ id: 9, name: 'Gate (iOS build)' }] },
      // The job log echoes the step's script under its group header; none of it is an error.
      log: ['##[group]Run set -o pipefail', '{ grep -aE \': error: \' "$RUNNER_TEMP/build.txt" || true; } | sort -u', '  echo "the iOS app failed to build: ${e:-xcodebuild exited $rc}"', err, '** TEST BUILD FAILED **', err, 'the iOS app failed to build: Walnut/Board.swift:12:5: error: x'].map((l) => `2026-11-09T00:00:00.0Z ${l}`).join('\n') + '\n',
    })
    const out = gateRun(g, commit(g.r, { 'ios-native/a.swift': '1\n' }, 'one'))
    expect(out.status).toBe(1)
    const section = out.stdout.slice(out.stdout.indexOf('── iOS build'))
    expect(section.split(err).length - 1).toBe(1)
    expect(section).toMatch(/the iOS app failed to build/)
    expect(section).not.toMatch(/TEST BUILD FAILED|##\[group\]|grep|echo/)
  })

  it('says so for a failed tier whose job GitHub does not list, never skipping it without a word', () => {
    // 2026-11-10: the job list came back without the tier under load, every failed tier was skipped,
    // and a land was refused with "the failing tests are listed above" and none listed.
    const g = ghRepo({
      statuses: [st('walnut/push-gate (quick 7/8)', 'failure', '1 NEW failure(s)'), st('walnut/push-gate', 'failure', 'failed: quick 7/8')],
      jobs: { jobs: [] },
    })
    const out = spawnSync('bash', [GATE, 'origin', URL], { cwd: g.r, input: line(commit(g.r, { 'a.txt': '1\n' }, 'one'), g.base), encoding: 'utf8', env: cleanEnv({ ...g.env, WALNUT_PUSH_GATE_LOG_RETRY_SECS: '0' }) })
    expect(out.status).toBe(1)
    expect(out.stdout).toContain('── quick 7/8 (')
    expect(out.stdout).toContain("GitHub did not list this tier's job, so its failing tests are not named here")
  })

  it('asks again for a job log GitHub has not served yet, for up to two minutes, and says so when it never comes', () => {
    // 2026-11-09: a land tier's log came more than 30 s after its job ended; three tries 10 s apart
    // read nothing, and the land was refused with no test named.
    const failed = ['[test-layers] FAILED: 1 test(s) failed twice:', '  tests/scripts/x.test.ts :: a case', '[test-layers] failed: 364 file(s) in 216 s']
    const answers = (logAfter: number) => ({
      statuses: [st('walnut/push-gate (land 1/2)', 'failure', '[test-layers] failed: 364 file(s) in 216 s'), st('walnut/push-gate', 'failure', 'failed: land 1/2')],
      jobs: { jobs: [{ id: 9, name: 'Gate (land 1/2)' }] },
      log: failed.map((l) => `2026-11-09T00:00:00.0Z ${l}`).join('\n') + '\n',
      logAfter,
    })
    const late = ghRepo(answers(5))
    const out = spawnSync('bash', [GATE, 'origin', URL], { cwd: late.r, input: line(commit(late.r, { 'a.txt': '1\n' }, 'one'), late.base), encoding: 'utf8', env: cleanEnv({ ...late.env, WALNUT_PUSH_GATE_LOG_RETRY_SECS: '0' }) })
    expect(out.status).toBe(1)
    expect(out.stdout).toContain('  tests/scripts/x.test.ts :: a case')
    const never = ghRepo(answers(99))
    const none = spawnSync('bash', [GATE, 'origin', URL], { cwd: never.r, input: line(commit(never.r, { 'a.txt': '1\n' }, 'one'), never.base), encoding: 'utf8', env: cleanEnv({ ...never.env, WALNUT_PUSH_GATE_LOG_RETRY_SECS: '0' }) })
    expect(none.status).toBe(1)
    expect(none.stdout).toContain("GitHub did not serve this job's log within two minutes, so its failing tests are not named here")
    // A large log whose failed list comes early: a `printf | grep -q` test of it died on SIGPIPE under
    // pipefail and read false, and the tier's failures went unnamed.
    const big = ghRepo({ ...answers(0), log: [...failed, ...Array.from({ length: 6000 }, (_, i) => `noise line ${i} ${'x'.repeat(60)}`)].map((l) => `2026-11-09T00:00:00.0Z ${l}`).join('\n') + '\n' })
    const named = spawnSync('bash', [GATE, 'origin', URL], { cwd: big.r, input: line(commit(big.r, { 'a.txt': '1\n' }, 'one'), big.base), encoding: 'utf8', env: cleanEnv({ ...big.env, WALNUT_PUSH_GATE_LOG_RETRY_SECS: '0' }) })
    expect(named.status).toBe(1)
    expect(named.stdout).toContain('[test-layers] FAILED: 1 test(s) failed twice:')
    expect(named.stdout).toContain('  tests/scripts/x.test.ts :: a case')
    expect(named.stderr).not.toMatch(/Broken pipe/)
  })

  it('never tests a job log with `printf | grep -q`, which a large log turns false under pipefail', () => {
    const src = fs.readFileSync(GATE, 'utf8')
    // Nor feeds one through a pipe to a reader that stops early (grep -q, an awk that exits).
    expect(src.match(/printf '%s\\n' "\$jlog" \| (grep -a?q|awk '[^']*exit)/g) ?? []).toEqual([])
  })

  it('decides from the tiers when the verdict job has not run: one failed tier refuses, every tier passed lets it through', () => {
    const tiers = [...Array.from({ length: 8 }, (_, i) => `quick ${i + 1}/8`), 'frontend', 'browser specs']
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
    expect(fs.readFileSync(g.seen, 'utf8')).not.toMatch(/refs\/(heads\/)?gate/)
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
    expect(fs.readFileSync(g.seen, 'utf8')).toContain(`refs/gate/${gated.slice(0, 12)}`)
  })

  it('names the commits GitHub has no copy of when --run is refused, not the gate commit', () => {
    const g = ghRepo({ statuses: [st('walnut/push-gate (quick 1/3)', 'failure', '1 NEW failure(s)')] })
    git(g.r, 'push', '-q', URL, 'main:main')
    commit(g.r, { 'a.txt': '1\n' }, 'the change that broke it')
    const tip = commit(g.r, { 'b.txt': '2\n' }, 'a later change')
    const out = spawnSync('bash', [GATE, '--run', URL, tip], { cwd: g.r, encoding: 'utf8', env: cleanEnv(g.env) })
    expect(out.status).toBe(1)
    expect(out.stdout).toMatch(/This push carries:\n {2}[0-9a-f]+ a later change\n {2}[0-9a-f]+ the change that broke it/)
    expect(out.stdout).not.toMatch(/push gate: the files of/)
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
    expect(fs.readFileSync(g.seen, 'utf8')).toContain('refs/gate/')
  })

  it('runs a land\'s gate with --run in land mode: the land alone on top of its main, kept apart from a full pass', () => {
    const tiers = ['land 1/1', 'frontend', 'browser specs']
    const g = ghRepo({ statuses: [st('walnut/gate-plan', 'success', '3 tiers, land: 12 test files'), ...tiers.map((t) => st(`walnut/push-gate (${t})`, 'success', 'passed'))] })
    git(g.r, 'push', '-q', URL, 'main:main')
    const ghMain = git(g.r, 'rev-parse', 'HEAD')
    const macMain = commit(g.r, { 'tests/e2e/browser/x.txt': 'already landed\n', '.github/workflows/push-gate.yml': '# runs scripts/push-gate-plan.mjs\n' }, 'a land GitHub has not seen yet')
    const tip = commit(g.r, { 'b.txt': '2\n' }, 'the land')
    const verdicts = path.join(path.dirname(g.r), 'verdicts')
    const env = { ...g.env, WALNUT_PUSH_GATE_VERDICTS: verdicts, WALNUT_PUSH_GATE_MODE: 'land', WALNUT_PUSH_GATE_LAND_BASE: macMain }
    const out = spawnSync('bash', [GATE, '--run', URL, tip], { cwd: g.r, encoding: 'utf8', env: cleanEnv(env) })
    expect(out.status, out.stdout + out.stderr).toBe(0)
    expect(out.stdout).toMatch(/Test gate \(land\) on/)
    expect(out.stdout).toMatch(/plan: 3 tiers, land/)
    const gated = fs.readFileSync(g.seen, 'utf8').match(/commits\/([0-9a-f]{40})\/statuses/)![1]
    expect(git(g.r, 'log', '-1', '--format=%B', gated)).toMatch(/^Walnut-Gate: land$/m)
    expect(git(g.r, 'rev-parse', `${gated}^{tree}`)).toBe(git(g.r, 'rev-parse', `${tip}^{tree}`))
    expect(git(g.r, 'rev-parse', `${gated}^^{tree}`)).toBe(git(g.r, 'rev-parse', `${macMain}^{tree}`))
    expect(git(g.r, 'rev-parse', `${gated}^^`)).toBe(ghMain)
    const tree = git(g.r, 'rev-parse', `${tip}^{tree}`)
    expect(fs.existsSync(path.join(verdicts, 'land', `${tree}.${git(g.r, 'rev-parse', `${macMain}^{tree}`)}`))).toBe(true)
    expect(fs.existsSync(path.join(verdicts, tree))).toBe(false)
    // The same land again passes at once; a push of those files still runs the whole gate.
    fs.rmSync(g.seen)
    const again = spawnSync('bash', [GATE, '--run', URL, tip], { cwd: g.r, encoding: 'utf8', env: cleanEnv(env) })
    expect(again.stdout).toMatch(/Test gate \(land\) passed on these files onto this main/)
    expect(fs.existsSync(g.seen)).toBe(false)
    const push = spawnSync('bash', [GATE, 'origin', URL], { cwd: g.r, input: line(tip, ghMain), encoding: 'utf8', env: cleanEnv({ ...g.env, WALNUT_PUSH_GATE_VERDICTS: verdicts }) })
    expect(push.stdout).not.toMatch(/passed on these files/)
    expect(fs.readFileSync(g.seen, 'utf8')).toContain('refs/heads/gate/')
  })

  it('runs only the named tests with --run in files mode, keeps nothing, and the browser job reads its specs', () => {
    const g = ghRepo({ statuses: [st('walnut/gate-plan', 'success', '2 tiers, files: 1'), st('walnut/push-gate (files)', 'success'), st('walnut/push-gate (browser specs)', 'success')] })
    git(g.r, 'push', '-q', URL, 'main:main')
    const tip = commit(g.r, { 'b.txt': '2\n', '.github/workflows/push-gate.yml': '# runs scripts/push-gate-plan.mjs\n' }, 'a commit to trace')
    const verdicts = path.join(path.dirname(g.r), 'verdicts')
    const out = spawnSync('bash', [GATE, '--run', URL, tip], { cwd: g.r, encoding: 'utf8', env: cleanEnv({ ...g.env, WALNUT_PUSH_GATE_VERDICTS: verdicts, WALNUT_PUSH_GATE_MODE: 'files', WALNUT_PUSH_GATE_FILES: 'tests/core/a.test.ts uses-x.spec.ts no;such' }) })
    expect(out.status, out.stdout + out.stderr).toBe(0)
    expect(out.stdout).toMatch(/Test gate \(files\) on [0-9a-f]+: only tests\/core\/a\.test\.ts uses-x\.spec\.ts/)
    const gated = fs.readFileSync(g.seen, 'utf8').match(/commits\/([0-9a-f]{40})\/statuses/)![1]
    const msg = git(g.r, 'log', '-1', '--format=%B', gated)
    expect(msg).toMatch(/^Walnut-Gate: files\nWalnut-Gate-Test: tests\/core\/a\.test\.ts\nWalnut-Gate-Test: uses-x\.spec\.ts$/m)
    expect(msg).not.toContain('no;such')
    expect(fs.existsSync(verdicts) ? fs.readdirSync(verdicts, { recursive: true }).filter((f) => !String(f).endsWith('.jsonl')) : []).toEqual([])
    const specs = spawnSync('bash', [GATE, '--specs', `${gated}^`, gated], { cwd: g.r, encoding: 'utf8', env: cleanEnv() })
    expect(specs.stdout.trim()).toBe('tests/e2e/browser/uses-x.spec.ts')
  })

  it('refuses a land gate with no main to land on', () => {
    const g = ghRepo({})
    git(g.r, 'push', '-q', URL, 'main:main')
    const tip = commit(g.r, { 'b.txt': '2\n' }, 'the land')
    const out = spawnSync('bash', [GATE, '--run', URL, tip], { cwd: g.r, encoding: 'utf8', env: cleanEnv({ ...g.env, WALNUT_PUSH_GATE_MODE: 'land' }) })
    expect(out.status).toBe(2)
    expect(out.stderr).toMatch(/needs WALNUT_PUSH_GATE_LAND_BASE/)
  })

  it('waits for the plan\'s tier count before it passes a planned run on its tiers', () => {
    const three = ['land 1/1', 'frontend', 'browser specs'].map((t) => st(`walnut/push-gate (${t})`, 'success', 'passed'))
    const unplanned = ghRepo({ statuses: three })
    const tip = commit(unplanned.r, { '.github/workflows/push-gate.yml': '# runs scripts/push-gate-plan.mjs\n' }, 'one')
    const waiting = gateRun(unplanned, tip)
    expect(waiting.status).toBe(1)
    expect(waiting.stdout).toMatch(/did not answer within 0 minutes/)
    const planned = ghRepo({ statuses: [st('walnut/gate-plan', 'success', '3 tiers, land: x'), ...three] })
    const ok = gateRun(planned, commit(planned.r, { '.github/workflows/push-gate.yml': '# runs scripts/push-gate-plan.mjs\n' }, 'one'))
    expect(ok.status, ok.stdout + ok.stderr).toBe(0)
    expect(ok.stdout).toMatch(/Test gate passed\./)
    // A full plan names ten: three passes are not enough.
    const full = ghRepo({ statuses: [st('walnut/gate-plan', 'success', '10 tiers, full: a push'), ...three] })
    const short = gateRun(full, commit(full.r, { '.github/workflows/push-gate.yml': '# runs scripts/push-gate-plan.mjs\n' }, 'one'))
    expect(short.status).toBe(1)
  })

  it('judges the files with WALNUT_PUSH_GATE_SAME_TREE even when GitHub\'s main has them', () => {
    const g = ghRepo({ statuses: [st('walnut/push-gate', 'success', 'all 10 tiers passed')] })
    const tip = git(g.r, 'rev-parse', 'HEAD')
    git(g.r, 'push', '-q', URL, 'main:main')
    const out = spawnSync('bash', [GATE, '--run', URL, tip], { cwd: g.r, encoding: 'utf8', env: cleanEnv({ ...g.env, WALNUT_PUSH_GATE_SAME_TREE: '1' }) })
    expect(out.status, out.stdout + out.stderr).toBe(0)
    expect(out.stdout).toMatch(/Test gate passed\./)
    expect(fs.readFileSync(g.seen, 'utf8')).toContain('dispatches -X POST -f ref=main -f inputs[sha]=')
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
  const five = [...Array.from({ length: 8 }, (_, i) => `quick ${i + 1}/8`), 'frontend', 'browser specs']

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
    expect(fs.readFileSync(ok.posts, 'utf8')).toMatch(/state=success -f context=walnut\/push-gate -f description=all 10 tiers passed/)

    const other = stub([...five.slice(0, 9).map((t) => mine(t, 'success')), mine('browser specs', 'success', 'https://github.com/acme/demo/actions/runs/76')])
    run(other.env, ['--verdict'], { NEEDS: 'success success' })
    expect(fs.readFileSync(other.posts, 'utf8')).toMatch(/state=failure .*9 of 10 tiers reported/)

    const job = stub(five.map((t) => mine(t, 'success')))
    run(job.env, ['--verdict'], { NEEDS: 'success failure' })
    expect(fs.readFileSync(job.posts, 'utf8')).toMatch(/state=failure .*jobs: success failure/)

    // A land run counts the plan's tiers, not a full gate's.
    const land = stub(['land 1/1', 'frontend', 'browser specs'].map((t) => mine(t, 'success')))
    run(land.env, ['--verdict'], { NEEDS: 'success success success', GATE_TIERS: '3' })
    expect(fs.readFileSync(land.posts, 'utf8')).toMatch(/state=success -f context=walnut\/push-gate -f description=all 3 tiers passed/)
    const notEnough = stub(['land 1/1', 'frontend', 'browser specs'].map((t) => mine(t, 'success')))
    run(notEnough.env, ['--verdict'], { NEEDS: 'success success success' })
    expect(fs.readFileSync(notEnough.posts, 'utf8')).toMatch(/state=failure .*3 of 10 tiers reported/)

    const bad = stub(five.map((t) => mine(t, t === 'frontend' ? 'failure' : 'success')))
    run(bad.env, ['--verdict'], { NEEDS: 'success success' })
    expect(fs.readFileSync(bad.posts, 'utf8')).toMatch(/state=failure .*description=failed: frontend/)
  })
})

describe('push-gate-status.sh --plan', () => {
  it('writes the plan as walnut/gate-plan, its description led by the tier count push-gate.sh reads', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-gate-plan-status-'))
    dirs.push(dir)
    const posts = path.join(dir, 'posts.log')
    fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/sh\nshift 4; echo "$*" >> ${JSON.stringify(posts)}\n`, { mode: 0o755 })
    const env = cleanEnv({ PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: 'acme/demo', GITHUB_SHA: 'a'.repeat(40), GITHUB_SERVER_URL: 'https://github.com', GITHUB_RUN_ID: '77' })
    const r = spawnSync('bash', [path.join(ROOT, 'scripts/push-gate-status.sh'), '--plan', 'land', '3', '731 test files in 1 job(s)'], { encoding: 'utf8', env })
    expect(r.status).toBe(0)
    expect(fs.readFileSync(posts, 'utf8')).toMatch(/state=success -f context=walnut\/gate-plan -f description=3 tiers, land: 731 test files/)
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

/**
 * Every GitHub read of the gate has a time limit (2026-11-06: one `gh api` call hung for most of
 * an hour, the gate never read the failed tier written meanwhile, and reported "did not answer"
 * at its deadline). Fails on a new bare `gh api` call, and pins that the limit really ends a call.
 */
describe('the GitHub reads of the gate', () => {
  const src = fs.readFileSync(GATE, 'utf8')

  it('all go through ghcall, the time-limited wrapper', () => {
    const bare = src.split('\n').filter((line) => /(^|[^\w-])gh api\b/.test(line) && !line.trim().startsWith('#'))
    expect(bare, 'call ghcall api ..., never gh api ... directly').toEqual([])
    expect(src.match(/\bghcall api\b/g)?.length).toBeGreaterThanOrEqual(4)
  })

  it('the wrapper ends a call past its limit and passes an exit code through', () => {
    const body = /ghcall\(\) \{\n([\s\S]*?)\n  \}\n/.exec(src)?.[1]
    expect(body).toBeTruthy()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-gate-ghcall-'))
    dirs.push(dir)
    // A gh that sleeps, or exits 3: the wrapper runs whatever `gh` is on PATH.
    fs.writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\n[ "$2" = slow ] && exec sleep 30\nexit 3\n', { mode: 0o755 })
    const run = (arg: string) => spawnSync('bash', ['-c', `ghcall() {\n${body}\n}\nghcall api ${arg}`], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, WALNUT_PUSH_GATE_CALL_SECS: '1' }, encoding: 'utf8', timeout: 20_000,
    })
    const started = Date.now()
    expect(run('slow').status).toBe(124)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(run('quick').status).toBe(3)
  })
})

/**
 * scripts/push-gate-sweep.sh removes gate refs a killed hook left (2026-11-07: two finished
 * `gate/<sha>` branches each showed a "Compare & pull request" banner on the repository's page).
 */
describe('push-gate-sweep.sh', () => {
  const SWEEP = path.join(ROOT, 'scripts/push-gate-sweep.sh')
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const HOUR = 3_600_000

  it('removes the refs whose runs ended over an hour ago, or that never ran and are old, and nothing else', () => {
    const { r } = repo()
    const dir = path.dirname(r)
    const bare = path.join(dir, 'remote.git')
    spawnSync('git', ['init', '-q', '--bare', bare], { env: cleanEnv() })
    const mk = (name: string, date?: string) => {
      fs.writeFileSync(path.join(r, `${name}.txt`), name)
      git(r, 'add', '.')
      spawnSync('git', ['commit', '-q', '-m', name], { cwd: r, env: cleanEnv(date ? { GIT_COMMITTER_DATE: date } : {}) })
      return git(r, 'rev-parse', 'HEAD')
    }
    const sha = {
      doneDispatched: mk('a'), doneBranch: mk('b'), running: mk('c'), recent: mk('d'),
      neverRanOld: mk('e', '2020-01-01T00:00:00Z'), neverRanNew: mk('f'), young: mk('g'), oldStamped: mk('h'), main: mk('m'),
    }
    const secs = (msAgo: number) => Math.floor((Date.now() - msAgo) / 1000)
    const youngAt = secs(60_000)
    const refs: Record<string, string> = {
      [`refs/gate/${sha.doneDispatched.slice(0, 12)}`]: sha.doneDispatched,
      [`refs/heads/gate/${sha.doneBranch.slice(0, 12)}`]: sha.doneBranch,
      [`refs/gate/${sha.running.slice(0, 12)}`]: sha.running,
      [`refs/gate/${sha.recent.slice(0, 12)}`]: sha.recent,
      [`refs/gate/${sha.neverRanOld.slice(0, 12)}`]: sha.neverRanOld,
      [`refs/gate/${sha.neverRanNew.slice(0, 12)}`]: sha.neverRanNew,
      // Pushed a minute ago for a re-gate: its earlier runs ended hours ago, its new run is not listed yet.
      [`refs/gate/${sha.young.slice(0, 12)}-${youngAt}`]: sha.young,
      [`refs/gate/${sha.oldStamped.slice(0, 12)}-${secs(3 * HOUR)}`]: sha.oldStamped,
      'refs/heads/main': sha.main, 'refs/heads/bun-ci': sha.main, 'refs/heads/claude/x': sha.main,
    }
    for (const [ref, at] of Object.entries(refs)) git(r, 'push', '-q', bare, `${at}:${ref}`)
    const runs = [
      { event: 'workflow_dispatch', display_title: `Push gate ${sha.doneDispatched}`, head_sha: sha.main, status: 'completed', updated_at: iso(2 * HOUR) },
      { event: 'push', display_title: 'Push gate gate/x', head_sha: sha.doneBranch, status: 'completed', updated_at: iso(3 * HOUR) },
      { event: 'workflow_dispatch', display_title: `Push gate ${sha.running}`, head_sha: sha.main, status: 'completed', updated_at: iso(5 * HOUR) },
      { event: 'workflow_dispatch', display_title: `Push gate ${sha.running}`, head_sha: sha.main, status: 'in_progress', updated_at: iso(0) },
      { event: 'workflow_dispatch', display_title: `Push gate ${sha.recent}`, head_sha: sha.main, status: 'completed', updated_at: iso(10 * 60_000) },
      { event: 'workflow_dispatch', display_title: `Push gate ${sha.young}`, head_sha: sha.main, status: 'completed', updated_at: iso(4 * HOUR) },
      { event: 'workflow_dispatch', display_title: `Push gate ${sha.oldStamped}`, head_sha: sha.main, status: 'completed', updated_at: iso(2 * HOUR) },
    ]
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(dir, 'runs.json'), JSON.stringify({ workflow_runs: runs }))
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
case $2 in
  *workflows/push-gate.yml/runs*) cat ${JSON.stringify(path.join(dir, 'runs.json'))} ;;
  */commits/*) TZ=UTC git --git-dir=${JSON.stringify(bare)} log -1 --date=format-local:%Y-%m-%dT%H:%M:%SZ --format=%cd "\${2##*/}" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 })
    const out = spawnSync('bash', [SWEEP, bare, 'acme/demo'], { cwd: r, encoding: 'utf8', env: cleanEnv({ PATH: `${bin}:${process.env.PATH}` }) })
    expect(out.status, out.stdout + out.stderr).toBe(0)
    const left = spawnSync('git', ['--git-dir', bare, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' }).stdout.trim().split('\n').sort()
    expect(left).toEqual([
      'refs/gate/' + sha.neverRanNew.slice(0, 12), 'refs/gate/' + sha.recent.slice(0, 12), 'refs/gate/' + sha.running.slice(0, 12),
      `refs/gate/${sha.young.slice(0, 12)}-${youngAt}`,
      'refs/heads/bun-ci', 'refs/heads/claude/x', 'refs/heads/main',
    ].sort())
  })

  it('runs before every GitHub gate, in the background, and every hour on GitHub', () => {
    const src = fs.readFileSync(GATE, 'utf8')
    expect(src).toMatch(/\( bash "\$\(dirname "\$0"\)\/push-gate-sweep\.sh" "\$remote_url" "\$repo" <\/dev\/null >\/dev\/null 2>&1 & \)/)
    const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/push-gate-sweep.yml'), 'utf8')
    expect(wf).toMatch(/schedule:\n\s+- cron: '\d+ \* \* \* \*'/)
    expect(wf).toMatch(/run: bash scripts\/push-gate-sweep\.sh origin "\$GITHUB_REPOSITORY"/)
    expect(wf).toMatch(/contents: write/)
  })
})
