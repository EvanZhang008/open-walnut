/**
 * Behavioral test for the daemon's fs MUTATION family ('fs-mutate-v1'):
 * fsMutateFloor + fsMutateDenied + fsMutateResolve + cmdFsRename / cmdFsRm / cmdFsCopy.
 *
 * The code under test is the session daemon's runtime (`daemon-standalone.ts`
 * and its fs write module, `daemon-fs-write.ts`). These functions live inside
 * the module's factory and are not exported, so we slice each function's text
 * out of the runtime's text (daemonRuntimeText), transpile it, and rebuild it
 * with `new Function` (as daemon-fs-read-bounded-range.test.ts does).
 *
 * Everything runs inside ONE mkdtemp directory, and HOME_DIR is injected as a
 * subdirectory of it — the floor's "never the home directory" rule must be
 * exercised without the real home ever being a candidate.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import ts from 'typescript'
import { daemonRuntimeText } from '../helpers/daemon-runtime-text.js'

type Reply = { ok?: boolean; error?: string; renamed?: boolean; removed?: boolean; copied?: boolean }
type Cmd = Record<string, unknown>

interface Daemon {
  floor: (raw: unknown) => string | null
  denied: (p: string) => boolean
  resolve: (raw: unknown) => Promise<string | null>
  rename: (cmd: Cmd) => Promise<Reply>
  rm: (cmd: Cmd) => Promise<Reply>
  copy: (cmd: Cmd) => Promise<Reply>
}

/** Pull the six functions out of the daemon's runtime and rebuild them. */
function extractMutate(homeDir: string): Daemon {
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
    // Module-level constant the denylist reads, taken verbatim from the daemon so
    // the binding is computed the way the daemon computes it (from the injected
    // empty env, so it lands under the temp HOME_DIR).
    grabLine('const FALLBACK_DAEMON_DIR ='),
    grab('function fsMutateFloor('),
    grab('function fsMutateDenied('),
    grab('async function fsMutateResolve('),
    grab('async function cmdFsRename('),
    grab('async function cmdFsRm('),
    grab('async function cmdFsCopy('),
  ].join('\n')
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

  let reply: Reply = {}
  const sendOk = (_ws: unknown, _id: unknown, data: Reply) => { reply = { ok: true, ...data } }
  const sendError = (_ws: unknown, _id: unknown, error: string) => { reply = { ok: false, error } }

  // The denylist reads the daemon's dir overrides from its env; hand it an
  // EMPTY env so the real machine's WALNUT_* settings can't leak into the pins.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(
    'path', 'fs', 'HOME_DIR', 'daemonEnv', 'sendOk', 'sendError',
    js + '\nreturn { fsMutateFloor, fsMutateDenied, fsMutateResolve, cmdFsRename, cmdFsRm, cmdFsCopy };',
  ) as (...a: unknown[]) => Record<string, (...a: unknown[]) => unknown>
  const fns = factory(path, fs, homeDir, {}, sendOk, sendError)

  const call = async (name: string, cmd: Cmd): Promise<Reply> => {
    reply = {}
    await fns[name](null, 1, cmd)
    return reply
  }
  return {
    floor: (raw) => fns.fsMutateFloor(raw) as string | null,
    denied: (p) => fns.fsMutateDenied(p) as boolean,
    resolve: (raw) => fns.fsMutateResolve(raw) as Promise<string | null>,
    rename: (cmd) => call('cmdFsRename', cmd),
    rm: (cmd) => call('cmdFsRm', cmd),
    copy: (cmd) => call('cmdFsCopy', cmd),
  }
}

let tmp: string
let home: string
let work: string
let daemon: Daemon
const dirs: string[] = []

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fs-mutate-')))
  dirs.push(tmp)
  home = path.join(tmp, 'home')
  work = path.join(tmp, 'work')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(work, { recursive: true })
  daemon = extractMutate(home)
})

afterAll(() => {
  // Every path here was produced by mkdtemp above — nothing outside /tmp is touched.
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})

