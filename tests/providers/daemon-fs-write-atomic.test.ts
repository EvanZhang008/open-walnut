/**
 * Behavioral test for the daemon's fs.write conditional/atomic write
 * ('fs-write-atomic-v1'): `~` expansion, the `atomic` rename, the
 * `expectSha256` precondition, and the `sha256` echo.
 *
 * The code under test is the session daemon's runtime (`daemon-standalone.ts`
 * and its fs write module, `daemon-fs-write.ts`). These functions live inside
 * the module's factory and are not exported, so we slice each function's text
 * out of the runtime's text, transpile it, and rebuild it with `new Function`,
 * exactly like tests/providers/daemon-fs-mutate.test.ts.
 *
 * Everything runs inside ONE mkdtemp directory, and HOME_DIR is injected as a
 * subdirectory of it — the `~` expansion must be exercised without the real home
 * ever being a candidate.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import ts from 'typescript'
import { ok, fail, type Answer } from '../../src/providers/daemon-module-deps.js'
import { daemonRuntimeText } from '../helpers/daemon-runtime-text.js'

type Reply = { ok?: boolean; error?: string; written?: boolean; size?: number; sha256?: string }
type Cmd = Record<string, unknown>

/** Pull cmdFsWrite (plus the floor helpers it calls) out of the daemon's runtime. */
function extractWrite(homeDir: string): (cmd: Cmd) => Promise<Reply> {
  // The runtime's text: daemon-standalone.ts, then its area modules (cmdFsWrite and the floor helpers are daemon-fs-write.ts).
  const src = daemonRuntimeText()

  const grab = (header: string): string => {
    const i = src.indexOf('\n' + header)
    expect(i, `${header} not found in the daemon`).toBeGreaterThan(-1)
    const end = src.indexOf('\n}', i + 1)
    expect(end).toBeGreaterThan(i)
    return src.slice(i + 1, end + 2)
  }
  const grabLine = (prefix: string): string => {
    const i = src.indexOf('\n' + prefix)
    expect(i, `${prefix} not found in the daemon`).toBeGreaterThan(-1)
    return src.slice(i + 1, src.indexOf('\n', i + 1) + 1)
  }
  const code = [
    // Read by fsMutateDenied; taken verbatim from the daemon (see daemon-fs-mutate.test.ts).
    grabLine('const FALLBACK_DAEMON_DIR ='),
    grabLine('const FS_WRITE_PRECONDITION_MAX_BYTES ='),
    grabLine('const FS_WRITE_TEMP_STALE_MS ='),
    grab('function fsMutateFloor('),
    grab('function fsMutateDenied('),
    grab('async function fsMutateResolve('),
    grab('async function sweepStaleWriteTemps('),
    grab('async function cmdFsWrite('),
  ].join('\n')
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

  // The denylist reads the daemon's dir overrides from its env; hand it an
  // EMPTY env so the real machine's WALNUT_* settings can't leak into the pins.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(
    'path', 'fs', 'crypto', 'HOME_DIR', 'daemonEnv', 'ok', 'fail', js + '\nreturn { cmdFsWrite };',
  ) as (...a: unknown[]) => Record<string, (...a: unknown[]) => Promise<Answer>>
  const fns = factory(path, fs, crypto, homeDir, {}, ok, fail)

  return async (cmd: Cmd): Promise<Reply> => {
    const a = await fns.cmdFsWrite(cmd)
    return a.ok ? { ok: true, ...a.data } : { ok: false, error: a.error }
  }
}

const sha = (s: string) => crypto.createHash('sha256').update(Buffer.from(s, 'utf-8')).digest('hex')

let tmp: string
let home: string
let work: string
let write: (cmd: Cmd) => Promise<Reply>
const dirs: string[] = []

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fs-write-')))
  dirs.push(tmp)
  home = path.join(tmp, 'home')
  work = path.join(tmp, 'work')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(work, { recursive: true })
  write = extractWrite(home)
})

