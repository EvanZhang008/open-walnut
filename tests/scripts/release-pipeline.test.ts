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
 *   once a week after a fresh-machine install of it (the plan itself is
 *   tests/scripts/stable-promote.test.ts).
 */
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { nextVersion, rollChangelog, setManifestVersion } from '../../scripts/release.mjs'
import { NIGHTLY_GAP_HOURS, lastNightlyCommit, newerBase, nightlyDue, nightlyVersion, servesNightly } from '../../scripts/nightly-version.mjs'
import { pickLastGreen, releaseGateRev, verdictOf } from '../../scripts/ci-gate.mjs'
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
    for (const f of ['package.json', 'package-lock.json']) {
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

  it('a release commit (only the release files) is judged by its parent', () => {
    expect(releaseGateRev(['package.json', 'package-lock.json', 'CHANGELOG.md'])).toBe('parent')
    expect(releaseGateRev(['CHANGELOG.md'])).toBe('parent')
    expect(releaseGateRev(['package.json', 'src/cli.ts'])).toBe('self')
    expect(releaseGateRev([])).toBe('self')
  })

  it('the nightly takes the newest green commit, skipping red, running and cancelled ones', () => {
    const runs = [
      run(5, 'e', '2026-10-01T05:00:00Z', 'in_progress', null),
      run(4, 'd', '2026-10-01T04:00:00Z', 'completed', 'cancelled'),
      run(3, 'c', '2026-10-01T03:00:00Z', 'completed', 'failure'),
      run(2, 'b', '2026-10-01T02:00:00Z', 'completed', 'success'),
      run(1, 'a', '2026-10-01T01:00:00Z', 'completed', 'success'),
    ]
    const jobs = (id: number) => (id === 3 ? gate('failure') : gate('success'))
    expect(pickLastGreen(runs, jobs)).toBe('b')
    expect(pickLastGreen(runs.slice(0, 3), jobs)).toBeNull()
    // Report-only failures fail the run but not the gate: still green.
    expect(pickLastGreen([run(3, 'c', '2026-10-01T03:00:00Z', 'completed', 'failure')], () => gate('success'))).toBe('c')
  })
})

