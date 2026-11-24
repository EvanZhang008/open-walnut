/**
 * A batch completes while the leader keeps writing, however long the home takes to read.
 *
 * A home of real size takes minutes to read, and the leader never stops writing: its git
 * auto-commit every 30 s, its stores, its notes. When a batch fixed its moment before that read,
 * any file written during it voided the batch (one rehearsal on a 20 GB home: 12 voids in 55
 * minutes, every one a file under .git/objects), so no batch ever completed. Each test here
 * reads a home slower than its writers write, and checks that one batch completes and that it is
 * still the home as of one moment: git's refs name objects the copy holds, every object's bytes
 * hash to its name, and files one writer section writes together agree.
 *
 * MACHINE SAFETY: every home and target is a temp dir; the writers are a child process of this
 * test that stops when its stop file appears (and is killed in afterEach), plus a timer here.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { snapshotTo, verifyStandby } from '../../../src/core/standby/index.js'
import { gated, setWriteGateEnabled } from '../../../src/utils/write-gate.js'
import { sandbox, walk, write, type Sandbox } from './helpers.js'

let sb: Sandbox
let child: ChildProcess | null = null
let timer: ReturnType<typeof setInterval> | null = null
afterEach(async () => {
  if (timer) clearInterval(timer)
  timer = null
  if (child && child.exitCode === null) child.kill('SIGKILL')
  child = null
  setWriteGateEnabled(false)
  await sb?.cleanup()
})

const FILLER = 'artifacts/fill/'
/** Each filler file's read takes this long: the home takes several writer intervals to read. */
const SLOW_READ_MS = 100
const slowRead = async (rel: string) => { if (rel.startsWith(FILLER)) await new Promise((r) => setTimeout(r, SLOW_READ_MS)) }

function seedFiller(home: string, files: number): void {
  for (let i = 0; i < files; i++) write(home, `${FILLER}f-${String(i).padStart(3, '0')}.bin`, crypto.randomBytes(64 * 1024))
}

/**
 * The git writer, as a process of its own: git's own write patterns on a fake object store.
 * Every tick it writes a loose object (a temp file renamed to the hash of its bytes) and touches
 * an older one (git freshens an object it writes again); every 8th tick it moves the branch and
 * rewrites the index through a lock file renamed into place; every 12th it packs the loose
 * objects into a new pack (pack, then idx) and removes the loose ones it packed, and every 36th
 * packs everything and removes the old packs. A plain file is rewritten in place every tick (a
 * writer outside the write gate).
 */
