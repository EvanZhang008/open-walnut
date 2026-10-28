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

/**
 * What `ldd --version` says the C library is: 'musl', 'glibc', or null when it
 * says neither (no ldd). The same reading as install.sh's libc_of.
 */
function lddLibc(run) {
  if (run === undefined) run = () => childProcess.spawnSync('ldd', ['--version'], { encoding: 'utf8', timeout: 3000 })
  try {
    const r = run()
    const out = `${(r && r.stdout) || ''}${(r && r.stderr) || ''}`
    if (/musl/i.test(out)) return 'musl'
    if (/GNU|GLIBC|glibc/.test(out)) return 'glibc'
  } catch (err) { /* no ldd */ }
  return null
}

/**
 * Is this Linux on musl (Alpine)? Node's report names glibc's version on a glibc
 * system (Node 12.17+); before that, ldd says which; only then musl's loader
 * decides, since a glibc system may carry it too (Debian's musl package).
 */
function isMusl() {
  if (process.platform !== 'linux') return false
  try {
    const report = process.report && typeof process.report.getReport === 'function' ? process.report.getReport() : null
    const parsed = typeof report === 'string' ? JSON.parse(report) : report
    if (parsed && parsed.header) return !parsed.header.glibcVersionRuntime
  } catch (err) { /* fall back to ldd */ }
  const libc = lddLibc()
  if (libc) return libc === 'musl'
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

/**
 * The installed platform package's file, looked up from `fromDir` the way
 * require does (the node_modules of `fromDir` and of each directory above it):
 * { target, file }; { target, unreadable } when a directory on the way is there
 * but this user may not read it (an install as root whose files only root may
 * read: fetching it again would only end the same way); else null.
 */
function findFile(targets, fromDir) {
  if (fromDir === undefined) fromDir = __dirname
  const dirs = []
  for (let dir = path.resolve(fromDir); ; dir = path.dirname(dir)) {
    if (path.basename(dir) !== 'node_modules') dirs.push(path.join(dir, 'node_modules'))
    if (path.dirname(dir) === dir) break
  }
  for (const target of targets) {
    for (const modules of dirs) {
      const file = path.join(modules, SCOPE, target, 'walnut')
      try {
        if (fs.statSync(file).isFile()) return { target, file }
      } catch (err) {
        if (err.code === 'EACCES' || err.code === 'EPERM') return { target, unreadable: blockedDir([modules, path.join(modules, SCOPE), path.dirname(file)]) }
      }
    }
  }
  return null
}

/** The first of `dirs` this user may not enter, else the last. */
function blockedDir(dirs) {
  for (const dir of dirs) {
    try { fs.accessSync(dir, fs.constants.R_OK | fs.constants.X_OK) } catch (err) { if (err.code === 'EACCES' || err.code === 'EPERM') return dir }
  }
  return dirs[dirs.length - 1]
}

/** What to say when the file is there but this user may not read it. */
function unreadableLine(dir) {
  return `cannot read ${dir}: it was installed for another user (as root, say). Make it readable with: sudo chmod -R a+rX ${shellQuote(dir)}`
}

const shellQuote = (s) => (/^[A-Za-z0-9_\/.,:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`)

const canWrite = (p) => { try { fs.accessSync(p, fs.constants.W_OK); return true } catch (err) { return false } }

/** Can this user replace the package: its root and the directory npm renames it in (the server's update asks the same). */
function installWritable(packageRoot) {
  return canWrite(packageRoot) && canWrite(path.dirname(packageRoot))
}

/** Can this user put the platform package in place: the deepest directory of its scope that is there. */
function fetchWritable(packageRoot) {
  let dir = path.join(packageRoot, 'node_modules', SCOPE)
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir)
  return canWrite(dir)
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

/**
 * The command that installs this package again, in the words of the install it
 * is. `io` stands in for the file system in tests: { exists, realpath, writable, sudo }.
 */
function reinstallCommand(packageRoot, version, io) {
  const o = Object.assign({
    exists: fs.existsSync,
    realpath: (p) => { try { return fs.realpathSync(p) } catch (err) { return p } },
    writable: installWritable,
    // npm running this as root for a person (sudo npm i -g): they need sudo again.
    sudo: typeof process.getuid === 'function' && process.getuid() === 0 && !!process.env.SUDO_USER,
  }, io)
  // A Homebrew keg holds the archive's layout too (its marker included): Homebrew owns it.
  if (o.realpath(packageRoot).indexOf('/Cellar/open-walnut/') !== -1) return 'brew reinstall open-walnut'
  // The archive's npm is its own and is not on PATH; install.sh replaces it with the compiled file.
  if (archivePrefixOf(packageRoot, o.exists)) return INSTALL_SH
  // npm 12 runs no install script it was not allowed to, and lib/postinstall.js is what fetches a left-out file.
  const npm = `npm install -g open-walnut@${version} --allow-scripts=open-walnut`
  return o.sudo || !o.writable(packageRoot) ? `sudo ${npm}` : npm
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
  if (found && found.unreadable) {
    process.stderr.write(`open-walnut: ${unreadableLine(found.unreadable)}\n`)
    process.exit(1)
  }
  if (found) return run(found, packageRoot)
  const version = ownVersion(packageRoot)
  const missing = `the Walnut for ${targets[0]} was not installed with the package (npm leaves out an optional dependency it could not get)`
  if (!fetchWritable(packageRoot)) {
    // Another user's install (sudo npm i -g): a download could not be put in place.
    process.stderr.write(`open-walnut: ${missing}, and this user cannot write ${packageRoot} to fetch it.\nInstall it again with: ${reinstallCommand(packageRoot, version)}\n`)
    process.exit(1)
  }
  process.stderr.write(`open-walnut: ${missing}; fetching ${SCOPE}/${targets[0]}@${version}.\n`)
  const log = (l) => process.stderr.write(`open-walnut: ${l}\n`)
  Promise.resolve()
    // An absolute path: Node 8 and 10 read the working directory for a relative one, and it may be gone.
    .then(() => require(path.join(__dirname, 'fetch-platform.js')).fetchPlatformPackage({ packageRoot, target: targets[0], version, log }))
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

/**
 * The Mac app sets OPEN_WALNUT_EXIT_ON_ORPHAN for the server it starts: when the
 * app dies without stopping it (a crash, a force quit), the server must go too,
 * or it holds the port with no app to show it. The app's child here is this
 * launcher, so it watches for that: once its parent is gone (it was handed to
 * launchd, or to a subreaper), `onOrphan` runs once. Returns the timer, or null
 * when nothing asked for it.
 */
function watchForOrphan(onOrphan, env, ppid, everyMs) {
  if (env === undefined) env = process.env
  if (ppid === undefined) ppid = () => process.ppid
  if (env.OPEN_WALNUT_EXIT_ON_ORPHAN !== '1') return null
  const parent = ppid()
  // Already launchd's (or no parent to read): nothing to outlive.
  if (!(parent > 1)) return null
  const timer = setInterval(() => {
    if (ppid() === parent) return
    clearInterval(timer)
    onOrphan()
  }, everyMs || 1000)
  if (timer.unref) timer.unref()
  return timer
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
    // The app that started this died without stopping the file: stop it the way the app would have.
    const orphanWatch = watchForOrphan(() => forward.SIGTERM())
    const detach = () => {
      for (const signal of Object.keys(forward)) process.removeListener(signal, forward[signal])
      if (orphanWatch) clearInterval(orphanWatch)
    }
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

module.exports = { SCOPE, INSTALL_SH, isMusl, lddLibc, candidateTargets, hasMuslCxxRuntime, findFile, unreadableLine, installWritable, fetchWritable, archivePrefixOf, reinstallCommand, ownVersion, startDir, watchForOrphan, launch }
