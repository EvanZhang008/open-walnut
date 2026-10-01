#!/usr/bin/env node
/**
 * Cut a stable release: `npm run release -- patch|minor|major|<x.y.z>`.
 *
 * One command, one commit, one tag; the publish itself happens in GitHub
 * Actions (.github/workflows/release.yml) when the tag arrives, through npm
 * trusted publishing, so no machine here holds an npm token and every release
 * is built from the same clean checkout with provenance.
 *
 * What it checks, and refuses to start when any of it is wrong:
 *   1. the branch is main and main is at origin/main (fetched now): a release is
 *      a point on main that others can check out, never a local pile;
 *   2. CI passed on that commit (scripts/ci-gate.mjs; the workflow checks again):
 *      every npm install updates itself on restart, so a release is cut from green;
 *   3. package.json, package-lock.json and CHANGELOG.md have no uncommitted edits.
 *      Other uncommitted work in the tree is fine and stays exactly as it is: the
 *      release commit is built from HEAD plus those three files only, and CI
 *      publishes from a clean checkout of the tag, never from this tree;
 *   4. CHANGELOG.md has an `## [Unreleased]` section with content: that becomes
 *      `## [x.y.z] - YYYY-MM-DD`, and a fresh empty Unreleased goes above it.
 *
 * Then: commit `release: x.y.z` (HEAD's tree + the three files, through a private
 * index, so whatever else is staged stays staged and out of the commit), tag
 * `vx.y.z` (annotated), push both atomically.
 *
 * `--dry-run` prints the plan and changes nothing. `--no-push` stops after the
 * tag (push by hand). The version argument is validated as a plain release
 * (no prerelease): nightlies are cut by CI, not here.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RELEASE_FILES, commitVerdict } from './ci-gate.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const noPush = args.includes('--no-push')
const bump = args.find((a) => !a.startsWith('--'))

function fail(message) {
  process.stderr.write(`release: ${message}\n`)
  process.exit(1)
}

function git(gitArgs, opts = {}) {
  return execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim()
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

/**
 * Set the version in package.json or package-lock.json text (the lock's root
 * package too). Only for files in npm's own layout (2-space JSON + newline), so
 * the diff is the version lines and nothing else.
 */
export function setManifestVersion(text, version) {
  const data = JSON.parse(text)
  if (`${JSON.stringify(data, null, 2)}\n` !== text) throw new Error('not in npm\'s JSON layout (run npm install to normalize it)')
  data.version = version
  if (data.packages?.['']) data.packages[''].version = version
  return `${JSON.stringify(data, null, 2)}\n`
}

/**
 * Commit `files` (path -> new content) on top of HEAD without touching the shared
 * index or the worktree, and move main only if it is still where we started.
 */
function commitFiles(files, message, expectedHead) {
  const indexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-release-'))
  const env = { ...process.env, GIT_INDEX_FILE: path.join(indexDir, 'index') }
  try {
    git(['read-tree', expectedHead], { env })
    for (const [file, content] of Object.entries(files)) {
      const blob = git(['hash-object', '-w', '--stdin'], { input: content })
      const mode = git(['ls-files', '-s', '--', file], { env }).split(/\s+/)[0] || '100644'
      git(['update-index', '--cacheinfo', `${mode},${blob},${file}`], { env })
    }
    const tree = git(['write-tree'], { env })
    const commit = git(['commit-tree', tree, '-p', expectedHead, '-m', message])
    try {
      git(['update-ref', '-m', message, 'refs/heads/main', commit, expectedHead])
    } catch {
      throw new Error('main moved while the release was being made (another commit landed); run it again')
    }
    return commit
  } finally {
    fs.rmSync(indexDir, { recursive: true, force: true })
  }
}

function checkCi(sha) {
  let result
  try {
    result = commitVerdict(sha)
  } catch {
    process.stdout.write('release: could not ask GitHub about CI (is `gh` installed and signed in?); the Release workflow checks before it publishes\n')
    return
  }
  const where = result.url ? ` (${result.url})` : ''
  switch (result.verdict) {
    case 'green': return
    case 'pending': fail(`CI is still running on ${sha.slice(0, 8)}${where}; release once it passes`)
    case 'none': fail(`no CI run found for ${sha.slice(0, 8)}; push main and wait for CI to pass`)
    default: fail(`CI did not pass on ${sha.slice(0, 8)}${where}. Every npm install updates itself on restart, so releases are cut from a green commit`)
  }
}

function main() {
  if (!bump) fail('usage: npm run release -- patch|minor|major|<x.y.z> [--dry-run] [--no-push]')
  const pkgPath = path.join(root, 'package.json')
  const pkgText = fs.readFileSync(pkgPath, 'utf8')
  const pkg = JSON.parse(pkgText)
  if (pkg.name !== 'open-walnut') fail(`this is ${pkg.name}, not open-walnut`)
  let version
  try { version = nextVersion(pkg.version, bump) } catch (e) { fail(e.message) }

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch !== 'main') fail(`on branch ${branch}; releases are cut from main`)
  git(['fetch', '--quiet', 'origin', 'main'])
  const head = git(['rev-parse', 'HEAD'])
  const remote = git(['rev-parse', 'origin/main'])
  if (head !== remote) fail(`main is not at origin/main (local ${head.slice(0, 8)}, origin ${remote.slice(0, 8)}); push or pull first`)
  if (git(['tag', '--list', `v${version}`]) || git(['ls-remote', '--tags', 'origin', `refs/tags/v${version}`])) fail(`tag v${version} already exists`)
  const edited = git(['status', '--porcelain', '--', ...RELEASE_FILES])
  if (edited) fail(`uncommitted edits to the release files:\n${edited}\nCommit or finish them first; other uncommitted work can stay.`)
  checkCi(head)

  const date = new Date().toISOString().slice(0, 10)
  const files = {}
  try {
    files['CHANGELOG.md'] = rollChangelog(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), version, date)
    files['package.json'] = setManifestVersion(pkgText, version)
    files['package-lock.json'] = setManifestVersion(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'), version)
  } catch (e) { fail(e.message) }

  process.stdout.write(`release: ${pkg.version} -> ${version} (${date})${dryRun ? ' [dry run]' : ''}\n`)
  if (dryRun) {
    process.stdout.write(`  would commit "release: ${version}" on ${head.slice(0, 8)}: ${RELEASE_FILES.join(', ')}\n`)
    process.stdout.write(`  would tag v${version}${noPush ? '' : ` and push main + v${version}`}\n`)
    process.stdout.write('release: dry run; nothing was written, committed, tagged or pushed.\n')
    return
  }

  let commit
  try { commit = commitFiles(files, `release: ${version}`, head) } catch (e) { fail(e.message) }
  // main now points at the release commit; bring the three files (and only them)
  // in the worktree and the shared index up to it.
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(root, file), content)
  git(['reset', '--quiet', '--', ...RELEASE_FILES])
  git(['tag', '-a', `v${version}`, '-m', `Open Walnut ${version}`, commit])
  process.stdout.write(`release: committed ${commit.slice(0, 8)} "release: ${version}" and tagged v${version}\n`)
  if (noPush) {
    process.stdout.write(`release: push with: git push --atomic origin main v${version}\n`)
    return
  }
  try {
    execFileSync('git', ['push', '--atomic', 'origin', 'main', `v${version}`], { cwd: root, stdio: 'inherit' })
  } catch {
    fail(`the push failed; the release commit and tag v${version} are local. Push them with: git push --atomic origin main v${version}`)
  }
  process.stdout.write(`release: pushed v${version}; GitHub Actions publishes it to npm (see the Release workflow run).\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
