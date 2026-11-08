/**
 * A Demo generation's terminal sockets live in a short private dir in /tmp
 * (src/lib/demo-terminal-dir.ts), because under a long account home the daemon
 * dir's `term/walnut-<uuid>.dsock` passes macOS's 103-byte socket cap. These
 * tests pin that the path fits whatever the home, that each generation gets its
 * own dir and keeps it, and that a dir that is not this account's private dir
 * claimed for this Demo is never used and never removed.
 *
 * Every dir made here is removed after each test; the roots are neutral paths
 * that are never created.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  DEMO_TERMINAL_BASE, checkDemoTerminalDir, demoTerminalDir, demoTerminalDirFromEnv, ensureDemoTerminalDir, removeDemoTerminalDir,
} from '../../src/lib/demo-terminal-dir.js'

const SOCKET_CAP = 103
const made: string[] = []

/** A fresh generation's dir under a neutral root, removed after the test. */
function freshDir(root = `/home/someone/.local/share/open-walnut-demo`): { dir: string; owner: string } {
  const generation = randomUUID()
  const dir = demoTerminalDir(root, generation)
  made.push(dir)
  return { dir, owner: path.join(root, 'data', generation) }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of made.splice(0)) {
    try {
      const st = fs.lstatSync(dir)
      if (st.isSymbolicLink()) fs.unlinkSync(dir)
      else { fs.chmodSync(dir, 0o700); fs.rmSync(dir, { recursive: true, force: true }) }
    } catch { /* already gone */ }
  }
})

describe('demoTerminalDir', () => {
  it('fits the socket cap under a long home, where the daemon dir did not', () => {
    const home = `/Users/${'a'.repeat(40)}`
    const root = path.join(home, '.local', 'share', 'open-walnut-demo')
    const sid = randomUUID()
    const old = path.join(root, 'd', 'term', `walnut-${sid}.dsock`)
    expect(Buffer.byteLength(old)).toBeGreaterThan(SOCKET_CAP)
    const socket = path.join(demoTerminalDir(root, randomUUID()), `walnut-${sid}.dsock`)
    expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(SOCKET_CAP)
    // The ten-character home of the report sat at 104 bytes before.
    const report = path.join('/Users/abcdefghij/.local/share/open-walnut-demo', 'd', 'term', `walnut-${sid}.dsock`)
    expect(Buffer.byteLength(report)).toBe(104)
  })

  it('keeps the user name and home out of the path, and the uid in it', () => {
    const dir = demoTerminalDir('/Users/somebody-with-a-long-name/.local/share/open-walnut-demo', 'g')
    expect(path.dirname(dir)).toBe(DEMO_TERMINAL_BASE)
    expect(dir).not.toContain('somebody')
    expect(dir.startsWith('/tmp/open-walnut')).toBe(false)
    const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'user'
    expect(path.basename(dir)).toMatch(new RegExp(`^walnut-demo-${uid}-[0-9a-f]{16}$`))
  })

  it('is the same for a generation every time, and differs across generations and roots', () => {
    const a = '/Users/one/.local/share/open-walnut-demo'
    const b = '/Users/two/.local/share/open-walnut-demo'
    const gen = randomUUID()
    expect(demoTerminalDir(a, gen)).toBe(demoTerminalDir(a, gen))
    expect(demoTerminalDir(`${a}/`, gen)).toBe(demoTerminalDir(a, gen))
    const all = new Set([demoTerminalDir(a, gen), demoTerminalDir(b, gen), demoTerminalDir(a, randomUUID()), demoTerminalDir(b, randomUUID())])
    expect(all.size).toBe(4)
    // No two names collide where a plain concatenation would.
    expect(demoTerminalDir('/x/open-walnut-demo', 'ab')).not.toBe(demoTerminalDir('/x/open-walnut-dem', 'oab'))
  })

  it('refuses a relative root or an unsafe generation', () => {
    expect(() => demoTerminalDir('rel/open-walnut-demo', 'g')).toThrow()
    for (const bad of ['', '..', 'a/b', 'a b', 'a'.repeat(65)]) {
      expect(() => demoTerminalDir('/x/open-walnut-demo', bad), bad).toThrow(/Invalid Demo generation/)
    }
  })
})

