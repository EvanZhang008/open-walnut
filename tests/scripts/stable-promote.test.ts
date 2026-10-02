/**
 * scripts/stable-promote.mjs: which soaked nightly the hourly check promotes, once a day, as
 * which version, with which notes, and how main's CHANGELOG is rolled afterwards.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MIN_GAP_HOURS, allowedScripts, bumpFor, generatedNotes, planRelease, rollReleased, soakedNightly } from '../../scripts/stable-promote.mjs'
import { releaseNotes } from '../../scripts/release-notes.mjs'
import { INSTALL_SCRIPT_PACKAGES } from '../../src/core/self-update/install-kind.js'

const HOUR = 3_600_000
const NOW = new Date('2026-10-06T16:47:00Z')
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR).toISOString()

/** A registry document: [version, gitHead or null, hours since publish]. */
function packument(latest: string | null, versions: Array<[string, string | null, number]>) {
  return {
    'dist-tags': latest ? { latest } : {},
    versions: Object.fromEntries(versions.map(([v, head]) => [v, head ? { gitHead: head } : {}])),
    time: Object.fromEntries(versions.map(([v, , h]) => [v, ago(h)])),
  }
}

const REGISTRY = packument('0.6.0', [
  ['0.6.0', 'stable0', 200],
  ['0.6.1-nightly.20261003.7', 'old', 85],
  ['0.6.1-nightly.20261004.8', 'cand', 59],
  ['0.6.1-nightly.20261004.9', null, 50],
  ['0.6.1-nightly.20261005.10', 'fresh', 23],
])

const CHANGELOG_AT_CANDIDATE = '# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- A published build no longer calls itself dirty.\n\n## [0.6.0] - 2026-10-01\n\n- Old.\n'
const EMPTY_UNRELEASED = '# Changelog\n\n## [Unreleased]\n\n## [0.6.0] - 2026-10-01\n\n- Old.\n'

function deps(over: Partial<Parameters<typeof planRelease>[0]> = {}) {
  return {
    packument: REGISTRY,
    now: NOW,
    lastStableSha: 'stable0',
    isAncestor: () => true,
    commitsSince: () => ['fix(release): published builds are no longer stamped dirty', 'docs: a note'],
    changelogAt: () => EMPTY_UNRELEASED,
    ciVerdict: () => 'green',
    ...over,
  }
}

describe('soakedNightly', () => {
  it('is the newest nightly out at least the soak time that names its commit', () => {
    // 20261004.9 is newer and soaked but has no gitHead; 20261005.10 is too fresh.
    expect(soakedNightly(REGISTRY, NOW)).toEqual({ version: '0.6.1-nightly.20261004.8', sha: 'cand', publishedAt: ago(59) })
    expect(soakedNightly(REGISTRY, NOW, 20)?.sha).toBe('fresh')
    expect(soakedNightly(REGISTRY, NOW, 100)).toBeNull()
    // The default soak is a day.
    expect(soakedNightly(packument('0.6.0', [['0.6.1-nightly.20261005.11', 'day', 25]]), NOW)?.sha).toBe('day')
    expect(soakedNightly(packument('0.6.0', [['0.6.1-nightly.20261005.12', 'young', 23]]), NOW)).toBeNull()
    // A stable release is never a candidate, however old.
    expect(soakedNightly(packument('0.6.0', [['0.6.0', 'stable0', 500]]), NOW)).toBeNull()
  })
})

describe('bumpFor', () => {
  it('before 1.0, a breaking change is the next minor and any feat, fix or perf the next patch', () => {
    expect(bumpFor(['docs: x', 'feat(tasks): y', 'fix: z'], '0.6.0')).toBe('patch')
    expect(bumpFor(['feat: a'], '0.6.0')).toBe('patch')
    expect(bumpFor(['fix(sessions): y', 'test: z'], '0.6.0')).toBe('patch')
    expect(bumpFor(['perf: faster'], '0.6.0')).toBe('patch')
    expect(bumpFor(['feat!: breaking'], '0.6.0')).toBe('minor')
    expect(bumpFor(['refactor(api)!: drop v0 routes'], '0.6.0')).toBe('minor')
    expect(bumpFor([{ subject: 'feat: x', body: 'Why.\n\nBREAKING CHANGE: the old flag is gone' }], '0.6.0')).toBe('minor')
    expect(bumpFor([{ subject: 'chore: x', body: 'BREAKING-CHANGE: y' }], '0.6.0')).toBe('minor')
    // "breaking" in prose is not a footer.
    expect(bumpFor([{ subject: 'fix: x', body: 'not a BREAKING CHANGE: really' }], '0.6.0')).toBe('patch')
  })

  it('from 1.0, breaking is major, feat minor, fix or perf patch', () => {
    expect(bumpFor(['feat!: x'], '1.2.3')).toBe('major')
    expect(bumpFor(['feat: x', 'fix: y'], '1.2.3')).toBe('minor')
    expect(bumpFor(['fix: y'], '1.2.3')).toBe('patch')
  })

  it('commits a user never sees release nothing', () => {
    expect(bumpFor(['docs: x', 'test(a): b', 'chore: c', 'ci: d', 'release: 0.6.0', 'Merge branch x'], '0.6.0')).toBeNull()
    expect(bumpFor([], '0.6.0')).toBeNull()
  })
})

