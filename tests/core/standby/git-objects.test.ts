/**
 * Git's object store in a batch (src/core/standby/change-rules.ts `content-addressed`,
 * batch-place.ts, git-tips.ts): an object git moves into a pack around the batch's moment is
 * never left out, a pack that comes or goes while a round reads the store fails that round, and
 * every object a ref of the batch names is in the batch.
 *
 * MACHINE SAFETY: every home and target is a temp dir; the readdir spy only adds files to the
 * test's own home and is restored after each test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { snapshotTo } from '../../../src/core/standby/index.js'
import { idxHas, missingRefTips } from '../../../src/core/standby/git-tips.js'
import type { BatchFile } from '../../../src/core/standby/types.js'
import { sandbox, write, type Sandbox } from './helpers.js'

let sb: Sandbox | null = null
afterEach(async () => { vi.restoreAllMocks(); await sb?.cleanup(); sb = null })

const sha1 = (b: Buffer | string) => crypto.createHash('sha1').update(b).digest('hex')
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A body whose sha1 starts like `prefix`, so its loose object lands in a dir the walk listed. */
function objectIn(prefix: string): { id: string; body: Buffer } {
  for (let n = 0; ; n++) {
    const body = Buffer.from(`object ${n} ${crypto.randomUUID()}`)
    const id = sha1(body)
    if (id.startsWith(prefix)) return { id, body }
  }
}

async function homeWithRepo(name: string): Promise<{ home: string; oldId: string }> {
  sb = await sandbox(name)
  const old = Buffer.from('old object')
  const oldId = sha1(old)
  write(sb.home, `.git/objects/${oldId.slice(0, 2)}/${oldId.slice(2)}`, old)
  write(sb.home, `.git/objects/pack/pack-${'0'.repeat(40)}.pack`, 'p0')
  write(sb.home, `.git/objects/pack/pack-${'0'.repeat(40)}.idx`, 'i0')
  write(sb.home, '.git/HEAD', 'ref: refs/heads/main\n')
  write(sb.home, '.git/refs/heads/main', `${oldId}\n`)
  write(sb.home, 'notes/a.md', 'a\n')
  await pause(50)
  const first = await snapshotTo(sb.home, sb.target)
  expect(first.ok, first.ok ? '' : first.reason).toBe(true)
  await pause(50)
  return { home: sb.home, oldId }
}

