/**
 * Which install is this, and which command updates it? Pure path reasoning:
 * the source checkout wins over everything but the replica, and a global
 * install's manager is read off where the package landed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-install-kind'))

import { detectInstall, INSTALL_SCRIPT_PACKAGES, managerArgv, managerCommand, managerFromPath } from '../../../src/core/self-update/install-kind.js'

describe('managerFromPath', () => {
  it('names the manager a global install path belongs to', () => {
    expect(managerFromPath('/usr/local/lib/node_modules/open-walnut')).toBe('npm')
    expect(managerFromPath('/Users/alice/.nvm/versions/node/v24.1.0/lib/node_modules/open-walnut')).toBe('npm')
    expect(managerFromPath('/Users/alice/.bun/install/global/node_modules/open-walnut')).toBe('bun')
    expect(managerFromPath('/Users/alice/Library/pnpm/global/5/node_modules/open-walnut')).toBe('pnpm')
    expect(managerFromPath('/Users/alice/.pnpm-global/5/node_modules/open-walnut')).toBe('pnpm')
    expect(managerFromPath('/Users/alice/.config/yarn/global/node_modules/open-walnut')).toBe('yarn')
    expect(managerFromPath('C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\open-walnut')).toBe('npm')
  })

  it('is null for a package root outside node_modules (a checkout, an unpacked tarball)', () => {
    expect(managerFromPath('/Users/alice/open-walnut')).toBeNull()
    expect(managerFromPath('/opt/open-walnut-0.5.1')).toBeNull()
    // "node_modules" as part of a longer name is not the directory.
    expect(managerFromPath('/srv/node_modules_backup/open-walnut')).toBeNull()
  })
})

describe('managerCommand and managerArgv', () => {
  it('spells each manager\'s global install of the latest release', () => {
    expect(managerCommand('npm')).toBe('npm install -g open-walnut@latest')
    expect(managerCommand('pnpm')).toBe('pnpm add -g open-walnut@latest')
    expect(managerCommand('bun')).toBe('bun add -g open-walnut@latest')
    expect(managerCommand('yarn')).toBe('yarn global add open-walnut@latest')
    expect(managerCommand('npm', 'nightly')).toBe('npm install -g open-walnut@nightly')
  })

  it('argv is the same words without a shell', () => {
    expect(managerArgv('npm', 'open-walnut@0.6.0')).toEqual({ file: 'npm', args: ['install', '-g', 'open-walnut@0.6.0', `--allow-scripts=${INSTALL_SCRIPT_PACKAGES.join(',')}`] })
    expect(managerArgv('pnpm', 'open-walnut@0.6.0')).toEqual({ file: 'pnpm', args: ['add', '-g', 'open-walnut@0.6.0'] })
    expect(managerArgv('bun', 'open-walnut@0.6.0')).toEqual({ file: 'bun', args: ['add', '-g', 'open-walnut@0.6.0'] })
    expect(managerArgv('yarn', 'open-walnut@0.6.0')).toEqual({ file: 'yarn', args: ['global', 'add', 'open-walnut@0.6.0'] })
  })
})

describe('detectInstall', () => {
  const npmRoot = '/usr/local/lib/node_modules/open-walnut'

  it('is a replica on the cloud companion whatever the paths say', () => {
    const info = detectInstall({ cloud: true, installDir: '/srv/open-walnut', packageRoot: npmRoot })
    expect(info.kind).toBe('replica')
    expect(info.updateCommand).toBeNull()
    // Its status is readable over the internet: no server path rides along.
    expect(info.packageRoot).toBeNull()
    expect(info.sourceDir).toBeNull()
  })

  it('is a source checkout when the running code has a .git beside it', () => {
    const info = detectInstall({ cloud: false, installDir: '/Users/alice/open-walnut', packageRoot: '/Users/alice/open-walnut' })
    expect(info).toMatchObject({ kind: 'source', sourceDir: '/Users/alice/open-walnut', manager: null, updateCommand: null })
  })

  it('is an npm install with that manager\'s command', () => {
    const info = detectInstall({ cloud: false, installDir: null, packageRoot: npmRoot })
    expect(info).toMatchObject({ kind: 'npm', manager: 'npm', updateCommand: 'npm install -g open-walnut@latest', packageRoot: npmRoot })
    const bun = detectInstall({ cloud: false, installDir: null, packageRoot: '/Users/alice/.bun/install/global/node_modules/open-walnut' })
    expect(bun).toMatchObject({ kind: 'npm', manager: 'bun', updateCommand: 'bun add -g open-walnut@latest' })
    const nightly = detectInstall({ cloud: false, installDir: null, packageRoot: npmRoot }, 'nightly')
    expect(nightly.updateCommand).toBe('npm install -g open-walnut@nightly')
  })

  it('is "other" for a package root with no checkout and no node_modules parent, or no root at all', () => {
    expect(detectInstall({ cloud: false, installDir: null, packageRoot: '/opt/open-walnut' })).toMatchObject({ kind: 'other', updateCommand: null })
    expect(detectInstall({ cloud: false, installDir: null, packageRoot: null })).toMatchObject({ kind: 'other', packageRoot: null })
  })

  it('reads the process defaults from constants when called bare', () => {
    // The mocked constants have no install dir and no package root: an "other" install, not a crash.
    expect(detectInstall().kind).toBe('other')
  })
})

// npm 12 runs no dependency install script that is not allowed. A dependency
// whose script fetches its binary (better-sqlite3, node-pty) then installs
// without it, and Walnut cannot open its database: every such dependency must be
// allowed in package.json (a checkout, `npm rebuild` in the package) and named
// by the global install the updater runs.
describe('install scripts a working install needs', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { allowScripts?: Record<string, boolean> }
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { hasInstallScript?: boolean; dev?: boolean }>
  }
  const allowed = Object.entries(pkg.allowScripts ?? {}).filter(([, v]) => v === true).map(([k]) => k)

  it('package.json allows every runtime dependency that has an install script', () => {
    const needed = new Set<string>()
    for (const [key, meta] of Object.entries(lock.packages)) {
      if (!key || !meta.hasInstallScript || meta.dev) continue
      needed.add(key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length))
    }
    expect([...needed].filter((name) => !(name in (pkg.allowScripts ?? {}))).sort()).toEqual([])
  })

  it('the updater names this package and exactly the allowed ones', () => {
    expect([...INSTALL_SCRIPT_PACKAGES].sort()).toEqual(['open-walnut', ...allowed].sort())
  })
})