describe('generatedNotes', () => {
  it('lists feat subjects as Added and fix/perf as Fixed, without type or scope', () => {
    expect(generatedNotes(['feat(tasks): the Leader pill counts open subtasks', 'fix: a crash', 'docs: no', 'perf(search): faster'])).toBe(
      '### Added\n\n- The Leader pill counts open subtasks\n\n### Fixed\n\n- A crash\n- Faster',
    )
    expect(generatedNotes(['fix: only', 'fix: `npm ci` keeps the lockfile'])).toBe('### Fixed\n\n- Only\n- `npm ci` keeps the lockfile')
    expect(generatedNotes(['docs: none'])).toBe('')
  })
})

describe('planRelease', () => {
  it('promotes the soaked nightly as a patch for fixes, with notes from the commits when nobody wrote any', () => {
    const ciVerdict = vi.fn(() => 'green')
    const commitsSince = vi.fn(() => ['fix(release): published builds are no longer stamped dirty', 'docs: a note'])
    const plan = planRelease(deps({ ciVerdict, commitsSince }))
    expect(plan).toEqual({
      publish: true, sha: 'cand', version: '0.6.1', bump: 'patch', from: '0.6.0', nightly: '0.6.1-nightly.20261004.8',
      notes: '### Fixed\n\n- Published builds are no longer stamped dirty', written: false,
    })
    expect(commitsSince).toHaveBeenCalledWith('stable0', 'cand')
    expect(ciVerdict).toHaveBeenCalledWith('cand')
  })

  it('a feat is the next patch before 1.0, and a written Unreleased section is the notes', () => {
    const plan = planRelease(deps({ commitsSince: () => ['feat: a thing', 'fix: b'], changelogAt: () => CHANGELOG_AT_CANDIDATE }))
    expect(plan).toMatchObject({ publish: true, version: '0.6.1', bump: 'patch', written: true, notes: '### Fixed\n\n- A published build no longer calls itself dirty.' })
  })

  it('a breaking change is the next minor before 1.0', () => {
    const plan = planRelease(deps({ commitsSince: () => [{ subject: 'feat(config)!: rename the data dir', body: '' }] }))
    expect(plan).toMatchObject({ publish: true, version: '0.7.0', bump: 'minor', notes: '### Added\n\n- Rename the data dir' })
  })

  it('a written entry alone is enough for a patch', () => {
    const plan = planRelease(deps({ commitsSince: () => ['docs: x', 'test: y'], changelogAt: () => CHANGELOG_AT_CANDIDATE }))
    expect(plan).toMatchObject({ publish: true, version: '0.6.1', bump: 'patch', written: true })
  })

  it('reads the changelog at the candidate, not at main', () => {
    const changelogAt = vi.fn(() => EMPTY_UNRELEASED)
    planRelease(deps({ changelogAt }))
    expect(changelogAt).toHaveBeenCalledWith('cand')
  })

  it('skips, saying why, whenever there is nothing safe or new to release', () => {
    const ciVerdict = vi.fn(() => 'green')
    const skip = (over: Partial<Parameters<typeof planRelease>[0]>) => {
      const plan = planRelease(deps({ ciVerdict, ...over }))
      expect(plan.publish).toBe(false)
      return (plan as { reason: string }).reason
    }
    expect(skip({ packument: { ...REGISTRY, 'dist-tags': {} } })).toContain('no latest release')
    expect(skip({ soakHours: 100 })).toContain('no nightly has been out 100h')
    expect(skip({ lastStableSha: null })).toContain('cannot find the commit of 0.6.0')
    expect(skip({ lastStableSha: 'cand' })).toContain('is the code 0.6.0 already ships')
    expect(skip({ isAncestor: () => false })).toContain('does not descend from 0.6.0')
    expect(skip({ commitsSince: () => ['docs: x', 'test: y'] })).toContain('nothing a user would notice since 0.6.0 (2 commits)')
    // CI is asked last, and only when there is something to release.
    expect(ciVerdict).not.toHaveBeenCalled()
    expect(skip({ ciVerdict: () => 'red' })).toBe('CI on cand is red')
    expect(skip({ ciVerdict: () => 'none' })).toBe('CI on cand is none')
  })

  it('one stable a day: the hourly check waits 23h after the last one, a run by hand does not', () => {
    expect(MIN_GAP_HOURS).toBe(23)
    const fresh = packument('0.6.0', [['0.6.0', 'stable0', 22], ['0.6.1-nightly.20261004.8', 'cand', 59]])
    const plan = planRelease(deps({ packument: fresh }))
    expect(plan).toMatchObject({ publish: false, reason: '0.6.0 came out 22h ago; the next stable waits 23h' })
    expect(planRelease(deps({ packument: fresh, minGapHours: 0 }))).toMatchObject({ publish: true, sha: 'cand' })
    const dayOld = packument('0.6.0', [['0.6.0', 'stable0', 23.5], ['0.6.1-nightly.20261004.8', 'cand', 59]])
    expect(planRelease(deps({ packument: dayOld }))).toMatchObject({ publish: true, sha: 'cand' })
  })
})

