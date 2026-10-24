// The open-walnut npm package's launcher (scripts/npm-packages.mjs builds the
// package): it runs the compiled Walnut that npm installed beside it as one of
// the package's optional dependencies, @open-walnut/<target>, the way esbuild
// and the Codex CLI ship. npm installs only the one whose os, cpu and libc match
// this machine. Plain Node, no dependencies: it is all the package runs on Node.
//
// The compiled file needs no Node, so this must start on any Node that npm
// installs the package with: CommonJS, ES2017 syntax and Node 8 APIs only
// (Ubuntu 18.04's apt Node is 8, Debian 11's is 12). tests/scripts/npm-launcher-node-floor.test.ts
// parses it as ES2017, and bin/open-walnut.js refuses an older Node in ES5.
//
// The file learns how it was started from three env vars (install-kind.ts
// LAUNCHER_ENV), so `walnut update` updates this npm install and a restart runs
// this launcher again, which then finds the new platform package. When npm left
// the platform package out, lib/postinstall.js (at install) and launch() (at a
// start) fetch it themselves (lib/fetch-platform.js).
'use strict'
const childProcess = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const tty = require('tty')

const SCOPE = '@open-walnut'
const INSTALL_SH = 'curl -fsSL https://github.com/EvanZhang008/open-walnut/releases/latest/download/install.sh | sh'

/** Is this Linux on musl (Alpine)? Node's report names glibc's version on a glibc system (Node 12+). */
function isMusl() {
  if (process.platform !== 'linux') return false
  try {
    const report = process.report && typeof process.report.getReport === 'function' ? process.report.getReport() : null
    const parsed = typeof report === 'string' ? JSON.parse(report) : report
    if (parsed && parsed.header) return !parsed.header.glibcVersionRuntime
  } catch (err) { /* fall back to the loader's name */ }
  try {
    return fs.readdirSync('/lib').some((name) => name.indexOf('ld-musl-') === 0)
  } catch (err) {
    return false
  }
}

/** The platform packages to look for, best first; empty where no build exists. */
function candidateTargets(platform, arch, musl) {
  if (platform === undefined) platform = process.platform
  if (arch === undefined) arch = process.arch
  if ((platform !== 'darwin' && platform !== 'linux') || (arch !== 'arm64' && arch !== 'x64')) return []
  const base = `${platform}-${arch}`
  if (platform === 'darwin') return [base]
  if (musl === undefined) musl = isMusl()
  // An npm that ignores `libc` installs both; the other one still runs here when it is all there is.
  return musl ? [`${base}-musl`, base] : [base, `${base}-musl`]
}

/**
 * Has this musl system the C++ runtime the musl build links (Alpine's libstdc++
 * and libgcc packages), where musl's loader looks?
 */
function hasMuslCxxRuntime(exists) {
  if (exists === undefined) exists = fs.existsSync
  const dirs = ['/lib', '/usr/lib', '/usr/local/lib']
  return ['libstdc++.so.6', 'libgcc_s.so.1'].every((name) => dirs.some((dir) => exists(path.join(dir, name))))
}

/** The installed platform package's file, looked up from `fromDir` the way require does, or null. */
function findFile(targets, fromDir) {
  if (fromDir === undefined) fromDir = __dirname
  for (const target of targets) {
    try {
      const file = path.join(path.dirname(require.resolve(`${SCOPE}/${target}/package.json`, { paths: [fromDir] })), 'walnut')
      if (fs.existsSync(file)) return { target, file }
    } catch (err) { /* not installed */ }
  }
  return null
}

/** The npm prefix of the self-contained Node archive this package root lives in (its marker beside it), or null. */
function archivePrefixOf(packageRoot, exists) {
  if (exists === undefined) exists = fs.existsSync
  const modules = path.dirname(packageRoot)
  const lib = path.dirname(modules)
  if (path.basename(modules) !== 'node_modules' || path.basename(lib) !== 'lib') return null
  const prefix = path.dirname(lib)
  return exists(path.join(prefix, 'open-walnut-runtime.json')) ? prefix : null
}

/** The command that installs this package again, in the words of the install it is. */
function reinstallCommand(packageRoot, version, exists) {
  // The archive's npm is its own and is not on PATH; install.sh replaces it with the compiled file.
  if (archivePrefixOf(packageRoot, exists)) return INSTALL_SH
  return `npm install -g open-walnut@${version}`
}

function ownVersion(packageRoot) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version
    return typeof v === 'string' && v ? v : 'latest'
  } catch (err) {
    return 'latest'
  }
}