const at = (rel: string) => path.join(work, rel)

describe('daemon fsMutateFloor', () => {
  it('accepts an ordinary absolute path two levels deep', () => {
    expect(daemon.floor('/tmp/x/y')).toBe('/tmp/x/y')
    expect(daemon.floor(at('a.ts'))).toBe(at('a.ts'))
  })

  it('expands ~ against the injected HOME_DIR', () => {
    expect(daemon.floor('~/projects/a.ts')).toBe(path.join(home, 'projects/a.ts'))
  })

  it('refuses the root, the home directory (with or without a trailing slash), and one-segment paths', () => {
    expect(daemon.floor('/')).toBeNull()
    expect(daemon.floor(home)).toBeNull()
    expect(daemon.floor(home + '/')).toBeNull()
    expect(daemon.floor('~')).toBeNull()
    expect(daemon.floor('/tmp')).toBeNull()
    expect(daemon.floor('/usr')).toBeNull()
  })

  it('refuses relative paths and "." / ".." SEGMENTS, but not names containing dots', () => {
    expect(daemon.floor('a/../b')).toBeNull()
    expect(daemon.floor('/a/../b')).toBeNull()
    expect(daemon.floor('/a/./b')).toBeNull()
    expect(daemon.floor('/a/b/..')).toBeNull()
    // A NAME with dots is an ordinary filename — a substring check would break it.
    expect(daemon.floor('/a/mod..old/thing.ts')).toBe('/a/mod..old/thing.ts')
    expect(daemon.floor('/a/..bar')).toBe('/a/..bar')
  })

  it('refuses non-strings and empty input', () => {
    expect(daemon.floor(undefined)).toBeNull()
    expect(daemon.floor('')).toBeNull()
    expect(daemon.floor(42)).toBeNull()
  })
})

describe('daemon fsMutateDenied', () => {
  it('refuses credential stores by SEGMENT, anywhere on the host', () => {
    for (const p of [
      path.join(home, '.ssh'), path.join(home, '.ssh/id_ed25519'), '/srv/backup/.aws/credentials',
      path.join(home, '.gnupg/x'), path.join(home, '.kube/config'), '/opt/app/secrets/db.env',
      path.join(home, '.open-walnut/auth.json'), '/anywhere/bridge-tokens.json',
    ]) {
      expect(daemon.denied(p), `must deny ${p}`).toBe(true)
    }
    // A NAME containing the word is an ordinary file: substring matching would
    // make the user's own notes undeletable.
    expect(daemon.denied('/work/my.ssh.notes')).toBe(false)
    expect(daemon.denied('/work/secrets-policy.md')).toBe(false)
    expect(daemon.denied('/work/auth.json.example')).toBe(false)
  })

  it('refuses Walnut\'s runtime state: the legacy /tmp roots AND the current ~/.open-walnut/tmp', () => {
    // The stream JSONLs are the conversation history; there is no second copy.
    // Streams moved from /tmp/open-walnut-streams to ~/.open-walnut/tmp/streams
    // in 2026-08 — a denylist that only knew the old root left the new one
    // deletable through the file tree.
    for (const p of [
      '/tmp/open-walnut', '/tmp/open-walnut/sessions.json',
      '/tmp/open-walnut-streams/abc.jsonl',
      path.join(home, '.open-walnut/tmp'),
      path.join(home, '.open-walnut/tmp/streams/abc.jsonl'),
      path.join(home, '.open-walnut/tmp/file-history/x/y.blob'),
    ]) {
      expect(daemon.denied(p), `must deny ${p}`).toBe(true)
    }
    // A sibling that merely shares the prefix is not the runtime root.
    expect(daemon.denied('/tmp/open-walnut-notes/a.md')).toBe(false)
    // The REST of the data dir (skills, notes, config) stays editable: the tree
    // is how a user fixes a broken skill file.
    expect(daemon.denied(path.join(home, '.open-walnut/skills/x/SKILL.md'))).toBe(false)
    expect(daemon.denied(path.join(home, '.open-walnut/config.yaml'))).toBe(false)
  })

  it('refuses the home fallback daemon dir (used when /tmp cannot hold the daemon), not its neighbours', () => {
    for (const p of [
      path.join(home, '.cache/open-walnut'),
      path.join(home, '.cache/open-walnut/daemon.pid'),
      path.join(home, '.cache/open-walnut/bin/walnut'),
    ]) {
      expect(daemon.denied(p), `must deny ${p}`).toBe(true)
    }
    expect(daemon.denied(path.join(home, '.cache/open-walnut-notes/a.md'))).toBe(false)
    expect(daemon.denied(path.join(home, '.cache/other-tool/x'))).toBe(false)
  })
})

