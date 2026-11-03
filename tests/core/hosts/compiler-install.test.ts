/**
 * The command Walnut names for installing a C compiler fits the host's package manager.
 * 2026-11-03: Settings told an Ubuntu machine (a Windows PC's WSL) to run `sudo yum install -y
 * gcc`, because the hint listed yum first for every Linux. The last block keeps every other
 * place from naming a package-manager command itself.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { compilerInstallCommands, PACKAGE_MANAGERS } from '../../../src/core/hosts/compiler-install.js'
import { parsePreflight, readinessProblems } from '../../../src/core/hosts/host-readiness-problems.js'

const ROOT = path.resolve(__dirname, '../../..')

describe('compilerInstallCommands', () => {
  it('names the command of the package manager the host has, alone', () => {
    expect(compilerInstallCommands({ platform: 'linux', packageManager: 'apt-get' })).toEqual(['sudo apt-get update && sudo apt-get install -y gcc libc6-dev'])
    expect(compilerInstallCommands({ platform: 'linux', packageManager: 'yum' })).toEqual(['sudo yum install -y gcc glibc-devel'])
    expect(compilerInstallCommands({ platform: 'linux', packageManager: 'apk' })).toEqual(['sudo apk add gcc musl-dev'])
    for (const pm of PACKAGE_MANAGERS) expect(compilerInstallCommands({ platform: 'linux', packageManager: pm })[0]).toMatch(new RegExp(`^sudo ${pm} `))
  })

  it('a Mac gets the Command Line Tools, whatever else it has', () => {
    expect(compilerInstallCommands({ platform: 'darwin', packageManager: 'yum' })).toEqual(['xcode-select --install'])
  })

  it('with no package manager known (an older daemon), the common ones', () => {
    expect(compilerInstallCommands({ platform: 'linux' })).toEqual([
      'sudo apt-get update && sudo apt-get install -y gcc libc6-dev', 'sudo dnf install -y gcc glibc-devel', 'sudo yum install -y gcc glibc-devel',
    ])
    expect(compilerInstallCommands({ platform: 'linux', packageManager: 'pacman' })).toHaveLength(3)
  })
})

describe('the Remote Hosts line for a host with no compiler', () => {
  const ubuntu = { claude: { found: true, kind: 'native', version: '9.9.9' }, compiler: { found: false }, dtach: { found: false }, platform: 'linux', arch: 'x64', packageManager: 'apt-get' }

  it('reads the package manager from the daemon, and drops one it does not know', () => {
    expect(parsePreflight(ubuntu)?.packageManager).toBe('apt-get')
    expect(parsePreflight({ ...ubuntu, packageManager: 'rm -rf /' })?.packageManager).toBeUndefined()
  })

  it('an Ubuntu host is told apt-get, never yum', () => {
    const problems = readinessProblems(parsePreflight(ubuntu)!, { local: false, prebuiltDtach: false, hostLabel: 'home-pc' })
    const line = problems.find((p) => p.kind === 'compiler_missing')
    expect(line?.commands).toEqual(['sudo apt-get update && sudo apt-get install -y gcc libc6-dev'])
  })
})

/** Source files under `dir`, recursively (no tests, no generated output). */
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'dist' ? [] : sources(p)
    return /\.(ts|tsx|mjs|js)$/.test(e.name) ? [p] : []
  })
}

describe('the class: every package-manager command comes from compiler-install.ts', () => {
  // Each one here builds its command for a host it already knows the package manager of.
  const ALLOWED: Record<string, string> = {
    'src/core/hosts/compiler-install.ts': 'the one place',
    'src/providers/host-fix-core.ts': "the daemon's fix: the command of the package manager it found on the host",
    'src/core/cloud-setup/user-data.ts': 'the cloud box bootstrap, on the one image it launches',
  }

  it('no other file names `<package manager> install` or `apk add`', () => {
    const offenders: string[] = []
    for (const file of [...sources(path.join(ROOT, 'src')), ...sources(path.join(ROOT, 'web/src'))]) {
      const rel = path.relative(ROOT, file)
      if (ALLOWED[rel]) continue
      const text = fs.readFileSync(file, 'utf8')
      if (/\b(?:(?:dnf|yum|apt-get|apt|zypper) install|apk add)\b/.test(text)) offenders.push(rel)
    }
    // A new one: take the command from compilerInstallCommands, or list it with why.
    expect(offenders).toEqual([])
  })
})
