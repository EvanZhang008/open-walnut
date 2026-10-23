/**
 * The release pipeline's pure parts, and the shape of the workflow that runs it.
 *
 * - scripts/release.mjs: the next version for a bump word, and rolling the
 *   CHANGELOG's Unreleased section under the version (refusing an empty one).
 * - scripts/nightly-version.mjs: the nightly version shape and its ordering
 *   against the stable release it precedes (the update checker's comparator is
 *   the judge, so a nightly can never be told it is newer than its own release).
 * - scripts/ci-gate.mjs: what counts as "CI passed" on a commit, which commit a
 *   release tag is judged by, and which commit the nightly publishes.
 * - .github/workflows/release.yml: parses, publishes with provenance through
 *   OIDC (no token), gates the tag on package.json and on CI, publishes the
 *   newest green commit as the nightly, and promotes a soaked nightly to stable
 *   once a day after a fresh-machine install of it (the plan itself is
 *   tests/scripts/stable-promote.test.ts). Each channel builds once, runs those
 *   files through the binary matrix and publishes the same bytes; a stable's
 *   GitHub Release is a draft until its files are on it.
 * - .github/workflows/binary-matrix.yml: a release's call runs the release's own
 *   files, at its version, without cancelling or being cancelled by a push run.
 */
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { nextVersion, rollChangelog, setManifestVersion } from '../../scripts/release.mjs'
import { NIGHTLY_GAP_HOURS, lastNightlyCommit, newerBase, nightlyDue, nightlyVersion, servesNightly } from '../../scripts/nightly-version.mjs'
import { combinedVerdict, isTransientGhFailure, pickLastGreen, releaseGateRev, verdictOf } from '../../scripts/ci-gate.mjs'
import { releaseNotes } from '../../scripts/release-notes.mjs'
import { compareVersions } from '../../src/core/self-update/version-compare.js'
import { channelOf } from '../../src/core/self-update/update-check.js'

describe('nextVersion', () => {
  it('bumps a part or takes an exact release', () => {
    expect(nextVersion('0.5.1', 'patch')).toBe('0.5.2')
    expect(nextVersion('0.5.1', 'minor')).toBe('0.6.0')
    expect(nextVersion('0.5.1', 'major')).toBe('1.0.0')
    expect(nextVersion('0.5.1', '0.7.3')).toBe('0.7.3')
  })

  it('refuses a prerelease or a word it does not know', () => {
    expect(() => nextVersion('0.5.1', '0.6.0-beta.1')).toThrow('no prerelease')
    expect(() => nextVersion('0.5.1', 'next')).toThrow('patch, minor, major')
    expect(() => nextVersion('0.5.1', undefined as unknown as string)).toThrow()
    expect(() => nextVersion('nope', 'patch')).toThrow('not x.y.z')
  })
})

const CHANGELOG = `# Changelog

Intro.

## [Unreleased]

### Added

- A thing.

### Fixed

- Another.

## [0.5.1] - 2026-09-28

### Changed

- Old.
`

describe('rollChangelog', () => {
  it('moves Unreleased under the version with the date and opens a fresh Unreleased', () => {
    const out = rollChangelog(CHANGELOG, '0.5.2', '2026-10-01')
    expect(out).toBe(`# Changelog

Intro.

## [Unreleased]

## [0.5.2] - 2026-10-01

### Added

- A thing.

### Fixed

- Another.

## [0.5.1] - 2026-09-28

### Changed

- Old.
`)
    // Rolling the result again fails: the new Unreleased is empty.
    expect(() => rollChangelog(out, '0.5.3', '2026-10-02')).toThrow('is empty')
  })

  it('works when Unreleased is the last section', () => {
    const out = rollChangelog('# Changelog\n\n## [Unreleased]\n\n- Only.\n', '1.0.0', '2026-10-01')
    expect(out).toBe('# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-10-01\n\n- Only.\n')
  })

  it('refuses a file without Unreleased, and a version that already has a section', () => {
    expect(() => rollChangelog('# Changelog\n\n## [0.5.1] - x\n', '0.5.2', '2026-10-01')).toThrow('no "## [Unreleased]"')
    expect(() => rollChangelog(CHANGELOG, '0.5.1', '2026-10-01')).toThrow('already has a 0.5.1 section')
  })

  it('the repository CHANGELOG has the section the script needs', () => {
    const text = fs.readFileSync(path.resolve(__dirname, '../../CHANGELOG.md'), 'utf8')
    expect(text).toMatch(/^## \[Unreleased\]\s*$/m)
  })
})

describe('nightlyVersion', () => {
  it('is the next patch as a nightly prerelease, by UTC day and run', () => {
    expect(nightlyVersion('0.5.1', new Date('2026-10-01T23:59:00Z'), 318)).toBe('0.5.2-nightly.20261001.318')
    expect(nightlyVersion('0.5.1', new Date('2026-10-01T23:59:00-07:00'), '7')).toBe('0.5.2-nightly.20261002.7')
    expect(() => nightlyVersion('0.5.1', new Date(), 'x')).toThrow('run number')
    expect(() => nightlyVersion('v1', new Date(), 1)).toThrow('not x.y.z')
  })

  it('orders the way the update checker needs: later nightlies win, the release they precede wins over all of them', () => {
    const a = nightlyVersion('0.5.1', new Date('2026-10-01T00:00:00Z'), 5)
    const b = nightlyVersion('0.5.1', new Date('2026-10-01T00:00:00Z'), 12)
    const c = nightlyVersion('0.5.1', new Date('2026-10-02T00:00:00Z'), 1)
    expect(compareVersions(b, a)).toBeGreaterThan(0)
    expect(compareVersions(c, b)).toBeGreaterThan(0)
    expect(compareVersions('0.5.2', c)).toBeGreaterThan(0)
    expect(compareVersions(c, '0.5.1')).toBeGreaterThan(0)
    expect(channelOf(c)).toBe('nightly')
    // After the 0.5.2 release the next nightly is a 0.5.3 prerelease, above 0.5.2.
    expect(compareVersions(nightlyVersion('0.5.2', new Date('2026-10-03T00:00:00Z'), 1), '0.5.2')).toBeGreaterThan(0)
  })

  it('builds on the newer of package.json and the latest stable, so it never sorts below a release main has not caught up with', () => {
    expect(newerBase('0.6.0', '0.7.0')).toBe('0.7.0')
    expect(newerBase('0.7.0', '0.6.9')).toBe('0.7.0')
    expect(newerBase('0.6.10', '0.6.9')).toBe('0.6.10')
    expect(newerBase('0.6.0', '0.6.0')).toBe('0.6.0')
    // npm unreachable or answering something odd: package.json alone.
    expect(newerBase('0.6.0', undefined)).toBe('0.6.0')
    expect(newerBase('0.6.0', '')).toBe('0.6.0')
    expect(newerBase('0.6.0', '0.7.0-nightly.1')).toBe('0.6.0')
    const nightly = nightlyVersion(newerBase('0.6.0', '0.7.0'), new Date('2026-10-07T00:00:00Z'), 1)
    expect(nightly).toBe('0.7.1-nightly.20261007.1')
    expect(compareVersions(nightly, '0.7.0')).toBeGreaterThan(0)
  })

  it('runs as the workflow calls it, taking the latest stable from the environment', () => {
    const script = path.resolve(__dirname, '../../scripts/nightly-version.mjs')
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')) as { version: string }
    const run = (latest: string) => execFileSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, GITHUB_RUN_NUMBER: '3', WALNUT_LATEST_STABLE: latest } }).trim()
    expect(run('99.0.0')).toMatch(/^99\.0\.1-nightly\.\d{8}\.3$/)
    expect(run('')).toMatch(new RegExp(`^${nextVersion(pkg.version, 'patch').replace(/\./g, '\\.')}-nightly\\.\\d{8}\\.3$`))
  })
})

