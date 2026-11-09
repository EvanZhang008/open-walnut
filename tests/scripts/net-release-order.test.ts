/**
 * Nothing that runs this commit's Walnut starts before the host network connector it pins is out.
 *
 * 2026-11-09: a commit moved NET_BIN_VERSION (src/providers/net-binary.ts) to 0.2.1 while
 * walnut-net-v0.2.1, built only by hand in walnut-net.yml, did not exist yet. Both join workflows
 * started two minutes before it was out, their daemon got a 404 for its SHA256SUMS, net.identity
 * failed and the invite timed out. Now walnut-net.yml builds a version as soon as it reaches main,
 * and every workflow that runs a join of this commit first waits in a job of its own for the
 * release (scripts/net-release-ready.sh, which reads the same pin and URL the daemon does).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { parse as parseYaml } from 'yaml'

const ROOT = path.resolve(__dirname, '../..')
const WORKFLOWS = path.join(ROOT, '.github/workflows')
const SCRIPT = path.join(ROOT, 'scripts/net-release-ready.sh')
const PIN = 'src/providers/net-binary.ts'

type Step = { id?: string; run?: string }
type Job = { needs?: string | string[]; if?: string; outputs?: Record<string, string>; steps?: Step[] }
type Workflow = { on?: Record<string, { branches?: string[]; paths?: string[] } | null>; jobs: Record<string, Job> }

const load = (f: string) => parseYaml(fs.readFileSync(path.join(WORKFLOWS, f), 'utf8')) as Workflow
const workflows = fs.readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort()
const globRe = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*')}$`)
const runs = (j: Job) => (j.steps ?? []).map((s) => s.run ?? '').join('\n')
const needs = (j: Job) => (typeof j.needs === 'string' ? [j.needs] : j.needs ?? [])

/**
 * A workflow that runs Walnut's host network from this commit: it runs the join (its test, or
 * the variable that test reads), or a push that changes the pin starts it.
 */
function runsTheConnector(f: string): boolean {
  if (f === 'walnut-net.yml' || f === 'release.yml') return false
  const paths = load(f).on?.push?.paths ?? []
  return /host-network-outside-join|WALNUT_OUTSIDE_JOIN/.test(fs.readFileSync(path.join(WORKFLOWS, f), 'utf8')) || paths.some((p) => globRe(p).test(PIN))
}

/** Every job `job` waits for, directly or through another. */
function upstream(jobs: Record<string, Job>, job: string, seen = new Set<string>()): Set<string> {
  for (const n of needs(jobs[job])) if (!seen.has(n)) { seen.add(n); upstream(jobs, n, seen) }
  return seen
}

