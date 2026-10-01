/**
 * Which install is this, and which command updates it? Pure path reasoning:
 * the source checkout wins over everything but the replica, and a global
 * install's manager is read off where the package landed.
 */
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-install-kind'))

import { detectInstall, managerArgv, managerCommand, managerFromPath } from '../../../src/core/self-update/install-kind.js'

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
    expect(managerArgv('npm', 'open-walnut@0.6.0')).toEqual({ file: 'npm', args: ['install', '-g', 'open-walnut@0.6.0'] })
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
