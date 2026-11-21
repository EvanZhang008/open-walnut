/**
 * Measure the standby copy on a synthetic home of realistic size (docs/reference/standby-copy.md):
 * the scan, the first full batch, the write hold under steady writes, incremental batches,
 * and verify passes; then the same batches again while a writer outside the write gate appends
 * to a log every 20 ms, as many of Walnut's own logs do, to measure how often a batch is void.
 * Synthetic data only: it never reads a real home.
 *
 *   bun scripts/standby-bench.ts <work dir> [--gb 20] [--files 100000] [--batches 20] [--keep]
 *
 * <work dir> gets home/ (built once, reused) and target/ (made fresh). Prints one JSON line
 * of results at the end.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import Database from '../src/lib/sqlite.js'
import { scanHome } from '../src/core/standby/scan.js'
import { snapshotTo, verifyStandby } from '../src/core/standby/index.js'
import { removeTree } from '../src/core/standby/target-files.js'
import { setWriteGateEnabled } from '../src/utils/write-gate.js'
import { writeTextFile } from '../src/utils/fs.js'

const args = process.argv.slice(2)
const work = path.resolve(args[0] ?? '')
if (!args[0]) throw new Error('usage: bun scripts/standby-bench.ts <work dir> [--gb N] [--files N] [--batches N]')
const flag = (name: string, dflt: number) => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args[i + 1]) : dflt }
const GB = flag('gb', 20)
const FILES = flag('files', 100_000)
const BATCHES = flag('batches', 20)
const APPEND_MS = flag('append-ms', 20)
const home = path.join(work, 'home')
const target = path.join(work, 'target')
const log = (...a: unknown[]) => console.log(`[bench ${new Date().toISOString().slice(11, 19)}]`, ...a)

function rnd(n: number): Buffer { return crypto.randomBytes(n) }
function text(n: number, seed: number): string { return `# note ${seed}\n` + `lorem ipsum ${seed} `.repeat(Math.ceil(n / 16)).slice(0, n) }

async function makeDb(rel: string, mb: number): Promise<void> {
  const file = path.join(home, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, body TEXT); CREATE INDEX IF NOT EXISTS t_body ON t(substr(body, 1, 16))')
  const ins = db.prepare('INSERT INTO t (body) VALUES (?)')
  const rows = Math.ceil((mb * 1024 * 1024) / 1100)
  const tx = db.transaction((n: number) => { for (let i = 0; i < n; i++) ins.run(rnd(500).toString('hex')) })
  for (let done = 0; done < rows; done += 10_000) tx(Math.min(10_000, rows - done))
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.close()
}

async function build(): Promise<void> {
  if (fs.existsSync(path.join(home, '.bench-done'))) { log('home exists, reused'); return }
  await removeTree(home)
  log(`building a synthetic home: ~${GB} GB, ~${FILES} files`)
  const small = FILES - 200
  const dirsFor = [['artifacts/notes', 0.55], ['conversations', 0.2], ['memory/daily', 0.05], ['.git/objects', 0.15], ['plugin-data/x', 0.05]] as const
  let n = 0
  for (const [dir, share] of dirsFor) {
    const count = Math.floor(small * share)
    for (let i = 0; i < count; i++, n++) {
      const sub = path.join(home, dir, `d${Math.floor(i / 100)}`)
      if (i % 100 === 0) fs.mkdirSync(sub, { recursive: true })
      const size = 1000 + ((n * 7919) % 15_000)
      fs.writeFileSync(path.join(sub, `f${i}.${dir.startsWith('.git') ? 'obj' : 'md'}`), dir.startsWith('.git') ? rnd(size) : text(size, n))
    }
  }
  // Databases: about 2 GB together.
  await makeDb('tasks/tasks.sqlite', 300)
  await makeDb('sessions.sqlite', 1200)
  await makeDb('usage.sqlite', 200)
  await makeDb('org/threads.sqlite', 100)
  // Big binaries to reach the size: voice archive and git packs.
  const smallBytes = 2.2 * 1024 ** 3 // about what the files and databases above hold
  const bigTotal = Math.max(0, GB * 1024 ** 3 - smallBytes)
  const bigCount = 40
  const each = Math.floor(bigTotal / bigCount)
  for (let i = 0; i < bigCount; i++) {
    const file = path.join(home, i % 4 === 0 ? `.git/objects/pack/pack-${i}.pack` : `voice-archive/rec-${i}.m4a`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const fd = fs.openSync(file, 'w')
    const block = rnd(8 * 1024 * 1024)
    for (let w = 0; w < each; w += block.length) { block.writeUInt32LE(w >>> 0, 0); block.writeUInt32LE(i, 4); fs.writeSync(fd, block, 0, Math.min(block.length, each - w)) }
    fs.closeSync(fd)
  }
  fs.writeFileSync(path.join(home, 'config.yaml'), 'theme: dark\n')
  fs.writeFileSync(path.join(home, '.bench-done'), '')
  log('home built')
}

/** Bytes this process has caused to be written to storage so far (Linux /proc/self/io), or null. */
const diskWrites = (): number | null => {
  try { return Number(/write_bytes: (\d+)/.exec(fs.readFileSync('/proc/self/io', 'utf8'))![1]) } catch { return null }
}
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]) }

