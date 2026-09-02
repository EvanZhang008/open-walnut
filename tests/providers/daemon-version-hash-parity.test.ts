/**
 * The daemon version string is a hash of the daemon's source files, and it is
 * computed TWICE by two different languages: `scripts/build-daemon.sh` stamps it
 * into the binary, and `computeExpectedDaemonVersion()` in
 * `src/providers/daemon-version-check.ts` recomputes it at connect time to decide
 * whether a host needs a redeploy.
 *
 * Those two lists are hand-maintained (neither side can introspect a bun-compiled
 * binary or an embedded template at distribution time), so they drift. Two distinct
 * failure modes, both silent:
 *
 *  - A file in the SHELL list but not the TS list: the binary's stamp moves when
 *    that file changes, but the server computes the old expectation, so it decides
 *    the freshly built daemon is the wrong version — a redeploy loop.
 *  - A file in NEITHER list (the real 2026-09 case: `daemon-capabilities.ts`):
 *    editing it changes what every daemon advertises on `hello`, yet the version
 *    string is unchanged, so no host ever redeploys and the server gates the new
 *    capability off forever — on exactly the daemons the edit was written for.
 *
 * Ordering matters as much as membership: the hash feeds `path + NUL + content +
 * NUL` per file in list order, so the same set in a different order is a different
 * hash and the two sides never converge.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const ROOT = path.resolve(__dirname, '../..')
const BUILD_SCRIPT = path.join(ROOT, 'scripts/build-daemon.sh')
const VERSION_CHECK = path.join(ROOT, 'src/providers/daemon-version-check.ts')

/** The SOURCES=( … ) array from the build script, in file order. */
function shellSourceList(): string[] {
  const src = fs.readFileSync(BUILD_SCRIPT, 'utf-8')
  const block = /^SOURCES=\(([\s\S]*?)^\)/m.exec(src)
  expect(block, 'SOURCES=( … ) not found in scripts/build-daemon.sh').not.toBeNull()
  return block![1]!
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter((l) => l.length > 0)
}

/** The DAEMON_SOURCE_FILES array from the version checker, in file order. */
function tsSourceList(): string[] {
  const src = fs.readFileSync(VERSION_CHECK, 'utf-8')
  const block = /const DAEMON_SOURCE_FILES = \[([\s\S]*?)^\]/m.exec(src)
  expect(block, 'DAEMON_SOURCE_FILES = [ … ] not found in daemon-version-check.ts').not.toBeNull()
  return [...block![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
}

/** The build script's algorithm, reimplemented: path + NUL + content + NUL. */
function hashFiles(rels: string[]): string {
  const hash = createHash('sha256')
  const NUL = Buffer.from([0])
  for (const rel of rels) {
    hash.update(Buffer.from(rel))
    hash.update(NUL)
    hash.update(fs.readFileSync(path.join(ROOT, rel)))
    hash.update(NUL)
  }
  return 'walnut-daemon-' + hash.digest('hex').slice(0, 12)
}

describe('daemon version hash: the two source lists agree', () => {
  it('the shell list and the TS list are identical, in the same order', () => {
    expect(tsSourceList()).toEqual(shellSourceList())
  })

  it('every listed file exists (a typo would silently hash nothing on one side)', () => {
    for (const rel of shellSourceList()) {
      expect(fs.existsSync(path.join(ROOT, rel)), `${rel} is listed but missing`).toBe(true)
    }
  })

  it('hashing either list yields the same version string', () => {
    expect(hashFiles(tsSourceList())).toBe(hashFiles(shellSourceList()))
  })

  it('computeExpectedDaemonVersion() matches the build script algorithm', async () => {
    const { computeExpectedDaemonVersion } = await import('../../src/providers/daemon-version-check.js')
    expect(computeExpectedDaemonVersion()).toBe(hashFiles(shellSourceList()))
  })

  // The specific regression this file was written for. Both twins report the
  // capability list on `hello`, so it is part of the deploy unit's behaviour.
  it('includes daemon-capabilities.ts — editing it must move the version', () => {
    expect(shellSourceList()).toContain('src/providers/daemon-capabilities.ts')
  })

  // Anything the twins import or inline belongs in the list. These are the files
  // whose absence has already caused a real "no host redeployed" incident class.
  it('includes both daemon twins and the shared core they mirror', () => {
    const list = shellSourceList()
    for (const rel of [
      'src/providers/daemon-standalone.ts',
      'src/providers/daemon-source.ts',
      'src/providers/daemon-core.ts',
    ]) {
      expect(list, `${rel} must be hashed`).toContain(rel)
    }
  })
})