describe('nightlyDue', () => {
  const at = (iso: string) => new Date(iso)
  const pack = (published: string | null) => published
    ? { 'dist-tags': { nightly: '0.6.1-nightly.20261002.9' }, time: { '0.6.1-nightly.20261002.9': published } }
    : { 'dist-tags': {}, time: {} }

  it('is due once the nightly dist-tag is the gap old, and not before', () => {
    expect(NIGHTLY_GAP_HOURS).toBe(4.5)
    expect(nightlyDue(pack('2026-10-02T06:20:00Z'), at('2026-10-02T10:47:00Z')).due).toBe(false)
    expect(nightlyDue(pack('2026-10-02T06:20:00Z'), at('2026-10-02T10:50:00Z')).due).toBe(true)
    expect(nightlyDue(pack('2026-10-02T06:20:00Z'), at('2026-10-02T10:47:00Z')).reason).toContain('4.5h')
  })

  it('on the schedule GitHub really ran, a check just short of six hours publishes', () => {
    // Every scheduled Release run from 2026-10-03 17:54 (the ten-minute cron) to
    // 2026-10-05 11:21 (a dispatch by hand), and the first nightly they found.
    const checks = ['2026-10-03T17:54:33Z', '2026-10-03T20:53:40Z', '2026-10-03T23:36:46Z', '2026-10-04T02:52:42Z',
      '2026-10-04T09:22:48Z', '2026-10-04T14:55:27Z', '2026-10-04T18:35:49Z', '2026-10-04T21:56:58Z',
      '2026-10-05T00:45:41Z', '2026-10-05T06:19:33Z', '2026-10-05T11:21:11Z']
    // npm records the version about ten minutes after its check starts (00:45:41 -> 00:55:36).
    const npmAt = (check: string) => new Date(Date.parse(check) + 10 * 60_000).toISOString()
    let last = npmAt(checks[0])
    const published = [checks[0]]
    for (const c of checks.slice(1)) {
      if (nightlyDue(pack(last), at(c)).due) { published.push(c); last = npmAt(c) }
    }
    // The 06:19 check found 5.4h: at the old 5.5h it waited for the next check, five hours on.
    expect(published).toContain('2026-10-05T06:19:33Z')
    const hours = published.slice(1).map((p, i) => (Date.parse(p) - Date.parse(published[i])) / 3_600_000)
    expect(Math.max(...hours)).toBeLessThan(10)
    expect(Math.min(...hours)).toBeGreaterThanOrEqual(NIGHTLY_GAP_HOURS)
  })

  it('is due when npm has no nightly at all', () => {
    expect(nightlyDue(pack(null), at('2026-10-02T12:00:00Z'))).toMatchObject({ due: true, reason: 'no nightly on npm yet' })
  })
})

