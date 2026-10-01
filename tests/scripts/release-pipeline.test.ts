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
 *   OIDC (no token), gates the tag on package.json and on CI, and publishes the
 *   newest green commit as the nightly.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { nextVersion, rollChangelog, setManifestVersion } from '../../scripts/release.mjs'
import { nightlyVersion } from '../../scripts/nightly-version.mjs'
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

  it('runs on release tags, a schedule and by hand', () => {
    expect(doc.on.push).toEqual({ tags: ['v*.*.*'] })
    expect(doc.on.schedule).toEqual([{ cron: '17 5,17 * * *' }])
    expect(doc.on).toHaveProperty('workflow_dispatch')
  })

  it('publishes through OIDC with provenance and never a stored token', () => {
    expect(doc.permissions['id-token']).toBe('write')
    expect(doc.permissions.actions).toBe('read')
    expect(text).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|registry-url/)
    expect(runs('stable')).toContain('npm publish --provenance --access public')
    expect(runs('stable')).toContain('npm install -g npm@latest')
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

  it('the nightly publishes the newest commit CI passed, without rerunning the tests', () => {
    expect(runs('nightly')).toContain('node scripts/ci-gate.mjs last-green main')
    expect(runs('nightly')).not.toContain('test:baseline')
    const pick = doc.jobs.nightly!.steps.find((s) => s.id === 'pick')
    expect(pick?.run).toContain('refs/tags/nightly')
    expect(pick?.run).toContain('git checkout --quiet "$green"')
    const publish = doc.jobs.nightly!.steps.find((s) => s.name?.includes('publish it'))
    expect(publish?.if).toBe("steps.pick.outputs.publish == 'true'")
    expect(runs('nightly')).toContain('git tag -f nightly "${{ steps.pick.outputs.sha }}"')
  })

  it('the GitHub Release notes come from the tested script, after the publish', () => {
    expect(runs('stable')).toContain('node scripts/release-notes.mjs "$version" > release-notes.md')
    expect(text).not.toContain('node -e')
    expect(stepIndex('stable', 'release-notes.mjs')).toBeGreaterThan(stepIndex('stable', 'npm publish'))
  })

  it('package.json exposes the release command', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts.release).toBe('node scripts/release.mjs')
  })
})
