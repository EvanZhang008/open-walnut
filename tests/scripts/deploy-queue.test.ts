/**
 * The deploy queue of scripts/deploy-committed.sh (scripts/lib/deploy-queue.sh):
 * at most one production restart per gap, each deploy ships the newest commit of
 * then, and every caller hears whether the deploy that carried its commit went out.
 *
 * 2026-11-03: 27 restarts in a day; a deploy inside the old cooldown exited 0
 * saying the server was current while the caller's commit was not live, and two
 * deploys at once failed outright.
 *
 * Run against a throwaway repo whose dev-prod.sh is a stub: it logs each deploy,
 * takes a moment, then "serves" its commit (writes the config the queue reads, and
 * dev-prod.sh's success stamp), or fails. The gap is 4 s. Nothing is built and no
 * server is touched; every queue file lives in the test's temp dir.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { gitChildEnv } from '../../src/lib/git-env.js'

const SCRIPTS = path.join(import.meta.dirname, '..', '..', 'scripts')
const GAP = 4

const STUB = `#!/usr/bin/env bash
# knows WALNUT_DEVPROD_SERVE_ROOT
set -euo pipefail
sha="$(git rev-parse HEAD)"
echo "start $sha $(date +%s)" >> "$STUB_DEPLOYS"
[[ -z "\${WALNUT_DEVPROD_SKIP_SMOKE:-}" ]] || { echo "a caller's knob reached the deploy" >&2; exit 9; }
[[ -z "\${WALNUT_DEPLOY_RUNNER:-}" ]] || { echo "WALNUT_DEPLOY_RUNNER reached dev-prod.sh" >&2; exit 9; }
sleep "\${STUB_SECS:-1}"
if [[ -f "$STUB_FAIL" ]]; then echo "type-check failed in the stub" >&2; exit 7; fi
printf '{"build":{"commit":"%s","dirty":false,"builtAt":"%s"}}' "\${sha:0:9}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STUB_CONFIG"
date +%s > "$TMPDIR/open-walnut-dev-prod.last-success"
echo "end $sha $(date +%s)" >> "$STUB_DEPLOYS"
echo "Server ready (PID: 1, stub)"
if [[ -f "$STUB_FAIL.incomplete" ]]; then
  echo "Deploy incomplete: the server runs the new build, but the walnut CLI in $PWD/dist was NOT updated (stub)."
fi
`

interface Fixture { root: string; repo: string; tmp: string; queue: string; deploys: string; config: string; fail: string }
const fixtures: Fixture[] = []

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitChildEnv(), stdio: 'pipe' }).toString().trim()
const commit = (f: Fixture, name: string) => {
  fs.writeFileSync(path.join(f.repo, `${name}.txt`), `${name}\n`)
  git(f.repo, 'add', `${name}.txt`)
  git(f.repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', name)
  return git(f.repo, 'rev-parse', 'HEAD')
}

function fixture(): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-queue-')))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(path.join(repo, 'scripts', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'open-walnut' }))
  fs.copyFileSync(path.join(SCRIPTS, 'deploy-committed.sh'), path.join(repo, 'scripts', 'deploy-committed.sh'))
  fs.copyFileSync(path.join(SCRIPTS, 'lib', 'deploy-queue.sh'), path.join(repo, 'scripts', 'lib', 'deploy-queue.sh'))
  fs.writeFileSync(path.join(repo, 'scripts', 'dev-prod.sh'), STUB)
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '-A')
  git(repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'base')
  fs.mkdirSync(path.join(repo, 'node_modules', 'leftpad'), { recursive: true })
  const tmp = path.join(root, 'tmp')
  fs.mkdirSync(tmp)
  const f = { root, repo, tmp, queue: path.join(root, 'queue'), deploys: path.join(root, 'deploys.log'), config: path.join(root, 'config.json'), fail: path.join(root, 'fail') }
  fixtures.push(f)
  return f
}

interface Run { code: number | null; stdout: string; stderr: string }
/** Every process below `root` (its tree by parent pid, as Claude Code's tool timeout finds it). */
function treeOf(root: number): number[] {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], { encoding: 'utf8' }).trim().split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number))
  const out: number[] = []
  const walk = (p: number) => { for (const [pid, ppid] of rows) if (ppid === p && !out.includes(pid)) { out.push(pid); walk(pid) } }
  walk(root)
  return out
}

