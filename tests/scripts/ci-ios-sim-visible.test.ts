/**
 * The iOS job waits until xcodebuild lists the booted simulator before any test step
 * (ios-native/tests/wait-sim-visible.sh). 2026-11-06, CI run 42205675031: simctl booted the
 * iPhone, xcodebuild then listed no simulator at all, and the unit leg failed before one test.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

const ROOT = path.resolve(__dirname, '../..')
const SCRIPT = path.join(ROOT, 'ios-native/tests/wait-sim-visible.sh')
type Step = { name?: string; run?: string; if?: string }
const doc = parseYaml(fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')) as { jobs: Record<string, { steps: Step[] }> }
const UDID = 'F0C70C77-E423-4478-B648-3D25045B311B'

/** Runs the script with a fake xcodebuild that lists the simulator from its `seenFrom`-th call on. */
function run(seenFrom: number, tries = 3) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-visible-'))
  const fake = path.join(dir, 'xcodebuild')
  fs.writeFileSync(fake, `#!/usr/bin/env bash
n=$(( $(cat "${dir}/n" 2>/dev/null || echo 0) + 1 )); echo $n > "${dir}/n"
echo '	{ platform:iOS Simulator, id:dvtdevice-DVTiOSDeviceSimulatorPlaceholder-iphonesimulator:placeholder, name:Any iOS Simulator Device }'
if [ $n -ge ${seenFrom} ]; then echo '	{ platform:iOS Simulator, arch:arm64, id:${UDID}, OS:26.5, name:iPhone 17 Pro }'; fi
`, { mode: 0o755 })
  const r = spawnSync('bash', [SCRIPT, UDID], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, XCODEBUILD: fake, WALNUT_SIM_WAIT_TRIES: String(tries), WALNUT_SIM_WAIT_SECS: '0', PATH: `${dir}:${process.env.PATH}` },
  })
  const calls = Number(fs.readFileSync(path.join(dir, 'n'), 'utf8'))
  fs.rmSync(dir, { recursive: true, force: true })
  return { code: r.status, out: r.stdout, calls }
}

describe('the iOS job waits until xcodebuild sees its simulator', () => {
  it('passes at once, or after a few tries, when xcodebuild lists the booted simulator', () => {
    expect(run(1)).toMatchObject({ code: 0, calls: 1 })
    expect(run(3)).toMatchObject({ code: 0, calls: 3 })
  })

  it('fails with an annotation naming the simulator when xcodebuild never lists it', () => {
    const r = run(99, 3)
    expect(r.code).toBe(1)
    expect(r.calls).toBe(3)
    expect(r.out).toContain(`::error title=iOS simulator::xcodebuild never listed the booted simulator ${UDID}`)
  })

  it("runs after the boot and before either leg's tests", () => {
    const steps = doc.jobs.ios!.steps
    const at = (pred: (s: Step) => boolean) => steps.findIndex(pred)
    const boot = at((s) => !!s.run?.includes('SIM_UDID=$udid'))
    const wait = at((s) => !!s.run?.includes('tests/wait-sim-visible.sh "$SIM_UDID"'))
    expect(boot).toBeGreaterThanOrEqual(0)
    expect(wait).toBeGreaterThan(boot)
    expect(steps[wait]!.if).toBeUndefined()
    for (const s of steps.filter((x) => x.run?.includes('xcodebuild test') || x.run?.includes('run-ui-tests.sh'))) {
      expect(steps.indexOf(s)).toBeGreaterThan(wait)
    }
  })
})
