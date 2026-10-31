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
const doc = parseYaml(raw) as { jobs: Record<string, { 'runs-on': string; needs?: string[]; 'continue-on-error'?: string; env?: Record<string, string>; strategy?: { matrix: { layer: string[] } }; steps: Step[] }> }
const job = doc.jobs.ios!

/** What a skip list names, `-skip-testing:<Target>/<Class>[/<method>]` each. */
function skips(list: string | undefined, target: string): { cls: string; method?: string }[] {
  return (list ?? '').split(/\s+/).filter(Boolean).map((arg) => {
    const m = arg.match(new RegExp(`^-skip-testing:${target}/(\\w+)(?:/(\\w+))?$`))
    if (!m) throw new Error(`not a ${target} skip: ${arg}`)
    return { cls: m[1]!, ...(m[2] ? { method: m[2] } : {}) }
  })
}

/** The classes a skip list leaves out whole. */
function skipped(list: string | undefined, target: string): string[] {
  return skips(list, target).filter((s) => !s.method).map((s) => s.cls)
}

/** Every XCTestCase class of a test target, with its file and its own source. */
function testClasses(target: string): { name: string; file: string; body: string }[] {
  const dir = path.join(ROOT, 'ios-native', target)
  return fs.readdirSync(dir).filter((f) => f.endsWith('.swift')).flatMap((file) => {
    const parts = fs.readFileSync(path.join(dir, file), 'utf8').split(/^(?:@\w+\s+)*(?:final\s+)?class (\w+)\s*:\s*XCTestCase/m)
    const out: { name: string; file: string; body: string }[] = []
    for (let i = 1; i < parts.length; i += 2) out.push({ name: parts[i]!, file, body: parts[i + 1]! })
    return out
  })
}

// A UI class that talks to a fixture server: its routes, the Inbox fixture marker, or
// a test that fails without an isolated server.
const TALKS_TO_FIXTURE = /__stub\/|"\/__\w+\/|WALNUT_UITEST_INBOX_ITEMS|InboxItemActionsUITests\.launch|isolated server/
// Fixture classes that probe their server and skip on the offline pairing, so CI runs
// them as skips. A new fixture class goes here (when it probes) or into IOS_CI_SKIP_UI.
const PROBES_ITS_FIXTURE = [
  'BoardOrderParityUITests', 'DemoModeUITests', 'InboxSelectUITests', 'LetterReplyUITests',
  'MidTurnQueueUITests', 'ModelPillHealUITests', 'ProvenanceAndInboxUITests', 'SendOnceUITests',
  'SessionMidTurnOrderUITests', 'SessionStreamStormUITests',
]

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

  it('leaves only wall-clock perf gates to the Mac, and every one of them', () => {
    const all = skips(job.env?.IOS_CI_SKIP_UNIT, 'WalnutTests')
    const classes = testClasses('WalnutTests')
    const isTiming = (c: { file: string }) => /Perf|Watchdog/.test(c.file)
    for (const s of all) {
      const c = classes.filter(isTiming).find((c) => c.name === s.cls)
      expect(c, `${s.cls} is no perf gate`).toBeDefined()
      if (s.method) expect(c!.body, `${s.cls} has no ${s.method}`).toMatch(new RegExp(`func ${s.method}\\b`))
    }
    // A class skipped by method counts as placed: its untimed tests still run here.
    const skippedNames = new Set(all.map((s) => s.cls))
    // A new timing class is placed on purpose: skipped, or here when its budgets hold
    // on a shared runner (these passed on run 41198110591 with room to spare).
    const holdsOnARunner = ['ScrollPerfTests', 'WatchdogStallAccountingTests']
    for (const c of classes.filter(isTiming)) {
      expect(skippedNames.has(c.name) !== holdsOnARunner.includes(c.name), `${c.name} (${c.file}): skip it in IOS_CI_SKIP_UNIT or list it as holding its budget`).toBe(true)
    }
    const unit = job.steps.find((s) => s.if === "matrix.layer == 'unit'" && s.run?.includes('xcodebuild test'))!
    expect(unit.run).toContain('$IOS_CI_SKIP_UNIT')
  })

  it('skips each UI class that needs its own fixture server, and only those', () => {
    const skips = skipped(job.env?.IOS_CI_SKIP_UI, 'WalnutUITests')
    const fixture = testClasses('WalnutUITests').filter((c) => TALKS_TO_FIXTURE.test(c.body)).map((c) => c.name)
    for (const name of skips) expect(fixture, `${name} needs no fixture`).toContain(name)
    for (const name of fixture) {
      const probes = PROBES_ITS_FIXTURE.includes(name)
      expect(probes !== skips.includes(name), `${name}: list it in PROBES_ITS_FIXTURE (it skips without its fixture) or in IOS_CI_SKIP_UI`).toBe(true)
    }
    for (const name of PROBES_ITS_FIXTURE) expect(fixture, `${name} no longer talks to a fixture`).toContain(name)
    const ui = job.steps.find((s) => s.if === "matrix.layer == 'ui'")!
    // Arguments replace the runner's default target, so the leg names it itself.
    expect(ui.run).toMatch(/run-ui-tests\.sh -only-testing:WalnutUITests \$IOS_CI_SKIP_UI/)
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