/**
 * Run the file with this process's arguments and become its exit: code, or the
 * same signal. `entry` is the file Node started (bin/open-walnut.js or
 * dist/cli.js). A missing file is fetched first (lib/fetch-platform.js): npm can
 * finish an install without it, and an update from a Node release restarts
 * into this launcher without checking.
 */
function launch(entry) {
  const packageRoot = path.dirname(path.dirname(path.resolve(entry)))
  const targets = candidateTargets()
  if (targets.length === 0) {
    process.stderr.write(`open-walnut: Walnut runs on macOS and Linux (arm64 and x64); there is no build for ${process.platform}-${process.arch}.\n`)
    process.exit(1)
  }
  const found = findFile(targets, path.dirname(path.resolve(entry)))
  if (found) return run(found, packageRoot)
  const version = ownVersion(packageRoot)
  process.stderr.write(`open-walnut: the Walnut for ${targets[0]} was not installed with the package (npm leaves out an optional dependency it could not get); fetching ${SCOPE}/${targets[0]}@${version}.\n`)
  const log = (l) => process.stderr.write(`open-walnut: ${l}\n`)
  Promise.resolve()
    .then(() => require('./fetch-platform.js').fetchPlatformPackage({ packageRoot, target: targets[0], version, log }))
    .then((file) => run({ target: targets[0], file }, packageRoot), (err) => {
      process.stderr.write(
        `open-walnut: could not fetch it either: ${err instanceof Error ? err.message : String(err)}.\n`
        + `Install it again with: ${reinstallCommand(packageRoot, version)}\n`,
      )
      process.exit(1)
    })
}

/**
 * Where the file starts: this process's directory, or, when that was deleted
 * under it, the same path made again (PWD), else the package root, else home.
 * npm replaces the package directory on an update, and a 0.6.x Mac app runs its
 * server in that directory: the restart into the update then had a deleted
 * directory, which bun refuses to start in.
 */
function startDir(packageRoot, cwd, exists) {
  if (cwd === undefined) cwd = () => process.cwd()
  if (exists === undefined) exists = (p) => { try { return fs.statSync(p).isDirectory() } catch (err) { return false } }
  try { return cwd() } catch (err) { /* deleted under this process */ }
  for (const dir of [process.env.PWD, packageRoot]) if (dir && exists(dir)) return dir
  return os.homedir()
}

function run(found, packageRoot) {
  const env = Object.assign({}, process.env, {
    OPEN_WALNUT_PACKAGE_ROOT: packageRoot,
    OPEN_WALNUT_LAUNCHED_FILE: found.file,
    OPEN_WALNUT_RELAUNCH: JSON.stringify([process.execPath, path.join(packageRoot, 'bin', 'open-walnut.js')]),
  })
  const start = (retried) => {
    const child = childProcess.spawn(found.file, process.argv.slice(2), { stdio: 'inherit', env, cwd: startDir(packageRoot) })
    const forward = {}
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
      // Ctrl-C in a terminal reaches the whole process group, the file included:
      // passing it on as well would be a second Ctrl-C. Stay alive and let it decide.
      // fd 0 itself: process.stdin is a stream Node makes lazily, and making one here would hold it open.
      const fromTerminal = (signal === 'SIGINT' || signal === 'SIGQUIT') && tty.isatty(0)
      forward[signal] = () => { if (!fromTerminal && child.exitCode === null && child.signalCode === null) child.kill(signal) }
      process.on(signal, forward[signal])
    }
    const detach = () => { for (const signal of Object.keys(forward)) process.removeListener(signal, forward[signal]) }
    child.on('error', (err) => {
      detach()
      // A package manager that dropped the mode bit: give it back once.
      if (err.code === 'EACCES' && !retried) {
        try { fs.chmodSync(found.file, 0o755); return start(true) } catch (e) { /* report below */ }
      }
      process.stderr.write(`open-walnut: could not start ${found.file}: ${err.message}\n`)
      process.exit(1)
    })
    child.on('exit', (code, signal) => {
      detach()
      // musl's loader exits 127 when a library the file links is missing.
      if (code === 127 && /-musl$/.test(found.target) && !hasMuslCxxRuntime()) {
        process.stderr.write("open-walnut: Walnut's musl build needs the C++ runtime, which this system lacks. Install it (Alpine: apk add libstdc++ libgcc).\n")
      }
      if (!signal) process.exit(code === null ? 1 : code)
      // The same signal ends this process too; one Node ignores (SIGPIPE) leaves the shell's code for it.
      process.kill(process.pid, signal)
      process.exit(128 + (os.constants.signals[signal] || 0))
    })
  }
  start(false)
}

module.exports = { SCOPE, INSTALL_SH, isMusl, candidateTargets, hasMuslCxxRuntime, findFile, archivePrefixOf, reinstallCommand, ownVersion, startDir, launch }