function call(f: Fixture, env: Record<string, string> = {}, args: string[] = []): { pid: number; done: Promise<Run> } {
  const child = spawn('bash', [path.join(f.repo, 'scripts', 'deploy-committed.sh'), ...args], {
    cwd: f.repo,
    env: {
      ...gitChildEnv(), TMPDIR: f.tmp, WALNUT_DEPLOY_QUEUE_DIR: f.queue, WALNUT_DEPLOY_CONFIG_URL: `file://${f.config}`,
      // The machine's own load never stretches a test's gap (WALNUT_DEPLOY_BUSY_GAP_SECS).
      WALNUT_DEPLOY_MIN_GAP_SECS: String(GAP), WALNUT_DEPLOY_LOAD_TEST: '0', WALNUT_DEPLOY_MEM_TEST: 'ok', STUB_DEPLOYS: f.deploys, STUB_CONFIG: f.config, STUB_FAIL: f.fail, ...env,
    },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (b) => { stdout += b })
  child.stderr.on('data', (b) => { stderr += b })
  return { pid: child.pid!, done: new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr }))) }
}

const deploys = (f: Fixture) => (fs.existsSync(f.deploys) ? fs.readFileSync(f.deploys, 'utf8').trim().split('\n').filter(Boolean) : [])
  .map((l) => { const [kind, sha, at] = l.split(' '); return { kind, sha, at: Number(at) } })
const runnerPid = (f: Fixture): number | null => {
  const v = Number((() => { try { return fs.readFileSync(path.join(f.queue, 'runner.lock', 'pid'), 'utf8') } catch { return '' } })())
  return Number.isInteger(v) && v > 1 ? v : null
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(what: () => boolean, ms: number, label: string): Promise<void> {
  const end = Date.now() + ms
  while (!what()) { if (Date.now() > end) throw new Error(`timed out: ${label}`); await sleep(100) }
}
/** The runner ends by itself once nothing waits. */
const runnerGone = (f: Fixture) => until(() => !fs.existsSync(path.join(f.queue, 'runner.lock')), 30_000, 'the runner to end')
const stampNow = (f: Fixture) => fs.writeFileSync(path.join(f.tmp, 'open-walnut-dev-prod.last-success'), String(Math.floor(Date.now() / 1000)))

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    // Only the runner this test started, by the pid it wrote into the test's own dir.
    const pid = runnerPid(f)
    if (pid) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } await sleep(200) }
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})

