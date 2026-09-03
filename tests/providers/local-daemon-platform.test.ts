/**
 * The local daemon must be selected by the HOST's platform/arch, never by a
 * hardcoded one (GitHub issue #11: daemon-darwin-arm64 was hardcoded, so a Linux
 * x64 box spawned a Mach-O binary, no port file appeared, and every local session
 * failed after the 10s timeout — while the remote SSH path had done arch
 * detection correctly all along).
 *
 * Three contracts are pinned here:
 *   1. the name follows the host, for every platform/arch we can be run on;
 *   2. the names match what scripts/build-daemon.sh actually writes — the two
 *      files are the only link between "what we build" and "what we look for";
 *   3. a missing binary degrades to the Node source daemon and NEVER to another
 *      platform's binary sitting in the same directory.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getLocalDaemonBinaryName, pickDaemonBinary } from '../../src/providers/local-daemon.js'

const BUILD_SCRIPT = path.join(import.meta.dirname, '..', '..', 'scripts', 'build-daemon.sh')

describe('getLocalDaemonBinaryName', () => {
  it('selects the Linux x64 daemon built by CI', () => {
    expect(getLocalDaemonBinaryName('linux', 'x64')).toBe('daemon-linux-x64')
  })

  it('selects the native daemon by default', () => {
    expect(getLocalDaemonBinaryName()).toBe(`daemon-${process.platform}-${process.arch}`)
  })

  it('follows the host for every platform/arch, never a darwin default', () => {
    const combos: Array<[string, string]> = [
      ['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'arm64'], ['darwin', 'x64'],
    ]
    for (const [platform, arch] of combos) {
      const name = getLocalDaemonBinaryName(platform, arch)
      expect(name).toBe(`daemon-${platform}-${arch}`)
      if (platform !== 'darwin') expect(name).not.toMatch(/darwin/)
    }
  })

  it('matches the names scripts/build-daemon.sh writes', () => {
    const built = [...fs.readFileSync(BUILD_SCRIPT, 'utf-8')
      .matchAll(/--outfile "\$OUTDIR\/(daemon-[a-z0-9-]+)"/g)].map((m) => m[1])
    // Three compiled targets today; if the build gains or renames one, this test
    // is where the mismatch has to be resolved.
    expect(built.sort()).toEqual(['daemon-darwin-arm64', 'daemon-linux-arm64', 'daemon-linux-x64'])
    for (const name of built) {
      const [, platform, arch] = name.split('-')
      expect(getLocalDaemonBinaryName(platform, arch)).toBe(name)
    }
  })
})

/**
 * The source-daemon degradation above is only reachable if the BUILD tolerates a
 * machine with no Bun. It used to `exit 1`, which made `npm start` fail outright on
 * every machine that had never installed Bun, so a new user following the README
 * stopped at the first command (found by the fresh-machine onboarding harness,
 * scripts/onboarding-test/). Release flows opt back into strict mode.
 */
describe('scripts/build-daemon.sh without Bun', () => {
  // A PATH with no bun, and a HOME with none of the fallback install prefixes. The
  // script returns before it creates or writes anything, so this touches no dist/.
  const noBunEnv = { PATH: '/usr/bin:/bin', HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'no-bun-')) }

  it('skips the binaries and succeeds, so npm start keeps going', () => {
    const res = spawnSync('bash', [BUILD_SCRIPT], { env: noBunEnv, encoding: 'utf-8' })
    expect(res.status).toBe(0)
    expect(res.stderr).toMatch(/skipping the daemon binaries/)
    expect(res.stderr).toMatch(/deploy the daemon from source/)
  })

  it('still refuses under WALNUT_REQUIRE_BUN=1, so a release cannot ship without them', () => {
    const res = spawnSync('bash', [BUILD_SCRIPT], {
      env: { ...noBunEnv, WALNUT_REQUIRE_BUN: '1' },
      encoding: 'utf-8',
    })
    expect(res.status).toBe(1)
  })

  it('is the mode the publish pipeline uses', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'package.json'), 'utf-8'))
    expect(pkg.scripts.prepublishOnly).toContain('WALNUT_REQUIRE_BUN=1')
  })
})

describe('pickDaemonBinary', () => {
  function dirWith(...names: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-pick-'))
    for (const n of names) fs.writeFileSync(path.join(dir, n), '#!/bin/sh\nexit 0\n')
    return dir
  }

  it('never returns a binary built for a different platform', () => {
    const dir = dirWith('daemon-darwin-arm64', 'daemon-darwin-arm64.version')
    // A Linux host looking at a macOS build tree: no match, so the caller
    // materializes the Node source daemon instead of executing a Mach-O file.
    expect(pickDaemonBinary([dir], getLocalDaemonBinaryName('linux', 'x64'))).toBeNull()
  })

  it('returns the host binary when it is present', () => {
    const dir = dirWith('daemon-linux-x64', 'daemon-darwin-arm64')
    expect(pickDaemonBinary([dir], 'daemon-linux-x64')).toBe(path.join(dir, 'daemon-linux-x64'))
  })

  it('prefers the first directory that has it', () => {
    const first = dirWith()
    const second = dirWith('daemon-linux-arm64')
    expect(pickDaemonBinary([first, second], 'daemon-linux-arm64'))
      .toBe(path.join(second, 'daemon-linux-arm64'))
    const both = dirWith('daemon-linux-arm64')
    expect(pickDaemonBinary([both, second], 'daemon-linux-arm64'))
      .toBe(path.join(both, 'daemon-linux-arm64'))
  })

  it('returns null when no directory has it', () => {
    expect(pickDaemonBinary([dirWith(), '/nonexistent-daemon-dir'], 'daemon-linux-x64')).toBeNull()
  })
})
