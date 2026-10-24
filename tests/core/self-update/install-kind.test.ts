/**
 * Which install is this, and which command updates it? Pure path reasoning:
 * the source checkout wins over everything but the replica, and a global
 * install's manager is read off where the package landed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { readBunLock, runtimeClosure, splitSpec } from '../../helpers/bun-lock.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-install-kind'))

import {
  BINARY_MARKER, detectInstall, globalPrefixOf, kegOf, LAUNCHER_ENV, managerArgv, managerCommand, managerFromPath, RUNTIME_MARKER, runsCompiled, runtimePrefixOf,
} from '../../../src/core/self-update/install-kind.js'

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
    // npm is told to allow exactly the launcher's own postinstall; no other manager is told anything.
    expect(managerArgv('npm', 'open-walnut@0.6.0')).toEqual({ file: 'npm', args: ['install', '-g', 'open-walnut@0.6.0', '--allow-scripts=open-walnut'] })
    expect(managerArgv('pnpm', 'open-walnut@0.6.0')).toEqual({ file: 'pnpm', args: ['add', '-g', 'open-walnut@0.6.0'] })
    expect(managerArgv('bun', 'open-walnut@0.6.0')).toEqual({ file: 'bun', args: ['add', '-g', 'open-walnut@0.6.0'] })
    expect(managerArgv('yarn', 'open-walnut@0.6.0')).toEqual({ file: 'yarn', args: ['global', 'add', 'open-walnut@0.6.0'] })
  })
})

describe('the self-contained archive', () => {
  it('finds the prefix of a global install path, and only of one', () => {
    expect(globalPrefixOf('/x/runtime/lib/node_modules/open-walnut')).toBe('/x/runtime')
    expect(globalPrefixOf('/Users/alice/open-walnut')).toBeNull()
    expect(globalPrefixOf('/x/node_modules/open-walnut')).toBeNull()
    expect(runtimePrefixOf('/x/runtime/lib/node_modules/open-walnut', (p) => p === `/x/runtime/${RUNTIME_MARKER}`)).toBe('/x/runtime')
    expect(runtimePrefixOf('/x/runtime/lib/node_modules/open-walnut', () => false)).toBeNull()
  })

  it('updates with its own Node and npm into its own prefix, never the npm on PATH', () => {
    const prefix = '/home/alice/.local/share/open-walnut/app/runtime'
    expect(managerArgv('npm', 'open-walnut@0.6.3', prefix)).toEqual({
      file: `${prefix}/bin/node`,
      args: [`${prefix}/lib/node_modules/npm/bin/npm-cli.js`, 'install', '-g', '--prefix', prefix, 'open-walnut@0.6.3', '--allow-scripts=open-walnut'],
    })
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

  it('is the self-contained archive when its prefix carries the marker, updated by its own Node', () => {
    const prefix = '/Users/alice/.local/share/open-walnut/app/runtime'
    const root = `${prefix}/lib/node_modules/open-walnut`
    const exists = (p: string) => p === `${prefix}/${RUNTIME_MARKER}`
    const info = detectInstall({ cloud: false, installDir: null, packageRoot: root, exists })
    expect(info).toMatchObject({ kind: 'npm', manager: 'npm', runtimePrefix: prefix, updateCommand: 'walnut update' })
    // The same shape without the marker is an ordinary global install (nvm, Homebrew's
    // node, /usr/local): its own npm on PATH, the command people know.
    const nvm = detectInstall({ cloud: false, installDir: null, packageRoot: root, exists: () => false })
    expect(nvm).toMatchObject({ kind: 'npm', runtimePrefix: null, updateCommand: 'npm install -g open-walnut@latest' })
  })

  it('reads the process defaults from constants when called bare', () => {
    // This process is a script runtime, in no layout of the file's: nothing below applies.
    // The mocked constants have no install dir and no package root: an "other" install, not a crash.
    expect(detectInstall().kind).toBe('other')
  })
})

// The compiled file (scripts/build-binary.mjs) reports a package root of its own
// (its unpacked runtime), which never says how it was installed: its executable's
// place does, or the npm launcher's env when that names this very file.
describe('detectInstall for the compiled file', () => {
  const root = '/home/alice/.local/share/open-walnut'
  const file = `${root}/versions/0.8.0/walnut`
  const runtimeRoot = '/home/alice/.open-walnut/local/runtime/0.8.0-abc'
  const files: Record<string, string> = {
    [`${root}/${BINARY_MARKER}`]: JSON.stringify({ layout: 'versions', target: 'linux-x64-musl' }),
    '/usr/lib/node_modules/open-walnut/package.json': JSON.stringify({ name: 'open-walnut', version: '0.8.0' }),
  }
  const readFile = (p: string) => { if (p in files) return files[p]!; throw new Error(`ENOENT ${p}`) }
  // Links: ~/.local/bin/walnut -> <root>/bin/walnut -> versions/0.8.0/walnut.
  const links: Record<string, string> = { '/home/alice/.local/bin/walnut': file, [`${root}/bin/walnut`]: file }
  const realpath = (p: string) => links[p] ?? p
  const inputs = { cloud: false, installDir: null, packageRoot: runtimeRoot, readFile, realpath }

  it('is a binary install in install.sh\'s versions layout, updated by itself, restarted through its link', () => {
    const info = detectInstall({ ...inputs, execPath: file, env: {} })
    expect(info).toMatchObject({
      kind: 'binary', manager: null, updateCommand: 'walnut update', packageRoot: null,
      binary: { root, target: 'linux-x64-musl', version: '0.8.0' }, relaunch: [`${root}/bin/walnut`],
    })
  })

  it('needs install.sh\'s marker: the same shape anywhere else is not one', () => {
    const elsewhere = '/home/alice/Downloads/versions/0.8.0/walnut'
    expect(detectInstall({ ...inputs, execPath: elsewhere, env: {} }).kind).toBe('other')
    const bad = { ...files, [`${root}/${BINARY_MARKER}`]: JSON.stringify({ layout: 'versions', target: '../../etc' }) }
    expect(detectInstall({ ...inputs, readFile: (p) => bad[p] ?? readFile(p), execPath: file, env: {} }).kind).toBe('other')
    // A file named otherwise in that place is not the walnut install.sh put there.
    expect(detectInstall({ ...inputs, execPath: `${root}/versions/0.8.0/node`, env: {} }).kind).toBe('other')
  })

  it('a compiled file in no install\'s place is no npm install, whatever package root its runtime reports', () => {
    const loose = '/home/alice/Downloads/walnut'
    const underNodeModules = '/home/alice/node_modules/open-walnut'
    expect(detectInstall({ ...inputs, packageRoot: underNodeModules, execPath: loose, env: {}, compiled: true })).toMatchObject({ kind: 'other', packageRoot: null, updateCommand: null })
    // Node running the package from there is that npm install, as before.
    expect(detectInstall({ ...inputs, packageRoot: underNodeModules, execPath: '/usr/bin/node', env: {}, compiled: false }).kind).toBe('npm')
    expect(runsCompiled(['bun', '/$bunfs/root/walnut', 'web'])).toBe(true)
    expect(runsCompiled(['/usr/bin/node', '/usr/lib/node_modules/open-walnut/dist/cli.js', 'web'])).toBe(false)
  })

  it('a file Homebrew installed names brew, and nothing else updates it', () => {
    const info = detectInstall({ ...inputs, execPath: '/opt/homebrew/Cellar/open-walnut/0.8.0/bin/walnut', env: {} })
    expect(info).toMatchObject({ kind: 'other', updateCommand: 'brew upgrade open-walnut', manager: null })
  })

  // 0.6.17's formula installed the Node archive into the keg, and its updater (which
  // knew no keg) put the launcher and its platform package into the archive's npm
  // prefix there. The launcher's env names that package root, marker beside it.
  // That formula promised the keg keeps itself up to date: it stays an npm install
  // of the archive, and only carries the keg for the `brew upgrade` line.
  it('a keg\'s Node archive that updated itself onto the launcher keeps updating with its npm, and knows its keg', () => {
    const cellarKeg = '/opt/homebrew/Cellar/open-walnut/0.6.17'
    const keg = `${cellarKeg}/libexec/app/runtime`
    const pkg = `${keg}/lib/node_modules/open-walnut`
    const kegFile = `${pkg}/node_modules/@open-walnut/darwin-arm64/walnut`
    const relaunch = [`${keg}/bin/node`, `${pkg}/bin/open-walnut.js`]
    const env = { [LAUNCHER_ENV.packageRoot]: pkg, [LAUNCHER_ENV.file]: kegFile, [LAUNCHER_ENV.relaunch]: JSON.stringify(relaunch) }
    const withPkg = (p: string) => (p === `${pkg}/package.json` ? JSON.stringify({ name: 'open-walnut', version: '0.6.99' }) : readFile(p))
    const exists = (p: string) => p === `${keg}/${RUNTIME_MARKER}`
    const info = detectInstall({ ...inputs, readFile: withPkg, exists, execPath: kegFile, env })
    expect(info).toMatchObject({ kind: 'npm', manager: 'npm', runtimePrefix: keg, updateCommand: 'walnut update', packageRoot: pkg, relaunch, homebrewKeg: cellarKeg })
    // Reached through the keg's opt link: the real path names the keg.
    const optRuntime = '/opt/homebrew/opt/open-walnut/libexec/app/runtime'
    const opt = `${optRuntime}/lib/node_modules/open-walnut`
    const viaOpt = (p: string) => (p.startsWith(opt) ? pkg + p.slice(opt.length) : realpath(p))
    const optInfo = detectInstall({
      ...inputs, readFile: (p) => withPkg(viaOpt(p)), realpath: viaOpt, exists: (p) => p === `${optRuntime}/${RUNTIME_MARKER}`,
      execPath: kegFile, env: { ...env, [LAUNCHER_ENV.packageRoot]: opt },
    })
    expect(optInfo).toMatchObject({ kind: 'npm', runtimePrefix: optRuntime, homebrewKeg: cellarKeg })
    expect(kegOf(`${cellarKeg}/libexec/walnut`)).toBe(cellarKeg)
    expect(kegOf('/opt/homebrew/lib/node_modules/open-walnut/bin/open-walnut.js')).toBeNull()
    // The same archive outside a keg (install.sh's, the Mac app's) still updates itself with its own npm.
    const share = '/Users/alice/.local/share/open-walnut/app/runtime'
    const sharePkg = `${share}/lib/node_modules/open-walnut`
    const shareFile = `${sharePkg}/node_modules/@open-walnut/darwin-arm64/walnut`
    const shareInfo = detectInstall({
      ...inputs,
      readFile: (p) => (p === `${sharePkg}/package.json` ? JSON.stringify({ name: 'open-walnut' }) : readFile(p)),
      exists: (p) => p === `${share}/${RUNTIME_MARKER}`,
      execPath: shareFile,
      env: { [LAUNCHER_ENV.packageRoot]: sharePkg, [LAUNCHER_ENV.file]: shareFile },
    })
    expect(shareInfo).toMatchObject({ kind: 'npm', runtimePrefix: share, updateCommand: 'walnut update' })
    expect(shareInfo.homebrewKeg).toBeUndefined()
    // An npm install on Homebrew's own Node is npm's, not the keg's: its root is no open-walnut keg.
    const brewNode = '/opt/homebrew/lib/node_modules/open-walnut'
    const brewNodeFile = `${brewNode}/node_modules/@open-walnut/darwin-arm64/walnut`
    const brewNodeInfo = detectInstall({
      ...inputs,
      readFile: (p) => (p === `${brewNode}/package.json` ? JSON.stringify({ name: 'open-walnut' }) : readFile(p)),
      execPath: brewNodeFile,
      env: { [LAUNCHER_ENV.packageRoot]: brewNode, [LAUNCHER_ENV.file]: brewNodeFile },
    })
    expect(brewNodeInfo).toMatchObject({ kind: 'npm', updateCommand: 'npm install -g open-walnut@latest' })
    expect(brewNodeInfo.homebrewKeg).toBeUndefined()
  })

  it('started by the npm launcher, it is that npm install, restarted through the launcher', () => {
    const npmFile = '/usr/lib/node_modules/open-walnut/node_modules/@open-walnut/linux-x64/walnut'
    const env = {
      [LAUNCHER_ENV.packageRoot]: '/usr/lib/node_modules/open-walnut',
      [LAUNCHER_ENV.file]: npmFile,
      [LAUNCHER_ENV.relaunch]: JSON.stringify(['/usr/bin/node', '/usr/lib/node_modules/open-walnut/bin/open-walnut.js']),
    }
    const info = detectInstall({ ...inputs, execPath: npmFile, env })
    expect(info).toMatchObject({
      kind: 'npm', manager: 'npm', updateCommand: 'npm install -g open-walnut@latest', packageRoot: '/usr/lib/node_modules/open-walnut',
      relaunch: ['/usr/bin/node', '/usr/lib/node_modules/open-walnut/bin/open-walnut.js'],
    })
    // Inherited by a child that is another Walnut (a session running a binary install's
    // walnut): the env names a different file there, so it counts for nothing.
    expect(detectInstall({ ...inputs, execPath: file, env }).kind).toBe('binary')
    // A package root that is not open-walnut's is not believed either.
    expect(detectInstall({ ...inputs, execPath: npmFile, env: { ...env, [LAUNCHER_ENV.packageRoot]: '/tmp/evil' } }).kind).toBe('other')
    // A relaunch that is not an argv is dropped; the install is still npm.
    expect(detectInstall({ ...inputs, execPath: npmFile, env: { ...env, [LAUNCHER_ENV.relaunch]: '"node"' } })).toMatchObject({ kind: 'npm', relaunch: null })
  })

  it('the launcher wins over a source checkout the file happens to sit near; nothing else does', () => {
    const npmFile = '/usr/lib/node_modules/open-walnut/node_modules/@open-walnut/linux-x64/walnut'
    const env = { [LAUNCHER_ENV.packageRoot]: '/usr/lib/node_modules/open-walnut', [LAUNCHER_ENV.file]: npmFile }
    expect(detectInstall({ ...inputs, installDir: '/home/alice/open-walnut', execPath: npmFile, env }).kind).toBe('npm')
    expect(detectInstall({ ...inputs, installDir: '/home/alice/open-walnut', execPath: '/usr/bin/node', env: {} }).kind).toBe('source')
  })
})

// Neither npm 12 nor bun runs a dependency's install script it was not told to
// trust. A checkout installs with bun, which runs only `trustedDependencies`; the
// same list is `allowScripts` for `npm rebuild` inside an unpacked package. Every
// runtime dependency whose install script matters must be on it.
describe('install scripts a working install needs', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    allowScripts?: Record<string, boolean>
    trustedDependencies?: string[]
  }
  const lock = readBunLock(path.join(root, 'bun.lock'))
  const allowed = Object.entries(pkg.allowScripts ?? {}).filter(([, v]) => v === true).map(([k]) => k)

  it('package.json allows every runtime dependency that has an install script', () => {
    const needed = new Set<string>()
    for (const key of runtimeClosure(lock)) {
      const [spec, , meta] = lock.packages[key]!
      if (meta?.hasInstallScript) needed.add(splitSpec(spec)[0])
    }
    // The closure is real: it reaches the native modules a server needs.
    expect(needed).toContain('sharp')
    expect(needed).toContain('onnxruntime-node')
    expect([...needed].filter((name) => !(name in (pkg.allowScripts ?? {}))).sort()).toEqual([])
  })

  it('Bun trusts exactly the packages npm is allowed to run scripts for', () => {
    expect([...(pkg.trustedDependencies ?? [])].sort()).toEqual([...allowed].sort())
  })
})
