/**
 * Regression lock for tests/setup/tmp-reaper.ts: every way a test can create a
 * directory directly under $TMPDIR is recorded and reaped; nothing else is.
 *
 * Runs under the real setup file (vitest.config.ts setupFiles), so the patched
 * fs is the one every test sees — including the NAMED ESM import below, which
 * is exactly the call shape `syncBuiltinESMExports()` exists for.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs, { mkdtempSync as namedMkdtempSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { recordedTmpDirs, reapTmpDirs } from './tmp-reaper'

const tmp = fs.realpathSync(os.tmpdir())
const under = (name: string): string => path.join(tmp, name)
const tag = (): string => `tmp-reaper-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`

describe('tmp-reaper records direct children of $TMPDIR', () => {
  it('mkdtempSync (default import), mkdtempSync (named import), promises.mkdtemp', async () => {
    const a = fs.mkdtempSync(under('tmp-reaper-a-'))
    const b = namedMkdtempSync(under('tmp-reaper-b-'))
    const c = await fsp.mkdtemp(under('tmp-reaper-c-'))
    for (const d of [a, b, c]) expect(recordedTmpDirs().has(fs.realpathSync(d)), d).toBe(true)
  })

  it('mkdtemp callback form', async () => {
    const created = await new Promise<string>((resolve, reject) =>
      fs.mkdtemp(under('tmp-reaper-cb-'), (err, dir) => (err ? reject(err) : resolve(dir))),
    )
    expect(recordedTmpDirs().has(fs.realpathSync(created))).toBe(true)
  })

  it('mkdirSync / promises.mkdir / mkdir callback of a NEW direct child', async () => {
    const a = under(tag())
    fs.mkdirSync(a, { recursive: true })
    const b = under(tag())
    await fsp.mkdir(b)
    const c = under(tag())
    await new Promise<void>((resolve, reject) => fs.mkdir(c, (err) => (err ? reject(err) : resolve())))
    for (const d of [a, b, c]) expect(recordedTmpDirs().has(d), d).toBe(true)
  })

  it('a nested mkdir -p claims the TOP-LEVEL home it brought into existence (createMockConstants shape)', async () => {
    // 577 test files mock constants to `<tmp>/walnut-test-<ts>-<rand>`; the code
    // under test then makes `<home>/tasks` recursively, so the home itself never
    // passes through mkdir. The home is what must be reaped.
    const home = path.join(os.tmpdir(), `tmp-reaper-home-${tag()}`)
    fs.mkdirSync(path.join(home, 'tasks', 'archive'), { recursive: true })
    expect(recordedTmpDirs().has(under(path.basename(home)))).toBe(true)
    const home2 = path.join(os.tmpdir(), `tmp-reaper-home-${tag()}`)
    await fsp.mkdir(path.join(home2, 'memory', 'sessions'), { recursive: true })
    expect(recordedTmpDirs().has(under(path.basename(home2)))).toBe(true)
  })

  it('a file written straight into the root (plugin-updates-cache-<pid>.json shape)', async () => {
    const f1 = path.join(os.tmpdir(), `tmp-reaper-file-${tag()}.json`)
    fs.writeFileSync(f1, '{}')
    const f2 = path.join(os.tmpdir(), `tmp-reaper-file-${tag()}.json`)
    await fsp.writeFile(f2, '{}')
    for (const f of [f1, f2]) expect(recordedTmpDirs().has(under(path.basename(f))), f).toBe(true)
  })

  it('the atomic-write idiom: write <file>.tmp then rename over the final name', async () => {
    const final = path.join(os.tmpdir(), `tmp-reaper-atomic-${tag()}.json`)
    await fsp.writeFile(`${final}.tmp`, '{}')
    await fsp.rename(`${final}.tmp`, final)
    expect(recordedTmpDirs().has(under(path.basename(final)))).toBe(true)
    const final2 = path.join(os.tmpdir(), `tmp-reaper-atomic-${tag()}.json`)
    fs.writeFileSync(`${final2}.tmp`, '{}')
    fs.renameSync(`${final2}.tmp`, final2)
    expect(recordedTmpDirs().has(under(path.basename(final2)))).toBe(true)
  })

  it('the Date.now()-named pattern the leaking tests actually use', () => {
    const dir = path.join(os.tmpdir(), `usage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    fs.mkdirSync(dir, { recursive: true })
    expect(recordedTmpDirs().has(path.join(tmp, path.basename(dir)))).toBe(true)
  })
})

describe('tmp-reaper leaves alone what is not a fresh direct child', () => {
  it('a nested directory or file inside an EXISTING temp dir claims nothing new', () => {
    const parent = under(`tmp-reaper-nest-${tag()}`)
    expect(spawnSync('mkdir', [parent]).status).toBe(0) // made outside this process: another worker's
    fs.mkdirSync(path.join(parent, 'inner'))
    fs.writeFileSync(path.join(parent, 'inner', 'f.txt'), 'x')
    expect(recordedTmpDirs().has(parent)).toBe(false)
    fs.rmSync(parent, { recursive: true, force: true })
  })

  it('a mkdir -p on a direct child that ALREADY existed (a shared dir another worker may use)', () => {
    // Made outside this process, the way another worker or the runner would.
    const shared = under(tag())
    expect(spawnSync('mkdir', [shared]).status).toBe(0)
    expect(recordedTmpDirs().has(shared)).toBe(false)
    fs.mkdirSync(shared, { recursive: true }) // exists → not a creation
    expect(recordedTmpDirs().has(shared)).toBe(false)
    fs.rmSync(shared, { recursive: true, force: true })
  })

  it('the harness-owned names, even when created fresh', () => {
    const own = under(`open-walnut-test-runtime-${tag()}`)
    fs.mkdirSync(own)
    expect(recordedTmpDirs().has(own)).toBe(false)
    fs.rmSync(own, { recursive: true, force: true })
  })

  it('a directory somewhere else entirely', () => {
    const elsewhere = fs.mkdtempSync(under('tmp-reaper-else-'))
    const outside = path.join(elsewhere, 'sub')
    fs.mkdirSync(outside)
    expect([...recordedTmpDirs()].some((d) => d === outside)).toBe(false)
  })
})

describe('reapTmpDirs', () => {
  it('removes recorded dirs that still exist, reports them, and forgets the rest', () => {
    const kept = fs.mkdtempSync(under('tmp-reaper-keep-'))
    const gone = fs.mkdtempSync(under('tmp-reaper-gone-'))
    fs.writeFileSync(path.join(kept, 'payload'), 'x')
    fs.rmSync(gone, { recursive: true }) // the test cleaned up itself

    const removed = reapTmpDirs()

    expect(removed).toContain(kept)
    expect(removed).not.toContain(gone)
    expect(fs.existsSync(kept)).toBe(false)
    expect(recordedTmpDirs().size).toBe(0)
  })
})
