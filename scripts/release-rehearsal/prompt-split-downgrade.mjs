#!/usr/bin/env bun
/**
 * The prompt split's downgrade (release B, src/core/session-prompt-gate.ts) rehearsed against a REAL
 * older release from the registry, as "Existing users keep working" asks: may a person who runs
 * this tree go back one release and still have every lane's persona and every task session's spawn
 * prompt?
 *
 *   bun scripts/release-rehearsal/prompt-split-downgrade.mjs [--older <version>|latest] [--out <dir>]
 *
 * This tree writes the sessions (a lane session with a persona, a task session with a spawn prompt,
 * Unicode in both) into a home of its own and runs its strip job as a server does, its real gate
 * included (no deploy on the rehearsal's machine: XDG_STATE_HOME is the run's own). Then the older
 * release, installed from npm as a person installs it, serves a copy of that home, and its own
 * `GET /api/sessions/:id` (0.6.37: getSessionByClaudeId, the record a resume builds its
 * --system-prompt and --append-system-prompt from) is compared with what was written, byte for byte:
 *
 *   gated     what a person gets: this tree's job on that home, as the first release after the older
 *             one. Judged: the gate stays closed, nothing is stripped, the older release reads both.
 *   stripped  what the gate exists for: the strip forced (as if the gate had opened). Judged: the
 *             rollback check (scripts/lib/rollback-data-check.mjs) refuses the older release, and
 *             the older release, started anyway, misses the texts (the hazard, recorded as seen).
 *   unsplit   `walnut sessions-prompts unsplit` from this tree on the stripped home. Judged: the
 *             rollback check passes the older release, which reads both, byte-equal.
 *   next      the gate in the two releases after this tree's version, on the gated home. Judged: the
 *             first stays closed (the release before it may still be the older one), the second,
 *             after the first recorded serving the store, opens and strips.
 *   olderWrote the older release, started on the stripped home anyway, writes it (renames each
 *             session), and a build before the split sets a new spawn prompt on a row whose persona
 *             is only in the table; then the two releases after this tree's version. Judged: the
 *             first keeps the gate closed, the second strips, every text reads back.
 *
 * Not reproduced: a real resume of a CLI by the older release (the record it would build one from is
 * what is read), and the Mac's deploy rule of the gate (tests/core/session-prompts-strip.test.ts).
 * Evidence: <out>/prompt-split-downgrade.json.
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { IsolatedWalnut } from './walnut.mjs'
import { installOlder, olderManifest } from './mixed-leader-host.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const sha = (s) => (typeof s === 'string' ? crypto.createHash('sha256').update(s, 'utf8').digest('hex') : null)
// Unicode as test data, in escapes: CJK, an emoji (a surrogate pair), a combining mark.
const PERSONA = 'You are the lane persona \u4e2d\u6587 \ud83d\ude80 e\u0301.\n'.repeat(400)
const PROMPT = 'Walnut spawn prompt \u4e2d \ud83d\ude80 rules.\n'.repeat(900)
const SESSIONS = {
  lane: { sid: '7a1c0f3e-0000-4000-8000-00000000a001', profile: { systemPrompt: PERSONA, systemPromptMode: 'append', allowedTools: ['Read'] } },
  task: { sid: '7a1c0f3e-0000-4000-8000-00000000a002', appliedAppendSystemPrompt: PROMPT },
  both: { sid: '7a1c0f3e-0000-4000-8000-00000000a003', appliedAppendSystemPrompt: `${PROMPT}both`, profile: { systemPrompt: `${PERSONA}both`, systemPromptMode: 'append' } },
}
const ROWS_WITH_TEXT = Object.keys(SESSIONS).length
/** The spawn prompt the older release's write sets on `both` (as a build before the split writes a whole row). */
const NEWER_SPAWN_PROMPT = 'Spawn prompt the older release set \u4e2d.\n'.repeat(700)

// ── This tree's side, in a child whose OPEN_WALNUT_HOME is the rehearsal's home ─────────────────

async function guardHome() {
  const home = process.env.OPEN_WALNUT_HOME
  const { WALNUT_HOME } = await import(path.join(repo, 'src/constants.ts'))
  if (!home || WALNUT_HOME !== home) throw new Error(`refusing: home ${WALNUT_HOME} is not ${home}`)
}

