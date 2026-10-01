/**
 * Build identity: writes dist/build-info.json so a running Walnut can say which
 * source it was built from. package.json only moves on an npm release, so a
 * checkout of today's main and the last npm install both report the same
 * version; the commit, branch and build time tell them apart.
 *
 *   { version, commit, branch, builtAt, dirty }
 *
 * commit/branch are null outside a git checkout (the npm tarball, a source
 * archive) and branch is null on a detached HEAD (CI, the cloud deploy). dirty
 * counts tracked changes only, like `git describe --dirty`: untracked scratch
 * files do not change what was built from the tree. The nightly release stamps
 * its version into package.json and package-lock.json before it builds and sets
 * WALNUT_VERSION_STAMPED=1, so those two files do not count either.
 *
 * tsup.config.ts calls writeBuildInfo() from onSuccess, after a build succeeds,
 * so `npm run build`, `web:build`, `prepublishOnly` and a bare `npx tsup` all
 * refresh it and a failed build keeps the old stamp. Missing git never fails a
 * build; it only yields nulls. Run directly to (re)write it:
 *   node scripts/build-info.mjs
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const BUILD_INFO_FILE = 'build-info.json'

// Mirror of GIT_REPO_REDIRECT_VARS in src/lib/git-env.ts, pinned by a test: this
// script runs before any bundle exists, so it cannot import the TS module. An
// inherited GIT_DIR (git exports one while running hooks) outranks cwd and would
// report some other repository's commit.
export const GIT_REPO_REDIRECT_VARS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX',
]

function gitEnv() {
  const env = { ...process.env }
  for (const name of GIT_REPO_REDIRECT_VARS) delete env[name]
  return env
}

/** One git query in `root`; null when git is absent, errors, or times out. */
function git(root, args) {
  try {
    // --no-optional-locks: `status` must not take index.lock, or a build racing
    // a commit in the same worktree makes that commit fail.
    const out = execFileSync('git', ['--no-optional-locks', ...args], {
      cwd: root,
      env: gitEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
    return out.trim()
  } catch {
    return null
  }
}

function samePath(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b)
  } catch {
    return path.resolve(a) === path.resolve(b)
  }
}

/**
 * Collect build identity for the package rooted at `root`. Only a checkout
 * whose top level IS `root` counts: an unpacked tarball sitting inside some
 * other repository must not report that repository's commit.
 */
export function collectBuildInfo(root, now = new Date(), env = process.env) {
  let version = '0.0.0'
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    if (typeof pkg.version === 'string' && pkg.version) version = pkg.version
  } catch { /* keep the placeholder; the reader falls back to its own version */ }

  let commit = null
  let branch = null
  let dirty = false
  const top = git(root, ['rev-parse', '--show-toplevel'])
  if (top && samePath(top, root)) {
    commit = git(root, ['rev-parse', '--short', 'HEAD']) || null
    const ref = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
    branch = ref && ref !== 'HEAD' ? ref : null
    const stamped = env.WALNUT_VERSION_STAMPED === '1' ? [':!package.json', ':!package-lock.json'] : []
    if (commit) dirty = (git(root, ['status', '--porcelain', '--untracked-files=no', '--', '.', ...stamped]) ?? '') !== ''
  }
  return { version, commit, branch, builtAt: now.toISOString(), dirty }
}

/** Write `<outDir>/build-info.json` atomically and return what was written. */
export function writeBuildInfo(root, outDir = path.join(root, 'dist')) {
  const info = collectBuildInfo(root)
  fs.mkdirSync(outDir, { recursive: true })
  const file = path.join(outDir, BUILD_INFO_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2) + '\n')
  fs.renameSync(tmp, file)
  return info
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const info = writeBuildInfo(root)
  console.log(`build-info: ${JSON.stringify(info)}`)
}