describe('the last nightly, as npm records it', () => {
  const head = '6e37ee4c881d998c40046ddbe92eb58833e1e21d'
  const pack = { 'dist-tags': { nightly: '0.6.1-nightly.20261003.27' }, versions: { '0.6.1-nightly.20261003.27': { gitHead: head } } }

  it('is the gitHead of the version under the nightly dist-tag', () => {
    expect(lastNightlyCommit(pack)).toBe(head)
    expect(lastNightlyCommit({ 'dist-tags': {}, versions: {} })).toBe('')
    // A version published without a git checkout has no gitHead: no record, not a guess.
    expect(lastNightlyCommit({ ...pack, versions: { '0.6.1-nightly.20261003.27': {} } })).toBe('')
  })

  it('npm serves a nightly only once the dist-tag names it and the version is there', () => {
    expect(servesNightly(pack, '0.6.1-nightly.20261003.27')).toBe(true)
    expect(servesNightly(pack, '0.6.1-nightly.20261003.28')).toBe(false)
    expect(servesNightly({ 'dist-tags': { nightly: '0.6.1-nightly.20261003.28' }, versions: {} }, '0.6.1-nightly.20261003.28')).toBe(false)
  })

  it('`last` and `wait` read the registry the job reads', async () => {
    const http = await import('node:http')
    let body = JSON.stringify({ 'dist-tags': {}, versions: {} })
    let hits = 0
    const server = http.createServer((_req, res) => {
      hits++
      // The third read sees the version npm finished processing.
      if (hits === 3) body = JSON.stringify(pack)
      res.setHeader('content-type', 'application/json')
      res.end(body)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/open-walnut`
    const script = path.resolve(__dirname, '../../scripts/nightly-version.mjs')
    const call = (args: string[], waitSecs = '5') => new Promise<{ code: number; out: string }>((resolve) => {
      execFile(process.execPath, [script, ...args], {
        encoding: 'utf8',
        env: { ...process.env, WALNUT_NIGHTLY_REGISTRY_URL: url, WALNUT_NIGHTLY_WAIT_EVERY_SECS: '0.05', WALNUT_NIGHTLY_WAIT_SECS: waitSecs },
      }, (err, stdout, stderr) => resolve({ code: err ? 1 : 0, out: `${stdout}${stderr}` }))
    })
    try {
      expect(await call(['last'])).toEqual({ code: 0, out: '\n' })
      const waited = await call(['wait', '0.6.1-nightly.20261003.27'])
      expect(waited).toEqual({ code: 0, out: 'npm serves open-walnut@0.6.1-nightly.20261003.27 as nightly\n' })
      expect(hits).toBe(3)
      expect((await call(['last'])).out).toBe(`${head}\n`)
      const never = await call(['wait', '0.6.1-nightly.20261003.99'], '0.2')
      expect(never.code).toBe(1)
      expect(never.out).toContain('does not serve it as nightly yet')
    } finally {
      server.close()
    }
  })
})

describe('releaseNotes', () => {
  it('is the body of the version\'s section, up to the next one', () => {
    const rolled = rollChangelog(CHANGELOG, '0.5.2', '2026-10-01')
    expect(releaseNotes(rolled, '0.5.2')).toBe('### Added\n\n- A thing.\n\n### Fixed\n\n- Another.')
    expect(releaseNotes(rolled, '0.5.1')).toBe('### Changed\n\n- Old.')
    expect(releaseNotes(rolled, '9.9.9')).toBeNull()
    expect(releaseNotes(rolled, 'Unreleased')).toBeNull()
  })

  it('runs as the workflow calls it, with the version as the first argument', () => {
    const out = execFileSync(process.execPath, [path.resolve(__dirname, '../../scripts/release-notes.mjs'), 'v0.5.1'], { encoding: 'utf8' })
    expect(out.trim().length).toBeGreaterThan(20)
    expect(out).not.toContain('See CHANGELOG.md.')
  })
})

describe('setManifestVersion', () => {
  it('changes the version lines and nothing else, the lock\'s root package included', () => {
    const pkg = `${JSON.stringify({ name: 'open-walnut', version: '0.5.1', scripts: { a: 'b' } }, null, 2)}\n`
    expect(setManifestVersion(pkg, '0.5.2')).toBe(pkg.replace('"version": "0.5.1"', '"version": "0.5.2"'))
    const lock = `${JSON.stringify({ name: 'open-walnut', version: '0.5.1', lockfileVersion: 3, packages: { '': { name: 'open-walnut', version: '0.5.1' }, 'node_modules/x': { version: '0.5.1' } } }, null, 2)}\n`
    const out = JSON.parse(setManifestVersion(lock, '0.5.2'))
    expect(out.version).toBe('0.5.2')
    expect(out.packages[''].version).toBe('0.5.2')
    expect(out.packages['node_modules/x'].version).toBe('0.5.1')
  })

  it('refuses a file outside npm\'s layout instead of reformatting it', () => {
    expect(() => setManifestVersion('{"name":"open-walnut","version":"0.5.1"}', '0.5.2')).toThrow('layout')
  })

  it('the repository manifests are in that layout', () => {
    for (const f of ['package.json']) {
      const text = fs.readFileSync(path.resolve(__dirname, '../..', f), 'utf8')
      expect(() => setManifestVersion(text, '9.9.9')).not.toThrow()
    }
  })
})

describe('ci-gate', () => {
  const run = (id: number, sha: string, created: string, status: string, conclusion: string | null) => ({
    id, head_sha: sha, created_at: created, status, conclusion, html_url: `https://example.test/runs/${id}`,
  })
  const gate = (conclusion: string) => [{ name: 'Test (quick)', conclusion: 'failure' }, { name: 'CI OK', conclusion }]

  it('judges a commit by the CI OK job of its newest run', () => {
    expect(verdictOf([], () => [])).toEqual({ verdict: 'none', url: null })
    expect(verdictOf([run(1, 'a', '2026-10-01T00:00:00Z', 'in_progress', null)], () => []).verdict).toBe('pending')
    expect(verdictOf([run(1, 'a', '2026-10-01T00:00:00Z', 'completed', 'failure')], () => gate('success')).verdict).toBe('green')
    expect(verdictOf([run(1, 'a', '2026-10-01T00:00:00Z', 'completed', 'success')], () => gate('failure')).verdict).toBe('red')
    expect(verdictOf([run(1, 'a', '2026-10-01T00:00:00Z', 'completed', 'cancelled')], () => []).verdict).toBe('cancelled')
    // A superseded run: CI OK skipped (now), or run against cancelled legs (before).
    expect(verdictOf([run(1, 'a', '2026-10-01T00:00:00Z', 'completed', 'cancelled')], () => gate('skipped')).verdict).toBe('cancelled')
    expect(verdictOf([run(1, 'a', '2026-10-01T00:00:00Z', 'completed', 'cancelled')], () => gate('failure')).verdict).toBe('cancelled')
    // A job that timed out fails the run, not cancels it: still red.
    expect(verdictOf([run(1, 'a', '2026-10-01T00:00:00Z', 'completed', 'failure')], () => gate('failure')).verdict).toBe('red')
    // No gate job (an older workflow): the run's own conclusion.
    expect(verdictOf([run(1, 'a', '2026-10-01T00:00:00Z', 'completed', 'success')], () => []).verdict).toBe('green')
    // A rerun is a newer run for the same commit and wins.
    const jobs = (id: number) => (id === 2 ? gate('success') : gate('failure'))
    expect(verdictOf([run(1, 'a', '2026-10-01T00:00:00Z', 'completed', 'failure'), run(2, 'a', '2026-10-01T01:00:00Z', 'completed', 'success')], jobs))
      .toEqual({ verdict: 'green', url: 'https://example.test/runs/2' })
  })

  it('a commit passes only when CI and the binary matrix both did; the matrix is asked only after CI', () => {
    const green = { verdict: 'green', url: 'ci' }
    let asked = 0
    const files = (verdict: string) => () => { asked++; return { verdict, url: 'matrix' } }
    expect(combinedVerdict(green, files('green'))).toEqual(green)
    expect(combinedVerdict(green, files('red'))).toEqual({ verdict: 'red', url: 'matrix', workflow: 'binary-matrix.yml' })
    expect(combinedVerdict(green, files('none')).verdict).toBe('none')
    expect(combinedVerdict(green, files('pending')).verdict).toBe('pending')
    asked = 0
    expect(combinedVerdict({ verdict: 'red', url: 'ci' }, files('green'))).toEqual({ verdict: 'red', url: 'ci' })
    expect(asked).toBe(0)
  })

  it('a release commit (only the release files) is judged by its parent', () => {
    expect(releaseGateRev(['package.json', 'CHANGELOG.md'])).toBe('parent')
    // A dependency change is code: bun.lock is not a release file.
    expect(releaseGateRev(['package.json', 'bun.lock'])).toBe('self')
    expect(releaseGateRev(['CHANGELOG.md'])).toBe('parent')
    expect(releaseGateRev(['package.json', 'src/cli.ts'])).toBe('self')
    expect(releaseGateRev([])).toBe('self')
  })

  it('the nightly takes the newest green commit, skipping red, running, cancelled and CI-less ones', () => {
    const verdicts: Record<string, string> = { f: 'none', e: 'pending', d: 'cancelled', c: 'red', b: 'green', a: 'green' }
    const asked: string[] = []
    const verdictFor = (sha: string) => { asked.push(sha); return { verdict: verdicts[sha]!, url: null } }
    expect(pickLastGreen(['f', 'e', 'd', 'c', 'b', 'a'], verdictFor)).toBe('b')
    // Newest first, and no further than the first green.
    expect(asked).toEqual(['f', 'e', 'd', 'c', 'b'])
    expect(pickLastGreen(['f', 'e', 'd', 'c'], verdictFor)).toBeNull()
    expect(pickLastGreen([], verdictFor)).toBeNull()
  })

  it('asks GitHub again only on its passing trouble, never on an answer', () => {
    for (const t of ['gh: Server Error (HTTP 502)', 'HTTP 503: Service Unavailable', 'HTTP 429: rate limited',
      'dial tcp 20.29.134.17:443: connect: connection refused', 'read: connection reset by peer', 'net/http: TLS handshake timeout', 'spawnSync gh ETIMEDOUT']) {
      expect(isTransientGhFailure(t), t).toBe(true)
    }
    for (const t of ['gh: Not Found (HTTP 404)', 'HTTP 401: Bad credentials', 'gh: Resource not accessible by integration (HTTP 403)',
      'To get started with GitHub CLI, please run:  gh auth login', 'spawnSync gh ENOENT']) {
      expect(isTransientGhFailure(t), t).toBe(false)
    }
  })

  it('last-green walks the branch in git and asks GitHub per commit, never the branch run list', () => {
    // 2026-10-05: `runs?branch=main` answered from a stale index for six hours and
    // the nightly took a week-old commit for the newest green one.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-last-green-'))
    try {
      const repo = path.join(tmp, 'repo')
      fs.mkdirSync(repo)
      // Never the caller's GIT_DIR (a hook exports one): it outranks cwd.
      const gitEnv = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' } as NodeJS.ProcessEnv
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv }).trim()
      git('init', '-q', '-b', 'main')
      const commit = (msg: string) => { git('commit', '-q', '--allow-empty', '-m', msg); return git('rev-parse', 'HEAD') }
      const old = commit('old, green long ago')
      const green = commit('green')
      const filesRed = commit('CI green, the binary matrix red')
      const red = commit('red')
      const docs = commit('docs only, no CI run')
      git('update-ref', 'refs/remotes/origin/main', docs)
      // The local branch moved on (unpushed work): origin's tip is the one that counts.
      commit('local only')
      const runsFor: Record<string, unknown[]> = {
        [old]: [{ id: 1, head_sha: old, created_at: '2026-09-28T00:00:00Z', status: 'completed', conclusion: 'success', html_url: 'u1' }],
        [green]: [{ id: 2, head_sha: green, created_at: '2026-10-05T01:00:00Z', status: 'completed', conclusion: 'success', html_url: 'u2' }],
        [red]: [{ id: 3, head_sha: red, created_at: '2026-10-05T02:00:00Z', status: 'completed', conclusion: 'failure', html_url: 'u3' }],
        [filesRed]: [{ id: 4, head_sha: filesRed, created_at: '2026-10-05T01:30:00Z', status: 'completed', conclusion: 'success', html_url: 'u4' }],
      }
      // The binary matrix's runs: the same as CI's but where a commit has its own.
      const filesRunsFor: Record<string, unknown[]> = {
        [filesRed]: [{ id: 5, head_sha: filesRed, created_at: '2026-10-05T01:31:00Z', status: 'completed', conclusion: 'failure', html_url: 'u5' }],
      }
      const jobsFor: Record<string, unknown[]> = { 1: [{ name: 'CI OK', conclusion: 'success' }], 2: [{ name: 'CI OK', conclusion: 'success' }], 3: [{ name: 'CI OK', conclusion: 'failure' }], 4: [{ name: 'CI OK', conclusion: 'success' }] }
      fs.writeFileSync(path.join(tmp, 'fixture.json'), JSON.stringify({ runsFor, filesRunsFor, jobsFor }))
      // A fake `gh api <endpoint>` that logs every endpoint and answers from the fixture.
      const bin = path.join(tmp, 'bin')
      fs.mkdirSync(bin)
      fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const fs = require('fs'), path = require('path')
const dir = ${JSON.stringify(tmp)}
const endpoint = process.argv[3]
fs.appendFileSync(path.join(dir, 'calls.log'), endpoint + '\\n')
// GH_FLAKY: the first call to each endpoint gets GitHub's 502, as on 2026-10-13.
if (process.env.GH_FLAKY) {
  const seen = path.join(dir, 'seen-' + require('crypto').createHash('sha1').update(endpoint).digest('hex'))
  if (!fs.existsSync(seen)) { fs.writeFileSync(seen, ''); process.stdout.write('{"message":"Server Error"}'); process.stderr.write('gh: Server Error (HTTP 502)\\n'); process.exit(1) }
}
const { runsFor, filesRunsFor, jobsFor } = JSON.parse(fs.readFileSync(path.join(dir, 'fixture.json'), 'utf8'))
let m
if ((m = /binary-matrix\\.yml\\/runs\\?head_sha=([0-9a-f]+)/.exec(endpoint))) process.stdout.write(JSON.stringify({ workflow_runs: filesRunsFor[m[1]] ?? runsFor[m[1]] ?? [] }))
else if ((m = /runs\\?head_sha=([0-9a-f]+)/.exec(endpoint))) process.stdout.write(JSON.stringify({ workflow_runs: runsFor[m[1]] ?? [] }))
else if ((m = /runs\\/(\\d+)\\/jobs/.exec(endpoint))) process.stdout.write(JSON.stringify({ jobs: jobsFor[m[1]] ?? [] }))
else { process.stderr.write('unexpected endpoint ' + endpoint); process.exit(1) }
`, { mode: 0o755 })
      const out = execFileSync(process.execPath, [path.resolve(__dirname, '../../scripts/ci-gate.mjs'), 'last-green', 'main'], {
        cwd: repo, encoding: 'utf8', env: { ...gitEnv, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      }).trim()
      expect(out).toBe(green)
      const calls = fs.readFileSync(path.join(tmp, 'calls.log'), 'utf8').trim().split('\n')
      expect(calls.some((c) => c.includes('runs?branch='))).toBe(false)
      // docs (no run), red (one run, its jobs), the commit CI passed and the matrix did not
      // (both asked), green (both asked): then it stops.
      expect(calls.filter((c) => c.includes('head_sha='))).toHaveLength(6)
      expect(calls.filter((c) => c.includes('binary-matrix.yml/runs?head_sha='))).toEqual([
        expect.stringContaining(filesRed), expect.stringContaining(green),
      ])
      expect(calls.some((c) => c.includes(`head_sha=${old}`))).toBe(false)

      // GitHub answers 502 once to every call: each is asked again and the answer holds.
      fs.rmSync(path.join(tmp, 'calls.log'))
      const flaky = execFileSync(process.execPath, [path.resolve(__dirname, '../../scripts/ci-gate.mjs'), 'last-green', 'main'], {
        cwd: repo, encoding: 'utf8', env: { ...gitEnv, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GH_FLAKY: '1', CI_GATE_RETRY_MS: '5' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
      expect(flaky).toBe(green)
      const flakyCalls = fs.readFileSync(path.join(tmp, 'calls.log'), 'utf8').trim().split('\n')
      expect(flakyCalls).toHaveLength(2 * calls.length)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('release.yml', () => {
  const text = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/release.yml'), 'utf8')
  type Step = { run?: string; name?: string; if?: string; id?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string> }
  type Job = {
    if?: string; needs?: string | string[]; uses?: string; with?: Record<string, string>; env?: Record<string, string>
    outputs?: Record<string, string>; permissions?: Record<string, string>; steps: Step[]
  }
  const doc = parseYaml(text) as {
    on: Record<string, unknown>
    permissions: Record<string, string>
    jobs: Record<string, Job>
  }
  const runs = (job: string) => doc.jobs[job]!.steps.map((s) => s.run ?? '').join('\n')
  const stepIndex = (job: string, needle: string) => doc.jobs[job]!.steps.findIndex((s) => (s.run ?? '').includes(needle))
  const usesIndex = (job: string, action: string) => doc.jobs[job]!.steps.findIndex((s) => s.uses?.startsWith(action))
  const needsOf = (job: string) => [doc.jobs[job]!.needs ?? []].flat()
  const matrix = parseYaml(fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/binary-matrix.yml'), 'utf8')) as { jobs: Record<string, Job & { 'timeout-minutes'?: number }> }

  /** Each channel: the job that builds, the binary matrix call that runs those files, the job that publishes them. */
  const CHANNELS = [
    { build: 'stable-build', files: 'stable-files', publish: 'stable', version: '"${GITHUB_REF_NAME#v}"', versionOut: '${{ needs.stable-build.outputs.version }}', ref: '${{ github.sha }}' },
    { build: 'nightly-build', files: 'nightly-files', publish: 'nightly', version: '"$version"', versionOut: '${{ needs.nightly-build.outputs.version }}', ref: '${{ needs.nightly-build.outputs.sha }}' },
    { build: 'promote-build', files: 'promote-files', publish: 'promote', version: '"$VERSION"', versionOut: '${{ needs.promote-plan.outputs.version }}', ref: '${{ needs.promote-plan.outputs.sha }}' },
  ] as const
  const RCODESIGN = 'sh scripts/install-rcodesign.sh "$RUNNER_TEMP/bin" && echo "$RUNNER_TEMP/bin" >> "$GITHUB_PATH"'

  it('runs on release tags, a schedule and by hand, and every check asks for both channels', () => {
    expect(doc.on.push).toEqual({ tags: ['v*.*.*'] })
    // Checks gated by a gap: whenever CI finishes on main, and on a schedule for a
    // quiet main. GitHub fired 10 of about 75 scheduled runs in 25 hours
    // (2026-10-03), so one schedule, as often as GitHub allows, and every scheduled
    // run checks both channels: with a cron per channel, the only run in the two
    // hours after a nightly came due was the stable one, and the nightly waited 7h.
    expect(doc.on.workflow_run).toEqual({ workflows: ['CI'], types: ['completed'], branches: ['main'] })
    expect(doc.on.schedule).toEqual([{ cron: '7,17,27,37,47,57 * * * *' }])
    expect(text).not.toContain('github.event.schedule ==')
    for (const job of ['nightly-build', 'promote-plan']) {
      expect(doc.jobs[job]!.if).toContain("github.event_name == 'schedule'")
      expect(doc.jobs[job]!.if).toContain("github.event_name == 'workflow_run'")
    }
    expect(doc.jobs['stable-build']!.if).toBe("startsWith(github.ref, 'refs/tags/v')")
    expect(doc.jobs.stable!.if).toBe("startsWith(github.ref, 'refs/tags/v')")
    const dispatch = doc.on.workflow_dispatch as { inputs: Record<string, { options?: string[]; default?: unknown }> }
    expect(dispatch.inputs.channel).toMatchObject({ options: ['nightly', 'stable'], default: 'nightly' })
    expect(doc.jobs['nightly-build']!.if).toContain("inputs.channel != 'stable'")
    expect(doc.jobs['promote-plan']!.if).toContain("inputs.channel == 'stable'")
    // The rest of each channel follows its first job.
    expect(doc.jobs.nightly!.if).toBe("needs.nightly-build.outputs.publish == 'true'")
    expect(doc.jobs['nightly-files']!.if).toBe("needs.nightly-build.outputs.publish == 'true'")
  })

  it('the release jobs push without the repo\'s git hooks', () => {
    // 2026-10-02: the pre-push hook type-checked for 50s before a tag moved.
    expect((doc as unknown as { env: Record<string, string> }).env.HUSKY).toBe('0')
  })

  it('publishes through OIDC with provenance and never a stored token', () => {
    expect(doc.permissions['id-token']).toBe('write')
    expect(doc.permissions.actions).toBe('read')
    expect(text).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|registry-url/)
    expect(runs('stable')).toContain('node scripts/npm-packages.mjs publish --dir "$RUNNER_TEMP/release/npm" --tag latest --provenance')
    expect(runs('nightly')).toContain('node scripts/npm-packages.mjs publish --dir "$RUNNER_TEMP/release/npm" --tag nightly --provenance')
    expect(runs('promote')).toContain('node scripts/npm-packages.mjs publish --dir "$RUNNER_TEMP/release/npm" --tag latest --provenance')
    for (const job of ['stable', 'nightly', 'promote']) expect(runs(job), job).toContain('npm install -g npm@12')
    expect(runs('nightly-build')).toContain('node scripts/nightly-version.mjs')
    // The repo's own package is the development one: no job publishes it.
    expect(text).not.toMatch(/npm publish|npm version/)
    // Only the publishing jobs may write.
    for (const job of ['stable-build', 'nightly-build', 'promote-build']) expect(doc.jobs[job]!.permissions?.contents, job).toBe('read')
  })

  it('each channel builds its files once, with the pinned bun and rcodesign, at the version it publishes, and uploads them', () => {
    const names = new Set<string>()
    for (const { build, version } of CHANNELS) {
      const job = doc.jobs[build]!
      const bun = job.steps.find((s) => s.uses?.startsWith('oven-sh/setup-bun'))
      expect(bun?.with?.['bun-version'], build).toBe('1.4.4')
      expect(runs(build), build).not.toContain('npm ci')
      const install = stepIndex(build, 'bun install --frozen-lockfile')
      const made = stepIndex(build, `node scripts/release-build.mjs --version ${version} --out "$RUNNER_TEMP/release"`)
      // build-binary.mjs refuses to build darwin-x64 off macOS without rcodesign.
      expect(install, build).toBeGreaterThan(-1)
      expect(job.steps[install + 1]!.run, build).toBe(RCODESIGN)
      expect(made, build).toBeGreaterThan(install + 1)
      const upload = job.steps.findIndex((s) => s.uses?.startsWith('actions/upload-artifact'))
      expect(upload, build).toBeGreaterThan(made)
      const w = job.steps[upload]!.with!
      expect(w.path, build).toBe('${{ runner.temp }}/release/assets')
      expect(w['if-no-files-found'], build).toBe('error')
      // A re-run of the build replaces the artifact its first attempt made.
      expect(w.overwrite, build).toBe(true)
      // The name the matrix and the publish job download is the build's output.
      expect(job.outputs?.files, build).toBe(w.name)
      names.add(String(w.name))
    }
    // One run may build a nightly and a stable: their artifacts never collide.
    expect(names.size).toBe(CHANNELS.length)
  })

  it('rcodesign is on PATH before every release build, here and in the binary matrix', () => {
    for (const [name, job] of Object.entries(doc.jobs)) {
      const build = job.steps?.findIndex((s) => (s.run ?? '').includes('node scripts/release-build.mjs')) ?? -1
      if (build < 0) continue
      const sign = job.steps.findIndex((s) => s.run === RCODESIGN)
      expect(sign, name).toBeGreaterThan(-1)
      expect(sign, name).toBeLessThan(build)
    }
    const steps = matrix.jobs.build!.steps
    const sign = steps.findIndex((s) => s.run === RCODESIGN)
    expect(sign).toBe(steps.findIndex((s) => s.run === 'bun install --frozen-lockfile') + 1)
    expect(sign).toBeLessThan(steps.findIndex((s) => (s.run ?? '').includes('scripts/build-binary.mjs --all')))
  })

  it('what each channel publishes is the files its binary matrix ran: unpacked, checked and packed, never rebuilt', () => {
    for (const { build, files, publish, versionOut, ref } of CHANNELS) {
      const call = doc.jobs[files]!
      expect(call.uses, files).toBe('./.github/workflows/binary-matrix.yml')
      expect(needsOf(files), files).toContain(build)
      expect(call.with, files).toEqual({ files: `\${{ needs.${build}.outputs.files }}`, version: versionOut, ref })
      expect(call.permissions, files).toEqual({ contents: 'read' })
      expect(needsOf(publish), publish).toEqual(expect.arrayContaining([build, files]))
      // The publishing job builds nothing.
      const all = JSON.stringify(doc.jobs[publish])
      for (const banned of ['release-build.mjs', 'build-binary.mjs', 'setup-bun', 'bun install']) expect(all, `${publish} ${banned}`).not.toContain(banned)
      const download = doc.jobs[publish]!.steps.findIndex((s) => s.uses?.startsWith('actions/download-artifact') && s.with?.name === `\${{ needs.${build}.outputs.files }}`)
      expect(download, publish).toBeGreaterThan(-1)
      expect(doc.jobs[publish]!.steps[download]!.with!.path, publish).toBe('${{ runner.temp }}/release/assets')
      const pack = doc.jobs[publish]!.steps.find((s) => s.name === 'The npm packages, of the very files the binary matrix ran')!
      expect(pack.run, publish).toContain('sh scripts/release-unpack.sh "$RUNNER_TEMP/release/assets" "$VERSION" "$RUNNER_TEMP/files"\n')
      expect(pack.run, publish).toContain('node scripts/npm-packages.mjs build --files "$RUNNER_TEMP/files" --version "$VERSION" --out "$RUNNER_TEMP/release/npm" --git-head ')
      expect(pack.run!.indexOf('release-unpack.sh'), publish).toBeLessThan(pack.run!.indexOf('npm-packages.mjs build'))
      const packAt = doc.jobs[publish]!.steps.indexOf(pack)
      expect(packAt, publish).toBeGreaterThan(download)
      expect(packAt, publish).toBeLessThan(stepIndex(publish, 'node scripts/npm-packages.mjs publish'))
      // The version it packs is the one the matrix rehearsed.
      const versionEnv = pack.env?.VERSION ?? doc.jobs[publish]!.env?.VERSION
      expect(versionEnv, publish).toBe(versionOut)
    }
    // The stable's version is the tag's, checked against package.json before the build.
    expect(doc.jobs['stable-build']!.outputs!.version).toBe('${{ steps.tag.outputs.version }}')
    expect(doc.jobs['stable-build']!.steps.find((s) => s.id === 'tag')!.run).toContain('echo "version=$version" >> "$GITHUB_OUTPUT"')
  })

  it('a stable\'s GitHub Release is a draft until its files are on it, then public, and only then gets its formula, app and archives', () => {
    for (const job of ['stable', 'promote']) {
      const create = stepIndex(job, 'gh release create')
      const attach = stepIndex(job, 'sh scripts/release-attach.sh "$TAG" "$RUNNER_TEMP/release/assets"')
      const goPublic = stepIndex(job, 'gh release edit "$TAG" --draft=false --latest')
      const archives = stepIndex(job, 'gh workflow run release-archives.yml')
      expect(create, job).toBeGreaterThan(stepIndex(job, 'node scripts/npm-packages.mjs publish'))
      expect(doc.jobs[job]!.steps[create]!.run, job).toMatch(/gh release create "[^"]+" --draft /)
      expect(attach, job).toBeGreaterThan(create)
      expect(goPublic, job).toBeGreaterThan(attach)
      expect(archives, job).toBeGreaterThan(goPublic)
      // Only a draft goes public, and only one holding SHA256SUMS (uploaded last).
      const run = doc.jobs[job]!.steps[goPublic]!.run!
      expect(run.indexOf('gh release view "$TAG" --json isDraft --jq .isDraft')).toBeLessThan(run.indexOf('--draft=false'))
      expect(run.indexOf('grep -qx SHA256SUMS')).toBeLessThan(run.indexOf('--draft=false'))
    }
    // No release is ever created public.
    expect([...text.matchAll(/gh release create [^\n]*/g)].map((m) => m[0]).every((l) => l.includes(' --draft '))).toBe(true)
    // The same text in both jobs, which tests/scripts/release-promote-steps.test.ts runs.
    const publicStep = (job: string) => doc.jobs[job]!.steps.find((s) => s.name === 'Publish the GitHub Release, now that it holds its files')!
    expect(publicStep('stable').run).toBe(publicStep('promote').run)
    expect(doc.jobs.stable!.env!.TAG).toBe('${{ github.ref_name }}')
    expect(publicStep('promote').env!.TAG).toBe('v${{ needs.promote-plan.outputs.version }}')
    expect(doc.jobs['promote']!.steps.at(-1)!.run).toContain('gh workflow run release-archives.yml')
    const script = fs.readFileSync(path.resolve(__dirname, '../../scripts/release-attach.sh'), 'utf8')
    expect(script.indexOf('"$here/install.sh" --clobber')).toBeLessThan(script.indexOf('"$dir/SHA256SUMS" --clobber'))
    // GitHub failing to list the assets stops it (tests/scripts/release-files.test.ts).
    expect(script).toContain('assets="$(gh release view "$tag" --json assets --jq \'.assets[].name\')" \\\n  || {')
    expect(script).toContain('printf \'%s\\n\' "$assets" | grep -qx SHA256SUMS')
  })

  it('a commit from before this release pipeline is never built: the nightly passes it over, the stable waits', () => {
    const pick = doc.jobs['nightly-build']!.steps.find((s) => s.id === 'pick')!.run!
    expect(pick).toContain('git cat-file -e "$green:scripts/release-build.mjs"')
    expect(pick).toContain('git cat-file -e "$green:scripts/release-unpack.sh"')
    const files = doc.jobs['promote-plan']!.steps.find((s) => s.id === 'files')!
    expect(files.run).toContain('git cat-file -e "$SHA:scripts/release-build.mjs"')
    expect(files.run).toContain('git cat-file -e "$SHA:scripts/release-unpack.sh"')
    expect(doc.jobs['promote-plan']!.outputs!.publish).toBe("${{ steps.plan.outputs.publish == 'true' && steps.files.outputs.publish == 'true' }}")
  })

  it('a stable publish needs the tag to name package.json\'s version and CI to have passed, both before the build', () => {
    const tagGate = doc.jobs['stable-build']!.steps.find((s) => s.name?.includes('tag names the version'))
    expect(tagGate?.run).toContain('exit 1')
    const gate = doc.jobs['stable-build']!.steps.indexOf(tagGate!)
    const ci = stepIndex('stable-build', 'node scripts/ci-gate.mjs release HEAD')
    expect(ci).toBeGreaterThan(gate)
    expect(ci).toBeLessThan(stepIndex('stable-build', 'release-build.mjs'))
    expect(stepIndex('stable-build', 'npm run lint')).toBeLessThan(stepIndex('stable-build', 'release-build.mjs'))
    expect(needsOf('stable')).toContain('stable-build')
  })

  it('a nightly check publishes only once the last one is old enough; by hand, at once', () => {
    const pick = doc.jobs['nightly-build']!.steps.find((s) => s.id === 'pick')!.run!
    const due = pick.indexOf('node scripts/nightly-version.mjs due')
    expect(due).toBeGreaterThan(-1)
    expect(due).toBeLessThan(pick.indexOf('node scripts/ci-gate.mjs last-green main'))
    expect(pick.slice(0, due)).toContain('"${{ github.event_name }}" != "workflow_dispatch"')
    const plan = doc.jobs['promote-plan']!.steps.find((s) => s.id === 'plan')!.run!
    expect(plan).toContain("github.event_name == 'workflow_dispatch' && '--min-gap-hours 0'")
  })

  it('the nightly publishes the newest commit CI passed, without rerunning the tests', () => {
    expect(runs('nightly-build')).toContain('node scripts/ci-gate.mjs last-green main')
    for (const job of ['nightly-build', 'nightly']) expect(runs(job), job).not.toContain('test:baseline')
    const pick = doc.jobs['nightly-build']!.steps.find((s) => s.id === 'pick')!
    // The last nightly is the one npm records, never a git tag: the job's token
    // cannot point a tag at a commit whose workflows differ from main's tip.
    expect(pick.run).toContain('last="$(node scripts/nightly-version.mjs last)"')
    expect(pick.run).not.toContain('refs/tags/nightly')
    expect(pick.run).toContain('git checkout --quiet "$green"')
    // Never older than the last nightly (the runs list can lag a finished run).
    expect(pick.run).toContain('git merge-base --is-ancestor "$last" "$green"')
    const build = doc.jobs['nightly-build']!.steps.find((s) => s.id === 'build')!
    expect(build.if).toBe("steps.pick.outputs.publish == 'true'")
    expect(doc.jobs['nightly-build']!.outputs).toMatchObject({ publish: '${{ steps.pick.outputs.publish }}', sha: '${{ steps.pick.outputs.sha }}', version: '${{ steps.build.outputs.version }}' })
    for (const job of ['nightly-build', 'nightly']) expect(runs(job), job).not.toMatch(/git (tag|push)/)
    // The run ends only once npm serves what it published, so the next run reads it.
    const steps = doc.jobs.nightly!.steps
    const publish = steps.findIndex((s) => (s.run ?? '').includes('npm-packages.mjs publish'))
    const wait = steps.findIndex((s) => s.run === 'node scripts/nightly-version.mjs wait "$VERSION"')
    expect(wait).toBeGreaterThan(publish)
  })

  it('the nightly asks again, right before it publishes, whether its commit is still the next nightly', () => {
    // The pick and the publish are jobs apart now: another run may have published
    // in between, and two runs must never publish one commit twice or move installs back.
    const job = doc.jobs.nightly!
    const checkout = job.steps.find((s) => s.uses?.startsWith('actions/checkout'))!
    expect(checkout.with).toEqual({ ref: '${{ needs.nightly-build.outputs.sha }}', 'fetch-depth': 0 })
    expect(job.env).toMatchObject({ SHA: '${{ needs.nightly-build.outputs.sha }}', VERSION: '${{ needs.nightly-build.outputs.version }}' })
    const recheck = job.steps.findIndex((s) => s.id === 'recheck')
    const run = job.steps[recheck]!.run!
    expect(run).toContain('last="$(node scripts/nightly-version.mjs last)"')
    expect(run).toContain('[ "$last" = "$SHA" ] && [ "${{ inputs.force }}" != "true" ]')
    expect(run).toContain('[ "${{ inputs.force }}" != "true" ] && [ "$last" != "none" ] && ! git merge-base --is-ancestor "$last" "$SHA"')
    expect(run).toContain('::warning::')
    // Every step after it waits on its answer: nothing is downloaded, packed or published otherwise.
    for (const s of job.steps.slice(recheck + 1)) expect(s.if, s.name ?? s.uses ?? s.run).toBe("steps.recheck.outputs.publish == 'true'")
    expect(recheck).toBeLessThan(job.steps.findIndex((s) => (s.run ?? '').includes('npm-packages.mjs publish')))
    expect(recheck).toBeGreaterThan(job.steps.indexOf(checkout))
  })

  it('the GitHub Release notes come from the tested script, after the publish', () => {
    expect(runs('stable')).toContain('node scripts/release-notes.mjs "$VERSION" > release-notes.md')
    expect(text).not.toContain('node -e')
    expect(stepIndex('stable', 'release-notes.mjs')).toBeGreaterThan(stepIndex('stable', 'npm-packages.mjs publish'))
  })

  it('a nightly after a stable release builds on that release', () => {
    const build = doc.jobs['nightly-build']!.steps.find((s) => s.id === 'build')!
    expect(build.run).toContain('WALNUT_LATEST_STABLE="$(npm view open-walnut@latest version')
    expect(build.run!.indexOf('export WALNUT_LATEST_STABLE')).toBeLessThan(build.run!.indexOf('node scripts/nightly-version.mjs'))
    expect(build.run!.indexOf('version="$(node scripts/nightly-version.mjs)"')).toBeLessThan(build.run!.indexOf('release-build.mjs'))
  })

  it('each publishing job has its own queue and a running publisher is never cancelled', () => {
    // Per job, not per run: one run checks both channels, and a nightly must not
    // wait behind a stable release.
    expect((doc as unknown as { concurrency?: unknown }).concurrency).toBeUndefined()
    const queue = (job: string) => (doc.jobs[job] as unknown as { concurrency?: { group: string; 'cancel-in-progress': boolean } }).concurrency
    expect(queue('nightly')).toEqual({ group: 'release-nightly', 'cancel-in-progress': false })
    expect(queue('promote')).toEqual({ group: 'release-promote', 'cancel-in-progress': false })
    // A tag publish is never a pending job another run could replace.
    expect(queue('stable')).toEqual({ group: 'release-tag-${{ github.ref_name }}', 'cancel-in-progress': false })
    // The planning, build, matrix and smoke jobs only read, so they need no queue.
    for (const job of ['promote-plan', 'promote-smoke', ...CHANNELS.flatMap((c) => [c.build, c.files])]) expect(queue(job), job).toBeUndefined()
  })

  it('every release job has a time limit, so a hung run cannot hold the release queue', () => {
    for (const [name, job] of Object.entries(doc.jobs as Record<string, Job & { 'timeout-minutes'?: number }>)) {
      // A job that calls the binary matrix cannot have one: the matrix's own jobs do.
      if (job.uses) {
        expect(job.uses, name).toBe('./.github/workflows/binary-matrix.yml')
        continue
      }
      expect(job['timeout-minutes'], name).toBeGreaterThan(0)
    }
    for (const [name, job] of Object.entries(matrix.jobs)) expect(job['timeout-minutes'], `binary-matrix ${name}`).toBeGreaterThan(0)
  })

  it('the daily stable runs the build\'s files everywhere and installs the soaked nightly on fresh Linux and macOS before publishing', () => {
    const jobs = doc.jobs as Record<string, Job & { strategy?: { matrix: { os: string[] } } }>
    expect(runs('promote-plan')).toMatch(/node scripts\/stable-promote\.mjs plan --notes "\$RUNNER_TEMP\/notes\.md" .*>> "\$GITHUB_OUTPUT"/)
    expect(jobs['promote-smoke']!.needs).toBe('promote-plan')
    expect(jobs['promote-smoke']!.if).toBe("needs.promote-plan.outputs.publish == 'true'")
    expect(jobs['promote-smoke']!.strategy!.matrix.os).toEqual(['ubuntu-24.04', 'macos-26'])
    const smoke = runs('promote-smoke')
    expect(smoke).toContain('npm install -g npm@12')
    expect(smoke).toContain('node scripts/stable-promote.mjs allow-scripts')
    expect(smoke).toContain('npm install -g "open-walnut@$NIGHTLY" --allow-scripts="$allow"')
    expect(smoke).toContain('HOME="$RUNNER_TEMP/home" open-walnut web')
    expect(smoke).toContain('/api/system/health')
    // The build and its matrix run beside the smoke, from the nightly's commit.
    expect(jobs['promote-build']!.needs).toBe('promote-plan')
    expect(jobs['promote-build']!.if).toBe("needs.promote-plan.outputs.publish == 'true'")
    expect(jobs['promote-build']!.steps.find((s) => s.uses?.startsWith('actions/checkout'))!.with).toEqual({ ref: '${{ needs.promote-plan.outputs.sha }}' })
    expect(jobs['promote-files']!.needs).toEqual(['promote-plan', 'promote-build'])
    expect(jobs['promote-files']!.if).toBe("needs.promote-plan.outputs.publish == 'true'")
    // Publishing waits for the matrix and both smokes; a red one stops it.
    expect(jobs.promote!.needs).toEqual(['promote-plan', 'promote-build', 'promote-files', 'promote-smoke'])
    // A dry run (dispatch, stable) plans the newest nightly, builds it, runs its files
    // and smoke-tests it, and stops there.
    expect(jobs.promote!.if).toBe("needs.promote-plan.outputs.publish == 'true' && !inputs.dry_run")
    expect(runs('promote-plan')).toContain("${{ inputs.dry_run && '--soak-hours 0' || '' }}")
    for (const job of ['promote-smoke', 'promote-build', 'promote-files']) expect(jobs[job]!.if, job).not.toContain('dry_run')
    const checkout = jobs.promote!.steps.find((s) => s.uses?.startsWith('actions/checkout'))
    expect(checkout?.with?.ref).toBe('${{ needs.promote-plan.outputs.sha }}')
    const publish = stepIndex('promote', 'npm-packages.mjs publish --dir "$RUNNER_TEMP/release/npm" --tag latest --provenance')
    const tag = stepIndex('promote', 'git tag -f -a "v$VERSION"')
    const roll = stepIndex('promote', 'node scripts/stable-promote.mjs roll')
    expect(publish).toBeGreaterThan(stepIndex('promote', 'sh scripts/release-unpack.sh'))
    expect(tag).toBeGreaterThan(publish)
    expect(roll).toBeGreaterThan(tag)
    expect(runs('promote')).toContain('gh release create "v$VERSION" --draft')
    expect(runs('promote')).toContain('git commit --quiet -am "release: $VERSION"')
    expect(usesIndex('promote', 'actions/download-artifact')).toBeGreaterThan(-1)
  })

  it('package.json is already in the form npm publishes', () => {
    // npm normalizes the manifest at publish and logs each fix; for `./bin/x` it
    // says the bin "was invalid and removed" though it keeps it (2026-10-03 nightly
    // log), which reads like a broken package. Nothing to fix means nothing logged.
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')) as { bin: Record<string, string>; repository: { url: string } }
    expect(Object.keys(pkg.bin).sort()).toEqual(['open-walnut', 'walnut'])
    for (const target of Object.values(pkg.bin)) expect(target).toBe('bin/open-walnut.js')
    expect(pkg.repository.url).toBe('git+https://github.com/EvanZhang008/open-walnut.git')
  })

  it('package.json exposes the release command', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts.release).toBe('node scripts/release.mjs')
  })
})

describe('binary-matrix.yml', () => {
  type Step = { run?: string; name?: string; if?: string; uses?: string; with?: Record<string, unknown> }
  type Job = { if?: string; needs?: string; env?: Record<string, string>; steps: Step[]; strategy?: { matrix: { include: Array<{ file: string }> } } }
  const doc = parseYaml(fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/binary-matrix.yml'), 'utf8')) as {
    on: { workflow_call: { inputs: Record<string, { type: string; default: string }> } }
    concurrency: { group: string; 'cancel-in-progress': string }
    jobs: Record<string, Job>
  }
  const ROWS = ['linux', 'macos', 'old-kernel']

  it('takes a release\'s files, their version and their commit from a caller', () => {
    for (const input of ['files', 'version', 'ref']) expect(doc.on.workflow_call.inputs[input], input).toMatchObject({ type: 'string', default: '' })
  })

  it('a release\'s call builds nothing, and its rows run even so; a failed build runs no row', () => {
    expect(doc.jobs.build!.if).toBe("inputs.files == ''")
    for (const row of ROWS) {
      expect(doc.jobs[row]!.needs, row).toBe('build')
      expect(doc.jobs[row]!.if, row).toBe("${{ !cancelled() && (needs.build.result == 'success' || (needs.build.result == 'skipped' && inputs.files != '')) }}")
    }
  })

  it('every row of a release\'s call runs its own target out of the release\'s very .gz, checked, at the release\'s version', () => {
    for (const row of ROWS) {
      const steps = doc.jobs[row]!.steps
      expect(steps[0]!.uses, row).toBe('actions/checkout@v5')
      expect(steps[0]!.with, row).toEqual({ ref: '${{ inputs.ref }}' })
      const own = steps.find((s) => s.uses?.startsWith('actions/download-artifact') && s.with?.name === 'walnut-files')!
      expect(own.if, row).toBe("inputs.files == ''")
      const theirs = steps.find((s) => s.uses?.startsWith('actions/download-artifact') && s.with?.name === '${{ inputs.files }}')!
      expect(theirs.if, row).toBe("inputs.files != ''")
      const unpack = steps.find((s) => (s.run ?? '').includes('scripts/release-unpack.sh'))!
      expect(unpack.if, row).toBe("inputs.files != ''")
      const target = row === 'old-kernel' ? 'linux-x64' : '"${FILE#walnut-}"'
      expect(unpack.run, row).toContain(`sh scripts/release-unpack.sh "$RUNNER_TEMP/release" "$VERSION" dist-bin ${target}\n`)
      // The rehearsal compares the file's --version with package.json's.
      expect(unpack.run, row).toContain('node scripts/release-files.mjs stamp "$VERSION"')
      expect(doc.jobs[row]!.env?.VERSION, row).toBe('${{ inputs.version }}')
      const rehearse = steps.findIndex((s) => /binary-matrix\.sh|release-rehearsal\/run\.mjs|binary-old-kernel\.sh/.test(s.run ?? ''))
      expect(rehearse, row).toBeGreaterThan(steps.indexOf(unpack))
    }
    for (const row of ['linux', 'macos']) {
      for (const { file } of doc.jobs[row]!.strategy!.matrix.include) expect(file, row).toMatch(/^walnut-(darwin|linux)-(arm64|x64)(-musl)?$/)
      expect(doc.jobs[row]!.env?.FILE, row).toBe('${{ matrix.file }}')
    }
    // The Mac rows judge the signature of the file the release ships.
    const mac = doc.jobs.macos!.steps
    expect(mac.findIndex((s) => (s.run ?? '').startsWith('codesign --verify'))).toBeGreaterThan(mac.findIndex((s) => (s.run ?? '').includes('release-unpack.sh')))
  })

  it('a release\'s call never cancels, and is never cancelled by, a push run on the same ref', () => {
    // A nightly or a promote calls it from a run on main, where main's push runs live.
    expect(doc.concurrency.group).toBe("binary-matrix-${{ inputs.files != '' && format('{0}-{1}', github.run_id, inputs.files) || github.ref }}")
    expect(doc.concurrency['cancel-in-progress']).toBe("${{ inputs.files == '' }}")
  })
})

describe('ci.yml', () => {
  const text = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/ci.yml'), 'utf8')
  const doc = parseYaml(text) as {
    jobs: Record<string, { needs?: string | string[]; strategy?: { matrix: Record<string, unknown> }; steps: Array<{ run?: string; name?: string; 'continue-on-error'?: boolean }> }>
  }
  const runs = (job: string) => doc.jobs[job]!.steps.map((s) => s.run ?? '').join('\n')
  const gate = doc.jobs['ci-ok']!

  it('CI OK, the check both channels publish by, waits on the rehearsal, the slow tier and e2e', () => {
    expect(gate.needs).toEqual(expect.arrayContaining(['build', 'test', 'test-heavy', 'test-e2e', 'onboarding', 'remote-host', 'rehearsal']))
    // The informational browser suite stays out of the gate.
    expect(gate.needs).not.toContain('browser')
    const check = gate.steps.map((s) => s.run ?? '').join('\n')
    for (const job of gate.needs as string[]) expect(check, job).toContain(`needs.${job}.result`)
  })

  it('CI OK judges every finished run but one a newer push cancelled', () => {
    // always() ran it on superseded runs too, against cancelled legs: a red run
    // for every quick re-push. !cancelled() still runs it when a gate failed.
    expect((gate as { if?: string }).if).toBe('${{ !cancelled() }}')
    expect((parseYaml(text) as { concurrency: { 'cancel-in-progress': boolean } }).concurrency['cancel-in-progress']).toBe(true)
  })

  it('the rehearsal packs this commit and installs it with npm 12 on Linux and macOS', () => {
    expect(doc.jobs.rehearsal!.strategy!.matrix.os).toEqual(['ubuntu-24.04', 'macos-26'])
    const steps = doc.jobs.rehearsal!.steps.map((s) => s.run ?? '')
    const pack = steps.findIndex((r) => r.includes('scripts/release-rehearsal/pack.mjs') && r.includes('--rehearsal'))
    const npm12 = steps.findIndex((r) => r.includes('npm install -g npm@12'))
    const rehearse = steps.findIndex((r) => r.includes('scripts/release-rehearsal/run.mjs'))
    expect(pack).toBeGreaterThan(-1)
    expect(npm12).toBeGreaterThan(pack)
    expect(rehearse).toBeGreaterThan(npm12)
    expect(steps[rehearse]).toContain('--field latest')
    expect(doc.jobs.rehearsal!.steps.some((s) => s['continue-on-error'])).toBe(false)
  })

  it('the quick tier blocks in three serial legs that cover it once', () => {
    const legs = (doc.jobs.test!.strategy!.matrix.include as Array<{ tier: string; cmd: string }>).filter((l) => l.tier.startsWith('quick'))
    expect(legs.map((l) => l.cmd)).toEqual([1, 2, 3].map((i) => `npm run test:baseline -- --maxWorkers=1 --shard=${i}/3`))
    expect(doc.jobs.test!.steps.some((s) => s['continue-on-error'])).toBe(false)
  })

  it('the slow and e2e tiers block, with retries for runner flakes', () => {
    expect(runs('test-heavy')).toContain('npm run test:slow -- --maxWorkers=1 --retry=2')
    expect(doc.jobs['test-heavy']!.steps.some((s) => s['continue-on-error'])).toBe(false)
    // e2e: four shards, each judged against the committed baseline, never tolerated.
    expect(doc.jobs['test-e2e']!.strategy!.matrix.shard).toEqual([1, 2, 3, 4])
    expect(runs('test-e2e')).toContain('node scripts/test-baseline.mjs check --maxWorkers=1 --retry=2 --shard=${{ matrix.shard }}/4')
    expect(doc.jobs['test-e2e']!.steps.some((s) => s['continue-on-error'])).toBe(false)
    const e2e = doc.jobs['test-e2e']!.steps.find((s) => s.run?.includes('test-baseline.mjs')) as { env?: Record<string, string> }
    expect(e2e.env).toMatchObject({
      WALNUT_BASELINE_CONFIG: 'vitest.e2e.config.ts',
      WALNUT_BASELINE_FILE: 'tests/setup/known-failures-e2e.json',
    })
    expect(fs.existsSync(path.resolve(__dirname, '../../tests/setup/known-failures-e2e.json'))).toBe(true)
    // Each leg keeps its own run, so the next baseline can be read off CI.
    expect(e2e.env!.WALNUT_BASELINE_RUN_OUT).toContain('known-failures-e2e-${{ matrix.shard }}.json')
    expect(text).toContain('name: known-failures-e2e-${{ matrix.shard }}')
  })

  it('the browser suite runs in shards and reports through the tested summary script', () => {
    expect(doc.jobs.browser!.strategy!.matrix.shard).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(runs('browser')).toContain('npx playwright test --project=chromium --shard=${{ matrix.shard }}/8')
    // The run ends itself before the job timeout, so its report is always uploaded.
    // Its budget is counted from the job's first step (2026-10-23: a 14 min browser
    // install left a fixed 45 min run still going when the job's 60 ran out).
    const jobMin = (doc.jobs.browser as unknown as { 'timeout-minutes': number })['timeout-minutes']
    const steps = doc.jobs.browser!.steps
    expect(steps[0]!.run).toBe('echo "JOB_STARTED_AT=$(date +%s)" >> "$GITHUB_ENV"')
    const test = runs('browser')
    expect(test).toMatch(/--global-timeout=\$\(\( budget \* 1000 \)\)/)
    const left = /left=\$\(\( JOB_STARTED_AT \+ (\d+) \* 60 - \$\(date \+%s\) \)\)/.exec(test)
    expect(Number(left?.[1])).toBeLessThanOrEqual(jobMin - 5)
    const cap = Number(/budget=\$\(\( left < (\d+) \? left : \1 \)\)/.exec(test)?.[1])
    expect(cap * 1000).toBeLessThan((jobMin - 10) * 60_000)
    // Every engine a spec launches is installed: *.webkit.spec.ts specs launch WebKit.
    expect(test).toContain('npx playwright install --with-deps chromium webkit')
    expect(test).toContain('node scripts/playwright-summary.mjs')
  })

  it('the browser budget never runs the tests past the job timeout, however long the setup took', () => {
    const test = runs('browser')
    const script = test.slice(test.indexOf('left=$(('), test.indexOf('npx playwright test --project'))
    const jobMin = (doc.jobs.browser as unknown as { 'timeout-minutes': number })['timeout-minutes']
    for (const setupSecs of [60, 840, 2900, 3500]) {
      const now = 1_800_000_000
      const r = spawnSync('bash', ['-c', `date() { echo ${now}; }; export -f date; JOB_STARTED_AT=${now - setupSecs}; ${script} echo "$budget"`], { encoding: 'utf8' })
      const budget = Number(r.stdout.trim().split('\n').pop())
      expect(budget).toBeGreaterThan(0)
      expect(budget).toBeLessThanOrEqual(2700)
      if (setupSecs < 50 * 60) expect(setupSecs + budget).toBeLessThanOrEqual((jobMin - 5) * 60)
    }
  })

  it('a browser spec that fails to load blocks in Lint & build, before any shard runs', () => {
    // 2026-10-02: one missing export made every shard run 0 tests, and the report-only
    // shards stayed green.
    const steps = doc.jobs.build!.steps
    const list = steps.findIndex((s) => (s.run ?? '').includes('npx playwright test --list --project=chromium'))
    expect(list).toBeGreaterThan(steps.findIndex((s) => s.run === 'bun install --frozen-lockfile'))
    expect(steps[list]!['continue-on-error']).toBeUndefined()
    expect(gate.needs).toContain('build')
  })
})
