/**
 * How this Walnut was installed, which decides whether an update check makes
 * sense and what command performs the update.
 *
 *   - `source`: a git checkout run in place (contributors, `bun run dev:prod`).
 *     The developer manages this tree; a registry comparison would only nag.
 *   - `npm`: a package manager's install (`npm i -g open-walnut`, pnpm, bun,
 *     yarn). The command is the manager that put it there, read off the path.
 *     The self-contained archive (scripts/runtime-bundle/build.mjs, what
 *     install.sh puts in place) is one too: an npm prefix with its own Node,
 *     marked by RUNTIME_MARKER, updated by that Node's npm into that prefix.
 *     The npm package is a launcher (scripts/npm-packages.mjs) that runs the
 *     compiled file of a platform package; the file knows it was started that
 *     way from the launcher's env (LAUNCHER_ENV), checked against its own path.
 *   - `binary`: the compiled file in the layout install.sh makes
 *     (`<root>/versions/<version>/walnut`, `<root>/bin/walnut` linking the one in
 *     use, BINARY_MARKER in `<root>`). It updates itself (binary-install.ts).
 *   - `other`: a package root without a checkout or a node_modules parent (an
 *     unpacked tarball, a cloud bundle), or a compiled file outside any layout
 *     Walnut knows. Checked, but there is no one command Walnut runs; a file in a
 *     Homebrew keg names `brew upgrade`, and so does a keg's Node archive that
 *     updated itself onto the npm launcher before the formula installed the file.
 *   - `replica`: the cloud companion. It deploys through its own scripts, and
 *     the primary console is where the user acts.
 */

import fs from 'node:fs'
import path from 'node:path'
import { CLOUD_MODE, WALNUT_INSTALL_DIR, WALNUT_PACKAGE_ROOT } from '../../constants.js'
import { singleFile } from '../../lib/single-file.js'

export type InstallKind = 'source' | 'npm' | 'binary' | 'other' | 'replica'
export type PackageManager = 'npm' | 'pnpm' | 'bun' | 'yarn'

export const PACKAGE_NAME = 'open-walnut'
export const PACKAGE_PAGE_URL = 'https://www.npmjs.com/package/open-walnut'
/** The file the self-contained archive leaves in its npm prefix (scripts/runtime-bundle/build.mjs). */
export const RUNTIME_MARKER = 'open-walnut-runtime.json'
/** The file install.sh leaves in the root of the versions layout, naming the file's target. */
export const BINARY_MARKER = 'open-walnut-install.json'
/** What the npm launcher (scripts/npm-packages.mjs) tells the file it starts. */
export const LAUNCHER_ENV = {
  /** The launcher package's root: `<prefix>/lib/node_modules/open-walnut`. */
  packageRoot: 'OPEN_WALNUT_PACKAGE_ROOT',
  /** The file the launcher started; the env counts only in that file. */
  file: 'OPEN_WALNUT_LAUNCHED_FILE',
  /** JSON argv that runs the launcher again (a restart after an npm update). */
  relaunch: 'OPEN_WALNUT_RELAUNCH',
} as const
export const HOMEBREW_UPDATE_COMMAND = 'brew upgrade open-walnut'

/** The versions layout of a `binary` install. */
export interface BinaryInstall {
  /** `~/.local/share/open-walnut` by default. */
  root: string
  /** The platform package it updates from (`darwin-arm64`, `linux-x64-musl`, ...). */
  target: string
  /** The version directory the running file sits in. */
  version: string
}

export interface InstallInfo {
  kind: InstallKind
  /** The source checkout for `source`; null otherwise. */
  sourceDir: string | null
  /** Where the running package lives, whatever the kind. */
  packageRoot: string | null
  manager: PackageManager | null
  /** The one command that updates this install, or null when there is none. */
  updateCommand: string | null
  /**
   * The self-contained archive's npm prefix, which holds its own Node: the update
   * runs that Node's npm into this prefix, never whatever `npm` is on PATH (a
   * machine with this install may have no Node at all). Null for every other install.
   */
  runtimePrefix?: string | null
  /** The versions layout of a `binary` install; null for every other install. */
  binary?: BinaryInstall | null
  /**
   * The command that starts this install again as its newest version (a restart
   * after an update), when that is not this process's own executable: the
   * launcher for an npm install of the file, the `bin/walnut` link for a binary one.
   */
  relaunch?: string[] | null
}

export interface DetectInstallInputs {
  cloud: boolean
  installDir: string | null
  packageRoot: string | null
  /** Does this path exist? (Injected by tests; the marker check is one stat at startup.) */
  exists?: (p: string) => boolean
  /**
   * The running executable and the env, for the compiled file's own installs
   * (the versions layout, the npm launcher, a Homebrew keg). Absent: those are
   * not checked. The bare call passes this process's own.
   */
  execPath?: string
  env?: Record<string, string | undefined>
  realpath?: (p: string) => string
  readFile?: (p: string) => string
  /** Is this process the compiled file (runsCompiled)? Its own package root then never counts. */
  compiled?: boolean
}

