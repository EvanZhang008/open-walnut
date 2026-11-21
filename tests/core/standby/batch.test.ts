/**
 * The standby copy end to end on one machine: a batch holds every leader-data path and
 * nothing else, databases are consistent copies, and every change shape (edit, delete,
 * rename, a rewrite that keeps size and mtime, a file changed while it is copied, a database
 * that cannot be read) leaves a complete copy that verifies.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { homePathClass } from '../../../src/core/home-manifest/index.js'
import { snapshotTo, standbyStatus, verifyStandby } from '../../../src/core/standby/index.js'
import { databaseStat } from '../../../src/core/standby/batch.js'
import { chunkCount, leaderPlainFiles, makeDb, openCopiedDb, sandbox, seedHome, sha, walk, write, type Sandbox } from './helpers.js'

let sb: Sandbox
const dbs: Array<{ close: () => unknown }> = []
afterEach(async () => {
  for (const db of dbs.splice(0)) db.close()
  await sb?.cleanup()
})

const copyOf = (rel: string) => path.join(sb.target, 'copy', rel)

async function batch(hooks?: Parameters<typeof snapshotTo>[2]['hooks']) {
  const out = await snapshotTo(sb.home, sb.target, { hooks })
  return out
}

/** Wait past the margin so files written now count as before the next batch's moment. */
const settle = () => new Promise((r) => setTimeout(r, 30))

describe('a batch', () => {
  it('holds every leader-data path with its content, and no machine or rebuildable path', async () => {
    sb = await sandbox('all')
    const seeded = seedHome(sb.home)
    dbs.push(...seeded.dbs)
    await settle()
    const out = await batch()
    expect(out.ok, out.ok ? '' : out.reason).toBe(true)

    const copied = walk(path.join(sb.target, 'copy'))
    for (const rel of leaderPlainFiles(sb.home)) {
      expect(copied, rel).toContain(rel)
      expect(sha(copyOf(rel)), rel).toBe(sha(path.join(sb.home, rel)))
    }
    for (const rel of copied) expect(homePathClass(rel), rel).toBe('leader-data')
    for (const rel of ['server.lock.json', 'tmp/streams/s1.jsonl', 'search.sqlite', 'cache/applied-ops.json.unused', 'tasks/tasks.json.lock/owner/x']) {
      expect(copied, rel).not.toContain(rel)
    }
    expect(copied.filter((p) => /-(wal|shm)$/.test(p))).toEqual([])
    expect(fs.statSync(copyOf('triggers/check.sh')).mode & 0o777).toBe(0o500)
    expect(fs.statSync(copyOf('config.yaml')).mode & 0o777).toBe(0o400)

    for (const [rel, rows] of [['tasks/tasks.sqlite', 200], ['sessions.sqlite', 50], ['cache/applied-ops.sqlite', 5]] as const) {
      const { db, done } = openCopiedDb(copyOf(rel))
      try {
        expect(db.pragma('integrity_check', { simple: true }), rel).toBe('ok')
        expect(db.prepare('SELECT count(*) AS n FROM t').get(), rel).toEqual({ n: rows })
      } finally { done() }
    }
    const status = await standbyStatus(sb.target)
    expect(status.batch).toBe(1)
    expect(status.fileCount).toBe(copied.length)
    expect((await verifyStandby(sb.target, { deep: true })).drift).toEqual([])
  })

  it('writes no new chunk when nothing changed, and moves the position', async () => {
    sb = await sandbox('same')
    dbs.push(...seedHome(sb.home).dbs)
    await settle()
    expect((await batch()).ok).toBe(true)
    const chunks = chunkCount(sb.target)
    const second = await batch()
    expect(second.ok && second.commit.unchanged).toBe(true)
    expect(second.ok && second.stats.sentChunks).toBe(0)
    expect(chunkCount(sb.target)).toBe(chunks)
    expect((await standbyStatus(sb.target)).batch).toBe(2)
  })

  it('follows edits, deletes, renames and a rewrite that keeps size and mtime', async () => {
    sb = await sandbox('changes')
    const seeded = seedHome(sb.home)
    dbs.push(...seeded.dbs)
    // A whole-second mtime, so it can be set back exactly after the rewrite below.
    const cfg = path.join(sb.home, 'config.yaml')
    const fixed = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000)
    fs.utimesSync(cfg, fixed, fixed)
    await settle()
    expect((await batch()).ok).toBe(true)

    write(sb.home, 'memory/MEMORY.md', '# Memory, edited\n')
    fs.rmSync(path.join(sb.home, 'artifacts/notes/deep'), { recursive: true })
    fs.renameSync(path.join(sb.home, 'conversations/main/history.jsonl'), path.join(sb.home, 'conversations/main/renamed.jsonl'))
    // Same size, same mtime, different bytes: only the ctime moves.
    const st = fs.statSync(cfg)
    fs.writeFileSync(cfg, 'theme: lite\n')
    fs.utimesSync(cfg, fixed, fixed)
    expect(fs.statSync(cfg).size).toBe(st.size)
    expect(fs.statSync(cfg).mtimeMs).toBe(st.mtimeMs)
    seeded.dbs[0].prepare('INSERT INTO t (body) VALUES (?)').run('after the first batch')
    await settle()

    const out = await batch()
    expect(out.ok, out.ok ? '' : out.reason).toBe(true)
    expect(fs.readFileSync(copyOf('memory/MEMORY.md'), 'utf8')).toBe('# Memory, edited\n')
    expect(fs.existsSync(copyOf('artifacts/notes/deep/a/b/c.md'))).toBe(false)
    expect(fs.existsSync(copyOf('artifacts/notes/deep'))).toBe(false)
    expect(fs.existsSync(copyOf('conversations/main/history.jsonl'))).toBe(false)
    expect(fs.readFileSync(copyOf('conversations/main/renamed.jsonl'), 'utf8')).toBe('{"a":1}\n')
    expect(fs.readFileSync(copyOf('config.yaml'), 'utf8')).toBe('theme: lite\n')
    const { db, done } = openCopiedDb(copyOf('tasks/tasks.sqlite'))
    try { expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 201 }) } finally { done() }
    expect((await verifyStandby(sb.target, { deep: true })).drift).toEqual([])
  })
})

