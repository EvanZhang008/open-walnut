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
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function nightlyVersion(baseVersion, date, run) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-.*)?$/.exec(baseVersion)
  if (!m) throw new Error(`package.json version "${baseVersion}" is not x.y.z`)
  const day = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`
  const n = Number(run)
  if (!Number.isInteger(n) || n < 0) throw new Error(`run number "${run}" is not a non-negative integer`)
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}-nightly.${day}.${n}`
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const run = process.env.GITHUB_RUN_NUMBER ?? process.argv[2] ?? '0'
  process.stdout.write(`${nightlyVersion(pkg.version, new Date(), run)}\n`)
}