describe('release.yml', () => {
  const text = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/release.yml'), 'utf8')
  const doc = parseYaml(text) as {
    on: Record<string, unknown>
    permissions: Record<string, string>
    jobs: Record<string, { if?: string; steps: Array<{ run?: string; name?: string; if?: string; id?: string }> }>
  }
  const runs = (job: string) => doc.jobs[job]!.steps.map((s) => s.run ?? '').join('\n')
  const stepIndex = (job: string, needle: string) => doc.jobs[job]!.steps.findIndex((s) => (s.run ?? '').includes(needle))

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
    for (const job of ['nightly', 'promote-plan']) expect(doc.jobs[job]!.if).toContain("github.event_name == 'schedule'")
    expect(doc.jobs.nightly!.if).toContain("github.event_name == 'workflow_run'")
    expect(doc.jobs['promote-plan']!.if).toContain("github.event_name == 'workflow_run'")
    expect(doc.jobs.stable!.if).not.toContain('workflow_run')
    const dispatch = doc.on.workflow_dispatch as { inputs: Record<string, { options?: string[]; default?: unknown }> }
    expect(dispatch.inputs.channel).toMatchObject({ options: ['nightly', 'stable'], default: 'nightly' })
    expect(doc.jobs.nightly!.if).toContain("inputs.channel != 'stable'")
    expect(doc.jobs['promote-plan']!.if).toContain("inputs.channel == 'stable'")
  })

  it('the release jobs push without the repo\'s git hooks', () => {
    // 2026-10-02: the pre-push hook type-checked for 50s before a tag moved.
    expect((doc as unknown as { env: Record<string, string> }).env.HUSKY).toBe('0')
  })

  it('publishes through OIDC with provenance and never a stored token', () => {
    expect(doc.permissions['id-token']).toBe('write')
    expect(doc.permissions.actions).toBe('read')
    expect(text).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|registry-url/)
    expect(runs('stable')).toContain('npm publish --provenance --access public')
    expect(runs('stable')).toContain('npm install -g npm@12')
    expect(runs('nightly')).toContain('npm publish --tag nightly --provenance --access public')
    expect(runs('nightly')).toContain('node scripts/nightly-version.mjs')
  })

  it('a stable publish needs the tag to name package.json\'s version and CI to have passed, both before publishing', () => {
    expect(doc.jobs.stable!.if).toContain("startsWith(github.ref, 'refs/tags/v')")
    const tagGate = doc.jobs.stable!.steps.find((s) => s.name?.includes('tag names the version'))
    expect(tagGate?.run).toContain('exit 1')
    const ci = stepIndex('stable', 'node scripts/ci-gate.mjs release HEAD')
    const publish = stepIndex('stable', 'npm publish')
    expect(ci).toBeGreaterThan(-1)
    expect(ci).toBeLessThan(publish)
  })

  it('a nightly check publishes only once the last one is old enough; by hand, at once', () => {
    const pick = doc.jobs.nightly!.steps.find((s) => s.id === 'pick')!.run!
    const due = pick.indexOf('node scripts/nightly-version.mjs due')
    expect(due).toBeGreaterThan(-1)
    expect(due).toBeLessThan(pick.indexOf('node scripts/ci-gate.mjs last-green main'))
    expect(pick.slice(0, due)).toContain('"${{ github.event_name }}" != "workflow_dispatch"')
    const plan = doc.jobs['promote-plan']!.steps.find((s) => s.id === 'plan')!.run!
    expect(plan).toContain("github.event_name == 'workflow_dispatch' && '--min-gap-hours 0'")
  })

  it('the nightly publishes the newest commit CI passed, without rerunning the tests', () => {
    expect(runs('nightly')).toContain('node scripts/ci-gate.mjs last-green main')
    expect(runs('nightly')).not.toContain('test:baseline')
    const pick = doc.jobs.nightly!.steps.find((s) => s.id === 'pick')
    // The last nightly is the one npm records, never a git tag: the job's token
    // cannot point a tag at a commit whose workflows differ from main's tip.
    expect(pick?.run).toContain('last="$(node scripts/nightly-version.mjs last)"')
    expect(pick?.run).not.toContain('refs/tags/nightly')
    expect(pick?.run).toContain('git checkout --quiet "$green"')
    // Never older than the last nightly (the runs list can lag a finished run).
    expect(pick?.run).toContain('git merge-base --is-ancestor "$last" "$green"')
    const publish = doc.jobs.nightly!.steps.find((s) => s.name?.includes('publish it'))
    expect(publish?.if).toBe("steps.pick.outputs.publish == 'true'")
    expect(runs('nightly')).not.toMatch(/git (tag|push)/)
    // The run ends only once npm serves what it published, so the next run reads it.
    const wait = doc.jobs.nightly!.steps.findIndex((s) => (s.run ?? '').includes('node scripts/nightly-version.mjs wait "${{ steps.publish.outputs.version }}"'))
    expect(wait).toBeGreaterThan(doc.jobs.nightly!.steps.indexOf(publish!))
    expect(doc.jobs.nightly!.steps[wait]!.if).toBe("steps.pick.outputs.publish == 'true'")
  })

  it('the GitHub Release notes come from the tested script, after the publish', () => {
    expect(runs('stable')).toContain('node scripts/release-notes.mjs "$version" > release-notes.md')
    expect(text).not.toContain('node -e')
    expect(stepIndex('stable', 'release-notes.mjs')).toBeGreaterThan(stepIndex('stable', 'npm publish'))
  })

  it('a nightly after a stable release builds on that release', () => {
    const publish = doc.jobs.nightly!.steps.find((s) => s.name?.includes('publish it'))!
    expect(publish.run).toContain('WALNUT_LATEST_STABLE="$(npm view open-walnut@latest version')
    expect(publish.run!.indexOf('export WALNUT_LATEST_STABLE')).toBeLessThan(publish.run!.indexOf('node scripts/nightly-version.mjs'))
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
    // The planning and smoke jobs only read, so they need no queue.
    expect(queue('promote-plan')).toBeUndefined()
    expect(queue('promote-smoke')).toBeUndefined()
  })

  it('every release job has a time limit, so a hung run cannot hold the release queue', () => {
    const jobs = doc.jobs as Record<string, { 'timeout-minutes'?: number }>
    for (const [name, job] of Object.entries(jobs)) expect(job['timeout-minutes'], name).toBeGreaterThan(0)
  })

  it('the daily stable installs the soaked nightly on fresh Linux and macOS before publishing it', () => {
    const jobs = doc.jobs as Record<string, { needs?: string | string[]; if?: string; strategy?: { matrix: { os: string[] } }; steps: Array<{ run?: string; name?: string; uses?: string; with?: Record<string, string>; env?: Record<string, string> }> }>
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
    // Publishing waits for both smokes; a red one stops it.
    expect(jobs.promote!.needs).toEqual(['promote-plan', 'promote-smoke'])
    // A dry run (dispatch, stable) plans the newest nightly and smoke-tests it, and stops there.
    expect(jobs.promote!.if).toBe("needs.promote-plan.outputs.publish == 'true' && !inputs.dry_run")
    expect(runs('promote-plan')).toContain("${{ inputs.dry_run && '--soak-hours 0' || '' }}")
    expect(jobs['promote-smoke']!.if).not.toContain('dry_run')
    const checkout = jobs.promote!.steps.find((s) => s.uses?.startsWith('actions/checkout'))
    expect(checkout?.with?.ref).toBe('${{ needs.promote-plan.outputs.sha }}')
    const publish = stepIndex('promote', 'npm publish --provenance --access public')
    const tag = stepIndex('promote', 'git tag -f -a "v$VERSION"')
    const roll = stepIndex('promote', 'node scripts/stable-promote.mjs roll')
    expect(publish).toBeGreaterThan(stepIndex('promote', 'npm ci'))
    expect(tag).toBeGreaterThan(publish)
    expect(roll).toBeGreaterThan(tag)
    expect(jobs.promote!.steps[publish]!.env?.WALNUT_VERSION_STAMPED).toBe('1')
    expect(runs('promote')).toContain('gh release create "v$VERSION"')
    expect(runs('promote')).toContain('git commit --quiet -am "release: $VERSION"')
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
    const globalMs = Number(/--global-timeout=(\d+)/.exec(runs('browser'))?.[1])
    expect(globalMs).toBeGreaterThan(0)
    expect(globalMs).toBeLessThan(((doc.jobs.browser as unknown as { 'timeout-minutes': number })['timeout-minutes'] - 10) * 60_000)
    expect(runs('browser')).toContain('node scripts/playwright-summary.mjs')
  })

  it('a browser spec that fails to load blocks in Lint & build, before any shard runs', () => {
    // 2026-10-02: one missing export made every shard run 0 tests, and the report-only
    // shards stayed green.
    const steps = doc.jobs.build!.steps
    const list = steps.findIndex((s) => (s.run ?? '').includes('npx playwright test --list --project=chromium'))
    expect(list).toBeGreaterThan(steps.findIndex((s) => s.run === 'npm ci'))
    expect(steps[list]!['continue-on-error']).toBeUndefined()
    expect(gate.needs).toContain('build')
  })
})
