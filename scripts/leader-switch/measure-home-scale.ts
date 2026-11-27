/**
 * The sessions in the data home at a real home's density, measured on synthetic data (no real data is read):
 *   bun scripts/leader-switch/measure-home-scale.ts <empty work dir> [--rows 653] [--home-gb 1.7] [--sub-mb 416] [--folders 37]
 *     [--subagents 12] [--tool-results 3] [--small-kb 4]
 *
 * The shape is the user's Mac's, read-only on 2026-11-26 (review mwy2yo76 round 2): 653 unarchived rows of the class,
 * Claude Code records of 1.7 GB in the home's own folder (330 transcripts) and 416 MB in 37 folders under it. The work
 * dir gets a fresh data home with that many session rows (the real session store), a fake engine dir with that many
 * bytes of transcripts, and a standby folder. Each session also keeps `--subagents` subagent transcripts and
 * `--tool-results` tool results of `--small-kb` each under `<sid>/` (a real home keeps thousands of such small files;
 * review round 3). It measures, on this machine's disk (no copy link):
 *   - the switch stop's first step (home-sessions.ts stopHomeSessions) with the real store: reading the rows, the
 *     supervision reads and stops through a fake runtime answering like the daemon for a session that runs nothing
 *     (a noop after `--stop-ms`, default 3 ms), the marks written, the process scan;
 *   - the first carry of the records (the periodic one that must have caught up before a switch can start);
 *   - the size a preflight's refusal names (session-carry.ts carrySize, asynchronous): how long its walk takes;
 *   - the final carry after a few sessions wrote meanwhile (what the switch stop sends inside the commit window).
 * Prints one JSON line of times and sizes, and a line per measure.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const args = process.argv.slice(2)
const work = args[0]
if (!work || args.includes('--help')) { console.error('usage: measure-home-scale.ts <empty work dir> [--rows N] [--home-gb G] [--sub-mb M] [--folders F] [--stop-ms MS] [--subagents N] [--tool-results N] [--small-kb K]'); process.exit(2) }
const opt = (name: string, d: number) => { const i = args.indexOf(`--${name}`); return i > 0 ? Number(args[i + 1]) : d }
const ROWS = opt('rows', 653)
const HOME_TRANSCRIPTS = 330
const HOME_BYTES = opt('home-gb', 1.7) * (1 << 30)
const SUB_BYTES = opt('sub-mb', 416) * (1 << 20)
const FOLDERS = opt('folders', 37)
const STOP_MS = opt('stop-ms', 3)
const SUBAGENTS = opt('subagents', 12)
const TOOL_RESULTS = opt('tool-results', 3)
const SMALL_BYTES = opt('small-kb', 4) * 1024

fs.mkdirSync(work, { recursive: true })
if (fs.readdirSync(work).length) { console.error(`${work} is not empty`); process.exit(2) }
const root = fs.realpathSync(work)
const home = path.join(root, 'home')
const engine = path.join(root, 'claude')
const standby = path.join(root, 'standby')
fs.mkdirSync(home, { recursive: true })
// This process's own home and engine dir only: never the account's.
process.env.OPEN_WALNUT_HOME = home
process.env.CLAUDE_CONFIG_DIR = engine
process.env.HOME = root

const mb = (n: number) => `${(n / (1 << 20)).toFixed(0)} MB`
const s = (ms: number) => `${(ms / 1000).toFixed(2)} s`
const line = (k: string, v: string) => console.log(`MEASURE  ${k}: ${v}`)

/** A transcript of about `bytes`: JSON lines of a model's shape (text that does not compress to nothing). */
function writeTranscript(file: string, sid: string, bytes: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const fd = fs.openSync(file, 'w', 0o600)
  try {
    let written = 0
    let n = 0
    while (written < bytes) {
      const text = crypto.randomBytes(Math.min(48 * 1024, Math.max(256, bytes - written))).toString('base64')
      const row = `${JSON.stringify({ type: n % 2 ? 'assistant' : 'user', sessionId: sid, uuid: crypto.randomUUID(), message: { role: n % 2 ? 'assistant' : 'user', content: text } })}\n`
      fs.writeSync(fd, row)
      written += row.length
      n++
    }
  } finally { fs.closeSync(fd) }
}

