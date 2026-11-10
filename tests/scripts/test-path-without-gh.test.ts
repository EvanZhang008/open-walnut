/**
 * A test that expects "no gh on this host" builds its PATH with systemBinWithout.
 *
 * A PATH that lists the system dirs finds gh on CI's Ubuntu image (/usr/bin/gh): the unit test of
 * the commit core met it first, and on 2026-11-10 the session commit fixture did, so the nightly
 * run's commit view offered a pull request the spec says cannot exist. The session daemon also adds
 * the system dirs to its PATH itself unless the PATH is pinned. This lists every test file that
 * expects the `no-gh` answer and fails on one whose PATH comes from anywhere else (a spec through
 * the fixture server beside it), or whose real daemon is not pinned.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { systemBinWithout, SYSTEM_BIN_DIRS } from '../helpers/system-bin.js'
import { createHostRuntime } from '../../src/providers/host-runtime-core.js'

const ROOT = path.resolve(__dirname, '../..')

function testFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'fixtures') testFiles(p, out) }
    else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

/** The file that builds a test's PATH: itself, or for a Playwright spec the fixture server beside it. */
const pathOwner = (file: string) => {
  const server = file.replace(/\.spec\.ts$/, '-server.ts')
  return file.endsWith('.spec.ts') && fs.existsSync(server) ? server : file
}

describe('a test that expects no gh never finds the one in /usr/bin', () => {
  it('every such test builds its PATH with systemBinWithout, and lists no system dir in it', () => {
    const self = path.join(ROOT, 'tests/scripts/test-path-without-gh.test.ts')
    const expecting = testFiles(path.join(ROOT, 'tests')).filter((f) => f !== self && /['"]no-gh['"]/.test(fs.readFileSync(f, 'utf8')))
    expect(expecting.map((f) => path.relative(ROOT, f)).sort()).toEqual([
      'tests/e2e/browser/session-commit.spec.ts',
      'tests/providers/git-commit-core.test.ts',
    ])
    for (const f of expecting) {
      const owner = pathOwner(f)
      const text = fs.readFileSync(owner, 'utf8')
      expect(text, path.relative(ROOT, owner)).toMatch(/systemBinWithout\(.*\[\s*'gh'\s*\]\)/)
      // A PATH array naming a system dir outright brings gh back.
      expect(text, path.relative(ROOT, owner)).not.toMatch(/PATH\s*=\s*\[[^\]]*'\/usr\/bin'/)
      // A real daemon adds the system dirs itself unless its PATH is pinned (below).
      if (/daemon-standalone/.test(text)) {
        expect(text, path.relative(ROOT, owner)).toMatch(/WALNUT_TEST_EXEC_GUARD: path\.join\(repoRoot, 'tests\/setup\/exec-guard-bin'\)/)
        expect(text, path.relative(ROOT, owner)).not.toMatch(/const PATH = \[[^\]]*exec-guard/)
      }
    }
  })

  it('a daemon keeps a pinned PATH as it is, and adds the system dirs to any other (2026-11-10)', () => {
    const fixturePath = '/fx/mock-bin:/fx/node-bin:/fx/sys-bin'
    const guard = path.join(ROOT, 'tests/setup/exec-guard-bin')
    const pinned = createHostRuntime({ env: { HOME: '/fx', PATH: fixturePath, WALNUT_TEST_EXEC_GUARD: guard } }).computeDaemonPath().path.split(':')
    for (const d of SYSTEM_BIN_DIRS) expect(pinned, d).not.toContain(d)
    expect(pinned.slice(0, 3)).toEqual(fixturePath.split(':'))
    // Without the guard the daemon puts /usr/bin back, which is how CI's gh was found.
    const plain = createHostRuntime({ env: { HOME: '/fx', PATH: fixturePath } }).computeDaemonPath().path.split(':')
    expect(plain).toContain('/usr/bin')
  })

  it('systemBinWithout links the system tools but the ones it leaves out', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'system-bin-'))
    try {
      const bin = systemBinWithout(path.join(dir, 'bin'), ['gh', 'sh'])
      expect(fs.existsSync(path.join(bin, 'sh'))).toBe(false)
      expect(fs.existsSync(path.join(bin, 'gh'))).toBe(false)
      const some = SYSTEM_BIN_DIRS.flatMap((d) => { try { return fs.readdirSync(d) } catch { return [] } }).find((n) => n !== 'gh' && n !== 'sh')!
      expect(fs.existsSync(path.join(bin, some)), some).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