afterAll(() => {
  // Every path here was produced by mkdtemp above — nothing outside /tmp is touched.
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})

const at = (rel: string) => path.join(work, rel)
const tmpSiblings = (dir: string) => fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))

describe('daemon cmdFsWrite ~ expansion', () => {
  it('expands a leading ~ against HOME_DIR and creates missing parents', async () => {
    const r = await write({ path: '~/x/settings.json', data: '{"a":1}', encoding: 'utf-8' })
    expect(r.ok).toBe(true)
    expect(fs.readFileSync(path.join(home, 'x/settings.json'), 'utf-8')).toBe('{"a":1}')
    // The bug this fixes: a literal './~' directory next to the daemon's cwd.
    expect(fs.existsSync(path.join(work, '~'))).toBe(false)
  })
})

describe('daemon cmdFsWrite atomic', () => {
  it('replaces an existing file, leaves no tmp sibling, and preserves its mode', async () => {
    fs.writeFileSync(at('settings.json'), 'old')
    fs.chmodSync(at('settings.json'), 0o600)
    const r = await write({ path: at('settings.json'), data: 'new', encoding: 'utf-8', atomic: true })
    expect(r.ok).toBe(true)
    expect(fs.readFileSync(at('settings.json'), 'utf-8')).toBe('new')
    expect(tmpSiblings(work)).toEqual([])
    // A fresh temp file would take the umask default and silently widen a 0600
    // credential file.
    expect(fs.statSync(at('settings.json')).mode & 0o777).toBe(0o600)
  })

  it('creates a missing file atomically (no old mode to preserve)', async () => {
    const r = await write({ path: at('deep/new.json'), data: 'fresh', encoding: 'utf-8', atomic: true })
    expect(r.ok).toBe(true)
    expect(fs.readFileSync(at('deep/new.json'), 'utf-8')).toBe('fresh')
    expect(tmpSiblings(at('deep'))).toEqual([])
  })

  it('writes THROUGH a symlink: the link stays a link and the file it points to changes', async () => {
    // A dotfiles-managed settings.json: ~/.claude/settings.json -> ~/dotfiles/claude/settings.json.
    fs.mkdirSync(at('dotfiles'))
    fs.writeFileSync(at('dotfiles/settings.json'), 'repo copy')
    fs.symlinkSync(at('dotfiles/settings.json'), at('settings.json'))
    const r = await write({
      path: at('settings.json'), data: 'edited', encoding: 'utf-8',
      atomic: true, expectSha256: sha('repo copy'),
    })
    expect(r.ok).toBe(true)
    // rename(2) onto the link name would have replaced the link with a plain file.
    expect(fs.lstatSync(at('settings.json')).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(at('dotfiles/settings.json'), 'utf-8')).toBe('edited')
    expect(tmpSiblings(work)).toEqual([])
    expect(tmpSiblings(at('dotfiles'))).toEqual([])
  })

  it('sweeps a temp sibling an interrupted write left behind, and keeps a fresh one', async () => {
    fs.writeFileSync(at('settings.json'), 'old')
    const dead = at('.settings.json.walnut-dead0000.tmp')
    const live = at('.settings.json.walnut-live0000.tmp')
    fs.writeFileSync(dead, 'half-written')
    fs.writeFileSync(live, 'someone else, right now')
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    fs.utimesSync(dead, twoHoursAgo, twoHoursAgo)
    const r = await write({ path: at('settings.json'), data: 'new', encoding: 'utf-8', atomic: true })
    expect(r.ok).toBe(true)
    expect(tmpSiblings(work)).toEqual(['.settings.json.walnut-live0000.tmp'])
    fs.unlinkSync(live)
  })
})