async function main(): Promise<void> {
  await build()
  await removeTree(target)
  const result: Record<string, unknown> = { gb: GB, files: FILES }
  const du = (dir: string) => Number(require('node:child_process').execFileSync('du', ['-sb', dir]).toString().split('\t')[0])
  result.homeBytes = du(home)

  const scans: number[] = []
  for (let i = 0; i < 3; i++) { const s = await scanHome(home); scans.push(s.ms); result.leaderFiles = s.files.size }
  result.scanMs = scans.map(Math.round)
  log('scan', result.scanMs, 'ms for', result.leaderFiles, 'files')

  setWriteGateEnabled(true)
  const first = await snapshotTo(home, target)
  if (!first.ok) throw new Error(`first batch void: ${first.reason}`)
  result.firstBatch = { totalMs: Math.round(first.stats.totalMs), holdMs: Math.round(first.stats.holdMs), sentGB: +(first.stats.sentBytes / 1024 ** 3).toFixed(2), files: first.stats.files }
  log('first batch', result.firstBatch)

  // Steady writes while batches run: notes through the gated writer, rows into two databases.
  let writing = true
  let writes = 0
  const sessions = new Database(path.join(home, 'sessions.sqlite'))
  const tasks = new Database(path.join(home, 'tasks/tasks.sqlite'))
  const writer = (async () => {
    while (writing) {
      const i = writes++
      await writeTextFile(path.join(home, 'artifacts/notes/d0', `live-${i % 50}.md`), text(2000, i))
      sessions.prepare('INSERT INTO t (body) VALUES (?)').run(`live ${i}`)
      if (i % 5 === 0) tasks.prepare('INSERT INTO t (body) VALUES (?)').run(`task ${i}`)
      await new Promise((r) => setTimeout(r, 50))
    }
  })()
  const run = async (label: string) => {
    const holds: number[] = []
    const names: number[] = []
    const totals: number[] = []
    const scansInc: number[] = []
    const sent: number[] = []
    const handWritten: number[] = []
    const disk: number[] = []
    let patched = 0
    let voids = 0
    const reasons: string[] = []
    for (let b = 0; b < BATCHES; b++) {
      const w0 = diskWrites()
      const out = await snapshotTo(home, target)
      const w1 = diskWrites()
      holds.push(out.stats.holdMs)
      names.push(out.stats.namesMs ?? 0)
      scansInc.push(out.stats.scanMs)
      if (!out.ok) { voids++; reasons.push(out.reason.slice(0, 120)); continue }
      totals.push(out.stats.totalMs)
      sent.push(out.stats.sentBytes)
      handWritten.push(out.commit.bytesWritten ?? 0)
      patched += out.commit.patched ?? 0
      if (w0 !== null && w1 !== null) disk.push(w1 - w0)
    }
    const r = {
      batches: BATCHES, void: voids, voidReasons: [...new Set(reasons)].slice(0, 5), writesDuring: writes,
      holdMs: { p50: q(holds, 0.5), p95: q(holds, 0.95), max: Math.round(Math.max(...holds)) },
      namesInHoldMs: { p50: q(names, 0.5), max: Math.round(Math.max(...names)) },
      scanMs: { p50: q(scansInc, 0.5), max: Math.round(Math.max(...scansInc)) },
      totalMs: totals.length ? { p50: q(totals, 0.5), p95: q(totals, 0.95), max: Math.round(Math.max(...totals)) } : null,
      sentMB: sent.length ? { p50: +(q(sent, 0.5) / 1024 ** 2).toFixed(1), max: +(Math.max(...sent) / 1024 ** 2).toFixed(1) } : null,
      patchedFiles: patched,
      copyWrittenMB: handWritten.length ? { p50: +(q(handWritten, 0.5) / 1024 ** 2).toFixed(1), max: +(Math.max(...handWritten) / 1024 ** 2).toFixed(1) } : null,
      diskWrittenMB: disk.length ? { p50: +(q(disk, 0.5) / 1024 ** 2).toFixed(1), max: +(Math.max(...disk) / 1024 ** 2).toFixed(1) } : null,
    }
    log(label, r)
    return r
  }
  result.incremental = await run('incremental (gated writes)')

  // A writer the gate does not hold: appends, as the time-tracking and audit logs do.
  let appending = true
  let appends = 0
  const appender = (async () => {
    while (appending) {
      await fsp.appendFile(path.join(home, 'time-tracking.jsonl'), `{"at":${Date.now()},"n":${appends++}}\n`)
      await new Promise((r) => setTimeout(r, APPEND_MS))
    }
  })()
  result.withUngatedAppends = { ...(await run(`incremental (plus an ungated append every ${APPEND_MS} ms)`)), appendEveryMs: APPEND_MS, appends }
  appending = false
  await appender
  writing = false
  await writer
  sessions.close(); tasks.close()
  setWriteGateEnabled(false)

  let t = performance.now()
  const v = await verifyStandby(target)
  result.verifyMs = Math.round(performance.now() - t)
  result.verifyDrift = v.drift.length
  t = performance.now()
  const deep = await verifyStandby(target, { deep: true })
  result.deepVerifyMs = Math.round(performance.now() - t)
  result.deepVerifyDrift = deep.drift.length
  result.targetBytes = du(target)
  log('verify', result.verifyMs, 'ms; deep', result.deepVerifyMs, 'ms')
  console.log(`RESULT ${JSON.stringify(result)}`)
  if (!args.includes('--keep')) await removeTree(target)
}

await main()