describe('git objects in a batch', () => {
  it('an object written after the walk and packed and pruned inside the hold is in the batch, in its pack', async () => {
    const { home, oldId } = await homeWithRepo('git-pack-in-hold')
    const { id, body } = objectIn(oldId.slice(0, 2))
    const objAbs = path.join(home, '.git/objects', id.slice(0, 2), id.slice(2))
    const pack = `.git/objects/pack/pack-${'1'.repeat(40)}`
    let afterWalk = false
    let packed = false
    const readdir = fsp.readdir.bind(fsp)
    vi.spyOn(fsp, 'readdir').mockImplementation((async (p: fs.PathLike, o?: unknown) => {
      // The hold lists the object's dir again (it changed since the walk): just before, git's
      // repack renames its pack in and prunes the loose object. The pack dir was stat'ed
      // before, unchanged, so the hold does not list it.
      if (String(p) === path.dirname(objAbs) && afterWalk && !packed) {
        packed = true
        fs.writeFileSync(path.join(home, `${pack}.pack`), body)
        fs.writeFileSync(path.join(home, `${pack}.idx`), `${id}\n`)
        fs.rmSync(objAbs)
      }
      return readdir(p as string, o as never)
    }) as never)
    const out = await snapshotTo(home, sb!.target, {
      hooks: {
        afterScan: async () => {
          if (afterWalk) return
          afterWalk = true
          fs.writeFileSync(objAbs, body)
          fs.writeFileSync(path.join(home, '.git/refs/heads/main'), `${id}\n`)
          await pause(30)
        },
      },
    })
    expect(packed, 'the repack ran inside the hold').toBe(true)
    expect(out.ok, out.ok ? '' : out.reason).toBe(true)
    const copy = path.join(sb!.target, 'copy')
    expect(fs.readFileSync(path.join(copy, '.git/refs/heads/main'), 'utf8').trim()).toBe(id)
    const loose = fs.existsSync(path.join(copy, '.git/objects', id.slice(0, 2), id.slice(2)))
    const inPack = fs.existsSync(path.join(copy, `${pack}.idx`)) && fs.readFileSync(path.join(copy, `${pack}.pack`)).equals(body)
    expect(loose || inPack, 'the object the branch names is in the copy').toBe(true)
  })

  it('a pack that comes while the round reads the store fails that round; the next takes it', async () => {
    const { home } = await homeWithRepo('git-pack-during-place')
    const packDir = path.join(home, '.git/objects/pack')
    let lists = 0
    const readdir = fsp.readdir.bind(fsp)
    vi.spyOn(fsp, 'readdir').mockImplementation((async (p: fs.PathLike, o?: unknown) => {
      const got = await readdir(p as string, o as never)
      // The second walk of the first round lists the pack dir; a repack renames a pack in right after.
      if (String(p) === packDir && ++lists === 2) fs.writeFileSync(path.join(packDir, `pack-${'2'.repeat(40)}.pack`), 'p2')
      return got
    }) as never)
    const out = await snapshotTo(home, sb!.target)
    expect(out.ok, out.ok ? '' : out.reason).toBe(true)
    if (!out.ok) return
    expect(out.stats.roundFailures).toEqual([expect.stringMatching(/\.git\/objects\/pack: a pack came or went while the batch read the object store/)])
    expect(fs.existsSync(path.join(sb!.target, 'copy', `.git/objects/pack/pack-${'2'.repeat(40)}.pack`))).toBe(true)
  })

  it('a branch naming an object no listing showed fails the round: the ref check under the rules', async () => {
    const { home, oldId } = await homeWithRepo('git-tip-unseen')
    const { id, body } = objectIn(oldId.slice(0, 2))
    const objAbs = path.join(home, '.git/objects', id.slice(0, 2), id.slice(2))
    fs.writeFileSync(objAbs, body)
    fs.writeFileSync(path.join(home, '.git/refs/heads/main'), `${id}\n`)
    await pause(30)
    // Every listing of its dir misses it (a listing racing a repack can, in principle).
    const readdir = fsp.readdir.bind(fsp)
    vi.spyOn(fsp, 'readdir').mockImplementation((async (p: fs.PathLike, o?: unknown) => {
      const got = (await readdir(p as string, o as never)) as Array<string | fs.Dirent>
      if (String(p) !== path.dirname(objAbs)) return got
      return got.filter((e) => (typeof e === 'string' ? e : e.name) !== id.slice(2))
    }) as never)
    const out = await snapshotTo(home, sb!.target, { maxRounds: 2 })
    expect(out.ok).toBe(false)
    expect(!out.ok && out.reason).toBe(`git's .git/refs/heads/main names ${id}, which the batch does not hold`)
  })

  const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'pipe' }); return true } catch { return false } })()
  it.skipIf(!hasGit)('the ref check finds a branch whose object the batch lacks, in a real repo and its packs', async () => {
    sb = await sandbox('git-tips')
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
    const git = (...a: string[]) => execFileSync('git', a, { cwd: sb!.home, env, stdio: 'pipe' }).toString().trim()
    git('init', '-q', '-b', 'main')
    write(sb.home, 'a.md', 'a\n')
    git('add', '-A')
    git('commit', '-qm', 'one')
    git('repack', '-adq')
    write(sb.home, 'b.md', 'b\n')
    git('add', '-A')
    git('commit', '-qm', 'two')
    const head = git('rev-parse', 'HEAD')
    const first = git('rev-parse', 'HEAD~1')
    const idx = fs.readdirSync(path.join(sb.home, '.git/objects/pack')).find((n) => n.endsWith('.idx'))!
    expect(await idxHas(path.join(sb.home, '.git/objects/pack', idx), first)).toBe(true)
    expect(await idxHas(path.join(sb.home, '.git/objects/pack', idx), head)).toBe(false)
    expect(await idxHas(path.join(sb.home, 'a.md'), head)).toBe(null)

    const entry = (rel: string): BatchFile => {
      const buf = fs.readFileSync(path.join(sb!.home, rel))
      return { p: rel, size: buf.length, h: crypto.createHash('sha256').update(buf).digest('hex'), src: { s: buf.length, m: 0, c: 0, i: 0 } }
    }
    const looseHead = `.git/objects/${head.slice(0, 2)}/${head.slice(2)}`
    const refs = ['.git/HEAD', '.git/refs/heads/main']
    const files = (extra: string[]) => new Map([...refs, ...extra].map((rel) => [rel, entry(rel)]))
    expect(await missingRefTips(sb.home, files([looseHead]))).toEqual([])
    expect(await missingRefTips(sb.home, files([]))).toEqual([`.git/refs/heads/main names ${head}`])
    // Packed: found in the batch's pack.
    git('repack', '-adq')
    const packIdx = `.git/objects/pack/${fs.readdirSync(path.join(sb.home, '.git/objects/pack')).find((n) => n.endsWith('.idx'))!}`
    expect(await missingRefTips(sb.home, files([packIdx, packIdx.replace(/\.idx$/, '.pack')]))).toEqual([])
    // An index without its pack holds nothing: git could not read the object from it.
    expect(await missingRefTips(sb.home, files([packIdx]))).toEqual([`.git/refs/heads/main names ${head}`])
    // A ref that moved since the batch read it is not checked (its content at the moment is the batch's).
    const moved = files([])
    write(sb.home, '.git/refs/heads/main', `${first}\n`)
    expect(await missingRefTips(sb.home, moved)).toEqual([])
    // An object the home lacks too is the leader's own state, not the batch's miss.
    write(sb.home, '.git/refs/heads/main', `${'f'.repeat(40)}\n`)
    expect(await missingRefTips(sb.home, files([]))).toEqual([])
  })
})