const GIT_WRITER = String.raw`
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
const [home, stopFile] = process.argv.slice(2)
const git = path.join(home, '.git')
const objects = path.join(git, 'objects')
const packDir = path.join(objects, 'pack')
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex')
const objPath = (id) => path.join(objects, id.slice(0, 2), id.slice(2))
const loose = () => {
  const out = []
  for (const d of fs.readdirSync(objects)) {
    if (!/^[0-9a-f]{2}$/.test(d)) continue
    for (const f of fs.readdirSync(path.join(objects, d))) if (/^[0-9a-f]{38}$/.test(f)) out.push(d + f)
  }
  return out
}
const replace = (lock, target, body) => { fs.writeFileSync(lock, body); fs.renameSync(lock, target) }
function writeObject(body) {
  const id = sha1(body)
  fs.mkdirSync(path.dirname(objPath(id)), { recursive: true })
  const tmp = path.join(path.dirname(objPath(id)), 'tmp_obj_' + crypto.randomBytes(3).toString('hex'))
  fs.writeFileSync(tmp, body)
  fs.renameSync(tmp, objPath(id))
  return id
}
function repack(full) {
  const contents = {}
  const ids = loose()
  for (const id of ids) contents[id] = fs.readFileSync(objPath(id)).toString('base64')
  const old = fs.readdirSync(packDir).filter((f) => f.endsWith('.idx'))
  if (full) for (const idx of old) Object.assign(contents, JSON.parse(fs.readFileSync(path.join(packDir, idx.replace(/\.idx$/, '.pack')), 'utf8')))
  const list = Object.keys(contents).sort()
  if (!list.length) return
  const name = 'pack-' + sha1(list.join('\n'))
  if (fs.existsSync(path.join(packDir, name + '.idx'))) return
  const sorted = Object.fromEntries(list.map((id) => [id, contents[id]]))
  replace(path.join(packDir, 'tmp_pack_' + crypto.randomBytes(3).toString('hex')), path.join(packDir, name + '.pack'), JSON.stringify(sorted))
  replace(path.join(packDir, 'tmp_idx_' + crypto.randomBytes(3).toString('hex')), path.join(packDir, name + '.idx'), list.join('\n') + '\n')
  // Only once the new pack is whole: the loose objects it holds go, and (full) the old packs, idx first.
  for (const id of ids) fs.rmSync(objPath(id), { force: true })
  if (full) for (const idx of old) if (!idx.startsWith(name)) {
    fs.rmSync(path.join(packDir, idx), { force: true })
    fs.rmSync(path.join(packDir, idx.replace(/\.idx$/, '.pack')), { force: true })
  }
}
let n = 0
let newest = null
const tick = () => {
  if (fs.existsSync(stopFile)) { clearInterval(t); return }
  n++
  newest = writeObject(Buffer.from('object ' + n + ' ' + crypto.randomBytes(8).toString('hex')))
  const others = loose()
  if (others.length > 1) { const old = others[n % others.length]; const now = new Date(); try { fs.utimesSync(objPath(old), now, now) } catch {} }
  if (n % 8 === 0) {
    replace(path.join(git, 'refs/heads/main.lock'), path.join(git, 'refs/heads/main'), newest + '\n')
    replace(path.join(git, 'index.lock'), path.join(git, 'index'), 'index at ' + n + '\n')
  }
  if (n % 12 === 0) repack(n % 36 === 0)
  fs.writeFileSync(path.join(home, 'notes/journal.md'), 'journal entry ' + n + '\n')
}
const t = setInterval(tick, 40)
tick()
`

function startGitWriter(root: string, home: string): string {
  const stop = path.join(root, 'stop-writers')
  const script = path.join(root, 'git-writer.mjs')
  fs.writeFileSync(script, GIT_WRITER)
  for (const d of ['.git/objects/pack', '.git/refs/heads', 'notes']) fs.mkdirSync(path.join(home, d), { recursive: true })
  fs.writeFileSync(path.join(home, '.git/HEAD'), 'ref: refs/heads/main\n')
  child = spawn(process.execPath, [script, home, stop], { stdio: 'ignore' })
  return stop
}

/** Walnut's own writer: one gated section writes three files, so at any moment outside a section they agree. */
function startStoreWriter(home: string): void {
  setWriteGateEnabled(true)
  let n = 0
  write(home, 'tasks/counter.json', '0')
  write(home, 'notes/pair-a.md', '0')
  write(home, 'notes/pair-b.md', '0')
  timer = setInterval(() => {
    void gated(async () => {
      n++
      const tmp = path.join(home, 'tasks/.counter.json.next')
      fs.writeFileSync(tmp, String(n))
      fs.renameSync(tmp, path.join(home, 'tasks/counter.json'))
      await fs.promises.writeFile(path.join(home, 'notes/pair-a.md'), String(n))
      fs.writeFileSync(path.join(home, 'notes/.pair-b.next'), String(n))
      fs.renameSync(path.join(home, 'notes/.pair-b.next'), path.join(home, 'notes/pair-b.md'))
    })
  }, 30)
}

const copyOf = (rel: string) => path.join(sb.target, 'copy', rel)

/** With STANDBY_STATS_FILE set (a measurement run), each batch's rounds and times go there, one JSON line each. */
function report(label: string, out: Awaited<ReturnType<typeof snapshotTo>>): void {
  const file = process.env.STANDBY_STATS_FILE
  if (!file) return
  const { rounds, passes, roundFailures, catchUpMs, holdMs, totalMs, stagedFiles, heldStatFiles } = out.stats
  fs.appendFileSync(file, `${JSON.stringify({ label, ok: out.ok, reason: out.ok ? undefined : out.reason, rounds, passes, roundFailures, catchUpMs: Math.round(catchUpMs), holdMs: Math.round(holdMs), totalMs: Math.round(totalMs), stagedFiles, heldStatFiles })}\n`)
}

