/**
 * How this Walnut was installed, which decides whether an update check makes
 * sense and what command performs the update.
 *
 *   - `source`: a git checkout run in place (contributors, `npm run dev:prod`).
 *     The developer manages this tree; a registry comparison would only nag.
 *   - `npm`: a package manager's install (`npm i -g open-walnut`, pnpm, bun,
 *     yarn). The command is the manager that put it there, read off the path.
 *     The self-contained archive (scripts/runtime-bundle/build.mjs, what
 *     install.sh puts in place) is one too: an npm prefix with its own Node,
 *     marked by RUNTIME_MARKER, updated by that Node's npm into that prefix.
 *   - `other`: a package root without a checkout or a node_modules parent (an
 *     unpacked tarball, a cloud bundle). Checked, but there is no one command.
 *   - `replica`: the cloud companion. It deploys through its own scripts, and
 *     the primary console is where the user acts.
 */

import fs from 'node:fs'
import path from 'node:path'
import { CLOUD_MODE, WALNUT_INSTALL_DIR, WALNUT_PACKAGE_ROOT } from '../../constants.js'

export type InstallKind = 'source' | 'npm' | 'other' | 'replica'
export type PackageManager = 'npm' | 'pnpm' | 'bun' | 'yarn'

export const PACKAGE_NAME = 'open-walnut'
export const PACKAGE_PAGE_URL = 'https://www.npmjs.com/package/open-walnut'
/** The file the self-contained archive leaves in its npm prefix (scripts/runtime-bundle/build.mjs). */
export const RUNTIME_MARKER = 'open-walnut-runtime.json'

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
}

export interface DetectInstallInputs {
  cloud: boolean
  installDir: string | null
  packageRoot: string | null
  /** Does this path exist? (Injected by tests; the marker check is one stat at startup.) */
  exists?: (p: string) => boolean
}

/**
 * The packages whose install scripts a working install needs: this package's
 * own postinstall plus package.json `allowScripts` (better-sqlite3 and node-pty
 * fetch their native binaries in theirs). npm 12 runs no dependency install
 * script it was not allowed to, and a global install has no project
 * package.json to allow them in.
 */
export const INSTALL_SCRIPT_PACKAGES = [
  PACKAGE_NAME,
  '@homebridge/node-pty-prebuilt-multiarch',
  'better-sqlite3',
  'esbuild',
  'onnxruntime-node',
  'protobufjs',
  'screencapturekit-audio-capture',
  'sharp',
] as const

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
 * npm gets `--allow-scripts`: without it npm 12 installs a Walnut whose database cannot open.
 * npm 10 ignores the flag and npm 11 only warns about it.
 */
export function managerArgv(manager: PackageManager, spec: string, runtimePrefix: string | null = null): { file: string; args: string[] } {
  const allow = `--allow-scripts=${INSTALL_SCRIPT_PACKAGES.join(',')}`
  if (runtimePrefix) {
    // The archive's own Node runs its own npm, into its own prefix.
    const npmCli = path.join(runtimePrefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    return { file: path.join(runtimePrefix, 'bin', 'node'), args: [npmCli, 'install', '-g', '--prefix', runtimePrefix, spec, allow] }
  }
  const argv = installArgv(manager, spec)
  if (manager !== 'npm') return argv
  return { ...argv, args: [...argv.args, allow] }
}

/** The command a person types. Short on purpose: a start after a plain npm 12 install repairs the native modules itself. */
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

export function detectInstall(inputs: DetectInstallInputs = {
  cloud: CLOUD_MODE, installDir: WALNUT_INSTALL_DIR, packageRoot: WALNUT_PACKAGE_ROOT,
}, channel: 'stable' | 'nightly' = 'stable'): InstallInfo {
  const base = { sourceDir: null, packageRoot: inputs.packageRoot, manager: null, updateCommand: null, runtimePrefix: null }
  // A replica's status can be read over the internet (with a device token); its paths stay home.
  if (inputs.cloud) return { ...base, kind: 'replica', packageRoot: null }
  if (inputs.installDir) return { ...base, kind: 'source', sourceDir: inputs.installDir }
  const manager = inputs.packageRoot ? managerFromPath(inputs.packageRoot) : null
  const runtimePrefix = manager === 'npm' && inputs.packageRoot ? runtimePrefixOf(inputs.packageRoot, inputs.exists) : null
  // The archive updates itself with `walnut update`: its npm is not on PATH.
  if (runtimePrefix) return { ...base, kind: 'npm', manager, runtimePrefix, updateCommand: 'walnut update' }
  if (manager) return { ...base, kind: 'npm', manager, updateCommand: managerCommand(manager, channel === 'nightly' ? 'nightly' : 'latest') }
  return { ...base, kind: 'other' }
}