describe('daemon cmdFsWrite expectSha256', () => {
  it('writes when the expected sha matches and echoes the sha of the NEW bytes', async () => {
    fs.writeFileSync(at('settings.json'), 'old')
    const r = await write({
      path: at('settings.json'), data: 'new', encoding: 'utf-8',
      atomic: true, expectSha256: sha('old'),
    })
    expect(r.ok).toBe(true)
    expect(r.sha256).toBe(sha('new'))
    expect(fs.readFileSync(at('settings.json'), 'utf-8')).toBe('new')
  })

  it('refuses a stale expectation with EMODIFIED, touching nothing', async () => {
    fs.writeFileSync(at('settings.json'), 'changed by the CLI')
    const r = await write({
      path: at('settings.json'), data: 'my edit', encoding: 'utf-8',
      atomic: true, expectSha256: sha('what I read earlier'),
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('EMODIFIED')
    // The whole point: the other writer's bytes survive.
    expect(fs.readFileSync(at('settings.json'), 'utf-8')).toBe('changed by the CLI')
    expect(tmpSiblings(work)).toEqual([])
  })

  it('refuses a non-regular file BEFORE opening it (a FIFO with no writer would wedge a thread)', async () => {
    execFileSync('mkfifo', [at('pipe')])
    const r = await write({
      path: at('pipe'), data: 'x', encoding: 'utf-8', atomic: true, expectSha256: sha(''),
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('ENOTFILE')
    expect(fs.statSync(at('pipe')).isFIFO()).toBe(true)
    expect(tmpSiblings(work)).toEqual([])
  })

  it('refuses to hash a file larger than the read ceiling instead of loading it', async () => {
    // A sparse file: the size is the only thing that matters here.
    fs.writeFileSync(at('huge.json'), '')
    fs.truncateSync(at('huge.json'), 32 * 1024 * 1024 + 1)
    const r = await write({
      path: at('huge.json'), data: '{}', encoding: 'utf-8', atomic: true, expectSha256: sha(''),
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('EFBIG')
    expect(fs.statSync(at('huge.json')).size).toBe(32 * 1024 * 1024 + 1)
  })

  it("treats 'absent' as must-not-exist-yet: creates, then refuses the second write", async () => {
    const first = await write({
      path: at('fresh.json'), data: 'one', encoding: 'utf-8', expectSha256: 'absent',
    })
    expect(first.ok).toBe(true)
    expect(fs.readFileSync(at('fresh.json'), 'utf-8')).toBe('one')

    const second = await write({
      path: at('fresh.json'), data: 'two', encoding: 'utf-8', expectSha256: 'absent',
    })
    expect(second.ok).toBe(false)
    expect(second.error).toContain('EMODIFIED')
    expect(fs.readFileSync(at('fresh.json'), 'utf-8')).toBe('one')
  })
})

describe('daemon cmdFsWrite legacy shape', () => {
  it('writes plainly with no atomic/expectSha256 and reports written + size + sha256', async () => {
    const data = Buffer.from('plain bytes', 'utf-8').toString('base64')
    const r = await write({ path: at('a.txt'), data })
    expect(r).toEqual({ ok: true, written: true, size: 11, sha256: sha('plain bytes') })
    expect(fs.readFileSync(at('a.txt'), 'utf-8')).toBe('plain bytes')
    expect(tmpSiblings(work)).toEqual([])
  })

  it('still accepts empty data as a legal zero-byte write', async () => {
    fs.writeFileSync(at('a.txt'), 'something')
    const r = await write({ path: at('a.txt'), data: '', encoding: 'utf-8' })
    expect(r.ok).toBe(true)
    expect(r.size).toBe(0)
    expect(r.sha256).toBe(sha(''))
    expect(fs.readFileSync(at('a.txt'), 'utf-8')).toBe('')
  })

  it('still accepts empty data on the atomic path', async () => {
    fs.writeFileSync(at('a.txt'), 'something')
    const r = await write({ path: at('a.txt'), data: '', encoding: 'utf-8', atomic: true })
    expect(r.ok).toBe(true)
    expect(r.size).toBe(0)
    expect(fs.readFileSync(at('a.txt'), 'utf-8')).toBe('')
    expect(tmpSiblings(work)).toEqual([])
  })
})
