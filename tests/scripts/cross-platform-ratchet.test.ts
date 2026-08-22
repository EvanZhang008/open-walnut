/**
 * Ratchet: the files a NON-macOS host executes must not carry macOS-only
 * assumptions.
 *
 * Issue #11 was this class twice over on one Linux box: the local daemon binary
 * name was hardcoded to darwin-arm64, and the deploy script pinned its log to
 * /private/tmp (a path that only exists on macOS), so the deploy killed the live
 * server and could not start its replacement. Both were single literals in
 * otherwise portable code, which is exactly what a review misses and a scan
 * catches.
 *
 * Scope is a CURATED list, not the whole repo: plenty of this project is
 * deliberately mac-only (the desktop app, Playwright helpers, launchd plumbing,
 * the iOS build). Only the files below run on a Linux self-host, so only they
 * are held to this bar. Add a file here when it joins that set.
 *
 * An occurrence passes when it is (a) in a comment, (b) inside a platform-guarded
 * block — a guard marker within the preceding 15 lines — or (c) listed in
 * ALLOWED with a reason. Otherwise the test fails and prints the location.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.join(import.meta.dirname, '..', '..')

/** Files executed on a Linux self-host (deploy path + daemon that runs there). */
const CROSS_PLATFORM_FILES = [
  'scripts/dev-prod.sh',
  'scripts/build-daemon.sh',
  'src/constants.ts',
  'src/providers/local-daemon.ts',
  'src/providers/daemon-source.ts',
  'src/providers/daemon-standalone.ts',
  'src/providers/daemon-core.ts',
]

/** macOS-only absolute paths. These have no legitimate unguarded use. */
const MAC_ONLY_PATHS = [
  '/private/tmp',
  '/private/var',
  '/opt/homebrew',
  '/System/',
  '/Library/',
  '/var/folders/',
  '/Users/',
]

/** Commands that exist only on macOS (or behave differently enough to break). */
const MAC_ONLY_COMMANDS = [
  'launchctl',
  'osascript',
  'pbcopy',
  'pbpaste',
  'sw_vers',
  'diskutil',
  'mdfind',
  'caffeinate',
  'networksetup',
  'scutil',
  'plutil',
  'shasum',
]

/**
 * Evidence that the surrounding block only runs on macOS, or that the tool is
 * probed before use. `command -v` counts: an absent tool then takes another path
 * instead of failing the run.
 */
const GUARD_MARKERS = [
  'uname -s',
  'Darwin',
  'darwin',
  'use_launchd',
  'XPC_SERVICE_NAME',
  'command -v',
  'process.platform',
  'os.platform',
]

/** Known-good occurrences. Every entry needs a reason, not just a silencer. */
const ALLOWED: Array<{ file: string; needle: string; reason: string }> = [
  {
    file: 'scripts/dev-prod.sh',
    needle: '/opt/homebrew',
    reason: 'appended to PATH as an OPTIONAL prefix; a nonexistent dir in PATH is inert on Linux',
  },
  {
    file: 'scripts/build-daemon.sh',
    needle: '/opt/homebrew',
    reason: 'one of several bun locations, each probed with -x before use',
  },
]

interface Violation { file: string; line: number; needle: string; text: string }

function isComment(line: string): boolean {
  const t = line.trim()
  return t.startsWith('#') || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

export function scanForMacOnlyAssumptions(
  file: string,
  content: string,
  allowed: typeof ALLOWED = ALLOWED,
): Violation[] {
  const lines = content.split('\n')
  const needles = [...MAC_ONLY_PATHS, ...MAC_ONLY_COMMANDS]
  const violations: Violation[] = []

  lines.forEach((line, i) => {
    if (isComment(line)) return
    for (const needle of needles) {
      if (!line.includes(needle)) continue
      if (allowed.some((a) => a.file === file && a.needle === needle)) continue
      // A guard in the preceding 15 lines (or on this line) makes the block
      // conditional on macOS / on the tool existing.
      const window = lines.slice(Math.max(0, i - 15), i + 1).join('\n')
      if (GUARD_MARKERS.some((m) => window.includes(m))) continue
      violations.push({ file, line: i + 1, needle, text: line.trim() })
    }
  })
  return violations
}

describe('cross-platform ratchet', () => {
  it('finds no unguarded macOS-only assumption in the Linux-executed files', () => {
    const violations = CROSS_PLATFORM_FILES.flatMap((file) =>
      scanForMacOnlyAssumptions(file, fs.readFileSync(path.join(REPO, file), 'utf-8')),
    )
    const report = violations.map((v) => `${v.file}:${v.line}  ${v.needle}  →  ${v.text}`).join('\n')
    expect(
      violations,
      `macOS-only assumption on a path a Linux host executes:\n${report}\n\n` +
      'Fix: derive it (process.platform / uname -s), guard the block, or add an ' +
      'ALLOWED entry in this test with a reason.',
    ).toEqual([])
  })

  it('every curated file exists (a renamed file must not silently drop coverage)', () => {
    for (const file of CROSS_PLATFORM_FILES) {
      expect(fs.existsSync(path.join(REPO, file)), `${file} is missing`).toBe(true)
    }
  })

  it('every ALLOWED entry still matches something (no stale exemptions)', () => {
    for (const entry of ALLOWED) {
      const content = fs.readFileSync(path.join(REPO, entry.file), 'utf-8')
      expect(content.includes(entry.needle), `stale exemption: ${entry.file} / ${entry.needle}`).toBe(true)
      expect(entry.reason.length).toBeGreaterThan(20)
    }
  })

  // A ratchet that cannot fail is worse than no ratchet: it reads as coverage.
  it('actually catches a violation', () => {
    const bad = [
      '#!/usr/bin/env bash',
      '# a comment mentioning /private/tmp is fine',
      'LOG=/private/tmp/x.log',
      'osascript -e "beep"',
    ].join('\n')
    const found = scanForMacOnlyAssumptions('scripts/fake.sh', bad, [])
    expect(found.map((v) => [v.line, v.needle])).toEqual([[3, '/private/tmp'], [4, 'osascript']])
  })

  it('accepts a guarded block and an allowlisted needle', () => {
    const guarded = [
      'if [[ "$(uname -s)" == "Darwin" ]]; then',
      '  launchctl remove com.example',
      'fi',
    ].join('\n')
    expect(scanForMacOnlyAssumptions('scripts/fake.sh', guarded, [])).toEqual([])

    const allowed = [{ file: 'scripts/fake.sh', needle: '/opt/homebrew', reason: 'x'.repeat(21) }]
    expect(scanForMacOnlyAssumptions('scripts/fake.sh', 'PATH=$PATH:/opt/homebrew/bin', allowed)).toEqual([])
    expect(scanForMacOnlyAssumptions('scripts/fake.sh', 'PATH=$PATH:/opt/homebrew/bin', [])).toHaveLength(1)
  })
})
