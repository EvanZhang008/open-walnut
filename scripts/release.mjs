#!/usr/bin/env node
/**
 * Cut a stable release: `npm run release -- patch|minor|major|<x.y.z>`.
 *
 * One command, one commit, one tag; the publish itself happens in GitHub
 * Actions (.github/workflows/release.yml) when the tag arrives, through npm
 * trusted publishing, so no machine here holds an npm token and every release
 * is built from the same clean checkout with provenance.
 *
 * What it does, in order, and refuses to start when any step would be wrong:
 *   1. the tree is clean (nothing staged or unstaged), the branch is main, and
 *      main is at origin/main (fetched now): a release is a point on main that
 *      others can check out, never a local pile;
 *   2. CHANGELOG.md has an `## [Unreleased]` section with content: that becomes
 *      `## [x.y.z] - YYYY-MM-DD`, and a fresh empty Unreleased goes above it;
 *   3. package.json and package-lock.json move to x.y.z (`npm version`, no tag);
 *   4. commit `release: x.y.z`, tag `vx.y.z` (annotated), push both.
 *
 * `--dry-run` prints the plan and changes nothing. `--no-push` stops after the
 * tag (push by hand). The version argument is validated as a plain release
 * (no prerelease): nightlies are cut by CI, not here.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const noPush = args.includes('--no-push')
const bump = args.find((a) => !a.startsWith('--'))

function fail(message) {
  process.stderr.write(`release: ${message}\n`)
  process.exit(1)
}

function git(...gitArgs) {
  return execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function run(cmd, cmdArgs) {
  if (dryRun) { process.stdout.write(`  would run: ${cmd} ${cmdArgs.join(' ')}\n`); return }
  execFileSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit' })
}

/** The next version for a bump word, or the version given, as a plain release. */
export function nextVersion(current, word) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-.*)?$/.exec(current)
  if (!m) throw new Error(`package.json version "${current}" is not x.y.z`)
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])]
  switch (word) {
    case 'major': return `${major + 1}.0.0`
    case 'minor': return `${major}.${minor + 1}.0`
    case 'patch': return `${major}.${minor}.${patch + 1}`
    default: {
      if (!/^\d+\.\d+\.\d+$/.test(word ?? '')) throw new Error('give patch, minor, major or an exact x.y.z (no prerelease: nightlies come from CI)')
      return word
    }
  }
}

/**
 * Move the Unreleased section under a version heading and open a new, empty one.
 * The Unreleased body must have content: a release with nothing to say is a mistake.
 */
export function rollChangelog(text, version, date) {
  const heading = /^## \[Unreleased\]\s*$/m
  const start = text.search(heading)
  if (start < 0) throw new Error('CHANGELOG.md has no "## [Unreleased]" section')
  const afterHeading = text.indexOf('\n', start) + 1
  const nextSection = text.slice(afterHeading).search(/^## \[/m)
  const bodyEnd = nextSection < 0 ? text.length : afterHeading + nextSection
  const body = text.slice(afterHeading, bodyEnd)
  if (!body.replace(/\s/g, '')) throw new Error('CHANGELOG.md "## [Unreleased]" is empty: write what changed before releasing')
  if (new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm').test(text)) throw new Error(`CHANGELOG.md already has a ${version} section`)
  return `${text.slice(0, start)}## [Unreleased]\n\n## [${version}] - ${date}\n${body}${text.slice(bodyEnd)}`
}

function main() {
  if (!bump) fail('usage: npm run release -- patch|minor|major|<x.y.z> [--dry-run] [--no-push]')
  const pkgPath = path.join(root, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  if (pkg.name !== 'open-walnut') fail(`this is ${pkg.name}, not open-walnut`)
  let version
  try { version = nextVersion(pkg.version, bump) } catch (e) { fail(e.message) }

  const status = git('status', '--porcelain')
  if (status) fail(`the tree is not clean:\n${status}\nCommit or stash first; a release is one commit on a clean main.`)
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  if (branch !== 'main') fail(`on branch ${branch}; releases are cut from main`)
  git('fetch', '--quiet', 'origin', 'main')
  const local = git('rev-parse', 'HEAD')
  const remote = git('rev-parse', 'origin/main')
  if (local !== remote) fail(`main is not at origin/main (local ${local.slice(0, 8)}, origin ${remote.slice(0, 8)}); pull or push first`)
  if (git('tag', '--list', `v${version}`)) fail(`tag v${version} already exists`)

  const changelogPath = path.join(root, 'CHANGELOG.md')
  const date = new Date().toISOString().slice(0, 10)
  let changelog
  try { changelog = rollChangelog(fs.readFileSync(changelogPath, 'utf8'), version, date) } catch (e) { fail(e.message) }

  process.stdout.write(`release: ${pkg.version} -> ${version} (${date})${dryRun ? ' [dry run]' : ''}\n`)
  if (!dryRun) fs.writeFileSync(changelogPath, changelog)
  else process.stdout.write(`  would write CHANGELOG.md with a ## [${version}] - ${date} section\n`)
  run('npm', ['version', version, '--no-git-tag-version', '--allow-same-version'])
  run('git', ['add', 'package.json', 'package-lock.json', 'CHANGELOG.md'])
  run('git', ['commit', '--quiet', '-m', `release: ${version}`])
  run('git', ['tag', '-a', `v${version}`, '-m', `Open Walnut ${version}`])
  if (noPush) {
    process.stdout.write(`release: tagged v${version}; push with: git push origin main v${version}\n`)
    return
  }
  run('git', ['push', 'origin', 'main', `v${version}`])
  if (dryRun) process.stdout.write(`release: dry run; nothing was written, committed, tagged or pushed.\n`)
  else process.stdout.write(`release: pushed v${version}; GitHub Actions publishes it to npm (see the Release workflow run).\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
