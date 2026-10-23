// The open-walnut npm package's launcher (scripts/npm-packages.mjs builds the
// package): it runs the compiled Walnut that npm installed beside it as one of
// the package's optional dependencies, @open-walnut/<target>, the way esbuild
// and the Codex CLI ship. npm installs only the one whose os, cpu and libc match
// this machine. Plain Node, no dependencies: it is all the package runs on Node.
//
// The file learns how it was started from three env vars (install-kind.ts
// LAUNCHER_ENV), so `walnut update` updates this npm install and a restart runs
// this launcher again, which then finds the new platform package.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import tty from 'node:tty'
import { fileURLToPath } from 'node:url'

const SCOPE = '@open-walnut'

/** Is this Linux on musl (Alpine)? Node's report names glibc's version on a glibc system. */
export function isMusl() {
  if (process.platform !== 'linux') return false
  try {
    const report = process.report?.getReport?.()
    const header = typeof report === 'string' ? JSON.parse(report).header : report?.header
    if (header) return !header.glibcVersionRuntime
  } catch { /* fall back to the loader's name */ }
  try {
    return fs.readdirSync('/lib').some((name) => name.startsWith('ld-musl-'))
  } catch {
    return false
  }
}

/** The platform packages to look for, best first; empty where no build exists. */
export function candidateTargets(platform = process.platform, arch = process.arch, musl = isMusl()) {
  if ((platform !== 'darwin' && platform !== 'linux') || (arch !== 'arm64' && arch !== 'x64')) return []
  const base = `${platform}-${arch}`
  if (platform === 'darwin') return [base]
  // An npm that ignores `libc` installs both; the other one still runs here when it is all there is.
  return musl ? [`${base}-musl`, base] : [base, `${base}-musl`]
}

/**
 * Has this musl system the C++ runtime the musl build links (Alpine's libstdc++
 * and libgcc packages), where musl's loader looks?
 */
export function hasMuslCxxRuntime(exists = fs.existsSync) {
  const dirs = ['/lib', '/usr/lib', '/usr/local/lib']
  return ['libstdc++.so.6', 'libgcc_s.so.1'].every((name) => dirs.some((dir) => exists(path.join(dir, name))))
}

/** The installed platform package's file, or null. */
export function findFile(fromUrl, targets) {
  const require = createRequire(fromUrl)
  for (const target of targets) {
    try {
      const file = path.join(path.dirname(require.resolve(`${SCOPE}/${target}/package.json`)), 'walnut')
      if (fs.existsSync(file)) return { target, file }
    } catch { /* not installed */ }
  }
  return null
}

/** Run the file with this process's arguments and become its exit: code, or the same signal. */
export function launch(entryUrl) {
  const entry = fileURLToPath(entryUrl)
  const packageRoot = path.dirname(path.dirname(entry))
  const targets = candidateTargets()
  if (targets.length === 0) {
    process.stderr.write(`open-walnut: Walnut runs on macOS and Linux (arm64 and x64); there is no build for ${process.platform}-${process.arch}.\n`)
    process.exit(1)
  }
  const found = findFile(entryUrl, targets)
  if (!found) {
    process.stderr.write(
      `open-walnut: the Walnut for ${targets[0]} is not installed here. npm installs it as the optional dependency ${SCOPE}/${targets[0]},\n`
      + 'and skipped it (optional dependencies turned off, or an npm too old to match this platform).\n'
      + 'Install it again with: npm install -g open-walnut\n',
    )
    process.exit(1)
  }
  const env = {
    ...process.env,
    OPEN_WALNUT_PACKAGE_ROOT: packageRoot,
    OPEN_WALNUT_LAUNCHED_FILE: found.file,
    OPEN_WALNUT_RELAUNCH: JSON.stringify([process.execPath, path.join(packageRoot, 'bin', 'open-walnut.js')]),
  }
  const start = (retried) => {
    const child = spawn(found.file, process.argv.slice(2), { stdio: 'inherit', env })
    const forward = {}
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
      // Ctrl-C in a terminal reaches the whole process group, the file included:
      // passing it on as well would be a second Ctrl-C. Stay alive and let it decide.
      // fd 0 itself: process.stdin is a stream Node makes lazily, and making one here would hold it open.
      const fromTerminal = (signal === 'SIGINT' || signal === 'SIGQUIT') && tty.isatty(0)
      forward[signal] = () => { if (!fromTerminal && child.exitCode === null && child.signalCode === null) child.kill(signal) }
      process.on(signal, forward[signal])
    }
    const detach = () => { for (const [signal, fn] of Object.entries(forward)) process.off(signal, fn) }
    child.on('error', (err) => {
      detach()
      // A package manager that dropped the mode bit: give it back once.
      if (err.code === 'EACCES' && !retried) {
        try { fs.chmodSync(found.file, 0o755); return start(true) } catch { /* report below */ }
      }
      process.stderr.write(`open-walnut: could not start ${found.file}: ${err.message}\n`)
      process.exit(1)
    })
    child.on('exit', (code, signal) => {
      detach()
      // musl's loader exits 127 when a library the file links is missing.
      if (code === 127 && found.target.endsWith('-musl') && !hasMuslCxxRuntime()) {
        process.stderr.write("open-walnut: Walnut's musl build needs the C++ runtime, which this system lacks. Install it (Alpine: apk add libstdc++ libgcc).\n")
      }
      if (!signal) process.exit(code ?? 1)
      // The same signal ends this process too; one Node ignores (SIGPIPE) leaves the shell's code for it.
      process.kill(process.pid, signal)
      process.exit(128 + (os.constants.signals[signal] ?? 0))
    })
  }
  start(false)
}
