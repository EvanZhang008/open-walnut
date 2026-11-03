/**
 * The Mac app release updates the previous release's app to itself before it is
 * attached (.github/workflows/mac-app.yml): the release it starts from
 * (scripts/previous-mac-release.mjs), and the step's place, condition and command.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { previousMacRelease } from '../../scripts/previous-mac-release.mjs'

const ROOT = path.resolve(__dirname, '../..')
type Step = { name?: string; uses?: string; if?: string; run?: string }

const rel = (tag: string, assets: string[], over: Record<string, unknown> = {}) =>
  ({ tag_name: tag, draft: false, prerelease: false, assets: assets.map((name) => ({ name })), ...over })
const BOTH = ['Walnut-arm64.dmg', 'Walnut-x64.dmg', 'SHA256SUMS']

describe('previousMacRelease', () => {
  it('the newest stable release older than this one that has the DMG for that Mac', () => {
    const releases = [
      rel('v0.7.0', BOTH), rel('v0.6.24', BOTH), rel('v0.6.10', BOTH), rel('v0.6.23', ['Walnut-x64.dmg']),
      rel('v0.6.9', BOTH),
    ]
    expect(previousMacRelease(releases, '0.7.0', 'arm64')).toBe('0.6.24')
    expect(previousMacRelease(releases, '0.6.24', 'arm64')).toBe('0.6.10')
    expect(previousMacRelease(releases, '0.6.24', 'x64')).toBe('0.6.23')
    // Numbers, not text: 0.6.10 is newer than 0.6.9.
    expect(previousMacRelease([rel('v0.6.9', BOTH), rel('v0.6.10', BOTH)], '0.6.11', 'arm64')).toBe('0.6.10')
  })

  it('never a draft, a prerelease, another component\'s tag, the same version or a release without the DMG', () => {
    const releases = [
      rel('v0.6.30', BOTH, { draft: true }), rel('v0.6.29', BOTH, { prerelease: true }),
      rel('walnut-net-v0.2.0', BOTH), rel('component-images-0.34.5-1', BOTH), rel('v0.6.28-nightly.20261103.1', BOTH),
      rel('v0.7.0', BOTH), rel('v0.6.27', ['SHA256SUMS']),
    ]
    expect(previousMacRelease(releases, '0.7.0', 'arm64')).toBeNull()
    expect(previousMacRelease([], '0.7.0', 'arm64')).toBeNull()
    expect(previousMacRelease([rel('v0.6.24', BOTH)], '0.6.24', 'arm64')).toBeNull()
  })
})

describe('mac-app.yml: the previous release\'s app updates itself to this one', () => {
  const doc = parseYaml(fs.readFileSync(path.join(ROOT, '.github/workflows/mac-app.yml'), 'utf8')) as { jobs: { app: { steps: Step[] } } }
  const steps = doc.jobs.app.steps
  const at = (pattern: RegExp) => steps.findIndex((s) => pattern.test(s.name ?? ''))
  const step = steps[at(/^The previous release's app updates itself/)]

  it('runs on the signed Apple silicon app, after Gatekeeper and the first launch, before anything is attached', () => {
    expect(step).toBeDefined()
    // Same developer is what the old app's updater checks: only a signed build can pass.
    expect(step.if).toBe("steps.signing.outputs.signed == 'true' && matrix.arch == 'arm64'")
    expect(at(/^Gatekeeper opens it/)).toBeLessThan(at(/^The previous release's app updates itself/))
    expect(at(/^First launch installs/)).toBeLessThan(at(/^The previous release's app updates itself/))
    expect(at(/^The previous release's app updates itself/)).toBeLessThan(at(/^Attach Walnut-/))
    // A failure fails the job: nothing lets it pass.
    expect((step as { 'continue-on-error'?: boolean })['continue-on-error']).toBeUndefined()
  })

  it('starts from that release\'s own DMG and updates to the notarized app, with the checks from harness', () => {
    const run = step.run ?? ''
    expect(run).toContain('bun harness/scripts/previous-mac-release.mjs --before "$VERSION" --arch "$ARCH"')
    expect(run).toContain('gh release download "v$prev" --dir "$RUNNER_TEMP/prev" --clobber --pattern "Walnut-$ARCH.dmg"')
    expect(run).toContain('bun harness/scripts/desktop-update-e2e.mjs --old "$RUNNER_TEMP/prev/Walnut.app" --new "$RUNNER_TEMP/Applications/Walnut.app"')
    // No release before it (the first with an app) is a notice, not a failure.
    expect(run).toMatch(/if \[ -z "\$prev" \]; then echo "::notice::[^"]*"; exit 0; fi/)
    // Clicked by the app's hook, never --auto: the old release's page may predate the page's own update.
    expect(run).not.toContain('--auto')
  })
})
