#!/usr/bin/env node
/**
 * The version a nightly publish gets: the next patch of package.json's version,
 * as a prerelease that sorts by day and then by run.
 *
 *   package.json 0.5.1, 2026-10-01, run 318  ->  0.5.2-nightly.20261001.318
 *
 * Why this shape: it is semver, so `npm install -g open-walnut@nightly` and the
 * update check (src/core/self-update/version-compare.ts) order nightlies among
 * themselves; `0.5.2-nightly.*` sorts below the stable 0.5.2 that eventually
 * carries the same work, so a stable release always outranks the nightlies
 * before it; and the word `nightly` is what tells the checker which channel an
 * install follows. The run number (GITHUB_RUN_NUMBER) keeps two publishes on
 * one day apart and climbs forever within a workflow.
 *
 * Nothing is committed: CI sets the version in its working copy with
 * `npm version --no-git-tag-version` and publishes `--tag nightly`.
 *
 * The base is the newer of package.json and the latest stable on npm
 * (WALNUT_LATEST_STABLE): a stable release bumps main with a commit CI never
 * runs, so the newest green commit can still name the version before it, and a
 * nightly must never sort below the stable it follows.
 *
 *   node scripts/nightly-version.mjs due              ->  due=true|false: is a scheduled nightly due?
 *   node scripts/nightly-version.mjs last             ->  the commit the last nightly was built from
 *   node scripts/nightly-version.mjs wait <version>   ->  returns once npm serves <version> as `nightly`
 *
 * The registry is the record of which commit the last nightly came from (the
 * `gitHead` npm stores with each version). A `nightly` git tag used to say it,
 * until the job could not move it: GitHub lets the job's token point a ref only
 * at a commit whose .github/workflows match main's tip, and the newest green
 * commit lags a main whose newest commit changed a workflow (2026-10-03).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The newer of two x.y.z versions (a missing or malformed one loses). */
export function newerBase(a, b) {
  const parse = (v) => /^(\d+)\.(\d+)\.(\d+)$/.exec(v ?? '')?.slice(1).map(Number)
  const [pa, pb] = [parse(a), parse(b)]
  if (!pb) return a
  if (!pa) return b
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i] ? a : b
  return a
}

/**
 * Hours between scheduled nightlies. The schedule fires every 30 minutes and this
 * gap decides, so a run GitHub drops costs half an hour, not six (T3 Code does the
 * same); 5.5 keeps the cadence at about six hours instead of drifting later.
 */
export const NIGHTLY_GAP_HOURS = 5.5

/** Whether a scheduled nightly is due: the `nightly` dist-tag is at least `gapHours` old. */
export function nightlyDue(packument, now, gapHours = NIGHTLY_GAP_HOURS) {
  const tag = packument['dist-tags']?.nightly
  const at = Date.parse(packument.time?.[tag] ?? '')
  if (!tag || !Number.isFinite(at)) return { due: true, reason: 'no nightly on npm yet' }
  const hours = (now.getTime() - at) / 3_600_000
  return hours >= gapHours
    ? { due: true, reason: `${tag} is ${hours.toFixed(1)}h old` }
    : { due: false, reason: `${tag} is ${hours.toFixed(1)}h old; the next one is due at ${gapHours}h` }
}

/** The commit the version under the `nightly` dist-tag was built from, or '' when npm has none. */
export function lastNightlyCommit(packument) {
  const tag = packument['dist-tags']?.nightly
  const head = tag ? packument.versions?.[tag]?.gitHead : undefined
  return typeof head === 'string' && /^[0-9a-f]{40}$/.test(head) ? head : ''
}

/** Whether npm already serves `version` under the `nightly` dist-tag. */
export function servesNightly(packument, version) {
  return packument['dist-tags']?.nightly === version && Boolean(packument.versions?.[version])
}

export function nightlyVersion(baseVersion, date, run) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-.*)?$/.exec(baseVersion)
  if (!m) throw new Error(`package.json version "${baseVersion}" is not x.y.z`)
  const day = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`
  const n = Number(run)
  if (!Number.isInteger(n) || n < 0) throw new Error(`run number "${run}" is not a non-negative integer`)
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}-nightly.${day}.${n}`
}

const REGISTRY = process.env.WALNUT_NIGHTLY_REGISTRY_URL ?? 'https://registry.npmjs.org/open-walnut'

async function packument() {
  const res = await fetch(REGISTRY, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`registry answered ${res.status}`)
  return res.json()
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain && process.argv[2] === 'due') {
  // `due`: prints due=true|false for $GITHUB_OUTPUT, the reason on stderr.
  const { due, reason } = nightlyDue(await packument(), new Date())
  process.stderr.write(`${reason}\n`)
  process.stdout.write(`due=${due}\n`)
} else if (isMain && process.argv[2] === 'last') {
  process.stdout.write(`${lastNightlyCommit(await packument())}\n`)
} else if (isMain && process.argv[2] === 'wait') {
  // npm takes minutes to serve a version it accepted ("Your package is being
  // processed"). The next nightly run reads the registry to learn what the last
  // nightly was, and the channel's queue starts it only when this one ends, so a
  // publish waits here until npm serves it: otherwise the next run would see the
  // nightly before it and publish the same commit again.
  const version = process.argv[3]
  if (!version) throw new Error('usage: nightly-version.mjs wait <version>')
  const deadline = Date.now() + Number(process.env.WALNUT_NIGHTLY_WAIT_SECS ?? 1800) * 1000
  const every = Number(process.env.WALNUT_NIGHTLY_WAIT_EVERY_SECS ?? 20) * 1000
  for (;;) {
    const served = await packument().then((p) => servesNightly(p, version), (err) => (process.stderr.write(`${err.message}\n`), false))
    if (served) { process.stdout.write(`npm serves open-walnut@${version} as nightly\n`); break }
    if (Date.now() + every > deadline) {
      process.stderr.write(`npm accepted open-walnut@${version} but does not serve it as nightly yet; the next run may publish this commit again\n`)
      process.exit(1)
    }
    await new Promise((resolve) => setTimeout(resolve, every))
  }
} else if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const run = process.env.GITHUB_RUN_NUMBER ?? process.argv[2] ?? '0'
  const base = newerBase(pkg.version, process.env.WALNUT_LATEST_STABLE)
  process.stdout.write(`${nightlyVersion(base, new Date(), run)}\n`)
}
