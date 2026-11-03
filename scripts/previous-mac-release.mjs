#!/usr/bin/env bun
/**
 * The release a person updates from: the newest stable Walnut release older
 * than `version` that has Walnut-<arch>.dmg attached. mac-app.yml starts that
 * release's own app from its DMG and lets it update itself to the app it just
 * built (scripts/desktop-update-e2e.mjs). Prints the version, or nothing when
 * no earlier release has a DMG for that Mac (the first one, or every older one
 * from before the app).
 *
 *   bun scripts/previous-mac-release.mjs --before 0.7.0 --arch arm64   (GH_REPO, GH_TOKEN as gh reads them)
 */
import { execFileSync } from 'node:child_process'
import { compareVersions } from './release-rehearsal/version-order.mjs'

const STABLE_TAG = /^v(\d+\.\d+\.\d+)$/

/**
 * `releases`: GitHub's release objects ({ tag_name, draft, prerelease, assets: [{ name }] }).
 * A draft, a prerelease, a tag that is no Walnut stable version (a component's, a
 * connector's) and a release without the DMG never count.
 */
export function previousMacRelease(releases, before, arch) {
  const dmg = `Walnut-${arch}.dmg`
  let best = null
  for (const r of releases ?? []) {
    const m = STABLE_TAG.exec(r?.tag_name ?? '')
    if (!m || r.draft || r.prerelease) continue
    const v = m[1]
    if (!(compareVersions(v, before) < 0)) continue
    if (!(r.assets ?? []).some((a) => a?.name === dmg)) continue
    if (!best || compareVersions(v, best) > 0) best = v
  }
  return best
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const val = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined }
  const before = val('--before')
  const arch = val('--arch')
  if (!before || !arch || compareVersions(before, before) === null) {
    console.error('usage: previous-mac-release.mjs --before <x.y.z> --arch <arm64|x64>')
    process.exit(2)
  }
  const repo = process.env.GH_REPO
  const pages = execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${repo ?? '{owner}/{repo}'}/releases?per_page=100`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const found = previousMacRelease(JSON.parse(pages).flat(), before, arch)
  if (found) process.stdout.write(`${found}\n`)
}
