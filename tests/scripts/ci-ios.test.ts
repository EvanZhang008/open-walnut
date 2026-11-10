/**
 * The CI job that runs the iOS app's tests on GitHub's macOS runners. It must
 * need no secrets (no signing, no App Store key: those are the owner's to add),
 * stay out of CI OK until it has a record, and run WalnutUITests only through
 * run-ui-tests.sh, the one way its pairing reaches the XCUITest runner.
 */
import fs from 'node:fs'
import os from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { wallClockGates } from '../helpers/swift-wall-clock-gates'

const ROOT = path.resolve(__dirname, '../..')
const raw = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')
type Step = { name?: string; id?: string; run?: string; if?: string; uses?: string; env?: Record<string, string>; with?: Record<string, string | number>; 'timeout-minutes'?: number }
const doc = parseYaml(raw) as { jobs: Record<string, { 'runs-on': string; 'timeout-minutes'?: number; needs?: string[]; 'continue-on-error'?: string; env?: Record<string, string>; strategy?: { 'max-parallel'?: string; matrix: { include: Leg[] } }; steps: Step[] }> }
type Leg = { layer: string; shard?: number; shards?: number }
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

const SHARD_SCRIPT = path.join(ROOT, 'ios-native/tests/ui/ci-shard.py')
// Minutes a UI shard's step spends building and installing before its first test (run 42735468568).
const UI_BUILD_MINUTES = 8
type ShardPlan = { shards: number; skipped: string[]; legs: { shard: number; seconds: number; classes: string[] }[] }

/** The number of UI shards the ios matrix runs. */
function uiShards(): number {
  return job.strategy!.matrix.include.filter((l) => l.layer === 'ui').length
}

/** The split ci-shard.py makes for the workflow's skip list (or another dir and times file). */
function shardPlan(shards: number, env: Record<string, string> = {}, skipArgs?: string[]): ShardPlan {
  const args = skipArgs ?? (job.env?.IOS_CI_SKIP_UI ?? '').split(/\s+/).filter(Boolean)
  return JSON.parse(execFileSync('python3', [SHARD_SCRIPT, 'plan', String(shards), ...args], { encoding: 'utf8', env: { ...process.env, ...env } })) as ShardPlan
}

/**
 * Every WalnutUITests class XCTest runs tests of, read here on its own (not through ci-shard.py):
 * a subclass of XCTestCase, directly or through a base class of the directory, with a test method
 * of its own, of a base class, or of an extension of it.
 */
