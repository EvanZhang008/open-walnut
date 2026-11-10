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

/**
 * Runs the script with a fake xcodebuild that lists the simulator from its `seenFrom`-th call
 * on, or (`afterRecover`) only once the simulator service was restarted and the iPhone booted
 * again. A fake simctl and service restart log their steps.
 */
function run(seenFrom: number, tries: number | null = 3, opts: { afterRecover?: boolean; recoverAt?: number | null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-visible-'))
  const fake = path.join(dir, 'xcodebuild')
  const seen = opts.afterRecover ? `[ -f "${dir}/rebooted" ]` : `[ $n -ge ${seenFrom} ]`
  fs.writeFileSync(fake, `#!/usr/bin/env bash
n=$(( $(cat "${dir}/n" 2>/dev/null || echo 0) + 1 )); echo $n > "${dir}/n"
echo '	{ platform:iOS Simulator, id:dvtdevice-DVTiOSDeviceSimulatorPlaceholder-iphonesimulator:placeholder, name:Any iOS Simulator Device }'
if ${seen}; then echo '	{ platform:iOS Simulator, arch:arm64, id:${UDID}, OS:26.5, name:iPhone 17 Pro }'; fi
`, { mode: 0o755 })
  const simctl = path.join(dir, 'simctl')
  fs.writeFileSync(simctl, `#!/usr/bin/env bash
echo "simctl $1" >> "${dir}/steps"
if [ "$1" = boot ] && grep -q '^restart$' "${dir}/steps"; then touch "${dir}/rebooted"; fi
if [ "$1" = list ]; then echo '    iPhone 17 Pro (${UDID}) (Booted)'; fi
`, { mode: 0o755 })
  const r = spawnSync('bash', [SCRIPT, UDID], {
    cwd: dir, encoding: 'utf8',
    env: {
      ...process.env, XCODEBUILD: fake, SIMCTL: simctl, WALNUT_SIM_SERVICE_RESTART: `echo restart >> "${dir}/steps"`,
      WALNUT_SIM_WAIT_SECS: '0',
      // null: the script's own default.
      ...(tries === null ? {} : { WALNUT_SIM_WAIT_TRIES: String(tries) }),
      ...(opts.recoverAt === null ? {} : { WALNUT_SIM_RECOVER_AT: String(opts.recoverAt ?? 3) }),
      PATH: `${dir}:${process.env.PATH}`,
    },
  })
  const calls = Number(fs.readFileSync(path.join(dir, 'n'), 'utf8'))
  const steps = fs.existsSync(path.join(dir, 'steps')) ? fs.readFileSync(path.join(dir, 'steps'), 'utf8').trim().split('\n') : []
  fs.rmSync(dir, { recursive: true, force: true })
  return { code: r.status, out: r.stdout, calls, steps }
}

describe('the iOS job waits until xcodebuild sees its simulator', () => {
  it('passes at once, or after a few tries, when xcodebuild lists the booted simulator', () => {
    expect(run(1)).toMatchObject({ code: 0, calls: 1 })
    expect(run(3)).toMatchObject({ code: 0, calls: 3 })
  })

  it('fails with an annotation naming the simulator, and what xcodebuild did list, when it never lists it', () => {
    const r = run(99, 3)
    expect(r.code).toBe(1)
    expect(r.calls).toBe(3)
    expect(r.out).toContain(`::error title=iOS simulator::xcodebuild never listed the booted simulator ${UDID}`)
    expect(r.out).toContain(`iPhone 17 Pro (${UDID}) (Booted)`)
    expect(r.out).toMatch(/xcodebuild listed these destinations:\n.*name:Any iOS Simulator Device/)
  })

  // 2026-11-07, CI run 42339693777: Booted to simctl, absent from xcodebuild for two minutes.
  it('restarts the simulator service and boots the iPhone again once, halfway, when xcodebuild still does not list it', () => {
    const r = run(0, 6, { afterRecover: true })
    expect(r).toMatchObject({ code: 0, calls: 4 })
    expect(r.steps).toEqual(['simctl shutdown', 'restart', 'simctl boot', 'simctl bootstatus'])
    expect(r.out).toContain(`xcodebuild sees simulator ${UDID} (try 4)`)
  })

  it('recovers at most once, and never when the simulator is seen first', () => {
    expect(run(99, 6, { recoverAt: 2 }).steps.filter((s) => s === 'restart')).toHaveLength(1)
    expect(run(2, 6).steps).toEqual([])
  })

  // 2026-11-10, CI run 42796192784: one leg saw the iPhone at try 3 of a slow first boot, the
  // other restarted the service at try 3, which started the wait over, and failed.
  it('by default waits past a slow listing without restarting anything, and restarts only well into the wait', () => {
    const late = run(6, null, { recoverAt: null })
    expect(late).toMatchObject({ code: 0, calls: 6 })
    expect(late.steps).toEqual([])
    const never = run(99, null, { recoverAt: null })
    expect(never.code).toBe(1)
    expect(never.calls).toBe(14)
    expect(never.steps.filter((s) => s === 'restart')).toHaveLength(1)
    // The restart comes after the 7th try, so 6 quiet ones went first.
    expect(never.out.indexOf('restarting the simulator service')).toBeGreaterThan(never.out.indexOf('(try 7 of 14)'))
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