describe('daemon fsMutateResolve', () => {
  it('returns the ORIGINAL path for a plain file (never the resolved one)', async () => {
    fs.writeFileSync(at('a.ts'), 'x')
    expect(await daemon.resolve(at('a.ts'))).toBe(at('a.ts'))
  })

  it('refuses a target whose symlinked ANCESTOR launders it into a denied tree', async () => {
    // /work/link -> /home ; /work/link/.ssh is 3 segments deep, has no '..', is
    // not HOME_DIR — every string rule passes, yet the kernel would reach ~/.ssh.
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true })
    fs.symlinkSync(home, at('link'))
    expect(await daemon.resolve(at('link/.ssh'))).toBeNull()
    // And the destructive command behind it refuses too — with the store intact.
    const r = await daemon.rm({ path: at('link/.ssh'), recursive: true })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('(EDENIED)')
    expect(fs.existsSync(path.join(home, '.ssh'))).toBe(true)
  })

  it('lets a missing parent through so the real call reports ENOENT, not a misleading EDENIED', async () => {
    expect(await daemon.resolve(at('nope/a.ts'))).toBe(at('nope/a.ts'))
    const r = await daemon.rm({ path: at('nope/a.ts') })
    expect(r.error).toContain('(ENOENT)')
  })
})

describe('daemon cmdFsRename', () => {
  it('renames a file', async () => {
    fs.writeFileSync(at('a.ts'), 'x')
    const r = await daemon.rename({ from: at('a.ts'), to: at('b.ts') })
    expect(r).toEqual({ ok: true, renamed: true })
    expect(fs.existsSync(at('a.ts'))).toBe(false)
    expect(fs.readFileSync(at('b.ts'), 'utf-8')).toBe('x')
  })

  it('refuses an existing target with EEXIST instead of clobbering it', async () => {
    fs.writeFileSync(at('a.ts'), 'source')
    fs.writeFileSync(at('b.ts'), 'victim')
    const r = await daemon.rename({ from: at('a.ts'), to: at('b.ts') })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('(EEXIST)')
    // The whole point: the other file is still there.
    expect(fs.readFileSync(at('b.ts'), 'utf-8')).toBe('victim')
    expect(fs.existsSync(at('a.ts'))).toBe(true)
  })

  it('reports ENOENT for a missing source', async () => {
    const r = await daemon.rename({ from: at('missing.ts'), to: at('b.ts') })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('(ENOENT)')
  })

  it('refuses a path outside the floor with EDENIED', async () => {
    fs.writeFileSync(at('a.ts'), 'x')
    for (const cmd of [
      { from: '/', to: at('b.ts') },
      { from: at('a.ts'), to: home },
      { from: at('a.ts'), to: '/tmp' },
      { from: at('a.ts'), to: 'relative.ts' },
    ]) {
      const r = await daemon.rename(cmd)
      expect(r.ok).toBe(false)
      expect(r.error).toContain('(EDENIED)')
    }
    expect(fs.existsSync(at('a.ts'))).toBe(true)
  })
})