describe('the connector release comes first', () => {
  it('walnut-net.yml builds a version as soon as a push to main moves it, and only then', () => {
    const w = load('walnut-net.yml')
    expect(w.on?.push?.branches).toEqual(['main'])
    const paths = w.on?.push?.paths ?? []
    for (const f of ['native/walnut-net/Cargo.toml', PIN]) expect(paths.some((p) => globRe(p).test(f)), f).toBe(true)
    expect(w.on).toHaveProperty('workflow_dispatch')
    expect(w.jobs.version.outputs?.publish).toBe('${{ steps.v.outputs.publish }}')
    for (const job of ['build', 'release']) expect(w.jobs[job].if, job).toBe("needs.version.outputs.publish == 'true'")
  })

  it('no Walnut release goes out before the connector it pins', () => {
    const jobs = load('release.yml').jobs
    // The nightly checks the green commit it picked, a promote the soaked nightly, a stable tag its tree.
    expect(runs(jobs['nightly-build'])).toMatch(/elif ! sh scripts\/net-release-ready\.sh --at "\$green"; then\n(?:\s*#.*\n)*\s*echo "publish=false"/)
    expect(runs(jobs['promote-plan'])).toMatch(/elif ! sh scripts\/net-release-ready\.sh --at "\$SHA"; then\n(?:\s*#.*\n)*\s*echo "publish=false"/)
    expect(runs(jobs['stable-build'])).toMatch(/^sh scripts\/net-release-ready\.sh$/m)
  })

  it('every workflow that runs a join of this commit waits for the connector first', () => {
    const members = workflows.filter(runsTheConnector)
    expect(members).toEqual(expect.arrayContaining(['fresh-mac-join.yml', 'windows-join.yml']))
    for (const f of members) {
      const jobs = load(f).jobs
      const waits = Object.keys(jobs).filter((k) => /sh scripts\/net-release-ready\.sh --wait \d+/.test(runs(jobs[k])))
      expect(waits, `${f}: a job that runs sh scripts/net-release-ready.sh --wait`).toHaveLength(1)
      for (const [k, j] of Object.entries(jobs)) {
        if (k === waits[0]) continue
        expect([...upstream(jobs, k)], `${f}: job ${k} needs ${waits[0]}`).toContain(waits[0])
        expect(j.if ?? '', `${f}: job ${k} runs only after the wait passed`).not.toMatch(/always\(|failure\(|cancelled\(/)
      }
    }
  })
})

/** Runs the version job's step of walnut-net.yml for an event, with the readiness check stubbed. */
function versionStep(event: string, out: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'net-version-'))
  try {
    const step = load('walnut-net.yml').jobs.version.steps!.find((s) => s.id === 'v')!
    for (const f of ['native/walnut-net/Cargo.toml', PIN, 'scripts/net-release-ready.sh']) fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true })
    fs.copyFileSync(path.join(ROOT, 'native/walnut-net/Cargo.toml'), path.join(dir, 'native/walnut-net/Cargo.toml'))
    fs.copyFileSync(path.join(ROOT, PIN), path.join(dir, PIN))
    fs.writeFileSync(path.join(dir, 'scripts/net-release-ready.sh'), `echo asked >> "${dir}/asked"; exit ${out ? 0 : 1}\n`)
    fs.writeFileSync(path.join(dir, 'out'), '')
    const r = spawnSync('bash', ['-e', '-c', step.run!], { cwd: dir, env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: path.join(dir, 'out') }, encoding: 'utf8' })
    const output = Object.fromEntries(fs.readFileSync(path.join(dir, 'out'), 'utf8').trim().split('\n').map((l) => l.split('=')))
    return { status: r.status, publish: output.publish, asked: fs.existsSync(path.join(dir, 'asked')) }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('walnut-net.yml decides whether to build', () => {
  it('a push of a version that is not out builds it', () => {
    expect(versionStep('push', false)).toEqual({ status: 0, publish: 'true', asked: true })
  })
  it('a push of a version that is out builds nothing', () => {
    expect(versionStep('push', true)).toEqual({ status: 0, publish: 'false', asked: true })
  })
  it('a run by hand builds without asking (its publish refuses a version that is out)', () => {
    expect(versionStep('workflow_dispatch', true)).toEqual({ status: 0, publish: 'true', asked: false })
  })
})

/**
 * Runs scripts/net-release-ready.sh in a repo of its own, with curl, date and sleep stubbed: curl
 * answers `answers` in turn (an HTTP code, or 200 with a body), sleep moves the stubbed clock.
 */
function ready(answers: Array<number | string>, args: string[] = [], opts: { pin?: string; env?: Record<string, string> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'net-ready-'))
  try {
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(bin)
    fs.mkdirSync(path.join(dir, 'src/providers'), { recursive: true })
    fs.writeFileSync(path.join(dir, PIN), opts.pin ?? fs.readFileSync(path.join(ROOT, PIN), 'utf8'))
    answers.forEach((a, i) => fs.writeFileSync(path.join(dir, `answer-${i + 1}`), String(a)))
    fs.writeFileSync(path.join(bin, 'curl'), [
      '#!/bin/sh',
      `n=$(cat "${dir}/calls" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${dir}/calls"`,
      'o=; url=; while [ $# -gt 0 ]; do case "$1" in -o) o=$2; shift 2;; -w|--max-time|--retry) shift 2;; -*) shift;; *) url=$1; shift;; esac; done',
      `echo "$url" >> "${dir}/urls"`,
      `a=$(cat "${dir}/answer-$n" 2>/dev/null || echo 404)`,
      'case "$a" in [0-9][0-9][0-9]) : > "$o"; printf %s "$a";; *) printf "%s\\n" "$a" > "$o"; printf 200;; esac',
    ].join('\n'), { mode: 0o755 })
    fs.writeFileSync(path.join(bin, 'date'), `#!/bin/sh\ncat "${dir}/clock" 2>/dev/null || echo 1000\n`, { mode: 0o755 })
    fs.writeFileSync(path.join(bin, 'sleep'), `#!/bin/sh\nc=$(cat "${dir}/clock" 2>/dev/null || echo 1000); echo $((c+$1)) > "${dir}/clock"\n`, { mode: 0o755 })
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}` }
    delete env.WALNUT_NET_RELEASE_BASE_URL
    Object.assign(env, opts.env)
    const r = spawnSync('sh', [SCRIPT, ...args], { cwd: dir, env, encoding: 'utf8' })
    const urls = fs.existsSync(path.join(dir, 'urls')) ? fs.readFileSync(path.join(dir, 'urls'), 'utf8').trim().split('\n') : []
    return { status: r.status, out: r.stdout + r.stderr, urls }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const version = /export const NET_BIN_VERSION = '(.*)'/.exec(fs.readFileSync(path.join(ROOT, PIN), 'utf8'))![1]
const base = /const RELEASE_BASE = '(.*)'/.exec(fs.readFileSync(path.join(ROOT, PIN), 'utf8'))![1]
const sums = `${'a'.repeat(64)}  walnut-net-${version}-linux-x64.gz`
const url = `${base}/walnut-net-v${version}/SHA256SUMS`

describe('scripts/net-release-ready.sh', () => {
  it('reads the pin and the release the daemon downloads from', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+/)
    expect(ready([sums])).toMatchObject({ status: 0, urls: [url] })
  })

  it('a release without its SHA256SUMS is not out, and says so at once without --wait', () => {
    const r = ready([404])
    expect(r.status).toBe(1)
    expect(r.urls).toHaveLength(1)
    expect(r.out).toContain(`walnut-net-v${version} is not out (HTTP 404`)
  })

  it('a SHA256SUMS that lists another version is not this release', () => {
    expect(ready([`${'a'.repeat(64)}  walnut-net-0.0.1-linux-x64.gz`]).status).toBe(1)
  })

  it('--wait asks again until the release is out', () => {
    const r = ready([404, 404, 503, sums], ['--wait', '3300'])
    expect(r.status).toBe(0)
    expect(r.urls).toHaveLength(4)
  })

  it('--wait gives up at its deadline', () => {
    const r = ready([], ['--wait', '120'])
    expect(r.status).toBe(1)
    expect(r.urls.length).toBeGreaterThan(1)
    expect(r.urls.length).toBeLessThanOrEqual(6)
  })

  it('--at reads the pin of that commit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'net-ready-git-'))
    try {
      const git = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: dir, encoding: 'utf8' })
      git('init', '-q')
      fs.mkdirSync(path.join(dir, 'src/providers'), { recursive: true })
      fs.writeFileSync(path.join(dir, PIN), `const RELEASE_BASE = 'https://example.com/dl'\nexport const NET_BIN_VERSION = '9.8.7'\n`)
      git('add', '.')
      git('commit', '-qm', 'pin')
      fs.writeFileSync(path.join(dir, PIN), `const RELEASE_BASE = 'https://example.com/dl'\nexport const NET_BIN_VERSION = '9.8.8'\n`)
      const bin = path.join(dir, 'bin')
      fs.mkdirSync(bin)
      fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\nfor a; do u=$a; done; echo "$u" > "${dir}/url"; printf 404\n`, { mode: 0o755 })
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}` }
      delete env.WALNUT_NET_RELEASE_BASE_URL
      spawnSync('sh', [SCRIPT, '--at', 'HEAD'], { cwd: dir, env, encoding: 'utf8' })
      expect(fs.readFileSync(path.join(dir, 'url'), 'utf8').trim()).toBe('https://example.com/dl/walnut-net-v9.8.7/SHA256SUMS')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a daemon release base set in the environment is the one asked', () => {
    expect(ready([sums], [], { env: { WALNUT_NET_RELEASE_BASE_URL: 'https://mirror.example/dl/' } }).urls).toEqual([`https://mirror.example/dl/walnut-net-v${version}/SHA256SUMS`])
  })

  it('a pin file it cannot read is an error, never "not out"', () => {
    const r = ready([sums], [], { pin: 'export const NET_BIN_VERSION = 0\n' })
    expect(r.status).toBe(2)
    expect(r.urls).toEqual([])
  })

  it('an option without its value is an error, never "not out"', () => {
    for (const args of [['--wait'], ['--at']]) expect(ready([sums], args).status, args[0]).toBe(2)
  })

  it('the version is matched as text, its dots too', () => {
    expect(ready([`${'a'.repeat(64)}  walnut-net-${version.replace(/\./g, 'x')}-linux-x64.gz`]).status).toBe(1)
  })
})