/** The copy's object store is whole: each loose object hashes to its name, each idx has its pack, and the branch's object is there. */
function checkObjectStore(): { loose: number; packs: number } {
  const objects = copyOf('.git/objects')
  const inPacks = new Set<string>()
  let packs = 0
  for (const f of fs.existsSync(path.join(objects, 'pack')) ? fs.readdirSync(path.join(objects, 'pack')) : []) {
    expect(f, 'no temp pack in the copy').toMatch(/^pack-[0-9a-f]{40}\.(pack|idx)$/)
    if (!f.endsWith('.idx')) continue
    packs++
    const pack = path.join(objects, 'pack', f.replace(/\.idx$/, '.pack'))
    expect(fs.existsSync(pack), `${f} has its pack`).toBe(true)
    const body = JSON.parse(fs.readFileSync(pack, 'utf8')) as Record<string, string>
    for (const id of fs.readFileSync(path.join(objects, 'pack', f), 'utf8').split('\n').filter(Boolean)) {
      expect(crypto.createHash('sha1').update(Buffer.from(body[id] ?? '', 'base64')).digest('hex'), `${id} in ${f}`).toBe(id)
      inPacks.add(id)
    }
  }
  let loose = 0
  for (const d of fs.readdirSync(objects).filter((x) => /^[0-9a-f]{2}$/.test(x))) {
    for (const f of fs.readdirSync(path.join(objects, d))) {
      expect(f, 'no temp object in the copy').toMatch(/^[0-9a-f]{38}$/)
      expect(crypto.createHash('sha1').update(fs.readFileSync(path.join(objects, d, f))).digest('hex')).toBe(d + f)
      loose++
    }
  }
  const head = fs.readFileSync(copyOf('.git/refs/heads/main'), 'utf8').trim()
  const isLoose = fs.existsSync(path.join(objects, head.slice(0, 2), head.slice(2)))
  expect(isLoose || inPacks.has(head), `the branch's object ${head} is in the copy`).toBe(true)
  return { loose, packs }
}

/** Walnut's gated section writes these three together: the copy, taken outside any section, holds one n in all. */
function checkStoreAgrees(): number {
  const n = fs.readFileSync(copyOf('tasks/counter.json'), 'utf8')
  expect(fs.readFileSync(copyOf('notes/pair-a.md'), 'utf8'), 'pair-a').toBe(n)
  expect(fs.readFileSync(copyOf('notes/pair-b.md'), 'utf8'), 'pair-b').toBe(n)
  return Number(n)
}