function uiClassesWithTests(): string[] {
  const dir = path.join(ROOT, 'ios-native/WalnutUITests')
  const parent = new Map<string, string>()
  const tests = new Map<string, number>()
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.swift'))) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8')
    const decls = [...text.matchAll(/^(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|internal|open|final|private|fileprivate)\s+)*(class|extension|struct|enum|actor|protocol) (\w+)(?:\s*:\s*(\w+))?/gm)]
    decls.forEach((d, i) => {
      const body = text.slice(d.index! + d[0].length, decls[i + 1]?.index ?? text.length)
      const n = body.split('\n').filter((l) => /^\s+(?:@\w+\s+)*(?:override\s+)?func test\w*\(\)/.test(l)).length
      if (d[1] === 'class' && d[3]) parent.set(d[2]!, d[3])
      if (d[1] === 'class' || d[1] === 'extension') tests.set(d[2]!, (tests.get(d[2]!) ?? 0) + n)
    })
  }
  const lineage = (c: string): string[] => (parent.has(c) ? [c, ...lineage(parent.get(c)!)] : [c])
  return [...parent.keys()].filter((c) => {
    const chain = lineage(c)
    return chain.at(-1) === 'XCTestCase' && chain.some((x) => (tests.get(x) ?? 0) > 0)
  }).sort()
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
  it('runs on the pinned macOS image, a unit leg and the UI shards 1..N', () => {
    expect(job['runs-on']).toBe('macos-26')
    const legs = job.strategy!.matrix.include
    expect(legs[0]).toEqual({ layer: 'unit' })
    const n = uiShards()
    expect(n).toBeGreaterThanOrEqual(2)
    expect(legs.slice(1)).toEqual(Array.from({ length: n }, (_, i) => ({ layer: 'ui', shard: i + 1, shards: n })))
    // Each leg's name says which it is: iOS app (unit), iOS app (ui 2/3).
    expect(job.name).toBe("iOS app (${{ matrix.layer }}${{ matrix.shard && format(' {0}/{1}', matrix.shard, matrix.shards) || '' }})")
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
    const ui = execFileSync('python3', [path.join(ROOT, 'ios-native/tests/failed-tests.py'), 'ui'], { input: JSON.stringify(summary), encoding: 'utf8' })
    expect(ui.split('\n')).toContain('::error title=iOS ui FooTests/testBar(a%3Ab)::x, 100%25%0Ay')
    // 2026-11-07: a leg that stopped before its tests has no bundle; one line, no traceback
    const none = spawnSync('python3', [path.join(ROOT, 'ios-native/tests/failed-tests.py'), 'ui'], { input: '', encoding: 'utf8' })
    expect(none).toMatchObject({ status: 0, stdout: 'no readable ui result bundle\n', stderr: '' })
  })

  it('names the failed tests of both legs, each from its own result bundle', () => {
    const step = job.steps.find((s) => s.name === 'The failed tests')!
    expect(step.if).toBe('failure()')
    expect(step.run).toContain('--path "$RUNNER_TEMP/ios-${{ matrix.layer }}.xcresult"')
    expect(step.run).toContain('failed-tests.py "${{ matrix.layer }}"')
    const unit = job.steps.find((s) => s.if === "matrix.layer == 'unit'" && s.run?.includes('xcodebuild test'))!
    expect(unit.run).toContain('-resultBundlePath "$RUNNER_TEMP/ios-unit.xcresult"')
    const ui = job.steps.find((s) => s.if === "matrix.layer == 'ui'")!
    expect(ui.run).toContain('WALNUT_UITEST_RESULT_BUNDLE="$RUNNER_TEMP/ios-ui.xcresult"')
  })

  it('lets a hung UI leg fail its step, not the job, so the evidence steps still run', () => {
    // A job past its timeout-minutes is cancelled, and a cancelled job runs no failure() step.
    const ui = job.steps.find((s) => s.if === "matrix.layer == 'ui'" && s.run?.includes('run-ui-tests.sh'))!
    const stepLimit = ui['timeout-minutes']!
    // The step builds first (about 8 minutes on run 42735468568), then runs its shard's tests,
    // which a slow runner may stretch by half. When a shard outgrows that, add a shard.
    const longest = Math.max(...shardPlan(uiShards()).legs.map((l) => l.seconds)) / 60
    expect(UI_BUILD_MINUTES + 1.5 * longest, `the longest UI shard (${longest.toFixed(1)} min of tests) no longer fits its step: add a UI shard to the ios matrix`).toBeLessThanOrEqual(stepLimit)
    // The evidence step has its own limit too (its screen is linear, seconds on a 2 MB text),
    // and both together stay 5 minutes under the job's, for the boot and the upload.
    const ev = job.steps.find((s) => s.id === 'evidence')!
    const evLimit = ev['timeout-minutes']!
    expect(evLimit).toBeGreaterThan(0)
    expect(evLimit).toBeLessThanOrEqual(5)
    expect(stepLimit + evLimit).toBeLessThanOrEqual(job['timeout-minutes']! - 5)
    expect(job.steps.indexOf(ev)).toBeGreaterThan(job.steps.indexOf(ui))
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
    // Arguments replace the runner's default target, so the leg names its shard's classes,
    // and the skip list still applies to a method it names.
    expect(ui.run).toContain('only=$(python3 ios-native/tests/ui/ci-shard.py ${{ matrix.shard }} ${{ matrix.shards }} $IOS_CI_SKIP_UI) || exit 1')
    expect(ui.run).toMatch(/run-ui-tests\.sh \$only \$IOS_CI_SKIP_UI\n/)
  })

  it('never uploads a result bundle: only the screened evidence of a failed UI test', () => {
    // The 130 MB result bundle it uploaded on failure failed the leak audit (2026-10-31).
    const uploads = Object.values(doc.jobs).flatMap((j) => j.steps.filter((s) => s.uses?.startsWith('actions/upload-artifact')))
    for (const u of uploads) expect(String(u.with?.path ?? ''), 'a result bundle is never an artifact').not.toMatch(/xcresult|\/dd\b|DerivedData/i)
    const own = job.steps.filter((s) => s.uses?.startsWith('actions/upload-artifact'))
    expect(own).toHaveLength(1)
    const up = own[0]!
    expect(up.with?.path).toBe('${{ runner.temp }}/ios-ui-evidence')
    expect(up.with?.['if-no-files-found']).toBe('ignore')
    expect(Number(up.with?.['retention-days'])).toBeLessThanOrEqual(7)
    // One artifact per shard and attempt: a second upload of a name fails.
    expect(up.with?.name).toBe('ios-ui-failure-evidence-${{ matrix.shard }}-attempt-${{ github.run_attempt }}')
    expect(up.if).toBe("failure() && matrix.layer == 'ui' && fromJSON(steps.evidence.outputs.kept || '0') > 0")
    // The evidence comes out of the bundle through the screening script, into its own directory.
    const ev = job.steps.find((s) => s.id === 'evidence')!
    expect(ev.if).toBe("failure() && matrix.layer == 'ui'")
    expect(ev.run).toContain('python3 ios-native/tests/ui-failure-evidence.py')
    expect(ev.run).toContain('--bundle "$RUNNER_TEMP/ios-ui.xcresult" --out "$RUNNER_TEMP/ios-ui-evidence"')
    expect(job.steps.indexOf(ev)).toBeLessThan(job.steps.indexOf(up))
    // No step copies the bundle (or anything of it) into the evidence directory but the script.
    for (const s of job.steps) if (s !== ev) expect(s.run ?? '').not.toContain('ios-ui-evidence')
    // Step continue-on-error would turn a failed test step into a success, and failure() false.
    for (const s of job.steps) expect(s, `${s.name}: no step-level continue-on-error`).not.toHaveProperty('continue-on-error')
    expect(fs.existsSync(path.join(ROOT, 'ios-native/tests/ui-failure-evidence.py'))).toBe(true)
  })

  it('picks a simulator the image has, never a fixed device name', () => {
    const boot = job.steps.find((s) => s.name === 'Boot an iPhone simulator')!
    expect(boot.run).toContain('simctl list devices available -j')
    expect(job.steps.map((s) => s.run ?? '').join('\n')).not.toMatch(/name=iPhone/)
  })

  // A wall-clock gate CI runs is judged through PerfGate (the median of its passes, or the
  // worst step but one), never on one timed pass or the worst of several: a shared runner
  // stalls one pass now and then, and run 41505408126 charged a 1.37 s stall in one 0.5 s
  // drain to the page (FirstPaintFreezeTests, mount ~60 ms in all three passes).
  it('judges no CI-run wall-clock gate on one pass or its worst', () => {
    const skipList = skips(job.env?.IOS_CI_SKIP_UNIT, 'WalnutTests')
    const isSkipped = (cls: string, method: string) => skipList.some((s) => s.cls === cls && (!s.method || s.method === method))
    const offenders = testClasses('WalnutTests').flatMap((c) => wallClockGates(c.body)
      .filter((g) => !isSkipped(c.name, g.method))
      .map((g) => `${c.file} ${c.name}/${g.method}: ${g.assert}`))
    expect(offenders, 'judge the gate with PerfGate.median of 3+ passes (or PerfGate.worstButOne for one long loop of like steps), check it without the clock, or skip it in IOS_CI_SKIP_UNIT').toEqual([])
  })

  it('catches every shape of a timed bound, and lets PerfGate, counts, indices, waits and lower bounds through', () => {
    const method = (name: string, lines: string[]) => `    func ${name}() async {\n${lines.map((l) => `        ${l}`).join('\n')}\n    }\n`
    const caught = [
      method('testDateSingleShot', ['let started = Date()', 'work()', 'XCTAssertLessThan(Date().timeIntervalSince(started), 0.1, "fast")']),
      method('testDispatchTime', ['let t0 = DispatchTime.now()', 'work()', 'let totalMs = Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1e6', 'XCTAssertLessThan(totalMs, 10.0)']),
      method('testContinuousClock', ['let clock = ContinuousClock()', 'let started = clock.now', 'await work()', 'XCTAssertLessThan(clock.now - started, .milliseconds(100))']),
      method('testMsHelper', ['let burstMs = ms { work() }', 'XCTAssertLessThan(burstMs, 1_000.0)']),
      method('testWorstOfLoop', ['var worst = 0.0', 'for _ in 0..<3 {', '    let total = ms { work() }', '    worst = max(worst, total)', '}', 'XCTAssertLessThan(worst, budgetMs)']),
      method('testFreeMax', ['let a = ms { work() }', 'let b = ms { work() }', 'XCTAssertLessThan(max(a, b), 5)']),
      method('testAssertComparison', ['let elapsed = ms { work() }', 'XCTAssert(elapsed < 5, "fast")']),
      method('testAssertReversed', ['let elapsed = ms { work() }', 'XCTAssertTrue(5 > elapsed)']),
      method('testGreaterThanBudget', ['let elapsed = ms { work() }', 'XCTAssertGreaterThan(5.0, elapsed)']),
      method('testAppendedSamples', ['var bursts: [Double] = []', 'for _ in 0..<40 { bursts.append(ms { work() }) }', 'XCTAssertLessThan(bursts.max() ?? 0, 1_000.0)']),
      method('testVerdict', ['var over: [String] = []', 'let measureMs = ms { work() }', 'if measureMs >= budget { over.append("slow") }', 'XCTAssertTrue(over.isEmpty)']),
      method('testHelperFunction', ['func typeInto(_ n: Int) -> (worst: Double, steps: [Double]) {', '    var steps: [Double] = []', '    for _ in 0..<n { steps.append(ms { work() }) }', '    return (steps.max() ?? 0, steps)', '}', 'let long = typeInto(1_480)', 'XCTAssertLessThan(long.worst, budget)']),
      // Each pass judged alone: the slowest decides, so one stall fails the run.
      method('testForEachPass', ['let passes = PerfGate.passes(3) { _ in ms { work() } }', 'for p in passes { XCTAssertLessThan(p, 100) }']),
      method('testForEachClosure', ['let passes = PerfGate.passes(3) { _ in ms { work() } }', 'passes.forEach { XCTAssertLessThan($0, 100) }']),
      method('testNestedPasses', ['var runs: [[Double]] = []', 'for _ in 0..<3 { runs.append((0..<5).map { _ in ms { work() } }) }', 'runs.forEach { run in', '    for step in run { XCTAssertLessThan(step, 16.7) }', '}']),
      method('testNamedClosure', ['let passes = PerfGate.passes(3) { _ in ms { work() } }', 'passes.forEach { pass in XCTAssertLessThanOrEqual(pass, 100) }']),
      method('testAllSatisfy', ['let passes = PerfGate.passes(3) { _ in ms { work() } }', 'XCTAssertTrue(passes.allSatisfy { $0 < 100 })']),
      // The clock against a deadline, a property, a call chained on the next line.
      method('testClockBeforeDeadline', ['let deadline = Date().addingTimeInterval(2)', 'await work()', 'XCTAssertLessThan(Date(), deadline)']),
      method('testContinuousClockDeadline', ['let deadline = ContinuousClock.now + .seconds(2)', 'await work()', 'XCTAssertTrue(ContinuousClock.now < deadline)']),
      '    func measureIt() {\n        self.lastMs = ms { work() }\n    }\n' + method('testPropertyDuration', ['measureIt()', 'XCTAssertLessThan(self.lastMs, 10)']),
      method('testMultiLineDate', ['let started = Date()', 'await work()', 'let elapsed = Date()', '    .timeIntervalSince(started)', 'XCTAssertLessThan(elapsed, 2)']),
      // A tuple loop: the element of enumerated(), each sequence of a zip.
      method('testEnumeratedLoop', ['let passes = PerfGate.passes(3) { _ in ms { work() } }', 'for (i, p) in passes.enumerated() { XCTAssertLessThan(p, 100, "pass \\(i)") }']),
      method('testEnumeratedMultiLine', ['let passes = PerfGate.passes(3) { _ in ms { work() } }', 'for (i, p) in passes.enumerated() {', '    XCTAssertLessThan(p, 100, "pass \\(i)")', '}']),
      method('testEnumeratedElement', ['let passes = PerfGate.passes(3) { _ in ms { work() } }', 'passes.enumerated().forEach { XCTAssertLessThan($0.element, 100) }']),
      method('testZipLoop', ['let passes = PerfGate.passes(3) { _ in ms { work() } }', 'for (p, b) in zip(passes, budgets) { XCTAssertLessThan(p, b) }']),
      method('testZipMultiLine', ['let passes = PerfGate.passes(3) { _ in ms { work() } }', 'for (b, p) in zip(budgets, passes) {', '    XCTAssertGreaterThan(b, p)', '}']),
      // An XCTFail an upper bound decides, a search asserted empty, a distance, a helper.
      method('testFailIf', ['let e = ms { work() }', 'if e > 100 { XCTFail("slow: \\(e)") }']),
      method('testFailIfMultiLine', ['let e = ms { work() }', 'if e > 100 {', '    XCTFail("slow")', '}']),
      method('testGuardFail', ['let e = ms { work() }', 'guard e < 100 else { return XCTFail("slow") }']),
      method('testNilSearch', ['let passes = PerfGate.passes(3) { _ in ms { work() } }', 'XCTAssertNil(passes.first { $0 > 100 })']),
      method('testDispatchDistance', ['let t0 = DispatchTime.now()', 'work()', 'XCTAssertLessThan(t0.distance(to: DispatchTime.now()), .milliseconds(100))']),
      '    private var runMs = 0.0\n    private func run() { runMs = ms { work() } }\n' + method('testBarePropertyDuration', ['run()', 'XCTAssertLessThan(runMs, 100)']),
      '    private func assertFast(_ v: Double, line: UInt = #line) { XCTAssertLessThan(v, 100, line: line) }\n' + method('testAssertHelper', ['let e = ms { work() }', 'assertFast(e)']),
      method('testOneLineNestedHelper', ['func timeOnce() -> Double { let t0 = Date(); work(); return Date().timeIntervalSince(t0) }', 'XCTAssertLessThan(timeOnce(), 0.1)']),
    ]
    const through = [
      method('testMedian', ['let passes = PerfGate.passes(3) { _ in ms { work() } }', 'XCTAssertLessThan(PerfGate.median(passes), 1, "slow: \\(PerfGate.summary(passes))")']),
      method('testWorstButOne', ['var steps: [Double] = []', 'for _ in 0..<40 { steps.append(ms { work() }) }', 'XCTAssertLessThan(PerfGate.worstButOne(steps), 1)']),
      method('testJudgedName', ['let passes = PerfGate.passes(3) { _ in ms { work() } }', 'let measureMs = PerfGate.median(passes)', 'var over: [String] = []', 'if measureMs >= budget { over.append("slow") }', 'XCTAssertTrue(over.isEmpty)']),
      method('testCounts', ['var worstCount = 0', 'for frame in frames { worstCount = max(worstCount, frame.cells) }', 'XCTAssertLessThan(worstCount, 40)', 'XCTAssertLessThanOrEqual(worstStepCells, 12)', 'XCTAssertLessThan(rows.map(\\.count).max() ?? 0, 9)']),
      method('testLowerBound', ['let started = Date()', 'await waitABit()', 'XCTAssertGreaterThan(Date().timeIntervalSince(started), 0.2)', 'XCTAssertGreaterThanOrEqual(ms { work() }, 0)']),
      method('testDomainDates', ['let twoDays = calendar.startOfDay(for: clock.now.addingTimeInterval(-86_400))', 'XCTAssertTrue(calls.contains { abs($0.from.timeIntervalSince(twoDays)) < 86_400 })', 'XCTAssertLessThan(abs(AppClock.now().timeIntervalSince(pin)), 5)', 'XCTAssertLessThan(created.timeIntervalSince1970, 2_000_000_000)']),
      method('testCountOfPasses', ['let passes = PerfGate.passes(3) { _ in ms { work() } }', 'XCTAssertLessThan(passes.count, 4)', 'XCTAssertLessThan(PerfGate.median(passes), 100)']),
      method('testClosureOnCounts', ['let passes = PerfGate.passes(3) { _ in ms { work() } }', 'XCTAssertLessThan(PerfGate.median(passes), 100)', 'rows.forEach { XCTAssertLessThan($0.cells, 12) }', 'for row in rows { XCTAssertLessThan(row.cells, 12) }']),
      // Dates worked out from a reading are not timings.
      method('testDatesFromNow', ['let now = Date()', 'let exp = now.addingTimeInterval(3_600)', 'XCTAssertLessThan(exp.timeIntervalSince(now), 3_601)', 'let backoff = retry.nextAttempt.timeIntervalSince(now)', 'XCTAssertLessThan(backoff, 31)', 'XCTAssertLessThan(Date().timeIntervalSince(item.createdAt), 86_400)', 'XCTAssertLessThan(token.expiry.timeIntervalSinceNow, 3_600)', 'XCTAssertGreaterThan(Date(), started)']),
      // An index, the count of slow passes (a vote), a wait's timeout in its poll loop.
      method('testTupleIndex', ['let passes = PerfGate.passes(3) { _ in ms { work() } }', 'for (i, p) in passes.enumerated() { XCTAssertLessThan(i, 3); print(p) }', 'passes.enumerated().forEach { XCTAssertLessThan($0.offset, 3) }', 'for i in passes.indices { XCTAssertLessThan(i, 3) }', 'for (p, b) in zip(passes, budgets) { XCTAssertLessThan(b, 200); print(p) }']),
      method('testCountOfSlowPasses', ['let passes = PerfGate.passes(3) { _ in ms { work() } }', 'XCTAssertLessThan(passes.filter { $0 > 100 }.count, 2)', 'if passes.isEmpty { XCTFail("no passes") }']),
      method('testPollWait', ['let deadline = Date().addingTimeInterval(5)', 'while !done() { guard Date() < deadline else { return XCTFail("timed out") }; try await Task.sleep(for: .milliseconds(5)) }', 'repeat {', '    if Date() > deadline { XCTFail("timed out"); break }', '    await Task.yield()', '} while !done()']),
      method('testInAComment', ['// XCTAssertLessThan(Date().timeIntervalSince(started), 0.1)', 'XCTAssertEqual(name, "XCTAssertLessThan(Date().timeIntervalSince(started), 0.1)")']),
    ]
    const body = [...caught, ...through].join('')
    const found = wallClockGates(body).map((g) => g.method)
    expect([...new Set(found)]).toEqual(caught.map((m) => [...m.matchAll(/func (test\w+)/g)].pop()![1]))
    // Each one's line points at its assertion.
    for (const g of wallClockGates(body)) expect(body.split('\n')[g.line - 1]).toMatch(/XCTAssert|XCTFail|\bif\b|\bguard\b|assertFast\(/)
  })
})