describe('a void batch', () => {
  it('a file changed while it is copied voids the batch; the previous one stays current and verifies', async () => {
    sb = await sandbox('void')
    dbs.push(...seedHome(sb.home).dbs)
    await settle()
    expect((await batch()).ok).toBe(true)
    write(sb.home, 'memory/MEMORY.md', '# second version\n')
    await settle()
    const out = await batch({ afterCopy: (rel) => { if (rel === 'memory/MEMORY.md') write(sb.home, rel, '# edited during the copy\n') } })
    expect(out.ok).toBe(false)
    expect(!out.ok && out.reason).toMatch(/memory\/MEMORY\.md: changed/)
    const status = await standbyStatus(sb.target)
    expect(status.batch).toBe(1)
    expect(fs.readFileSync(copyOf('memory/MEMORY.md'), 'utf8')).toBe('# Memory\n')
    expect((await verifyStandby(sb.target, { deep: true })).drift).toEqual([])
    expect(fs.existsSync(path.join(sb.home, 'tmp/standby-staging')) ? fs.readdirSync(path.join(sb.home, 'tmp/standby-staging')) : []).toEqual([])
  })

  it('a file changed after the moment with no copy from before it voids the batch', async () => {
    sb = await sandbox('late')
    dbs.push(...seedHome(sb.home).dbs)
    await settle()
    expect((await batch()).ok).toBe(true)
    // Unchanged at the scan, changed right after the hold: its content at the moment is unknown.
    const out = await batch({ afterHold: () => write(sb.home, 'user-own-folder/plan.md', 'changed after the moment\n') })
    expect(out.ok).toBe(false)
    expect(!out.ok && out.reason).toMatch(/plan\.md changed or went after the batch's moment/)
    expect((await standbyStatus(sb.target)).batch).toBe(1)
  })

  it('a file changed between the scan and the hold is taken with its content at the moment', async () => {
    sb = await sandbox('window')
    dbs.push(...seedHome(sb.home).dbs)
    await settle()
    expect((await batch()).ok).toBe(true)
    const out = await batch({ afterScan: async () => { write(sb.home, 'user-own-folder/plan.md', 'changed before the moment\n'); await settle() } })
    expect(out.ok, out.ok ? '' : out.reason).toBe(true)
    expect(fs.readFileSync(copyOf('user-own-folder/plan.md'), 'utf8')).toBe('changed before the moment\n')
  })

  it('a database that cannot be read voids the batch', async () => {
    sb = await sandbox('baddb')
    const seeded = seedHome(sb.home)
    dbs.push(...seeded.dbs)
    await settle()
    expect((await batch()).ok).toBe(true)
    write(sb.home, 'org/threads.sqlite', Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.alloc(4096, 7)]))
    await settle()
    const out = await batch()
    expect(out.ok).toBe(false)
    expect(!out.ok && out.reason).toMatch(/threads\.sqlite|database/)
    expect((await standbyStatus(sb.target)).batch).toBe(1)
    expect(fs.existsSync(copyOf('org/threads.sqlite'))).toBe(false)
    expect((await verifyStandby(sb.target, { deep: true })).drift).toEqual([])
  })

  it('a database removed between the scan and the hold voids the batch', async () => {
    sb = await sandbox('gonedb')
    const seeded = seedHome(sb.home)
    dbs.push(...seeded.dbs)
    await settle()
    expect((await batch()).ok).toBe(true)
    const out = await batch({ afterScan: () => { seeded.dbs[2].close(); dbs.splice(dbs.indexOf(seeded.dbs[2]), 1); for (const s of ['', '-wal', '-shm']) fs.rmSync(path.join(sb.home, `cache/applied-ops.sqlite${s}`), { force: true }) } })
    expect(out.ok).toBe(false)
    expect((await standbyStatus(sb.target)).batch).toBe(1)
  })
})