describe('a batch while the leader keeps writing', () => {
  it('completes on a home whose read outlasts the writers, git packing and pruning and a store writing all the while, and is one moment', async () => {
    sb = await sandbox('live')
    seedFiller(sb.home, 40)
    const stop = startGitWriter(sb.root, sb.home)
    startStoreWriter(sb.home)
    // Let the writers make an object store with packs before the first batch.
    await new Promise((r) => setTimeout(r, 600))

    const first = await snapshotTo(sb.home, sb.target, { hooks: { afterCopy: slowRead } })
    report('fake-git first', first)
    expect(first.ok, first.ok ? '' : first.reason).toBe(true)
    if (!first.ok) return
    // The read alone outlasted many writer ticks: the batch read first and took its moment after.
    expect(first.stats.catchUpMs).toBeGreaterThan(5 * 40)
    const store = checkObjectStore()
    expect(store.loose + store.packs).toBeGreaterThan(0)
    const n1 = checkStoreAgrees()
    expect(walk(path.join(sb.target, 'copy')).filter((p) => /\.lock$|tmp_obj_|tmp_pack_|tmp_idx_/.test(p))).toEqual([])
    expect(fs.existsSync(copyOf('notes/journal.md'))).toBe(true)
    expect((await verifyStandby(sb.target, { deep: true })).drift).toEqual([])

    // A later batch, the writers still going: it completes too, and is a later moment.
    const second = await snapshotTo(sb.home, sb.target, { hooks: { afterCopy: slowRead } })
    report('fake-git second', second)
    expect(second.ok, second.ok ? '' : second.reason).toBe(true)
    checkObjectStore()
    expect(checkStoreAgrees()).toBeGreaterThan(n1)
    expect((await verifyStandby(sb.target, { deep: true })).drift).toEqual([])

    // The leader stops (the switch's final batch, final-stop.ts): one batch takes what is left,
    // the next finds nothing changed, each in one round.
    fs.writeFileSync(stop, '')
    if (timer) clearInterval(timer)
    timer = null
    await new Promise<void>((r) => { if (!child || child.exitCode !== null) r(); else child.once('exit', () => r()) })
    await new Promise((r) => setTimeout(r, 100))
    const last = await snapshotTo(sb.home, sb.target)
    report('fake-git stopped', last)
    expect(last.ok, last.ok ? '' : last.reason).toBe(true)
    const again = await snapshotTo(sb.home, sb.target)
    report('fake-git stopped again', again)
    expect(again.ok && again.commit.unchanged, again.ok ? JSON.stringify(again.stats.roundFailures) : again.reason).toBe(true)
    expect(again.ok && again.stats.rounds).toBe(1)
    checkObjectStore()
    checkStoreAgrees()
  }, 120_000)

  const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'pipe' }); return true } catch { return false } })()
  it.skipIf(!hasGit)('real git committing, repacking and pruning during a slow first read: the copy is a repo git checks whole', async () => {
    sb = await sandbox('live-git')
    seedFiller(sb.home, 30)
    write(sb.home, '.gitignore', 'tmp/\n')
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: sb.home, env })
    execFileSync('git', ['add', '-A'], { cwd: sb.home, env })
    execFileSync('git', ['commit', '-qm', 'seed'], { cwd: sb.home, env })
    const stop = path.join(sb.root, 'stop-git')
    // git as the auto-commit runs it, every 50 ms instead of every 30 s; a repack and a gc that prunes at once now and then.
    const loop = `i=0; while [ ! -e "${stop}" ]; do i=$((i+1)); echo "note $i" > "notes-$((i % 20)).md"; `
      + 'git add -A >/dev/null 2>&1; git commit -qm "c$i" >/dev/null 2>&1; '
      + '[ $((i % 9)) -eq 0 ] && git repack -dq >/dev/null 2>&1; '
      + '[ $((i % 31)) -eq 0 ] && git -c gc.autoDetach=false gc -q --prune=now >/dev/null 2>&1; '
      + 'sleep 0.05; done'
    child = spawn('sh', ['-c', loop], { cwd: sb.home, env, stdio: 'ignore' })
    await new Promise((r) => setTimeout(r, 500))

    const out = await snapshotTo(sb.home, sb.target, { hooks: { afterCopy: slowRead } })
    report('real-git first', out)
    fs.writeFileSync(stop, '')
    await new Promise<void>((r) => { if (!child || child.exitCode !== null) r(); else child.once('exit', () => r()) })
    expect(out.ok, out.ok ? '' : out.reason).toBe(true)
    expect(walk(path.join(sb.target, 'copy')).filter((p) => /\.lock$|tmp_obj_|tmp_pack_/.test(p))).toEqual([])
    // A writable clone of the copy (the copy itself is read-only), checked by git.
    const check = path.join(sb.root, 'check')
    fs.cpSync(path.join(sb.target, 'copy'), check, { recursive: true })
    execFileSync('chmod', ['-R', 'u+w', check])
    const fsck = execFileSync('git', ['fsck', '--full', '--no-dangling'], { cwd: check, env, stdio: 'pipe' }).toString()
    expect(fsck).toBe('')
    const commits = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: check, env }).toString().trim())
    expect(commits).toBeGreaterThan(1)
  }, 120_000)
})