describe('the deploy queue', () => {
  it('one caller with no recent restart deploys at once and is told it is live', async () => {
    const f = fixture()
    const head = git(f.repo, 'rev-parse', 'HEAD')
    const r = await call(f).done
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain(`Deployed ${head.slice(0, 12)}: production serves it now.`)
    expect(deploys(f).filter((d) => d.kind === 'start').map((d) => d.sha)).toEqual([head])
    await runnerGone(f)
  }, 60_000)

  it('callers in a burst share ONE deploy, of the newest commit, after the gap', async () => {
    const f = fixture()
    stampNow(f) // production just restarted
    const gap = 10 // room for the second caller to file under load
    const t0 = Math.floor(Date.now() / 1000)
    const first = git(f.repo, 'rev-parse', 'HEAD')
    const a = call(f, { WALNUT_DEPLOY_MIN_GAP_SECS: String(gap) })
    await sleep(500)
    const second = commit(f, 'second')
    const b = call(f, { WALNUT_DEPLOY_MIN_GAP_SECS: String(gap) })
    const [ra, rb] = await Promise.all([a.done, b.done])
    expect(ra.code, ra.stderr).toBe(0)
    expect(rb.code, rb.stderr).toBe(0)
    const starts = deploys(f).filter((d) => d.kind === 'start')
    expect(starts.map((d) => d.sha)).toEqual([second])
    expect(starts[0].at).toBeGreaterThanOrEqual(t0 + gap)
    expect(ra.stdout).toMatch(/Deploy queued: production restarted recently, and restarts at most once per/)
    expect(ra.stdout).toContain(`Deployed: production serves ${second.slice(0, 12)}, which includes your commit ${first.slice(0, 12)}.`)
    expect(rb.stdout).toContain(`Deployed ${second.slice(0, 12)}: production serves it now.`)
    await runnerGone(f)
  }, 60_000)

  it('a busy Mac stretches the gap up to the busy gap, and an easy one does not (2026-11-09: load 200 to 400)', async () => {
    const f = fixture()
    stampNow(f) // production just restarted
    const t0 = Math.floor(Date.now() / 1000)
    const head = git(f.repo, 'rev-parse', 'HEAD')
    const busy = await call(f, { WALNUT_DEPLOY_MIN_GAP_SECS: '1', WALNUT_DEPLOY_BUSY_GAP_SECS: '12', WALNUT_DEPLOY_LOAD_TEST: '9999' }).done
    expect(busy.code, busy.stderr).toBe(0)
    const s1 = deploys(f).filter((d) => d.kind === 'start')
    expect(s1.map((d) => d.sha)).toEqual([head])
    expect(s1[0].at).toBeGreaterThanOrEqual(t0 + 12)
    expect(fs.readFileSync(path.join(f.queue, 'runner.log'), 'utf8')).toMatch(/the Mac is busy \(load 9999, over 4 per CPU\): the deploy waits/)
    expect(busy.stdout).toMatch(/Deploy queued: this Mac is busy \(load 9999\); the next deploy goes once it eases, at .* at the latest, with the newest commit then, which includes /)
    expect(fs.existsSync(path.join(f.queue, 'busy'))).toBe(false)
    await runnerGone(f)
    // An easy Mac: only the plain gap.
    const g = fixture()
    stampNow(g)
    const t1 = Math.floor(Date.now() / 1000)
    const easy = await call(g, { WALNUT_DEPLOY_MIN_GAP_SECS: '1', WALNUT_DEPLOY_BUSY_GAP_SECS: '60', WALNUT_DEPLOY_LOAD_TEST: '0.5' }).done
    expect(easy.code, easy.stderr).toBe(0)
    expect(deploys(g).filter((d) => d.kind === 'start')[0].at).toBeLessThan(t1 + 30)
    await runnerGone(g)
  }, 90_000)

  it('tight memory stretches the gap like a busy load (2026-11-11: the web build of a deploy adds about 1.4 GB)', async () => {
    const f = fixture()
    stampNow(f)
    const t0 = Math.floor(Date.now() / 1000)
    const tight = await call(f, { WALNUT_DEPLOY_MIN_GAP_SECS: '1', WALNUT_DEPLOY_BUSY_GAP_SECS: '12', WALNUT_DEPLOY_MEM_TEST: 'memory pressure level 2' }).done
    expect(tight.code, tight.stderr).toBe(0)
    expect(deploys(f).filter((d) => d.kind === 'start')[0].at).toBeGreaterThanOrEqual(t0 + 12)
    expect(fs.readFileSync(path.join(f.queue, 'runner.log'), 'utf8')).toMatch(/the Mac is busy \(memory pressure level 2\): the deploy waits/)
    expect(tight.stdout).toMatch(/Deploy queued: this Mac is busy \(memory pressure level 2\); the next deploy goes once it eases/)
    await runnerGone(f)
  }, 90_000)

  it('a commit that lands while a deploy runs goes with the next one, a gap after it', async () => {
    const f = fixture()
    const first = git(f.repo, 'rev-parse', 'HEAD')
    // The runner runs every deploy with the first caller's environment: the stub takes 8 s.
    const a = call(f, { STUB_SECS: '8' })
    await until(() => deploys(f).length > 0, 20_000, 'the first deploy to start')
    const second = commit(f, 'second')
    const b = call(f)
    const [ra, rb] = await Promise.all([a.done, b.done])
    expect(ra.code, ra.stderr).toBe(0)
    expect(rb.code, rb.stderr).toBe(0)
    expect(rb.stdout).toContain(`your commit ${second.slice(0, 12)} goes with the next one`)
    const d = deploys(f)
    expect(d.filter((x) => x.kind === 'start').map((x) => x.sha)).toEqual([first, second])
    const firstEnd = d.find((x) => x.kind === 'end' && x.sha === first)!.at
    expect(d.filter((x) => x.kind === 'start')[1].at).toBeGreaterThanOrEqual(firstEnd + GAP)
    await runnerGone(f)
  }, 60_000)

  it('a failed deploy fails every caller it carried, with its log, and nothing is called live', async () => {
    const f = fixture()
    fs.writeFileSync(f.fail, '')
    stampNow(f)
    const a = call(f)
    await sleep(300)
    commit(f, 'second')
    const b = call(f)
    for (const r of await Promise.all([a.done, b.done])) {
      expect(r.code).toBe(1)
      expect(r.stderr).toMatch(/Deploy failed: the deploy of [0-9a-f]{12}, which includes your commit [0-9a-f]{12}, exited 7; nothing of it is live\. Log: /)
      expect(r.stderr).toContain('type-check failed in the stub')
      const log = /Log: (\S+)/.exec(r.stderr)![1]
      expect(fs.existsSync(log)).toBe(true)
    }
    expect(deploys(f).filter((d) => d.kind === 'start')).toHaveLength(1)
    await runnerGone(f)
  }, 60_000)

  it('a deploy that went live with a part of it failed says so to the caller, as the last line', async () => {
    const f = fixture()
    fs.writeFileSync(`${f.fail}.incomplete`, '')
    const head = git(f.repo, 'rev-parse', 'HEAD')
    const r = await call(f).done
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain(`Deployed ${head.slice(0, 12)}: production serves it now.`)
    expect(r.stderr.trim().split('\n').at(-1)).toMatch(/^Deploy incomplete: the server runs the new build, but the walnut CLI in .* was NOT updated \(stub\)\.$/)
    await runnerGone(f)
  }, 60_000)

  it('a caller killed with its whole tree while it waits (a tool timeout) never cuts the deploy', async () => {
    const f = fixture()
    const head = git(f.repo, 'rev-parse', 'HEAD')
    const a = call(f, { STUB_SECS: '3' })
    await until(() => deploys(f).length > 0, 20_000, 'the deploy to start')
    // As Claude Code ends a timed-out command: every process below it by parent pid, then it.
    const tree = treeOf(a.pid)
    expect(tree).not.toContain(runnerPid(f))
    for (const pid of [...tree, a.pid]) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
    await a.done
    await until(() => deploys(f).some((d) => d.kind === 'end'), 20_000, 'the deploy to finish')
    expect(JSON.parse(fs.readFileSync(f.config, 'utf8')).build.commit).toBe(head.slice(0, 9))
    await runnerGone(f)
  }, 60_000)

  it('a commit production already serves is answered at once, with no runner', async () => {
    const f = fixture()
    const head = git(f.repo, 'rev-parse', 'HEAD')
    fs.writeFileSync(f.config, JSON.stringify({ build: { commit: head.slice(0, 9), dirty: false } }))
    const r = await call(f).done
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/Deploy skipped: production already serves/)
    expect(fs.existsSync(path.join(f.queue, 'runner.lock'))).toBe(false)
    expect(deploys(f)).toEqual([])
  }, 30_000)

  it('a forced deploy and a dry run go straight on, inside the gap', async () => {
    const f = fixture()
    stampNow(f)
    for (const env of [{ WALNUT_DEVPROD_FORCE: '1' }, { WALNUT_DEVPROD_DRY_RUN: '1' }]) {
      const before = deploys(f).length
      const r = await call(f, env).done
      expect(r.code, r.stderr).toBe(0)
      expect(deploys(f).length).toBe(before + 2)
    }
    expect(fs.existsSync(path.join(f.queue, 'requests'))).toBe(false)
  }, 30_000)

  it('NO_WAIT files the request and returns; the runner deploys it after the gap', async () => {
    const f = fixture()
    stampNow(f)
    const head = git(f.repo, 'rev-parse', 'HEAD')
    const r = await call(f, { WALNUT_DEPLOY_NO_WAIT: '1' }).done
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/Deploy queued: [0-9a-f]{12} goes out with the next deploy/)
    expect(deploys(f)).toEqual([])
    await until(() => deploys(f).some((d) => d.kind === 'end' && d.sha === head), 30_000, 'the queued deploy')
    await runnerGone(f)
  }, 60_000)

  it('a commit a rebase replaced is carried by its new copy, never deployed alone over a newer build', async () => {
    const f = fixture()
    const base = git(f.repo, 'rev-parse', 'HEAD')
    const x = commit(f, 'x')
    // Someone rebases: x's change lands again on top of another commit, under a new id.
    git(f.repo, 'reset', '-q', '--hard', base)
    commit(f, 'other')
    fs.writeFileSync(path.join(f.repo, 'x.txt'), 'x\n')
    git(f.repo, 'add', 'x.txt')
    git(f.repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'x')
    const head = git(f.repo, 'rev-parse', 'HEAD')
    const r = await call(f, {}, [x]).done
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toContain(`Deployed: production serves ${head.slice(0, 12)}, which includes your commit ${x.slice(0, 12)}.`)
    expect(deploys(f).filter((d) => d.kind === 'start').map((d) => d.sha)).toEqual([head])
    await runnerGone(f)
    // A commit whose change HEAD does not carry, older than what production serves: refused.
    git(f.repo, 'checkout', '-q', '-b', 'side', base)
    const side = commit(f, 'side')
    git(f.repo, 'checkout', '-q', 'main')
    const refused = await call(f, { WALNUT_DEPLOY_NO_GAP: '1' }, [side]).done
    expect(refused.code).toBe(1)
    expect(refused.stderr).toMatch(/Not deployed: your commit [0-9a-f]{12} is not on the checkout's HEAD/)
    expect(deploys(f).filter((d) => d.kind === 'start').map((d) => d.sha)).toEqual([head])
    await runnerGone(f)
  }, 60_000)

  it('the runner takes none of a caller\'s deploy knobs, and the caller is told so', async () => {
    const f = fixture()
    const r = await call(f, { WALNUT_DEVPROD_SKIP_SMOKE: '1', STUB_SECS: '0' }).done
    expect(r.code, r.stderr).toBe(0)
    expect(r.stderr).toContain('WALNUT_DEVPROD_SKIP_SMOKE does not apply to it')
    // The stub reports the runner's environment through the deploy log the queue kept.
    const logs = fs.readdirSync(path.join(f.queue, 'logs'))
    expect(logs).toHaveLength(1)
    await runnerGone(f)
  }, 60_000)

  it('two runners started at once deploy once', async () => {
    const f = fixture()
    const head = git(f.repo, 'rev-parse', 'HEAD')
    const a = call(f)
    const b = call(f)
    const [ra, rb] = await Promise.all([a.done, b.done])
    expect([ra.code, rb.code], ra.stderr + rb.stderr).toEqual([0, 0])
    expect(deploys(f).filter((d) => d.kind === 'start').map((d) => d.sha)).toEqual([head])
    await runnerGone(f)
  }, 60_000)

  it('a runner lock left by a dead runner is taken over', async () => {
    const f = fixture()
    fs.mkdirSync(path.join(f.queue, 'runner.lock'), { recursive: true })
    // A pid that is not running: one past every pid of a finished child.
    const dead = spawn('true')
    await new Promise((r) => dead.on('close', r))
    fs.writeFileSync(path.join(f.queue, 'runner.lock', 'pid'), String(dead.pid))
    const r = await call(f).done
    expect(r.code, r.stderr).toBe(0)
    expect(deploys(f).filter((d) => d.kind === 'start')).toHaveLength(1)
    await runnerGone(f)
  }, 60_000)
})
