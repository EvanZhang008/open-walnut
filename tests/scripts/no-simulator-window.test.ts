/**
 * No script or code in this repository opens the Simulator app (2026-11-09: test windows on a Mac a
 * person uses took the front from them, and a Cmd+Q meant for another app landed in one). A running
 * Simulator app is an ordinary app another program can bring to the front, launched with `open -g`
 * or not: checked on a Mac by the system log, an outside activate of a `-g` Simulator gave SETFRONT.
 * Tests boot devices headless (`xcrun simctl boot`, `xcrun simctl bootstatus -b`), which opens no
 * window, and `maestro start-device` (which boots and then runs `open -a Simulator`) is never used.
 *
 * Enumerated from the source: every committed script, workflow and code file, comments left out.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const SELF = 'tests/scripts/no-simulator-window.test.ts'
const files = execFileSync('git', ['ls-files', '*.sh', '*.bash', '*.zsh', '*.mjs', '*.cjs', '*.js', '*.ts', '*.tsx', '*.py', '*.swift', '*.yml', '*.yaml'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter((f) => f && f !== SELF && !f.includes('node_modules/'))

/** What on this line opens the Simulator app, or null. */
function opensSimulator(line: string): string | null {
  const code = line.trim()
  if (/^(#|\/\/|\*|\/\*)/.test(code)) return null
  if (/\bopen\b[^\n;|&]*(\bSimulator(\.app)?\b|com\.apple\.iphonesimulator)/.test(code)) return 'opens the Simulator app'
  if (/['"]open['"][^\n]*['"](-a|-b)['"][^\n]*['"](Simulator(\.app)?|com\.apple\.iphonesimulator)['"]/.test(code)) return 'spawns open on the Simulator app'
  if (/\bmaestro\b[^\n;|&]*\bstart-device\b/.test(code)) return 'runs maestro start-device'
  if (/openApplication\([^\n]*[Ss]imulator|launchApplication\([^\n]*[Ss]imulator/.test(code)) return 'launches the Simulator app'
  return null
}

describe('nothing in the repository opens the Simulator app', () => {
  it('the matcher knows every way, and leaves a headless boot alone', () => {
    for (const line of [
      'open -a Simulator',
      'open -g -a Simulator --args -CurrentDeviceUDID "$UDID"',
      'open "$(xcode-select -p)/Applications/Simulator.app"',
      'open -b com.apple.iphonesimulator',
      "execFileSync('open', ['-a', 'Simulator'])",
      'maestro start-device --platform ios',
      'NSWorkspace.shared.openApplication(at: simulatorURL, configuration: c)',
    ]) expect(opensSimulator(line), line).toBeTruthy()
    for (const line of [
      'xcrun simctl boot "$UDID"',
      'xcrun simctl bootstatus "$UDID" -b',
      '# never open -a Simulator: boot headless',
      'APP="$WORK/dd/Build/Products/Debug-iphonesimulator/Walnut.app"',
      'maestro --udid "$UDID" test flow.yaml',
    ]) expect(opensSimulator(line), line).toBeNull()
  })

  it('found the files it judges', () => {
    expect(files).toContain('ios-native/tests/fleet/remote-run.sh')
    expect(files).toContain('scripts/lib/sim-device.sh')
  })

  it('no committed file opens it', () => {
    const found: string[] = []
    for (const f of files) {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8')
      if (!/Simulator|iphonesimulator|start-device/.test(text)) continue
      text.split('\n').forEach((line, i) => {
        const what = opensSimulator(line)
        if (what) found.push(`${f}:${i + 1} ${what}: boot the device headless (xcrun simctl boot, bootstatus -b) instead`)
      })
    }
    expect(found).toEqual([])
  })
})
