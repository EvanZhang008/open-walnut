#!/usr/bin/env bun
// Are the optional components this tree pins out? Walnut downloads each one on first use from
// its `component-<name>-<version>` prerelease (src/core/components/manifest.ts assetUrl), and
// .github/workflows/components.yml publishes those. A release whose pins point at an archive
// that is not there yet would 404 the first time a person turns that feature on.
//
// The same class as scripts/net-release-ready.sh (2026-11-09: the host network connector a
// commit pinned was not out when its joins ran): whatever ships a commit asks here first.
//
//   bun scripts/components-release-ready.mjs              exit 0 when every pinned archive answers, 1 when not
//   bun scripts/components-release-ready.mjs --at <rev>   the pins of that commit
//
// Exit 2: manifest-data.ts holds no manifest this can read (its format changed under this).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const PIN = 'src/core/components/manifest-data.ts'

function usage() {
  console.error('usage: components-release-ready.mjs [--at REV]')
  process.exit(2)
}

/** The manifest the client reads, from the tree or from a commit. */
export function readManifest(source) {
  const start = source.indexOf('{', source.indexOf('COMPONENTS_MANIFEST'))
  const end = source.lastIndexOf('}')
  if (start < 0 || end < start) return null
  try {
    const m = JSON.parse(source.slice(start, end + 1))
    return m && typeof m.repo === 'string' && m.components && typeof m.components === 'object' ? m : null
  } catch {
    return null
  }
}

/** Every archive a client may fetch, with the URL it fetches it from (manifest.ts assetUrl). */
export function pinnedAssets(m, base = process.env.WALNUT_COMPONENTS_BASE_URL) {
  const out = []
  for (const [name, c] of Object.entries(m.components)) {
    for (const [platform, e] of Object.entries(c.platforms ?? {})) {
      const url = base
        ? `${base.replace(/\/+$/, '')}/${encodeURIComponent(e.asset)}`
        : `https://github.com/${m.repo}/releases/download/${encodeURIComponent(c.tag)}/${encodeURIComponent(e.asset)}`
      out.push({ name, platform, tag: c.tag, asset: e.asset, url })
    }
  }
  return out
}

/** HTTP status of one archive: a 404 answers at once, a dropped connection is tried again. */
async function status(url) {
  let last = 0
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(20_000) })
      if (r.status === 200 || r.status === 404) return r.status
      last = r.status
    } catch {
      last = 0
    }
    if (attempt < 2) await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)))
  }
  return last
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  let rev = ''
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--at' && args[i + 1]) rev = args[++i]
    else usage()
  }
  let source = ''
  try {
    source = rev ? execFileSync('git', ['show', `${rev}:${PIN}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) : fs.readFileSync(PIN, 'utf8')
  } catch {
    source = ''
  }
  const m = readManifest(source)
  if (!m) {
    console.error(`components-release-ready: ${PIN}${rev ? ` at ${rev}` : ''} holds no manifest this can read`)
    process.exit(2)
  }
  const assets = pinnedAssets(m)
  const codes = await Promise.all(assets.map((a) => status(a.url)))
  const missing = assets.filter((_, i) => codes[i] !== 200)
  for (const a of missing) console.error(`  ${a.tag}/${a.asset}: HTTP ${codes[assets.indexOf(a)] || 'no answer'} (${a.url})`)
  if (missing.length) {
    console.error(`${missing.length} of ${assets.length} pinned component archives are not out. components.yml publishes them when ${PIN} changes on main (or run it by hand with publish).`)
    process.exit(1)
  }
  console.log(`all ${assets.length} pinned component archives are out`)
}