describe('daemon cmdFsRm', () => {
  it('removes a file', async () => {
    fs.writeFileSync(at('a.ts'), 'x')
    const r = await daemon.rm({ path: at('a.ts') })
    expect(r).toEqual({ ok: true, removed: true })
    expect(fs.existsSync(at('a.ts'))).toBe(false)
  })

  it('refuses a directory without recursive (EISDIR) and keeps its contents', async () => {
    fs.mkdirSync(at('dir/inner'), { recursive: true })
    fs.writeFileSync(at('dir/inner/a.ts'), 'x')
    const r = await daemon.rm({ path: at('dir') })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('(EISDIR)')
    expect(fs.existsSync(at('dir/inner/a.ts'))).toBe(true)
  })

  it('removes a directory tree with recursive:true', async () => {
    fs.mkdirSync(at('dir/inner'), { recursive: true })
    fs.writeFileSync(at('dir/inner/a.ts'), 'x')
    const r = await daemon.rm({ path: at('dir'), recursive: true })
    expect(r).toEqual({ ok: true, removed: true })
    expect(fs.existsSync(at('dir'))).toBe(false)
  })

  it('reports ENOENT for a missing path', async () => {
    const r = await daemon.rm({ path: at('gone.ts') })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('(ENOENT)')
  })

  it('refuses the root, HOME, and one-segment paths with EDENIED', async () => {
    for (const p of ['/', home, '/tmp', '/usr']) {
      // Check the floor FIRST and let the assertion abort the test if it ever
      // stops refusing: this is the one call in the file that could do real
      // damage (a recursive delete of a real path) if the code under test broke,
      // so the dangerous call is never reached unless the guard already held.
      expect(daemon.floor(p), `floor must refuse ${p}`).toBeNull()
      const r = await daemon.rm({ path: p, recursive: true })
      expect(r.ok, `expected EDENIED for ${p}`).toBe(false)
      expect(r.error).toContain('(EDENIED)')
    }
    expect(fs.existsSync(home)).toBe(true)
  })

  it('removes a symlink as the LINK, never through it', async () => {
    fs.writeFileSync(at('target.ts'), 'keep me')
    fs.symlinkSync(at('target.ts'), at('link.ts'))
    const r = await daemon.rm({ path: at('link.ts') })
    expect(r.ok).toBe(true)
    expect(fs.existsSync(at('link.ts'))).toBe(false)
    expect(fs.readFileSync(at('target.ts'), 'utf-8')).toBe('keep me')
  })
})

describe('daemon cmdFsCopy', () => {
  it('copies a file', async () => {
    fs.writeFileSync(at('a.ts'), 'x')
    const r = await daemon.copy({ from: at('a.ts'), to: at('b.ts') })
    expect(r).toEqual({ ok: true, copied: true })
    expect(fs.readFileSync(at('a.ts'), 'utf-8')).toBe('x')
    expect(fs.readFileSync(at('b.ts'), 'utf-8')).toBe('x')
  })

  it('copies a directory tree', async () => {
    fs.mkdirSync(at('dir/inner'), { recursive: true })
    fs.writeFileSync(at('dir/inner/a.ts'), 'deep')
    const r = await daemon.copy({ from: at('dir'), to: at('copy') })
    expect(r.ok).toBe(true)
    expect(fs.readFileSync(at('copy/inner/a.ts'), 'utf-8')).toBe('deep')
  })

  it('refuses an existing target with EEXIST', async () => {
    fs.writeFileSync(at('a.ts'), 'source')
    fs.writeFileSync(at('b.ts'), 'victim')
    const r = await daemon.copy({ from: at('a.ts'), to: at('b.ts') })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('(EEXIST)')
    expect(fs.readFileSync(at('b.ts'), 'utf-8')).toBe('victim')
  })

  it('refuses a path outside the floor with EDENIED', async () => {
    fs.writeFileSync(at('a.ts'), 'x')
    const r = await daemon.copy({ from: at('a.ts'), to: '/tmp' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('(EDENIED)')
  })
})