async function phase(name, args) {
  await guardHome()
  const tracker = await import(path.join(repo, 'src/core/session-tracker.ts'))
  const jobs = await import(path.join(repo, 'src/core/session-prompt-jobs.ts'))
  const sdb = await import(path.join(repo, 'src/core/session-db.ts'))
  const out = {}
  if (name === 'seed') {
    await tracker.createSessionRecord(SESSIONS.lane.sid, '', 'rehearsal', '/w', { initialProcessStatus: 'stopped', profile: SESSIONS.lane.profile })
    await tracker.createSessionRecord(SESSIONS.task.sid, '', 'rehearsal', '/w', { initialProcessStatus: 'stopped', appliedAppendSystemPrompt: SESSIONS.task.appliedAppendSystemPrompt })
    await tracker.createSessionRecord(SESSIONS.both.sid, '', 'rehearsal', '/w', { initialProcessStatus: 'stopped', appliedAppendSystemPrompt: SESSIONS.both.appliedAppendSystemPrompt, profile: SESSIONS.both.profile })
  }
  if (name === 'read') {
    // This tree's whole read of each session (the record a resume builds from).
    out.reads = {}
    for (const [key, sess] of Object.entries(SESSIONS)) {
      const r = await tracker.getSessionByClaudeId(sess.sid)
      out.reads[key] = { persona: sha(r?.profile?.systemPrompt), spawnPrompt: sha(r?.appliedAppendSystemPrompt), title: r?.title ?? null }
    }
  }
  if (name === 'job') {
    // The job a server runs 120 s after it opens the store, with its real gate.
    const r = await jobs.runPromptJob({ version: args.version })
    out.gate = r.gate
    out.stripped = r.strip?.rows ?? 0
  }
  if (name === 'force-strip') out.stripped = (await jobs.runPromptPass('strip')).rows
  if (name === 'unsplit') out.unsplit = (await jobs.runPromptPass('unsplit')).rows
  const db = sdb.getDb()
  out.payloadsWithText = Number(db.prepare(`SELECT count(*) FROM sessions WHERE instr(payload, 'ystemPrompt":"') > 0`).pluck().get())
  out.marker = !!db.prepare('SELECT 1 FROM session_migrations WHERE id = ?').get(sdb.PROMPT_SPLIT_MARKER)
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  sdb.closeDb()
  return out
}

function child(name, home, args = {}) {
  const out = path.join(home, `.phase-${name}.json`)
  return new Promise((resolve, reject) => {
    const kid = spawn(process.execPath, [fileURLToPath(import.meta.url), '--phase', name, '--phase-out', out, '--version', args.version ?? ''], {
      cwd: repo, stdio: ['ignore', 'inherit', 'pipe'],
      env: {
        ...process.env, OPEN_WALNUT_HOME: home, NODE_ENV: 'test', WALNUT_LOG_LEVEL: 'warn',
        WALNUT_DAEMON_DIR: path.join(home, '.daemon'), XDG_STATE_HOME: path.join(home, '.state'), TMPDIR: path.join(home, '.tmp'),
      },
    })
    let err = ''
    kid.stderr.on('data', (d) => { err += String(d) })
    kid.on('exit', (code) => (code === 0 ? resolve(JSON.parse(fs.readFileSync(out, 'utf8'))) : reject(new Error(`${name} exited ${code}: ${err.slice(-2000)}`))))
  })
}

// ── The older release's side ─────────────────────────────────────────────────

/**
 * Start the older release on a copy of `fromHome`'s sessions store and read every session back.
 * `writeBack`: it also renames each session (PATCH, its own whole-row write), and its store is
 * copied to that dir once it stopped.
 */
async function olderReads(work, name, older, fromHome, { writeBack = null } = {}) {
  const w = new IsolatedWalnut({ work, name, bin: older.launcher, extraEnv: { WALNUT_NO_AUTO_UPDATE: '1' } })
  fs.mkdirSync(w.walnutHome, { recursive: true })
  fs.copyFileSync(path.join(fromHome, 'sessions.sqlite'), path.join(w.walnutHome, 'sessions.sqlite'))
  const got = {}
  try {
    await w.start()
    for (const [key, s] of Object.entries(SESSIONS)) {
      const { status, json } = await w.api('GET', `/api/sessions/${s.sid}`)
      const rec = json?.session ?? null
      got[key] = {
        status,
        persona: { want: sha(s.profile?.systemPrompt), got: sha(rec?.profile?.systemPrompt), bytes: Buffer.byteLength(rec?.profile?.systemPrompt ?? '') },
        spawnPrompt: { want: sha(s.appliedAppendSystemPrompt), got: sha(rec?.appliedAppendSystemPrompt), bytes: Buffer.byteLength(rec?.appliedAppendSystemPrompt ?? '') },
      }
      got[key].equal = got[key].persona.want === got[key].persona.got && got[key].spawnPrompt.want === got[key].spawnPrompt.got
      if (writeBack) got[key].renamed = (await w.api('PATCH', `/api/sessions/${s.sid}`, { title: `renamed by ${older.version}` })).status
    }
  } finally { await w.shutdown() }
  if (writeBack) {
    fs.rmSync(writeBack, { recursive: true, force: true })
    fs.mkdirSync(writeBack, { recursive: true })
    for (const f of ['sessions.sqlite', 'sessions.sqlite-wal', 'sessions.sqlite-shm']) if (fs.existsSync(path.join(w.walnutHome, f))) fs.copyFileSync(path.join(w.walnutHome, f), path.join(writeBack, f))
  }
  return got
}