const MAIN_CHANGELOG = `# Changelog

Intro.

## [Unreleased]

### Added

- Written after the candidate: stays.

### Fixed

- A published build no longer calls itself dirty.
  It used to say +dirty.
- Also after the candidate.

### Changed

- Shipped change.

## [0.6.0] - 2026-10-01

- Old.
`

describe('rollReleased', () => {
  const notes = '### Fixed\n\n- A published build no longer calls itself dirty.\n  It used to say +dirty.\n\n### Changed\n\n- Shipped change.\n'

  it('moves exactly the released entries under the version and keeps the ones written since', () => {
    const out = rollReleased(MAIN_CHANGELOG, notes, '0.6.1', '2026-10-06')
    expect(out).toBe(`# Changelog

Intro.

## [Unreleased]

### Added

- Written after the candidate: stays.

### Fixed

- Also after the candidate.

## [0.6.1] - 2026-10-06

### Fixed

- A published build no longer calls itself dirty.
  It used to say +dirty.

### Changed

- Shipped change.

## [0.6.0] - 2026-10-01

- Old.
`)
    expect(releaseNotes(out, '0.6.1')).toBe(notes.trim())
    expect(releaseNotes(out, '0.6.0')).toBe('- Old.')
  })

  it('leaves an empty Unreleased when everything shipped', () => {
    const out = rollReleased('# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- One.\n\n## [0.6.0] - x\n\n- Old.\n', '### Fixed\n\n- One.', '0.6.1', '2026-10-06')
    expect(out).toBe('# Changelog\n\n## [Unreleased]\n\n## [0.6.1] - 2026-10-06\n\n### Fixed\n\n- One.\n\n## [0.6.0] - x\n\n- Old.\n')
  })

  it('notes made from commit subjects leave Unreleased as it was', () => {
    const out = rollReleased(MAIN_CHANGELOG, '### Fixed\n\n- a crash', '0.6.1', '2026-10-06')
    expect(out).toContain('## [Unreleased]\n\n### Added\n\n- Written after the candidate: stays.')
    expect(out).toContain('- Shipped change.\n\n## [0.6.1] - 2026-10-06\n\n### Fixed\n\n- a crash\n\n## [0.6.0]')
  })

  it('works when Unreleased is the last section', () => {
    expect(rollReleased('# Changelog\n\n## [Unreleased]\n\n- Only.\n', '- Only.', '0.1.0', '2026-10-06')).toBe('# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-06\n\n- Only.\n')
  })

  it('an entry keeps its blank-separated paragraphs, and a subsection with text stays', () => {
    const text = '# C\n\n## [Unreleased]\n\n### Fixed\n\n- Shipped.\n\n  Second paragraph.\n\n- Kept.\n\n### Notes\n\nPlain text.\n\n## [0.6.0] - x\n'
    const out = rollReleased(text, '### Fixed\n\n- Shipped.\n\n  Second paragraph.', '0.6.1', '2026-10-06')
    expect(out).toBe('# C\n\n## [Unreleased]\n\n### Fixed\n\n- Kept.\n\n### Notes\n\nPlain text.\n\n## [0.6.1] - 2026-10-06\n\n### Fixed\n\n- Shipped.\n\n  Second paragraph.\n\n## [0.6.0] - x\n')
  })

  it('refuses a version that already has a section, and a file without Unreleased', () => {
    expect(() => rollReleased(MAIN_CHANGELOG, notes, '0.6.0', '2026-10-06')).toThrow('already has a 0.6.0 section')
    expect(() => rollReleased('# Changelog\n\n## [0.6.0] - x\n', notes, '0.6.1', '2026-10-06')).toThrow('no "## [Unreleased]"')
  })

  it('rolls the repository CHANGELOG', () => {
    const text = fs.readFileSync(path.resolve(__dirname, '../../CHANGELOG.md'), 'utf8')
    const written = releaseNotes(text, 'Unreleased')
    const out = rollReleased(text, written ?? '### Fixed\n\n- x', '99.0.0', '2026-10-06')
    expect(out).toMatch(/^## \[Unreleased\]\s*$/m)
    expect(releaseNotes(out, '99.0.0')).toBe((written ?? '### Fixed\n\n- x').trim())
    if (written) expect(releaseNotes(out, 'Unreleased')).toBeNull()
  })
})

describe('allow-scripts', () => {
  it('is the list the updater passes to npm', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'))
    expect(allowedScripts(pkg).sort()).toEqual([...INSTALL_SCRIPT_PACKAGES].sort())
    expect(allowedScripts({ name: 'x', allowScripts: { a: true, b: false } })).toEqual(['x', 'a'])
    const out = execFileSync(process.execPath, [path.resolve(__dirname, '../../scripts/stable-promote.mjs'), 'allow-scripts'], { encoding: 'utf8' })
    expect(out.trim().split(',').sort()).toEqual([...INSTALL_SCRIPT_PACKAGES].sort())
  })
})
