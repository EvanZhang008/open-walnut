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
 *   node scripts/nightly-version.mjs due   ->  due=true|false: is a scheduled nightly due?
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

export function nightlyVersion(baseVersion, date, run) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-.*)?$/.exec(baseVersion)
  if (!m) throw new Error(`package.json version "${baseVersion}" is not x.y.z`)
  const day = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`
  const n = Number(run)
  if (!Number.isInteger(n) || n < 0) throw new Error(`run number "${run}" is not a non-negative integer`)
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}-nightly.${day}.${n}`
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === 'due') {
  // `due`: prints due=true|false for $GITHUB_OUTPUT, the reason on stderr.
  const res = await fetch('https://registry.npmjs.org/open-walnut', { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`registry answered ${res.status}`)
  const { due, reason } = nightlyDue(await res.json(), new Date())
  process.stderr.write(`${reason}\n`)
  process.stdout.write(`due=${due}\n`)
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const run = process.env.GITHUB_RUN_NUMBER ?? process.argv[2] ?? '0'
  const base = newerBase(pkg.version, process.env.WALNUT_LATEST_STABLE)
  process.stdout.write(`${nightlyVersion(base, new Date(), run)}\n`)
}