/** What a build before the split does when it sets a spawn prompt on a stripped row: the text back in the payload, its stub kept, the column NULL. */
async function olderBuildSetsSpawnPrompt(home, sid, text) {
  const { default: Database } = await import(path.join(repo, 'src/lib/sqlite.ts'))
  const db = new Database(path.join(home, 'sessions.sqlite'))
  try {
    db.prepare("UPDATE sessions SET payload = json_set(payload, '$.appliedAppendSystemPrompt', ?), prompt_text_refs = NULL WHERE claude_session_id = ?").run(text, sid)
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally { db.close() }
}

async function rollbackCheck(older, home) {
  const { checkRollbackData } = await import(path.join(repo, 'scripts/lib/rollback-data-check.mjs'))
  try { return { passes: true, result: await checkRollbackData({ file: older.file, home }) } } catch (err) { return { passes: false, refusal: err.message } }
}

function copyHome(from, to) {
  fs.rmSync(to, { recursive: true, force: true })
  fs.mkdirSync(to, { recursive: true })
  fs.copyFileSync(path.join(from, 'sessions.sqlite'), path.join(to, 'sessions.sqlite'))
  return to
}

async function main() {
  const argv = process.argv.slice(2)
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
  if (arg('--phase')) {
    fs.writeFileSync(arg('--phase-out'), JSON.stringify(await phase(arg('--phase'), { version: arg('--version') || undefined })))
    process.exit(0)
  }
  const out = path.resolve(arg('--out', fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-split-downgrade.'))))
  const work = path.join(out, 'work')
  fs.mkdirSync(work, { recursive: true })
  const manifest = await olderManifest(arg('--older', 'latest'))
  const older = await installOlder(work, manifest)
  const thisVersion = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version
  const report = { at: new Date().toISOString(), older: older.version, olderFile: older.file, thisTree: thisVersion, scenarios: {}, problems: [] }
  const fail = (why) => { report.problems.push(why); process.stdout.write(`  x ${why}\n`) }

  // gated: this tree as the first release after the older one (it served nothing before).
  const base = path.join(out, 'home-gated')
  fs.mkdirSync(base, { recursive: true })
  await child('seed', base)
  const gated = await child('job', base, { version: thisVersion })
  const gatedReads = await olderReads(work, 'older-gated', older, base)
  report.scenarios.gated = { job: gated, olderReads: gatedReads, rollbackCheck: await rollbackCheck(older, base) }
  if (gated.gate.open || gated.stripped !== 0 || gated.payloadsWithText !== ROWS_WITH_TEXT) fail(`gated: the gate let the first release after ${older.version} strip (${JSON.stringify(gated)})`)
  for (const [k, v] of Object.entries(gatedReads)) if (!v.equal) fail(`gated: the older release read ${k} differently`)

  // stripped: the strip forced on a copy.
  const sHome = copyHome(base, path.join(out, 'home-stripped'))
  const forced = await child('force-strip', sHome)
  const check = await rollbackCheck(older, sHome)
  const strippedReads = await olderReads(work, 'older-stripped', older, copyHome(sHome, path.join(out, 'home-stripped-copy')))
  report.scenarios.stripped = { job: forced, rollbackCheck: check, olderReadsAnyway: strippedReads }
  if (forced.payloadsWithText !== 0) fail('stripped: texts left in a payload')
  if (check.passes || !/session_prompts that this build cannot read/.test(check.refusal ?? '')) fail(`stripped: the rollback check did not refuse ${older.version} (${JSON.stringify(check)})`)
  for (const [k, v] of Object.entries(strippedReads)) if (v.equal !== false) fail(`stripped: the older release, started anyway, still read ${k} whole: the hazard was not seen`)

  // unsplit: the down migration, then the older release.
  const uHome = copyHome(sHome, path.join(out, 'home-unsplit'))
  const unsplit = await child('unsplit', uHome)
  const uCheck = await rollbackCheck(older, uHome)
  const unsplitReads = await olderReads(work, 'older-unsplit', older, uHome)
  report.scenarios.unsplit = { job: unsplit, rollbackCheck: uCheck, olderReads: unsplitReads }
  if (!uCheck.passes) fail(`unsplit: the rollback check refused ${older.version} (${uCheck.refusal})`)
  for (const [k, v] of Object.entries(unsplitReads)) if (!v.equal) fail(`unsplit: the older release read ${k} differently`)

  // next: the two releases after this one on the gated home. The first is still the first that
  // recorded serving it past the last release without the split; the second opens the gate.
  const nHome = copyHome(base, path.join(out, 'home-next'))
  const [maj, min, pat] = thisVersion.split('.').map(Number)
  const n1 = `${maj}.${min}.${pat + 1}`
  const n2 = `${maj}.${min}.${pat + 2}`
  const first = await child('job', nHome, { version: n1 })
  const second = await child('job', nHome, { version: n2 })
  report.scenarios.next = { [n1]: first, [n2]: second }
  if (first.gate.open || first.payloadsWithText !== ROWS_WITH_TEXT) fail(`next: ${n1} stripped, though the release before it may be ${older.version} (${JSON.stringify(first)})`)
  if (!second.gate.open || second.payloadsWithText !== 0) fail(`next: ${n2} did not strip after ${n1} served the store (${JSON.stringify(second)})`)

  // olderWrote: the older release served the stripped store anyway and wrote it (each session
  // renamed, its own whole-row writes), and a build before the split set a new spawn prompt on a
  // row whose persona lives only in the table (that one write done here, in SQL, as such a build
  // does it). Then this tree again, as the two releases after it. Judged: the first keeps the gate
  // closed (a build before the split wrote the store), the second strips, and every text reads
  // back: the older build's new spawn prompt, and the persona it never saw.
  const wHome = path.join(out, 'home-older-wrote')
  const wroteReads = await olderReads(work, 'older-writes', older, copyHome(sHome, path.join(out, 'home-older-wrote-from')), { writeBack: wHome })
  await olderBuildSetsSpawnPrompt(wHome, SESSIONS.both.sid, NEWER_SPAWN_PROMPT)
  const w1 = await child('job', wHome, { version: n1 })
  const w2 = await child('job', wHome, { version: n2 })
  const wRead = await child('read', wHome)
  const wantBack = {
    lane: { persona: sha(SESSIONS.lane.profile.systemPrompt), spawnPrompt: null },
    task: { persona: null, spawnPrompt: sha(SESSIONS.task.appliedAppendSystemPrompt) },
    both: { persona: sha(SESSIONS.both.profile.systemPrompt), spawnPrompt: sha(NEWER_SPAWN_PROMPT) },
  }
  report.scenarios.olderWrote = { olderReads: wroteReads, [n1]: w1, [n2]: w2, reads: wRead.reads, want: wantBack }
  for (const [k, v] of Object.entries(wroteReads)) if (v.renamed !== 200) fail(`olderWrote: the older release did not write ${k} (${v.renamed})`)
  if (w1.gate.open || !/build before the prompt split/.test(w1.gate.reason)) fail(`olderWrote: ${n1} opened the gate after a build before the split wrote the store (${JSON.stringify(w1.gate)})`)
  if (!w2.gate.open || w2.payloadsWithText !== 0) fail(`olderWrote: ${n2} did not strip (${JSON.stringify(w2)})`)
  for (const [k, want] of Object.entries(wantBack)) {
    const r = wRead.reads[k]
    if (r.persona !== want.persona || r.spawnPrompt !== want.spawnPrompt) fail(`olderWrote: ${k} read back ${JSON.stringify(r)}, want ${JSON.stringify(want)}`)
    if (!String(r.title).startsWith('renamed by')) fail(`olderWrote: ${k} lost the older release's write (title ${r.title})`)
  }

  report.ok = report.problems.length === 0
  fs.writeFileSync(path.join(out, 'prompt-split-downgrade.json'), JSON.stringify(report, null, 2))
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exit(report.ok ? 0 : 1)
}

await main()