/**
 * The npm prefix a package root was installed into globally, when the path has
 * that shape (`<prefix>/lib/node_modules/open-walnut`); null otherwise.
 */
export function globalPrefixOf(packageRoot: string): string | null {
  const modules = path.dirname(packageRoot)
  const lib = path.dirname(modules)
  if (path.basename(modules) !== 'node_modules' || path.basename(lib) !== 'lib') return null
  return path.dirname(lib)
}

/** The self-contained archive's prefix this package root lives in, or null. */
export function runtimePrefixOf(packageRoot: string, exists: (p: string) => boolean = fs.existsSync): string | null {
  const prefix = globalPrefixOf(packageRoot)
  return prefix && exists(path.join(prefix, RUNTIME_MARKER)) ? prefix : null
}

function installArgv(manager: PackageManager, spec: string): { file: string; args: string[] } {
  switch (manager) {
    case 'pnpm': return { file: 'pnpm', args: ['add', '-g', spec] }
    case 'bun': return { file: 'bun', args: ['add', '-g', spec] }
    case 'yarn': return { file: 'yarn', args: ['global', 'add', spec] }
    default: return { file: 'npm', args: ['install', '-g', spec] }
  }
}

/**
 * The manager's global install of one spec (`@latest`, `@nightly`, `@0.6.0`), as argv: no shell.
 * What it installs is the launcher and this machine's platform package, neither of
 * which has an install script, so no manager needs one allowed.
 */
