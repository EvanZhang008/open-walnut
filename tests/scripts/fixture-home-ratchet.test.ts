/**
 * A browser fixture server's home is its own (tests/e2e/browser/fixture-home.ts).
 * Bun reads HOME once at startup, so `process.env.HOME = dir` in the server does not
 * move its own `os.homedir()`: 2026-10-30, the folder picker in the fixture listed the
 * developer's real home. Every fixture that sets HOME must go through fixtureHome.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..', '..')
const BROWSER = path.join(REPO, 'tests', 'e2e', 'browser')

describe('fixture servers own their home', () => {
  it('every browser fixture that sets HOME starts through fixtureHome', () => {
    const setting = fs.readdirSync(BROWSER)
      .filter((n) => n.endsWith('.ts') && n !== 'fixture-home.ts')
      // `process.env.HOME = x`, or HOME inside `Object.assign(process.env, { … })`.
      .filter((n) => /process\.env\.HOME = |Object\.assign\(process\.env, \{[^}]*\bHOME:/.test(fs.readFileSync(path.join(BROWSER, n), 'utf-8')))
    expect(setting.length).toBeGreaterThan(5)
    expect(setting, 'the Object.assign form is read too').toContain('warm-session-server.ts')
    for (const n of setting) {
      expect(fs.readFileSync(path.join(BROWSER, n), 'utf-8'), `${n} sets HOME; call fixtureHome first`).toMatch(/await fixtureHome\(/)
    }
  })

  it('the restarted process reads the fixture home, and its exit code comes back', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-home-')))
    try {
      const home = path.join(dir, 'home')
      const script = path.join(dir, 'probe.ts')
      fs.writeFileSync(script, [
        `import os from 'node:os'`,
        `import { fixtureHome } from ${JSON.stringify(path.join(BROWSER, 'fixture-home.ts'))}`,
        `const home = await fixtureHome(${JSON.stringify(home)})`,
        `console.log(JSON.stringify({ home, homedir: os.homedir() }))`,
        `process.exit(7)`,
      ].join('\n'))
      const bun = process.versions.bun ? process.execPath : 'bun'
      const r = spawnSync(bun, [script], { encoding: 'utf-8', env: { ...process.env, WALNUT_FIXTURE_HOME: '' }, timeout: 30_000 })
      expect(r.status, r.stderr).toBe(7)
      expect(JSON.parse(r.stdout.trim())).toEqual({ home, homedir: home })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a killed run\'s fixture is reaped through its restarted parent, never a server started by hand', async () => {
    const { orphanRoot } = await import('../e2e/browser/pw-concurrency.js')
    const cmd = (c: Record<number, string>) => (pid: number) => c[pid] ?? ''
    const ppid = (p: Record<number, number>) => (pid: number) => p[pid] ?? 0
    const server = 'bun tests/e2e/browser/test-server.ts'
    // The listener is the re-exec child; its parent (same command) was adopted by launchd.
    expect(orphanRoot(20, ppid({ 20: 10, 10: 1 }), cmd({ 20: server, 10: server }))).toBe(10)
    // An old-style orphan (no re-exec) is itself the root.
    expect(orphanRoot(20, ppid({ 20: 1 }), cmd({ 20: server }))).toBe(20)
    // A fixture started from a shell: its wrapper still has the shell as parent.
    expect(orphanRoot(20, ppid({ 20: 10, 10: 5 }), cmd({ 20: server, 10: server }))).toBeNull()
    // A parent that is some other program is never the fixture's wrapper.
    expect(orphanRoot(20, ppid({ 20: 10, 10: 1 }), cmd({ 20: server, 10: 'node runner.js' }))).toBeNull()
  })
})