describe('demoTerminalDirFromEnv', () => {
  it('names the dir only for a complete, valid Demo identity', () => {
    const root = '/Users/one/.local/share/open-walnut-demo'
    expect(demoTerminalDirFromEnv({ WALNUT_DEMO_ROOT: root, WALNUT_DEMO_GENERATION: 'g' })).toBe(demoTerminalDir(root, 'g'))
    expect(demoTerminalDirFromEnv({})).toBeNull()
    expect(demoTerminalDirFromEnv({ WALNUT_DEMO_ROOT: root })).toBeNull()
    expect(demoTerminalDirFromEnv({ WALNUT_DEMO_ROOT: '/Users/one/elsewhere', WALNUT_DEMO_GENERATION: 'g' })).toBeNull()
    expect(demoTerminalDirFromEnv({ WALNUT_DEMO_ROOT: 'open-walnut-demo', WALNUT_DEMO_GENERATION: 'g' })).toBeNull()
    expect(demoTerminalDirFromEnv({ WALNUT_DEMO_ROOT: root, WALNUT_DEMO_GENERATION: '../g' })).toBeNull()
  })
})

describe('ensureDemoTerminalDir', () => {
  it('makes a 0700 dir claimed for the data dir, and accepts it again', () => {
    const { dir, owner } = freshDir()
    ensureDemoTerminalDir(dir, owner)
    ensureDemoTerminalDir(dir, owner)
    const st = fs.lstatSync(dir)
    expect(st.isDirectory()).toBe(true)
    expect(st.mode & 0o777).toBe(0o700)
    expect(fs.readFileSync(path.join(dir, '.owner'), 'utf8')).toBe(`${owner}\n`)
  })

  it.each([0o000, 0o100, 0o200, 0o300, 0o400, 0o500, 0o600])('refuses private mode %o before writing a marker, without changing the directory', (mode) => {
    const { dir, owner } = freshDir()
    fs.mkdirSync(dir, { mode: 0o700 })
    const actual = fs.lstatSync(dir)
    vi.spyOn(fs, 'lstatSync').mockReturnValue(Object.assign(actual, { mode: (actual.mode & ~0o777) | mode }))
    const write = vi.spyOn(fs, 'writeFileSync')
    const chmod = vi.spyOn(fs, 'chmodSync')
    expect(() => ensureDemoTerminalDir(dir, owner)).toThrow(/needs mode 0700/)
    expect(write).not.toHaveBeenCalled()
    expect(chmod).not.toHaveBeenCalled()
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('refuses a dir claimed for another data dir and keeps its marker', () => {
    const { dir, owner } = freshDir()
    ensureDemoTerminalDir(dir, '/elsewhere/data/g')
    expect(() => ensureDemoTerminalDir(dir, owner)).toThrow(/another Walnut/)
    expect(fs.readFileSync(path.join(dir, '.owner'), 'utf8')).toBe('/elsewhere/data/g\n')
  })

  it('refuses a symlink at the path and writes nothing through it', () => {
    const { dir, owner } = freshDir()
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-demo-term-target-'))
    try {
      fs.chmodSync(target, 0o700)
      fs.symlinkSync(target, dir)
      expect(() => ensureDemoTerminalDir(dir, owner)).toThrow(/private directory/)
      expect(fs.readdirSync(target)).toEqual([])
    } finally {
      fs.rmSync(target, { recursive: true, force: true })
    }
  })

  it('refuses a dir others can read or enter', () => {
    const { dir, owner } = freshDir()
    fs.mkdirSync(dir, { mode: 0o700 })
    fs.chmodSync(dir, 0o755)
    expect(() => ensureDemoTerminalDir(dir, owner)).toThrow(/private directory/)
    expect(fs.existsSync(path.join(dir, '.owner'))).toBe(false)
  })

  it('refuses a dir another account owns', () => {
    if (typeof process.getuid !== 'function') return
    const { dir, owner } = freshDir()
    fs.mkdirSync(dir, { mode: 0o700 })
    const real = process.getuid()
    vi.spyOn(process, 'getuid').mockReturnValue(real + 1)
    expect(() => ensureDemoTerminalDir(dir, owner)).toThrow(/private directory/)
    expect(fs.existsSync(path.join(dir, '.owner'))).toBe(false)
  })

  it('refuses a marker that is a symlink', () => {
    const { dir, owner } = freshDir()
    fs.mkdirSync(dir, { mode: 0o700 })
    fs.symlinkSync('/etc/hosts', path.join(dir, '.owner'))
    expect(() => ensureDemoTerminalDir(dir, owner)).toThrow()
  })

  it('refuses any path that is not a Demo terminal dir', () => {
    for (const bad of ['/tmp/open-walnut/term', '/tmp/open-walnut-demo', '/tmp/walnut-demo-501-xyz', '/var/walnut-demo-501-0123456789abcdef']) {
      expect(() => ensureDemoTerminalDir(bad, '/x'), bad).toThrow(/Not a Demo terminal directory/)
    }
  })
})

describe('checkDemoTerminalDir', () => {
  it('is false for a missing dir and true for its own, creating nothing', async () => {
    const { dir, owner } = freshDir()
    await expect(checkDemoTerminalDir(dir, owner)).resolves.toBe(false)
    expect(fs.existsSync(dir)).toBe(false)
    ensureDemoTerminalDir(dir, owner)
    await expect(checkDemoTerminalDir(dir, owner)).resolves.toBe(true)
  })

  it('throws, removing nothing, for another claim, no claim, a loose mode or a symlink', async () => {
    const { dir, owner } = freshDir()
    ensureDemoTerminalDir(dir, '/elsewhere/data/g')
    await expect(checkDemoTerminalDir(dir, owner)).rejects.toThrow(/another Walnut/)
    fs.unlinkSync(path.join(dir, '.owner'))
    await expect(checkDemoTerminalDir(dir, owner)).rejects.toThrow(/unclaimed/)
    expect(fs.existsSync(dir)).toBe(true)
    fs.writeFileSync(path.join(dir, '.owner'), `${owner}\n`)
    fs.chmodSync(dir, 0o750)
    await expect(checkDemoTerminalDir(dir, owner)).rejects.toThrow(/private directory/)
    const link = freshDir()
    fs.symlinkSync(dir, link.dir)
    await expect(checkDemoTerminalDir(link.dir, owner)).rejects.toThrow(/private directory/)
    await expect(checkDemoTerminalDir('/tmp/open-walnut/term', owner)).rejects.toThrow(/Not a Demo terminal directory/)
  })
})

describe('removeDemoTerminalDir', () => {
  it('removes its own dir with its sockets, and is fine when it is gone', async () => {
    const { dir, owner } = freshDir()
    ensureDemoTerminalDir(dir, owner)
    fs.writeFileSync(path.join(dir, 'walnut-x.dpid'), '1 x\n')
    await removeDemoTerminalDir(dir, owner)
    expect(fs.existsSync(dir)).toBe(false)
    await expect(removeDemoTerminalDir(dir, owner)).resolves.toBeUndefined()
  })

  it('keeps a dir claimed for another data dir', async () => {
    const { dir, owner } = freshDir()
    ensureDemoTerminalDir(dir, '/elsewhere/data/g')
    fs.writeFileSync(path.join(dir, 'walnut-x.dpid'), '1 x\n')
    await expect(removeDemoTerminalDir(dir, owner)).rejects.toThrow(/another Walnut/)
    expect(fs.existsSync(path.join(dir, 'walnut-x.dpid'))).toBe(true)
  })

  it('removes an unclaimed dir only while it is empty', async () => {
    const { dir, owner } = freshDir()
    fs.mkdirSync(dir, { mode: 0o700 })
    fs.writeFileSync(path.join(dir, 'walnut-x.dsock'), '')
    await expect(removeDemoTerminalDir(dir, owner)).rejects.toThrow(/no owner marker/)
    expect(fs.existsSync(path.join(dir, 'walnut-x.dsock'))).toBe(true)
    fs.unlinkSync(path.join(dir, 'walnut-x.dsock'))
    await removeDemoTerminalDir(dir, owner)
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('keeps a symlink at the path and what it points to', async () => {
    const { dir, owner } = freshDir()
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-demo-term-target-'))
    try {
      fs.writeFileSync(path.join(target, '.owner'), `${owner}\n`)
      fs.symlinkSync(target, dir)
      await expect(removeDemoTerminalDir(dir, owner)).rejects.toThrow(/private directory/)
      expect(fs.existsSync(path.join(target, '.owner'))).toBe(true)
    } finally {
      fs.rmSync(target, { recursive: true, force: true })
    }
  })

  it('never touches a path that is not a Demo terminal dir', async () => {
    await expect(removeDemoTerminalDir('/tmp/open-walnut/term', '/x')).rejects.toThrow(/Not a Demo terminal directory/)
  })
})