describe('the names at the moment come from the moment, not from the first scan', () => {
  const rewrite = (rel: string, content: string) => {
    // As writeTextFile does: a temp file renamed over the old one (a new inode).
    const abs = path.join(sb.home, rel)
    fs.writeFileSync(`${abs}.next`, content)
    fs.renameSync(`${abs}.next`, abs)
  }

  it('a file made after the first scan and replaced after the hold is in the batch as it was at the moment', async () => {
    sb = await sandbox('born-replaced')
    dbs.push(...seedHome(sb.home).dbs)
    await settle()
    expect((await batch()).ok).toBe(true)
    const out = await batch({
      afterScan: () => write(sb.home, 'user-own-folder/new.md', 'v1 at the moment\n'),
      afterHold: () => rewrite('user-own-folder/new.md', 'v2 after the moment\n'),
    })
    // A batch may be void here, never complete without the file that existed at its moment.
    expect(out.ok, out.ok ? '' : out.reason).toBe(true)
    expect(fs.readFileSync(copyOf('user-own-folder/new.md'), 'utf8')).toBe('v1 at the moment\n')
  })

  it('a file made after the first scan and deleted after the hold is in the batch too', async () => {
    sb = await sandbox('born-deleted')
    dbs.push(...seedHome(sb.home).dbs)
    await settle()
    expect((await batch()).ok).toBe(true)
    const out = await batch({
      afterScan: () => write(sb.home, 'artifacts/notes/fresh/n.md', 'made before the moment\n'),
      afterHold: () => fs.rmSync(path.join(sb.home, 'artifacts/notes/fresh'), { recursive: true }),
    })
    expect(out.ok, out.ok ? '' : out.reason).toBe(true)
    expect(fs.readFileSync(copyOf('artifacts/notes/fresh/n.md'), 'utf8')).toBe('made before the moment\n')
    // The next batch is of a later moment: the file is gone there.
    await settle()
    expect((await batch()).ok).toBe(true)
    expect(fs.existsSync(copyOf('artifacts/notes/fresh/n.md'))).toBe(false)
  })

  it('a file made after the moment waits for the next batch', async () => {
    sb = await sandbox('born-late')
    dbs.push(...seedHome(sb.home).dbs)
    await settle()
    const out = await batch({ afterHold: () => write(sb.home, 'user-own-folder/later.md', 'after\n') })
    expect(out.ok, out.ok ? '' : out.reason).toBe(true)
    expect(fs.existsSync(copyOf('user-own-folder/later.md'))).toBe(false)
    await settle()
    expect((await batch()).ok).toBe(true)
    expect(fs.readFileSync(copyOf('user-own-folder/later.md'), 'utf8')).toBe('after\n')
  })

  it('a name added in the same clock tick as the scan listed its dir is still seen', async () => {
    // A dir's ctime is coarse: a second change in the tick the scan read it leaves it unmoved.
    sb = await sandbox('same-tick')
    write(sb.home, 'user-own-folder/keep.md', 'k\n')
    fs.mkdirSync(path.join(sb.home, 'tmp'), { recursive: true })
    expect((await batch()).ok).toBe(true)
    let committed = 0
    for (let i = 0; i < 15; i++) {
      await settle()
      write(sb.home, `tmp/x${i}`, `n${i} existed at the moment\n`)
      write(sb.home, `user-own-folder/a${i}.md`, 'a\n')
      const out = await batch({ afterScan: () => fs.renameSync(path.join(sb.home, `tmp/x${i}`), path.join(sb.home, `user-own-folder/n${i}.md`)) })
      if (!out.ok) continue
      committed++
      expect(fs.existsSync(copyOf(`user-own-folder/n${i}.md`)), `batch ${i} lost n${i}.md`).toBe(true)
    }
    expect(committed).toBeGreaterThan(10)
  })

  it('a database replaced between the scan and the pins voids the batch', async () => {
    sb = await sandbox('db-replaced')
    dbs.push(...seedHome(sb.home).dbs)
    await settle()
    expect((await batch()).ok).toBe(true)
    const out = await batch({
      afterScan: () => {
        const other = makeDb(sb.home, 'tasks/rebuilt.sqlite', 3)
        other.pragma('wal_checkpoint(TRUNCATE)')
        other.close()
        fs.renameSync(path.join(sb.home, 'tasks/rebuilt.sqlite'), path.join(sb.home, 'tasks/tasks.sqlite'))
      },
    })
    expect(out.ok).toBe(false)
    expect(!out.ok && out.reason).toMatch(/tasks\/tasks\.sqlite was replaced/)
  })

  it('a WAL restart that keeps the -wal size still changes the database\'s stat', async () => {
    sb = await sandbox('wal-restart')
    const db = makeDb(sb.home, 'w.sqlite', 0)
    dbs.push(db)
    db.pragma('wal_autocheckpoint = 0')
    const ins = db.prepare('INSERT INTO t (body) VALUES (?)')
    for (let i = 0; i < 20; i++) ins.run(`first ${i}`)
    db.pragma('wal_checkpoint(PASSIVE)')
    const before = await databaseStat(path.join(sb.home, 'w.sqlite'))
    // Every frame is checkpointed and nobody reads: the next writer restarts the WAL from frame 1.
    for (let i = 0; i < 20; i++) ins.run(`again ${i}`)
    const after = await databaseStat(path.join(sb.home, 'w.sqlite'))
    const walSize = (p: string) => fs.statSync(`${p}-wal`).size
    expect(walSize(path.join(sb.home, 'w.sqlite'))).toBeGreaterThan(0)
    expect(after.w).toBeDefined()
    expect(after.w).not.toBe(before.w)
  })

  it('the hold reads the small changed files even when one large changed file is past its budget', async () => {
    sb = await sandbox('budget')
    dbs.push(...seedHome(sb.home).dbs)
    await settle()
    expect((await batch()).ok).toBe(true)
    write(sb.home, 'big/blob.bin', Buffer.alloc(3 * 1024 * 1024, 7))
    write(sb.home, 'user-own-folder/plan.md', 'before the moment\n')
    await settle()
    const out = await snapshotTo(sb.home, sb.target, {
      holdCopyBytes: 1024 * 1024,
      hooks: { afterHold: () => write(sb.home, 'user-own-folder/plan.md', 'after the moment\n') },
    })
    expect(out.ok, out.ok ? '' : out.reason).toBe(true)
    expect(fs.readFileSync(copyOf('user-own-folder/plan.md'), 'utf8')).toBe('before the moment\n')
  })

  it('databases nobody has open (no -wal, no -shm) do not void the batch', async () => {
    sb = await sandbox('closed-dbs')
    write(sb.home, 'config.yaml', 'theme: dark\n')
    for (const rel of ['tasks/tasks.sqlite', 'sessions.sqlite']) makeDb(sb.home, rel, 20).close()
    expect(fs.existsSync(path.join(sb.home, 'sessions.sqlite-shm'))).toBe(false)
    await settle()
    const out = await batch()
    expect(out.ok, out.ok ? '' : out.reason).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('a backslash is part of a file name on this platform, not a separator', async () => {
    sb = await sandbox('backslash')
    dbs.push(...seedHome(sb.home).dbs)
    write(sb.home, 'user-own-folder/a\\b.md', 'a name with a backslash\n')
    await settle()
    const out = await batch()
    expect(out.ok, out.ok ? '' : out.reason).toBe(true)
    expect(fs.readFileSync(copyOf('user-own-folder/a\\b.md'), 'utf8')).toBe('a name with a backslash\n')
    expect((await verifyStandby(sb.target)).drift).toEqual([])
  })
})
