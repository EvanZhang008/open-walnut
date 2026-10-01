/**
 * The release pipeline's pure parts, and the shape of the workflow that runs it.
 *
 * - scripts/release.mjs: the next version for a bump word, and rolling the
 *   CHANGELOG's Unreleased section under the version (refusing an empty one).
 * - scripts/nightly-version.mjs: the nightly version shape and its ordering
 *   against the stable release it precedes (the update checker's comparator is
 *   the judge, so a nightly can never be told it is newer than its own release).
 * - .github/workflows/release.yml: parses, publishes with provenance through
 *   OIDC (no token), gates the tag on package.json, and gates nightly on main
 *   having moved.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { nextVersion, rollChangelog } from '../../scripts/release.mjs'
import { nightlyVersion } from '../../scripts/nightly-version.mjs'
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

describe('release.yml', () => {
  const doc = parseYaml(fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/release.yml'), 'utf8')) as {
    on: Record<string, unknown>
    permissions: Record<string, string>
    jobs: Record<string, { if?: string; steps: Array<{ run?: string; name?: string; if?: string }> }>
  }

  it('runs on release tags, a schedule and by hand', () => {
    expect(doc.on.push).toEqual({ tags: ['v*.*.*'] })
    expect(doc.on.schedule).toEqual([{ cron: '17 5,17 * * *' }])
    expect(doc.on).toHaveProperty('workflow_dispatch')
  })

  it('publishes through OIDC with provenance and never a stored token', () => {
    expect(doc.permissions['id-token']).toBe('write')
    const text = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/release.yml'), 'utf8')
    expect(text).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|registry-url/)
    const stableRuns = doc.jobs.stable!.steps.map((s) => s.run ?? '').join('\n')
    expect(stableRuns).toContain('npm publish --provenance --access public')
    expect(stableRuns).toContain('npm install -g npm@latest')
    const nightlyRuns = doc.jobs.nightly!.steps.map((s) => s.run ?? '').join('\n')
    expect(nightlyRuns).toContain('npm publish --tag nightly --provenance --access public')
    expect(nightlyRuns).toContain('node scripts/nightly-version.mjs')
    expect(nightlyRuns).toContain('npm run test:baseline')
  })

  it('a stable publish is gated on the tag naming package.json\'s version; nightly on main having moved', () => {
    expect(doc.jobs.stable!.if).toContain("startsWith(github.ref, 'refs/tags/v')")
    const gate = doc.jobs.stable!.steps.find((s) => s.name?.includes('tag names the version'))
    expect(gate?.run).toContain('exit 1')
    const moved = doc.jobs.nightly!.steps.find((s) => s.name?.includes('Did main move'))
    expect(moved?.run).toContain('refs/tags/nightly')
    const publish = doc.jobs.nightly!.steps.find((s) => s.name?.includes('publish it'))
    expect(publish?.if).toBe("steps.moved.outputs.publish == 'true'")
  })

  it('package.json exposes the release command', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts.release).toBe('node scripts/release.mjs')
  })
})
