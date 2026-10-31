/**
 * The CI job that runs the iOS app's tests on GitHub's macOS runners. It must
 * need no secrets (no signing, no App Store key: those are the owner's to add),
 * stay out of CI OK until it has a record, and run WalnutUITests only through
 * run-ui-tests.sh, the one way its pairing reaches the XCUITest runner.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

const ROOT = path.resolve(__dirname, '../..')
const raw = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')
type Step = { name?: string; run?: string; if?: string; uses?: string; env?: Record<string, string> }
const doc = parseYaml(raw) as { jobs: Record<string, { 'runs-on': string; needs?: string[]; 'continue-on-error'?: string; strategy?: { matrix: { layer: string[] } }; steps: Step[] }> }
const job = doc.jobs.ios!

describe('the iOS job in ci.yml', () => {
  it('runs on the pinned macOS image, a unit and a UI leg', () => {
    expect(job['runs-on']).toBe('macos-26')
    expect(job.strategy?.matrix.layer).toEqual(['unit', 'ui'])
  })

  it('reads no secret and signs nothing', () => {
    const text = JSON.stringify(job)
    expect(text).not.toMatch(/secrets\./)
    expect(text).not.toMatch(/DEVELOPMENT_TEAM|APP_STORE|altool|notarytool|archive/)
  })

  it('stays out of CI OK, and only the UI leg may fail without failing the run', () => {
    expect(doc.jobs['ci-ok']!.needs).not.toContain('ios')
    expect(job['continue-on-error']).toBe("${{ matrix.layer == 'ui' }}")
  })

  it('runs WalnutTests with xcodebuild and WalnutUITests through run-ui-tests.sh', () => {
    const unit = job.steps.find((s) => s.if === "matrix.layer == 'unit'" && s.run?.includes('xcodebuild test'))!
    expect(unit.run).toContain('xcodegen generate')
    expect(unit.run).toContain('-only-testing:WalnutTests')
    // Unsigned, the app has no entitlements and the keychain tests read -34018.
    expect(unit.run).not.toContain('CODE_SIGNING_ALLOWED=NO')
    const ui = job.steps.find((s) => s.if === "matrix.layer == 'ui'")!
    expect(ui.run).toContain('ios-native/tests/ui/run-ui-tests.sh')
    expect(fs.existsSync(path.join(ROOT, 'ios-native/tests/ui/run-ui-tests.sh'))).toBe(true)
  })

  it('uploads no artifact: the failures go into the log', () => {
    // The 130 MB result bundle it uploaded on failure failed the leak audit (2026-10-31).
    expect(job.steps.filter((s) => s.uses?.startsWith('actions/upload-artifact'))).toEqual([])
    expect(job.steps.find((s) => s.name === 'The failed tests')?.run).toContain('xcresulttool get test-results summary')
  })

  it('picks a simulator the image has, never a fixed device name', () => {
    const boot = job.steps.find((s) => s.name === 'Boot an iPhone simulator')!
    expect(boot.run).toContain('simctl list devices available -j')
    expect(job.steps.map((s) => s.run ?? '').join('\n')).not.toMatch(/name=iPhone/)
  })
})