async function main(): Promise<void> {
  const [{ createSessionRecord, listSessions, updateSessionRecord }, hs, carry, { snapshotTo, carryTargetDir }, { processesInFolders }] = await Promise.all([
    import('../../src/core/session-tracker.js'), import('../../src/core/leader/switch/home-sessions.js'),
    import('../../src/core/leader/switch/session-carry.js'), import('../../src/core/standby/index.js'), import('../../src/lib/home-processes.js'),
  ])
  // ---- the rows: 330 in the home itself, the rest in FOLDERS folders under it ----
  const t0 = Date.now()
  const sids: Array<{ sid: string; cwd: string }> = []
  for (let i = 0; i < ROWS; i++) {
    const cwd = i < HOME_TRANSCRIPTS ? home : path.join(home, 'plugin-data', `p${i % FOLDERS}`)
    fs.mkdirSync(cwd, { recursive: true })
    const sid = crypto.randomUUID()
    await createSessionRecord(sid, `t-scale-${i}`, 'Scale', cwd, { title: `scale ${i}` } as never)
    await updateSessionRecord(sid, { process_status: 'stopped' } as never)
    sids.push({ sid, cwd })
  }
  line('rows written', `${ROWS} in ${s(Date.now() - t0)}`)
  // ---- the records: the home's folder and the folders under it ----
  const t1 = Date.now()
  const subRows = sids.length - HOME_TRANSCRIPTS
  for (const [i, x] of sids.entries()) {
    const folder = hs.engineFolderName(x.cwd)!
    const bytes = i < HOME_TRANSCRIPTS ? HOME_BYTES / HOME_TRANSCRIPTS : SUB_BYTES / Math.max(1, subRows)
    writeTranscript(path.join(engine, 'projects', folder, `${x.sid}.jsonl`), x.sid, bytes)
    for (let k = 0; k < SUBAGENTS; k++) writeTranscript(path.join(engine, 'projects', folder, x.sid, 'subagents', `agent-a${k}.jsonl`), x.sid, SMALL_BYTES)
    for (let k = 0; k < TOOL_RESULTS; k++) {
      fs.mkdirSync(path.join(engine, 'projects', folder, x.sid, 'tool-results'), { recursive: true })
      fs.writeFileSync(path.join(engine, 'projects', folder, x.sid, 'tool-results', `toolu_${k}.txt`), crypto.randomBytes(SMALL_BYTES / 2).toString('hex'))
    }
  }
  const sel = carry.carrySelection(await listSessions(), home)
  line('records written', `${sel.folders.size} folders, ${s(Date.now() - t1)}`)
  // The size a preflight's refusal names: an asynchronous walk; the event loop's longest stall while it runs.
  let stall = 0
  let tick = Date.now()
  const probe = setInterval(() => { const now = Date.now(); stall = Math.max(stall, now - tick - 5); tick = now }, 5)
  const tw = Date.now()
  const size = await carry.carrySize(engine, sel)
  const walkMs = Date.now() - tw
  clearInterval(probe)
  line('records size (the refusal\'s walk)', `${mb(size.bytes)} in ${size.files} files${size.capped ? ' (capped)' : ''}, walked in ${s(walkMs)}, the event loop's longest stall ${stall} ms`)

  // ---- the first carry (the periodic one that must have caught up before a switch starts) ----
  const target = carryTargetDir(standby)
  const staging = path.join(home, 'tmp', 'standby-carry-staging')
  const place = () => carry.carryPlace(carry.carrySelection(sids.map((x) => ({ claudeSessionId: x.sid, cwd: x.cwd }) as never), home))
  const t2 = Date.now()
  const first = await snapshotTo(engine, target, { place: place(), stagingDir: staging })
  const firstMs = Date.now() - t2
  if (!first.ok) throw new Error(`first carry void: ${first.reason}`)
  line('first carry', `${s(firstMs)} for ${mb(size.bytes)} (${(size.bytes / (1 << 20) / (firstMs / 1000)).toFixed(0)} MB/s on this disk)`)

  // ---- the switch stop's first step, with the real store ----
  const stopDeps = {
    list: listSessions,
    save: async (sid: string, patch: object) => { await updateSessionRecord(sid, patch as never) },
    supervised: async () => { await new Promise((r) => setTimeout(r, 1)); return false },
    stop: async () => { await new Promise((r) => setTimeout(r, STOP_MS)); return { ok: true as const } },
    processesInHome: (sp: readonly string[]) => processesInFolders(sp),
    transcriptExists: async (folder: string, sid: string) => fs.existsSync(path.join(engine, 'projects', folder, `${sid}.jsonl`)),
    now: Date.now,
  }
  const t3 = Date.now()
  const stop = await hs.stopHomeSessions({ switchId: 'SCALE1', home, machine: 'machine-a', budgetMs: 30_000, deps: stopDeps })
  const stopMs = Date.now() - t3
  line('switch stop (sessions in the home)', `${s(stopMs)} for ${stop.rows} rows (${stop.moves} move, ${stop.ends.length} end); of it the marks ${s(stop.stampMs ?? 0)}; ok ${stop.ok}${stop.why ? ` (${stop.why.slice(0, 200)})` : ''}`)

  // ---- the final carry: a few sessions wrote since the last periodic carry ----
  for (const x of sids.slice(0, 20)) {
    const folder = hs.engineFolderName(x.cwd)!
    fs.appendFileSync(path.join(engine, 'projects', folder, `${x.sid}.jsonl`), `${JSON.stringify({ type: 'user', more: crypto.randomBytes(64 * 1024).toString('base64') })}\n`)
    if (SUBAGENTS) fs.appendFileSync(path.join(engine, 'projects', folder, x.sid, 'subagents', 'agent-a0.jsonl'), `${JSON.stringify({ type: 'user', more: crypto.randomBytes(1024).toString('base64') })}\n`)
  }
  const t4 = Date.now()
  let passes = 0
  let last = first
  for (;;) {
    passes++
    last = await snapshotTo(engine, target, { place: place(), stagingDir: staging })
    if (!last.ok) throw new Error(`final carry void: ${last.reason}`)
    if (last.commit.unchanged || passes >= 5) break
  }
  const finalMs = Date.now() - t4
  line('final carry', `${s(finalMs)} in ${passes} pass(es) (20 sessions wrote 64 KB each, and 1 KB to a subagent transcript, since the last periodic carry)`)
  line('extra downtime (the stop of the sessions plus the final carry, both inside the commit window)', s(stopMs + finalMs))
  console.log(JSON.stringify({ rows: ROWS, bytes: size.bytes, files: size.files, folders: sel.folders.size, sizeWalkMs: walkMs, sizeWalkStallMs: stall, firstCarryMs: firstMs, stopMs, stampMs: stop.stampMs, finalCarryMs: finalMs, finalPasses: passes, extraDowntimeMs: stopMs + finalMs, stopOk: stop.ok }))
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1) })
