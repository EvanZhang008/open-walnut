/**
 * How this Walnut was installed, which decides whether an update check makes
 * sense and what command performs the update.
 *
 *   - `source`: a git checkout run in place (contributors, `npm run dev:prod`).
 *     The developer manages this tree; a registry comparison would only nag.
 *   - `npm`: a package manager's install (`npm i -g open-walnut`, pnpm, bun,
 *     yarn). The command is the manager that put it there, read off the path.
 *   - `other`: a package root without a checkout or a node_modules parent (an
 *     unpacked tarball, a cloud bundle). Checked, but there is no one command.
 *   - `replica`: the cloud companion. It deploys through its own scripts, and
 *     the primary console is where the user acts.
 */

import { CLOUD_MODE, WALNUT_INSTALL_DIR, WALNUT_PACKAGE_ROOT } from '../../constants.js'

export type InstallKind = 'source' | 'npm' | 'other' | 'replica'
export type PackageManager = 'npm' | 'pnpm' | 'bun' | 'yarn'

export const PACKAGE_NAME = 'open-walnut'
export const PACKAGE_PAGE_URL = 'https://www.npmjs.com/package/open-walnut'

export interface InstallInfo {
  kind: InstallKind
  /** The source checkout for `source`; null otherwise. */
  sourceDir: string | null
  /** Where the running package lives, whatever the kind. */
  packageRoot: string | null
  manager: PackageManager | null
  /** The one command that updates this install, or null when there is none. */
  updateCommand: string | null
}

export interface DetectInstallInputs {
  cloud: boolean
  installDir: string | null
  packageRoot: string | null
}

/** The manager's global install of one spec (`@latest`, `@nightly`, `@0.6.0`), as argv: no shell. */
export function managerArgv(manager: PackageManager, spec: string): { file: string; args: string[] } {
  switch (manager) {
    case 'pnpm': return { file: 'pnpm', args: ['add', '-g', spec] }
    case 'bun': return { file: 'bun', args: ['add', '-g', spec] }
    case 'yarn': return { file: 'yarn', args: ['global', 'add', spec] }
    default: return { file: 'npm', args: ['install', '-g', spec] }
  }
}

export function managerCommand(manager: PackageManager, tag: 'latest' | 'nightly' = 'latest'): string {
  const { file, args } = managerArgv(manager, `${PACKAGE_NAME}@${tag}`)
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
  const base = { sourceDir: null, packageRoot: inputs.packageRoot, manager: null, updateCommand: null }
  // A replica's status can be read over the internet (with a device token); its paths stay home.
  if (inputs.cloud) return { ...base, kind: 'replica', packageRoot: null }
  if (inputs.installDir) return { ...base, kind: 'source', sourceDir: inputs.installDir }
  const manager = inputs.packageRoot ? managerFromPath(inputs.packageRoot) : null
  if (manager) return { ...base, kind: 'npm', manager, updateCommand: managerCommand(manager, channel === 'nightly' ? 'nightly' : 'latest') }
  return { ...base, kind: 'other' }
}
