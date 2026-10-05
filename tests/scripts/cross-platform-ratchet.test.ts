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

/**
 * A daemon binary name written as a literal. This is the OTHER half of issue #11
 * and the guard-marker rule cannot catch it: the offending literal
 * ('daemon-darwin-arm64') contains its own platform word, so any window check
 * sees "darwin" and calls it guarded. The name must be built from the host's
 * platform/arch instead — see getLocalDaemonBinaryName().
 */
const HARDCODED_DAEMON_BINARY = /daemon-(darwin|linux|win32)-(arm64|x64)/
/** build-daemon.sh names all three targets because it BUILDS them. */
const BINARY_LITERAL_EXEMPT = ['scripts/build-daemon.sh']

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
    const binary = HARDCODED_DAEMON_BINARY.exec(line)
    if (binary && !BINARY_LITERAL_EXEMPT.includes(file)) {
      violations.push({ file, line: i + 1, needle: binary[0], text: line.trim() })
    }
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

/**
 * Tests run on Linux in CI, so a test that spawns a macOS-only tool must say so:
 * a platform check, `isMac`, or `skipIf`/`runIf` within the 15 lines before it.
 * 2026-10-05: a quick-tier test ran `plutil -lint` unguarded, passed on the Mac,
 * and failed on every Linux runner with `spawnSync plutil ENOENT`.
 */
const MAC_ONLY_TOOL_SPAWN = /(execFileSync|spawnSync|execSync|execFile|spawn)\(\s*[`"'](plutil|codesign|xcrun|security|hdiutil|spctl|swiftc|launchctl|osascript|sw_vers|ditto|iconutil|lipo|defaults|sips|xattr)[`"' ]/
const TEST_GUARD_MARKERS = ['process.platform', 'os.platform', 'isMac', 'skipIf', 'runIf', 'darwin', 'Darwin']

export function scanTestForMacOnlySpawns(file: string, content: string): Violation[] {
  const lines = content.split('\n')
  const out: Violation[] = []
  lines.forEach((line, i) => {
    const m = MAC_ONLY_TOOL_SPAWN.exec(line)
    if (!m || isComment(line)) return
    const window = lines.slice(Math.max(0, i - 15), i + 1).join('\n')
    if (TEST_GUARD_MARKERS.some((g) => window.includes(g))) return
    out.push({ file, line: i + 1, needle: m[2], text: line.trim() })
  })
  return out
}

function testFiles(dir: string): string[] {
  return fs.readdirSync(path.join(REPO, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name)
    if (e.isDirectory()) return testFiles(rel)
    return /\.(test|spec)\.ts$/.test(e.name) ? [rel] : []
  })
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

  // The two bugs of issue #11, replayed. Both must be caught, or this ratchet
  // does not cover the thing it was written for.
  it('catches the exact code issue #11 reported', () => {
    const oldLogLine = [
      'PORT=3456',
      'LOCK_DIR="${TMPDIR:-/tmp}/open-walnut-dev-prod.lock"',
      'SERVER_LOG=/private/tmp/open-walnut-launchd.log',
    ].join('\n')
    expect(scanForMacOnlyAssumptions('scripts/dev-prod.sh', oldLogLine, []))
      .toMatchObject([{ line: 3, needle: '/private/tmp' }])

    // The guard-marker rule alone would clear this line, because the literal
    // contains 'darwin' — hence the dedicated binary-name check.
    const oldBinaryLine = "    const binaryName = 'daemon-darwin-arm64'"
    expect(scanForMacOnlyAssumptions('src/providers/local-daemon.ts', oldBinaryLine, []))
      .toMatchObject([{ line: 1, needle: 'daemon-darwin-arm64' }])

    // Building the name from the host is the fix, and must stay clean.
    const fixed = 'return `daemon-${platform}-${arch}`'
    expect(scanForMacOnlyAssumptions('src/providers/local-daemon.ts', fixed, [])).toEqual([])
  })

  it('lets build-daemon.sh name the targets it builds', () => {
    const buildLine = '  --outfile "$OUTDIR/daemon-darwin-arm64" \\'
    expect(scanForMacOnlyAssumptions('scripts/build-daemon.sh', buildLine, [])).toEqual([])
    expect(scanForMacOnlyAssumptions('src/providers/other.ts', buildLine, [])).toHaveLength(1)
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

  it('no test spawns a macOS-only tool without a platform guard (CI runs them on Linux)', () => {
    const violations = testFiles('tests').flatMap((file) =>
      scanTestForMacOnlySpawns(file, fs.readFileSync(path.join(REPO, file), 'utf-8')),
    )
    const report = violations.map((v) => `${v.file}:${v.line}  ${v.needle}  →  ${v.text}`).join('\n')
    expect(violations, `macOS-only tool spawned unguarded:\n${report}\n\nGuard it (process.platform, describe.skipIf) or check the content in JS.`).toEqual([])
  })

  it('the test-spawn scan catches an unguarded call and accepts a guarded one', () => {
    const call = ['execFile', "Sync('plu", "til', ['-lint', f])"].join('')
    expect(scanTestForMacOnlySpawns('tests/x.test.ts', `it('x', () => {\n  ${call}\n})`)).toHaveLength(1)
    expect(scanTestForMacOnlySpawns('tests/x.test.ts', `if (process.platform === 'darwin') {\n  ${call}\n}`)).toEqual([])
    expect(scanTestForMacOnlySpawns('tests/x.test.ts', `describe.skipIf(!isMac)('x', () => {\n  ${call}\n})`)).toEqual([])
  })
})
