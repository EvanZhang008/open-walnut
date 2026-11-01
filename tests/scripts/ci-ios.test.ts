/**
 * The CI job that runs the iOS app's tests on GitHub's macOS runners. It must
 * need no secrets (no signing, no App Store key: those are the owner's to add),
 * stay out of CI OK until it has a record, and run WalnutUITests only through
 * run-ui-tests.sh, the one way its pairing reaches the XCUITest runner.
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
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
// A UI class that drives the home screen (SpringBoard: the icon's long-press menu, a
// shortcut). On a hosted runner its animations stalled 60 s at a time and the shortcut
// came minutes late (2026-10-31, VoiceQuickActionUITests in run 41225175176); the Mac
// runs it.
const DRIVES_HOME_SCREEN = /com\.apple\.springboard/
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

  it('names each failed unit test as an annotation, which the public API serves with no login', () => {
    const step = job.steps.find((s) => s.name === 'The failed tests')!
    expect(step.run).toContain('python3 ios-native/tests/failed-tests.py')
    const summary = { result: 'Failed', totalTestCount: 2, failedTests: 1, testFailures: [{ testIdentifierString: 'FooTests/testBar(a:b)', failureText: 'x, 100%\ny' }] }
    const out = execFileSync('python3', [path.join(ROOT, 'ios-native/tests/failed-tests.py')], { input: JSON.stringify(summary), encoding: 'utf8' })
    expect(out.split('\n')).toContain('::error title=iOS unit FooTests/testBar(a%3Ab)::x, 100%25%0Ay')
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

  it('skips each UI class that needs its own fixture server or drives the home screen, and only those', () => {
    const skips = skipped(job.env?.IOS_CI_SKIP_UI, 'WalnutUITests')
    const classes = testClasses('WalnutUITests')
    const fixture = classes.filter((c) => TALKS_TO_FIXTURE.test(c.body)).map((c) => c.name)
    const homeScreen = classes.filter((c) => DRIVES_HOME_SCREEN.test(c.body)).map((c) => c.name)
    for (const name of skips) expect([...fixture, ...homeScreen], `${name} needs no fixture and drives no home screen`).toContain(name)
    for (const name of homeScreen) {
      expect(skips.includes(name) || PROBES_ITS_FIXTURE.includes(name), `${name} drives the home screen: list it in IOS_CI_SKIP_UI`).toBe(true)
    }
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

describe('WalnutTests waits', () => {
  // A wait of a fixed number of `Task.yield()`s says nothing about time: how far other
  // tasks get in 20 yields depends on the machine. It held on a Mac and failed on a CI
  // runner (2026-10-31: testLoadEarlierIsOneReadAtATime asserted before its first page
  // read had reached the fake). Wait by the clock: sleep in the loop, with a bound.
  const BARE_YIELD_WAIT = /for _ in 0\.\.<\d+ where [^\n]*\{\s*await Task\.yield\(\)\s*\}/g
  const dir = path.join(ROOT, 'ios-native/WalnutTests')

  it('no unit test waits by counting bare yields', () => {
    const offenders = fs.readdirSync(dir).filter((f) => f.endsWith('.swift')).flatMap((f) => {
      const text = fs.readFileSync(path.join(dir, f), 'utf8')
      return [...text.matchAll(BARE_YIELD_WAIT)].map((m) => `${f}:${text.slice(0, m.index).split('\n').length}: ${m[0]}`)
    })
    expect(offenders).toEqual([])
  })

  it('catches the shape it was written for, and lets a clocked wait through', () => {
    expect('for _ in 0..<20 where !store.loadingEarlier { await Task.yield() }'.match(BARE_YIELD_WAIT)).toHaveLength(1)
    expect('for _ in 0..<20 where x == nil {\n    await Task.yield()\n}'.match(BARE_YIELD_WAIT)).toHaveLength(1)
    expect('for _ in 0..<500 where x == nil { try? await Task.sleep(for: .milliseconds(10)) }'.match(BARE_YIELD_WAIT)).toBeNull()
  })

  // A pixel test that pumps the run loop for a fixed time and then asserts that something
  // DREW reads the screen at one moment the machine chooses. 2026-10-31 (run 41250878827):
  // FileSourceLinesViewTests read 0 highlighted pixels at 0.8 s on a slow runner, where the
  // highlight lights about 0.41 s in. Poll until it drew (snapshotOnceDrawn); a fixed pump
  // stays fine before a check that nothing drew, or that it faded.
  const FIXED_PUMP_THEN_DREW = /\bpump\([\d.]+\)\s*\n(?:[^\n]*\n){0,4}?[^\n]*XCTAssertGreaterThan\(/g
  const fixedPumpDraws = (text: string) => [...text.matchAll(FIXED_PUMP_THEN_DREW)].filter((m) => !/snapshotOnceDrawn|XCTAssert(Equal|LessThan)/.test(m[0]))

  it('no pixel test asserts a drawing after a fixed run loop pump', () => {
    const offenders = fs.readdirSync(dir).filter((f) => f.endsWith('.swift')).flatMap((f) => {
      const text = fs.readFileSync(path.join(dir, f), 'utf8')
      return fixedPumpDraws(text).map((m) => `${f}:${text.slice(0, m.index).split('\n').length}`)
    })
    expect(offenders).toEqual([])
  })

  it('catches a fixed pump before a drew check, and lets a poll or a faded check through', () => {
    expect(fixedPumpDraws('pump(0.8)\n        let image = snapshot(window)\n        let warm = warmPixelCount(image)\n        XCTAssertGreaterThan(warm, 200,')).toHaveLength(1)
    expect(fixedPumpDraws('pump(0.8)\n        XCTAssertGreaterThan(warmPixelCount(snapshot(window)), 200)')).toHaveLength(1)
    expect(fixedPumpDraws('pump(0.3)\n        let image = snapshotOnceDrawn(window)\n        XCTAssertGreaterThan(warmPixelCount(image), 200)')).toHaveLength(0)
    expect(fixedPumpDraws('pump(3.6)\n        let warm = warmPixelCount(snapshot(window))\n        XCTAssertLessThan(warm, 50)')).toHaveLength(0)
  })

  // A scroll edge test scrolls a list under the bar and reads the bar's pixels, and the bar
  // draws what covers the rows as it collapses. 2026-11-01 (run 41272965191):
  // InboxSettingsScrollEdgeTests read a red row in the Settings bar after a fixed 0.3 s on a
  // loaded runner, and passed on the next three runs. Such a file reads its pixels again
  // until they pass or a deadline does (`while ... Date() < deadline`). Judged per file: a
  // second single read in a file that polls once (titleInk's scroll back) is not caught.
  const scrollsThenRenders = (text: string) => /\bsetContentOffset\(/.test(text) && /\bdrawHierarchy\(/.test(text)
  const pollsPixels = (text: string) => /\bwhile\b[^\n]*Date\(\) < deadline/.test(text)

  it('every scroll edge pixel test reads the bar again until a deadline', () => {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.swift'))
    const scrolling = files.filter((f) => scrollsThenRenders(fs.readFileSync(path.join(dir, f), 'utf8')))
    expect(scrolling).toEqual(expect.arrayContaining(['BoardRailScrollEdgeTests.swift', 'InboxSettingsScrollEdgeTests.swift']))
    expect(scrolling.filter((f) => !pollsPixels(fs.readFileSync(path.join(dir, f), 'utf8')))).toEqual([])
  })

  it('tells a polled scroll edge read from a single one', () => {
    const once = 'list.setContentOffset(p, animated: false)\nsettle(v, 0.3)\nhost.view.drawHierarchy(in: r, afterScreenUpdates: true)'
    expect(scrollsThenRenders(once) && !pollsPixels(once)).toBe(true)
    expect(pollsPixels(`${once}\nwhile got.red > 12 && Date() < deadline {`)).toBe(true)
  })
})

describe('WalnutUITests settle waits', () => {
  // A block predicate (NSPredicate { ... }) reads the element tree on every check, a few
  // seconds each on a loaded CI runner: a 5 s wait on one ran out once there with the row
  // already in place by the next read (2026-11-01, run 41287770979, AskQuestionCardUITests).
  const dir = path.join(ROOT, 'ios-native/WalnutUITests')
  // Both spellings: expectation(for:) with wait(for:), and XCTNSPredicateExpectation with XCTWaiter.
  const SHORT_BLOCK_WAIT = /(?:expectation\(for:|XCTNSPredicateExpectation\(predicate:) NSPredicate \{[\s\S]{0,400}?wait\(for: \[\w+\], timeout: ([\d.]+)\)/g
  // An inverted one (nothing may change for its time) is meant to be short.
  const shortWaits = (text: string) => [...text.matchAll(SHORT_BLOCK_WAIT)].filter((m) => Number(m[1]) < 15 && !/\.isInverted = true/.test(m[0]))

  it('no block predicate wait in the UI tests is shorter than 15 s', () => {
    const offenders = fs.readdirSync(dir).filter((f) => f.endsWith('.swift')).flatMap((f) => {
      const text = fs.readFileSync(path.join(dir, f), 'utf8')
      return shortWaits(text).map((m) => `${f}:${text.slice(0, m.index).split('\n').length}: timeout ${m[1]}`)
    })
    expect(offenders).toEqual([])
  })

  it('catches a short wait and lets a long one through', () => {
    expect(shortWaits('let e = expectation(for: NSPredicate { _, _ in self.onScreen(x, in: app) }, evaluatedWith: nil)\n        wait(for: [e], timeout: 5)')).toHaveLength(1)
    expect(shortWaits('let e = expectation(for: NSPredicate { _, _ in ok() }, evaluatedWith: nil)\n        wait(for: [e], timeout: 15)')).toHaveLength(0)
    expect(shortWaits('let e = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in ok() }, object: x)\n        XCTAssertEqual(XCTWaiter.wait(for: [e], timeout: 10), .completed)')).toHaveLength(1)
    expect(shortWaits('let e = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in moved() }, object: x)\n        e.isInverted = true\n        XCTAssertEqual(XCTWaiter.wait(for: [e], timeout: 2), .completed)')).toHaveLength(0)
  })
})

describe('WalnutUITests menu taps', () => {
  // A menu entry tapped on the line after the tap that opens its menu is looked up
  // before the menu is drawn, and on a CI runner it was not there yet (2026-10-31:
  // CalendarInteractionUITests, "Failed to tap List"). Wait for the entry first.
  const dir = path.join(ROOT, 'ios-native/WalnutUITests')

  it('no UI test taps a menu entry right after the tap that opens it', () => {
    const offenders = fs.readdirSync(dir).filter((f) => f.endsWith('.swift')).flatMap((f) => {
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n')
      return lines.flatMap((line, i) =>
        i > 0 && /\.tap\(\)\s*$/.test(lines[i - 1]!) && /^\s*app\.(buttons|menuItems)\["[^"]+"\]\.tap\(\)/.test(line)
          ? [`${f}:${i + 1}: ${line.trim()}`] : [])
    })
    expect(offenders).toEqual([])
  })
})

describe('WalnutUITests harness streams', () => {
  // A harness stream that moves on by the clock races the test reading it: on a loaded
  // runner one XCUI query took seconds, and IslandStreamUITests looked for the half
  // written script 11.5 s after the tap, when a 3 s pause had ended and the script had
  // run (2026-11-01, run 41315324674). A stream a UI test reads stage by stage holds at
  // each stage until the test taps its Next button.
  const uiDir = path.join(ROOT, 'ios-native/WalnutUITests')
  const harness = fs.readFileSync(path.join(ROOT, 'ios-native/Walnut/Timeline/TimelineHarnessView.swift'), 'utf8')
  const STREAM_TAP = /app\.buttons\["(harness\.\w*[sS]tream)"\]/
  /** The body of one harness store function, up to the next `func` at its indent. */
  const body = (name: string) => harness.split(new RegExp(`\\n    func ${name}\\(`))[1]?.split(/\n    (?:private )?func /)[0] ?? ''
  /** The longest sleep a body takes, in ms. */
  const longestSleep = (text: string) => Math.max(0, ...[...text.matchAll(/Task\.sleep\(for: \.(milliseconds|seconds)\(([^)]*)\)\)/g)]
    .flatMap((m) => (m[2]!.match(/\d+(?:\.\d+)?/g) ?? []).map((n) => Number(n) * (m[1] === 'seconds' ? 1000 : 1))))

  it('every UI test that reads a harness stream holds it at each stage, and the stream sleeps only its cadence', () => {
    const readers = fs.readdirSync(uiDir).filter((f) => f.endsWith('.swift'))
      .map((f) => ({ f, text: fs.readFileSync(path.join(uiDir, f), 'utf8') }))
      .filter(({ text }) => STREAM_TAP.test(text))
    expect(readers.map((r) => r.f)).toContain('IslandStreamUITests.swift')
    for (const { f, text } of readers) {
      expect(text, `${f} reads a harness stream without its hold`).toContain('harness.islandNext')
    }
    const island = body('startIslandStream')
    expect(island).toMatch(/holdIsland\(\)[\s\S]*holdIsland\(\)[\s\S]*stopStream\(\)/)
    expect(longestSleep(island), 'startIslandStream pauses on the clock').toBeLessThanOrEqual(1000)
  })

  it('reads a clocked pause where there is one', () => {
    expect(longestSleep('try? await Task.sleep(for: .milliseconds(index == 10 ? 3000 : 600))')).toBe(3000)
    expect(longestSleep('try? await Task.sleep(for: .seconds(4))')).toBe(4000)
    expect(longestSleep('try? await Task.sleep(for: .milliseconds(600))')).toBe(600)
  })
})