export function managerArgv(manager: PackageManager, spec: string, runtimePrefix: string | null = null): { file: string; args: string[] } {
  if (runtimePrefix) {
    // The archive's own Node runs its own npm, into its own prefix.
    const npmCli = path.join(runtimePrefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    return { file: path.join(runtimePrefix, 'bin', 'node'), args: [npmCli, 'install', '-g', '--prefix', runtimePrefix, spec] }
  }
  return installArgv(manager, spec)
}

/** The command a person types: the same install, through the manager that put Walnut there. */
export function managerCommand(manager: PackageManager, tag: 'latest' | 'nightly' = 'latest'): string {
  const { file, args } = installArgv(manager, `${PACKAGE_NAME}@${tag}`)
  return [file, ...args].join(' ')
}

/** The manager a global install path belongs to; null when the path has no node_modules parent. */
export function managerFromPath(packageRoot: string): PackageManager | null {
  const p = packageRoot.replace(/\\/g, '/')
  if (!/\/node_modules\//.test(p + '/')) return null
  if (/\/\.bun\/install\/global\//.test(p)) return 'bun'
  if (/\/pnpm\/global\//.test(p) || /\/\.pnpm-global\//.test(p)) return 'pnpm'
  if (/\/\.yarn\/global\//.test(p) || /\/yarn\/global\//.test(p)) return 'yarn'
  return 'npm'
}

const safeRealpath = (realpath: (p: string) => string, p: string): string | null => {
  try { return realpath(p) } catch { return null }
}

/**
 * The npm launcher's package root, when this process is the file the launcher
 * started. The env is inherited by every child (the daemon, sessions, their
 * `walnut` calls), so it counts only where the file it names is this executable.
 */
export function launcherPackageRoot(execPath: string, env: Record<string, string | undefined>, realpath: (p: string) => string, readFile: (p: string) => string): { packageRoot: string; relaunch: string[] | null } | null {
  const root = env[LAUNCHER_ENV.packageRoot]
  const file = env[LAUNCHER_ENV.file]
  if (!root || !file) return null
  const self = safeRealpath(realpath, execPath)
  if (!self || safeRealpath(realpath, file) !== self) return null
  try {
    if ((JSON.parse(readFile(path.join(root, 'package.json'))) as { name?: string }).name !== PACKAGE_NAME) return null
  } catch {
    return null
  }
  let relaunch: string[] | null = null
  try {
    const parsed = JSON.parse(env[LAUNCHER_ENV.relaunch] ?? 'null') as unknown
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((x) => typeof x === 'string' && x)) relaunch = parsed
  } catch { /* no relaunch: the restart runs this file again */ }
  return { packageRoot: root, relaunch }
}

/**
 * The versions layout this executable sits in (`<root>/versions/<version>/walnut`,
 * with install.sh's marker in `<root>`), or null. The target comes from the
 * marker: install.sh chose it (musl or glibc), and an update keeps it.
 */
export function binaryInstallOf(execPath: string, realpath: (p: string) => string, readFile: (p: string) => string): BinaryInstall | null {
  const self = safeRealpath(realpath, execPath)
  if (!self || path.basename(self) !== 'walnut') return null
  const versionDir = path.dirname(self)
  const versions = path.dirname(versionDir)
  if (path.basename(versions) !== 'versions') return null
  const root = path.dirname(versions)
  let marker: { layout?: unknown; target?: unknown }
  try {
    marker = JSON.parse(readFile(path.join(root, BINARY_MARKER))) as typeof marker
  } catch {
    return null
  }
  if (marker.layout !== 'versions' || typeof marker.target !== 'string' || !/^(darwin|linux)-(arm64|x64)(-musl)?$/.test(marker.target)) return null
  return { root, target: marker.target, version: path.basename(versionDir) }
}

/**
 * Is this process the compiled file? Its entry recorded itself (singleFile), and
 * its argv[1] is that entry inside the file (`/$bunfs/root/walnut`), never a
 * script on disk.
 */
export function runsCompiled(argv: readonly string[] = process.argv): boolean {
  const entry = argv[1] ?? ''
  return entry.startsWith('/$bunfs/') || entry.includes('~BUN')
}

/** The stable path of a binary install's `walnut`: the link install.sh and the updater swap. */
export const binaryLinkOf = (root: string): string => path.join(root, 'bin', 'walnut')

/** A file Homebrew installed (`<cellar>/open-walnut/<version>/...`): brew owns its updates. */
export function inHomebrewKeg(file: string): boolean {
  return /\/Cellar\/open-walnut\/[^/]+\//.test(file.replace(/\\/g, '/'))
}

export function detectInstall(inputs: DetectInstallInputs = {
  cloud: CLOUD_MODE, installDir: WALNUT_INSTALL_DIR, packageRoot: WALNUT_PACKAGE_ROOT,
  execPath: process.execPath, env: process.env, compiled: singleFile() !== null || runsCompiled(),
}, channel: 'stable' | 'nightly' = 'stable'): InstallInfo {
  const base = { sourceDir: null, packageRoot: inputs.packageRoot, manager: null, updateCommand: null, runtimePrefix: null, binary: null, relaunch: null }
  // A replica's status can be read over the internet (with a device token); its paths stay home.
  if (inputs.cloud) return { ...base, kind: 'replica', packageRoot: null }
  const realpath = inputs.realpath ?? fs.realpathSync
  const readFile = inputs.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8'))
  let packageRoot = inputs.packageRoot
  let relaunch: string[] | null = null
  let viaLauncher = false
  if (inputs.execPath) {
    // The compiled file: these say how it was installed, and a package root the
    // file reports (its unpacked runtime) never does.
    const launched = launcherPackageRoot(inputs.execPath, inputs.env ?? {}, realpath, readFile)
    // A keg's Node archive that updated itself onto the launcher (0.6.17's updater
    // knew no keg): brew owns the keg, and `brew upgrade` replaces it with the file.
    if (launched && inHomebrewKeg(safeRealpath(realpath, launched.packageRoot) ?? launched.packageRoot)) {
      return { ...base, kind: 'other', packageRoot: null, updateCommand: HOMEBREW_UPDATE_COMMAND, relaunch: launched.relaunch }
    }
    if (launched) {
      viaLauncher = true
      packageRoot = launched.packageRoot
      relaunch = launched.relaunch
    } else {
      const binary = binaryInstallOf(inputs.execPath, realpath, readFile)
      if (binary) {
        return { ...base, kind: 'binary', packageRoot: null, binary, relaunch: [binaryLinkOf(binary.root)], updateCommand: 'walnut update' }
      }
      const self = safeRealpath(realpath, inputs.execPath) ?? inputs.execPath
      if (inHomebrewKeg(self)) return { ...base, kind: 'other', packageRoot: null, updateCommand: HOMEBREW_UPDATE_COMMAND }
      // A compiled file in none of those places: its unpacked runtime is no npm install.
      if (inputs.compiled) packageRoot = null
    }
  }
  if (inputs.installDir && !viaLauncher) return { ...base, kind: 'source', sourceDir: inputs.installDir }
  const manager = packageRoot ? managerFromPath(packageRoot) : null
  const runtimePrefix = manager === 'npm' && packageRoot ? runtimePrefixOf(packageRoot, inputs.exists) : null
  const npmBase = { ...base, packageRoot, relaunch }
  // The archive updates itself with `walnut update`: its npm is not on PATH.
  if (runtimePrefix) return { ...npmBase, kind: 'npm', manager, runtimePrefix, updateCommand: 'walnut update' }
  if (manager) return { ...npmBase, kind: 'npm', manager, updateCommand: managerCommand(manager, channel === 'nightly' ? 'nightly' : 'latest') }
  return { ...npmBase, kind: 'other' }
}