describe('the UI shards of the iOS job', () => {
  const skips = () => skipped(job.env?.IOS_CI_SKIP_UI, 'WalnutUITests')

  it('run every UI class with tests that IOS_CI_SKIP_UI does not leave out, each on one shard', () => {
    const plan = shardPlan(uiShards())
    expect(plan.shards).toBe(uiShards())
    expect(plan.legs).toHaveLength(uiShards())
    const placed = plan.legs.flatMap((l) => l.classes)
    expect(new Set(placed).size, 'a class on two shards').toBe(placed.length)
    const all = uiClassesWithTests()
    expect(all.length).toBeGreaterThan(30)
    const expected = all.filter((c) => !skips().includes(c))
    expect([...placed].sort(), 'a UI class with tests is on no shard and not in IOS_CI_SKIP_UI').toEqual(expected)
    for (const leg of plan.legs) expect(leg.classes.length, `shard ${leg.shard} runs no class`).toBeGreaterThan(0)
    // Inherited tests count: these hold none of their own beyond what ThreadPushUITestCase shares.
    expect(placed).toEqual(expect.arrayContaining(['ThreadPushHoldUITests', 'ThreadPushNavigationUITests']))
  })

  it('every class IOS_CI_SKIP_UI names exists', () => {
    const dir = path.join(ROOT, 'ios-native/WalnutUITests')
    const source = fs.readdirSync(dir).filter((f) => f.endsWith('.swift')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n')
    for (const c of skips()) expect(source, `IOS_CI_SKIP_UI names ${c}, which is no class`).toMatch(new RegExp(`\\bclass ${c}\\b`))
  })

  it('prints a shard as its -only-testing arguments, the same classes the plan gives it', () => {
    const args = (job.env?.IOS_CI_SKIP_UI ?? '').split(/\s+/).filter(Boolean)
    const plan = shardPlan(uiShards())
    for (const leg of plan.legs) {
      const out = execFileSync('python3', [SHARD_SCRIPT, String(leg.shard), String(uiShards()), ...args], { encoding: 'utf8' })
      expect(out.trim().split('\n')).toEqual(leg.classes.map((c) => `-only-testing:WalnutUITests/${c}`))
    }
  })

  it('weighs classes by the time CI measured, else by their tests, and deals them heaviest first', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-shard-'))
    const ui = path.join(dir, 'ui')
    fs.mkdirSync(ui)
    const write = (f: string, text: string) => fs.writeFileSync(path.join(ui, f), text)
    write('Base.swift', 'class SharedCase: XCTestCase {\n    func testShared() {}\n    func helper() {}\n}\n')
    write('Kid.swift', 'final class KidTests: SharedCase {\n    override func setUp() {}\n}\n')
    write('Big.swift', 'final class BigTests: XCTestCase {\n    func testA() throws {}\n    func testB() async throws {}\n    @MainActor func testC() {}\n    private func testHidden() {}\n    func testCase(_ x: Int) {}\n    // func testCommented() {}\n    /*\n    func testInABlockComment() {}\n    */\n    private final class Box: @unchecked Sendable {}\n}\n')
    write('BigMore.swift', 'extension BigTests {\n    func testD() {}\n}\n')
    write('Timed.swift', 'final class TimedTests: XCTestCase {\n    func testOne() {}\n    func testTwo() {}\n}\n')
    write('Skipped.swift', 'final class SkippedTests: XCTestCase {\n    func testX() {}\n}\n')
    write('Helpers.swift', 'enum Helpers {\n    static func testLike() {}\n}\nfinal class NotATest: NSObject {\n    func testY() {}\n}\n')
    const times = path.join(dir, 'times.tsv')
    // Measured: 10 s a test, and a test added since counts at that rate.
    fs.writeFileSync(times, '# comment\nTimedTests\t10.0\t1\n')
    const env = { CI_SHARD_UI_DIR: ui, CI_SHARD_TIMES: times }
    const skip = ['-skip-testing:WalnutUITests/SkippedTests', '-skip-testing:WalnutUITests/KidTests/testShared']
    const plan = shardPlan(2, env, skip)
    expect(plan.skipped).toEqual(['SkippedTests'])
    // BigTests: 4 tests x 60 s; SharedCase and KidTests 60 s each (the method skip keeps KidTests); TimedTests 2 x 10 s.
    expect(plan.legs).toEqual([
      { shard: 1, seconds: 240, classes: ['BigTests'] },
      { shard: 2, seconds: 140, classes: ['KidTests', 'SharedCase', 'TimedTests'] },
    ])
    // A shard with no class prints nothing and fails: no -only-testing would run the whole target.
    const empty = spawnSync('python3', [SHARD_SCRIPT, '5', '5', ...skip], { encoding: 'utf8', env: { ...process.env, ...env } })
    expect(empty).toMatchObject({ status: 1, stdout: '' })
    expect(empty.stderr).toContain('shard 5 of 5 has no class')
    expect(spawnSync('python3', [SHARD_SCRIPT, '4', '3'], { encoding: 'utf8', env: { ...process.env, ...env } }).status).not.toBe(0)
    expect(spawnSync('python3', [SHARD_SCRIPT, '1', '2', '-skip-testing:Other/X'], { encoding: 'utf8', env: { ...process.env, ...env } }).status).not.toBe(0)
    // record reads a job log's case lines into the times file, keeping classes the log lacks.
    const log = path.join(dir, 'job.log')
    fs.writeFileSync(log, [
      "2026-11-10T03:17:42Z Test Case '-[WalnutUITests.BigTests testA]' passed (30.500 seconds).",
      "2026-11-10T03:17:43Z Test Case '-[WalnutUITests.BigTests testB]' failed (9.500 seconds).",
      "2026-11-10T03:17:44Z Test Case '-[WalnutUITests.KidTests testShared]' skipped (0.200 seconds).",
      "2026-11-10T03:17:45Z Test Case '-[WalnutUITests.BigTests testA]' started.",
    ].join('\n'))
    execFileSync('python3', [SHARD_SCRIPT, 'record', log], { encoding: 'utf8', env: { ...process.env, ...env } })
    const rows = fs.readFileSync(times, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))
    expect(rows).toEqual(['BigTests\t40.0\t2', 'KidTests\t0.2\t1', 'TimedTests\t10.0\t1'])
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('has a measured time for most of the classes it runs', () => {
    const timed = new Set(fs.readFileSync(path.join(ROOT, 'ios-native/tests/ui/ci-shard-times.tsv'), 'utf8')
      .split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t')[0]))
    const placed = shardPlan(uiShards()).legs.flatMap((l) => l.classes)
    // An untimed class counts 60 s a test; refresh with `ci-shard.py record <job log>`.
    expect(placed.filter((c) => timed.has(c)).length / placed.length).toBeGreaterThan(0.6)
  })

  it('holds two macOS runners on a push, as one UI leg did, and every leg on a pull request', () => {
    expect(job.strategy?.['max-parallel']).toBe("${{ github.event_name == 'push' && 2 || 4 }}")
    expect(job.strategy!.matrix.include).toHaveLength(4)
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

  // The harness's ids are a contract checked by TimelineHarnessIdentifierTests, which only
  // a Mac runs: a new hold button without its manifest line failed the unit leg after it
  // landed (2026-11-01, run 41321892059). The same read here fails before a land.
  it('every harness identifier is in the Swift manifest, and every manifest line is a harness identifier', () => {
    const ids = new Set([...harness.matchAll(/accessibilityIdentifier\("(harness\.[\w.]+)"\)/g)].map((m) => m[1]!))
    const manifestTest = fs.readFileSync(path.join(ROOT, 'ios-native/WalnutTests/TimelineHarnessIdentifierTests.swift'), 'utf8')
    const block = manifestTest.split('private let expected: Set<String> = [')[1]!.split(']')[0]!
    const manifest = new Set([...block.matchAll(/"(harness\.[\w.]+)"/g)].map((m) => m[1]!))
    expect(ids.size).toBeGreaterThan(10)
    expect([...ids].filter((id) => !manifest.has(id)), 'add these to TimelineHarnessIdentifierTests.expected').toEqual([])
    expect([...manifest].filter((id) => !ids.has(id)), 'no harness control carries these').toEqual([])
  })

  it('reads a clocked pause where there is one', () => {
    expect(longestSleep('try? await Task.sleep(for: .milliseconds(index == 10 ? 3000 : 600))')).toBe(3000)
    expect(longestSleep('try? await Task.sleep(for: .seconds(4))')).toBe(4000)
    expect(longestSleep('try? await Task.sleep(for: .milliseconds(600))')).toBe(600)
  })
})
