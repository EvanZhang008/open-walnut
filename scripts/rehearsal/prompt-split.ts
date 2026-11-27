/**
 * Rehearsal of the session prompt split on a copy of real data (design: prompt split, section 4).
 * Runs the real code: each phase is a child process of this script whose OPEN_WALNUT_HOME is a
 * folder of its own holding a copy of the reference store, so nothing here opens the reference
 * itself writable, and nothing reaches a live home.
 *
 *   bun scripts/rehearsal/prompt-split.ts --ref <sessions.sqlite copy> --work <empty dir>
 *     --old <a tree of the build before the split (src/ and node_modules)> [--a <a tree of release A>]
 *     [--old-build <walnut file>]
 *
 * This tree is release B. Take the reference with `sqlite3 <home>/sessions.sqlite ".backup
 * <dir>/sessions.sqlite"`, never a plain copy of a live file. Phases: measure (the build before,
 * release A, each twice in turn, and B on the stripped store with its writer past the gate), strip
 * (B's job, run here by hand past its gate), the round trip of every session against the reference,
 * a strip killed after 3, 10 and 20 batches, a build before the split writing stripped rows again
 * and B stripping them once more, unsplit, what the build before reads of each shape and
 * whether the rollback check refuses it (without --old-build: the old tree's own CLI), and B's gate
 * as it stands on this machine (its deploy's rollback builds asked the probe). Prints one JSON
 * report, and the three columns HEAD / A / B last.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const NEW_TREE = path.resolve(import.meta.dir, '../..');
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ''), process.argv[i + 1] ?? '');

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const r2 = (n: number) => Math.round(n * 100) / 100;
function pct(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))]! : 0;
}
const stats = (v: number[]) => ({ n: v.length, p50: r2(pct(v, 0.5)), p95: r2(pct(v, 0.95)), max: r2(Math.max(0, ...v)) });
/** JSON with sorted keys: two records equal apart from key order give the same text. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

// ── Phases (children) ──────────────────────────────────────────────────────

type Digest = Record<string, [string | null, string | null, string]>;

async function guardHome(tree: string): Promise<string> {
  const home = process.env.OPEN_WALNUT_HOME!;
  const { WALNUT_HOME, LOG_DIR } = await import(path.join(tree, 'src/constants.ts'));
  if (WALNUT_HOME !== home || !String(LOG_DIR).startsWith(home)) {
    throw new Error(`refusing: home ${WALNUT_HOME} or log dir ${LOG_DIR} is not under ${home}`);
  }
  return home;
}

/** Each text's hash, and the whole record's (its stubs left out: a build before the split carries them along unread). */
function digestOf(rec: Record<string, any>): [string | null, string | null, string] {
  const a = typeof rec.appliedAppendSystemPrompt === 'string' ? sha(rec.appliedAppendSystemPrompt) : null;
  const p = typeof rec.profile?.systemPrompt === 'string' ? sha(rec.profile.systemPrompt) : null;
  const { appliedAppendSystemPromptRef: _a, ...rest } = rec;
  if (rest.profile) { const { systemPromptRef: _p, ...profile } = rest.profile; rest.profile = profile; }
  return [a, p, sha(canonical(rest))];
}

/** What a build reads of every row: the build before through its rowToSession on raw rows. */
async function phaseOldRead(tree: string): Promise<unknown> {
  const home = await guardHome(tree);
  const { default: Database } = await import(path.join(tree, 'src/lib/sqlite.ts'));
  const { rowToSession } = await import(path.join(tree, 'src/core/session-db.ts'));
  const db = new Database(path.join(home, 'sessions.sqlite'), { readonly: true, fileMustExist: true });
  const out: Digest = {};
  for (const row of db.prepare('SELECT * FROM sessions').all() as Array<Record<string, any>>) out[row.claude_session_id] = digestOf(rowToSession(row));
  db.close();
  return out;
}

/** The new build's whole read of every session by id, and the prompt table's own hashes. */
async function phaseNewRead(): Promise<unknown> {
  const home = await guardHome(NEW_TREE);
  const tracker = await import(path.join(NEW_TREE, 'src/core/session-tracker.ts'));
  const { getDb } = await import(path.join(NEW_TREE, 'src/core/session-db.ts'));
  await tracker.listSessions();
  const db = getDb();
  const out: Digest = {};
  for (const sid of db.prepare('SELECT claude_session_id FROM sessions').pluck().all() as string[]) {
    const rec = tracker.getSessionByClaudeIdSync(sid);
    out[sid] = rec ? digestOf(rec) : [null, null, 'missing'];
  }
  let badSha = 0;
  for (const t of db.prepare('SELECT body, sha256 FROM session_prompts').all() as Array<{ body: string; sha256: string }>) if (sha(t.body) !== t.sha256) badSha++;
  void home;
  return { digest: out, promptRows: db.prepare('SELECT count(*) FROM session_prompts').pluck().get(), badSha };
}

/** Store sizes, read with SQL. */
function sizesOf(db: any, file: string): Record<string, number> {
  const live = "process_status IN ('running', 'idle')";
  const one = (sql: string) => Number(db.prepare(sql).pluck().get() ?? 0);
  const lens = db.prepare(`SELECT length(CAST(payload AS BLOB)) FROM sessions WHERE ${live} ORDER BY 1 DESC`).pluck().all() as number[];
  const rowLens = db.prepare(`SELECT length(CAST(payload AS BLOB)) + length(CAST(coalesce(title, '') AS BLOB)) + 200 FROM sessions WHERE ${live}`).pluck().all() as number[];
  const hasTable = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'session_prompts'").get();
  return {
    rows: one('SELECT count(*) FROM sessions'),
    liveRows: lens.length,
    payloadBytesAll: one('SELECT sum(length(CAST(payload AS BLOB))) FROM sessions'),
    livePayloadMean: r2(lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length)),
    livePayloadP50: pct(lens, 0.5),
    liveTop30Mean: r2(lens.slice(0, 30).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(30, lens.length))),
    liveRowApproxMean: r2(rowLens.reduce((a, b) => a + b, 0) / Math.max(1, rowLens.length)),
    promptRows: hasTable ? one('SELECT count(*) FROM session_prompts') : 0,
    promptBytes: hasTable ? one('SELECT sum(length(CAST(body AS BLOB))) FROM session_prompts') : 0,
    fileBytes: fs.statSync(file).size + (fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0),
  };
}

/** Full scans and WRITES status writes on the 30 largest live rows, with `tree`'s code. */
// 400 writes left a p50 that moved 0.1 ms between two runs of the same build on the Mac.
const WRITES = 1200;
async function phaseMeasure(tree: string, stubs: boolean): Promise<unknown> {
  const home = await guardHome(tree);
  const tracker = await import(path.join(tree, 'src/core/session-tracker.ts'));
  const sdb = await import(path.join(tree, 'src/core/session-db.ts'));
  const { writingAsHost } = await import(path.join(tree, 'src/core/sessions/session-row-owner.ts'));
  await tracker.listSessions();
  // The indexes a server builds 120 s after the open, built now (each build its own).
  const late = await import(path.join(tree, 'src/lib/sqlite-late-index.ts')).catch(() => null);
  const lateBuilt: string[] = late?.buildLateIndexesNow ? await late.buildLateIndexesNow() : [];
  // Release B past its gate: writes leave only the stubs.
  if (stubs) {
    if (!sdb.letPromptTextsLeavePayload) throw new Error(`${tree} has no release B writer`);
    sdb.letPromptTextsLeavePayload();
  }
  const db = sdb.getDb();
  const file = path.join(home, 'sessions.sqlite');
  const sizes = sizesOf(db, file);
  const scan = async (n: number): Promise<number[]> => {
    const ms: number[] = [];
    for (let i = 0; i < n; i++) {
      tracker._dropSessionStoreCacheForTesting();
      const t = performance.now();
      await tracker.listSessions();
      ms.push(performance.now() - t);
    }
    return ms;
  };
  // A build with the prompt_text_refs column: its scan before the fill pass (the first start on
  // older rows, once), the fill itself, then the steady state every later start has.
  const jobsFile = path.join(tree, 'src/core/session-prompt-jobs.ts');
  const hasFill = fs.existsSync(jobsFile) && fs.readFileSync(jobsFile, 'utf8').includes("'refs'");
  let beforeFill: unknown = null;
  let fill: unknown = null;
  if (hasFill) {
    beforeFill = stats(await scan(5));
    const { runPromptPass } = await import(jobsFile);
    const batchMs: number[] = [];
    const r = await runPromptPass('refs', { onBatch: (b: { ms: number }) => batchMs.push(b.ms) });
    fill = { rows: r.rows, batches: r.batches, ms: r2(r.ms), batchMs: stats(batchMs) };
  }
  const scans = await scan(15);
  const ids = db.prepare("SELECT claude_session_id FROM sessions WHERE process_status IN ('running', 'idle') ORDER BY length(payload) DESC LIMIT 30").pluck().all() as string[];
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec('PRAGMA wal_autocheckpoint = 0');
  sdb._resetSessionRowWriteStatsForTesting?.();
  const writes: number[] = [];
  const changesBefore = Number(db.prepare('SELECT total_changes()').pluck().get());
  for (let i = 0; i < WRITES; i++) {
    const t = performance.now();
    // Each pass over the rows flips their status, and the activity time moves on every write, so
    // every write rewrites its row (a host-judged row's status is its host's: the leader keeps it).
    const flip = Math.floor(i / ids.length) % 2 === 1;
    // Most live rows are a host's: the leader writes their status as the host channel does.
    await writingAsHost(() => tracker.updateSessionRecord(ids[i % ids.length]!, {
      process_status: flip ? 'running' : 'idle', activity: flip ? 'processing' : undefined, lastActiveAt: new Date(Date.UTC(2026, 10, 26) + i * 1000).toISOString(),
    }));
    writes.push(performance.now() - t);
  }
  const wal = fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0;
  const landed = Number(db.prepare('SELECT total_changes()').pluck().get()) - changesBefore;
  return {
    sizes, lateBuilt, fullScanBeforeFillMs: beforeFill, fill, fullScanMs: stats(scans), scanPaths: sdb.sessionScanStats?.() ?? null,
    statusWriteMs: stats(writes), walBytesPerWrite: Math.round(wal / WRITES), rowChanges: landed, writeStats: sdb.sessionRowWriteStats?.() ?? null,
    textsInPayloadAfter: sdb.promptTextsInPayload?.() ?? true,
  };
}

/** Release B's strip job, run here by hand; prints `batch <n>` after each batch for a parent that kills it. */
async function phaseStrip(): Promise<unknown> {
  const home = await guardHome(NEW_TREE);
  const tracker = await import(path.join(NEW_TREE, 'src/core/session-tracker.ts'));
  const sdb = await import(path.join(NEW_TREE, 'src/core/session-db.ts'));
  const { runPromptPass } = await import(path.join(NEW_TREE, 'src/core/session-prompt-jobs.ts'));
  await tracker.listSessions();
  const db = sdb.getDb();
  const before = sizesOf(db, path.join(home, 'sessions.sqlite'));
  // The job past its gate (the gate itself: phaseGate).
  sdb.letPromptTextsLeavePayload();
  const batchMs: number[] = [];
  let n = 0;
  const pass = await runPromptPass('strip', { onBatch: (b: { ms: number }) => { batchMs.push(b.ms); process.stdout.write(`batch ${++n}\n`); } });
  const again = await runPromptPass('strip');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return {
    pass: { ...pass, ms: r2(pass.ms), longestBatchMs: r2(pass.longestBatchMs) }, batchMs: stats(batchMs), secondPassRows: again.rows,
    integrity: db.prepare('PRAGMA integrity_check').pluck().get(),
    marker: !!db.prepare('SELECT 1 FROM session_migrations WHERE id = ?').get(sdb.PROMPT_SPLIT_MARKER),
    textRowsLeft: db.prepare(`SELECT count(*) FROM sessions WHERE instr(payload, '"appliedAppendSystemPrompt":"') > 0 OR instr(payload, '"systemPrompt":"') > 0`).pluck().get(),
    before, after: sizesOf(db, path.join(home, 'sessions.sqlite')),
  };
}

/**
 * A stripped store a build before the split wrote again (design 3.3, review item 1): on rows whose
 * two texts both live only in the table, it sets a new spawn prompt (the text back in the payload,
 * the persona's stub kept, the column NULL), in SQL as such a build does it. Then B's fill and strip
 * run again, and every session is read back whole.
 */
async function phaseMixed(): Promise<unknown> {
  await guardHome(NEW_TREE);
  const tracker = await import(path.join(NEW_TREE, 'src/core/session-tracker.ts'));
  const sdb = await import(path.join(NEW_TREE, 'src/core/session-db.ts'));
  const { runPromptPass } = await import(path.join(NEW_TREE, 'src/core/session-prompt-jobs.ts'));
  await tracker.listSessions();
  const db = sdb.getDb();
  const ids = db.prepare(`SELECT claude_session_id FROM sessions WHERE json_valid(payload)
    AND json_type(payload, '$.profile.systemPromptRef') = 'object' AND json_type(payload, '$.appliedAppendSystemPromptRef') = 'object'
    AND json_type(payload, '$.profile.systemPrompt') IS NULL AND json_type(payload, '$.appliedAppendSystemPrompt') IS NULL LIMIT 20`).pluck().all() as string[];
  const newer: Record<string, string> = {};
  for (const sid of ids) {
    newer[sid] = sha(`spawn prompt an older build set on ${sid}`);
    db.prepare("UPDATE sessions SET payload = json_set(payload, '$.appliedAppendSystemPrompt', ?), prompt_text_refs = NULL WHERE claude_session_id = ?").run(`spawn prompt an older build set on ${sid}`, sid);
  }
  tracker._dropSessionStoreCacheForTesting();
  const fill = await runPromptPass('refs');
  sdb.letPromptTextsLeavePayload();
  const strip = await runPromptPass('strip');
  const digest: Digest = {};
  for (const sid of db.prepare('SELECT claude_session_id FROM sessions').pluck().all() as string[]) {
    const rec = tracker.getSessionByClaudeIdSync(sid);
    digest[sid] = rec ? digestOf(rec) : [null, null, 'missing'];
  }
  return { rows: ids.length, newer, fillRows: fill.rows, stripRows: strip.rows, digest,
    textRowsLeft: db.prepare(`SELECT count(*) FROM sessions WHERE instr(payload, '"appliedAppendSystemPrompt":"') > 0 OR instr(payload, '"systemPrompt":"') > 0`).pluck().get() };
}

/** B's gate on a copy, as it stands on this machine: its deploy's rollback builds are asked the probe (read only). */
async function phaseGate(): Promise<unknown> {
  await guardHome(NEW_TREE);
  const sdb = await import(path.join(NEW_TREE, 'src/core/session-db.ts'));
  const gate = await import(path.join(NEW_TREE, 'src/core/session-prompt-gate.ts'));
  const builds = gate.deployRollbackBuilds(process.env, process.env.REHEARSAL_REAL_HOME);
  const t = performance.now();
  const r = await gate.promptStripGate(sdb.getDb(), { rollbackBuilds: builds });
  return { ...r, ms: r2(performance.now() - t) };
}

async function phaseUnsplit(): Promise<unknown> {
  await guardHome(NEW_TREE);
  const tracker = await import(path.join(NEW_TREE, 'src/core/session-tracker.ts'));
  const sdb = await import(path.join(NEW_TREE, 'src/core/session-db.ts'));
  const { runPromptPass } = await import(path.join(NEW_TREE, 'src/core/session-prompt-jobs.ts'));
  const { SPLIT_PROMPT_ROWS_SQL } = await import(path.join(NEW_TREE, 'src/core/session-prompts.ts'));
  await tracker.listSessions();
  const pass = await runPromptPass('unsplit');
  const db = sdb.getDb();
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return {
    pass: { ...pass, ms: r2(pass.ms), longestBatchMs: r2(pass.longestBatchMs) }, splitRowsLeft: Number(db.prepare(SPLIT_PROMPT_ROWS_SQL).get().n),
    marker: !!db.prepare('SELECT 1 FROM session_migrations WHERE id = ?').get(sdb.PROMPT_SPLIT_MARKER),
    integrity: db.prepare('PRAGMA integrity_check').pluck().get(),
  };
}

// ── The orchestrator ───────────────────────────────────────────────────────

const WORK = args.get('work') ?? '';
const REF = args.get('ref') ?? '';
const OLD = args.get('old') ?? '';
const A_TREE = args.get('a') ?? '';

function homeFrom(name: string, from: string): string {
  const home = path.join(WORK, name);
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(path.join(home, 'runtime'), { recursive: true });
  for (const s of ['', '-wal', '-shm']) if (fs.existsSync(from + s)) fs.copyFileSync(from + s, path.join(home, `sessions.sqlite${s}`));
  return home;
}

/** Run one phase in a child; `killAfter` SIGKILLs it once it printed that many batches. */
function child(phase: string, home: string, opts: { tree?: string; killAfter?: number; stubs?: boolean } = {}): Promise<any> {
  const out = path.join(home, `${phase}.json`);
  fs.rmSync(out, { force: true });
  return new Promise((resolve, reject) => {
    const kid = spawn(process.execPath, [import.meta.path, '--phase', phase, '--out', out, '--tree', opts.tree ?? NEW_TREE, '--stubs', opts.stubs ? '1' : '0'], {
      cwd: opts.tree ?? NEW_TREE, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OPEN_WALNUT_HOME: home, WALNUT_DAEMON_DIR: path.join(home, 'runtime'), NODE_ENV: 'test', WALNUT_LOG_LEVEL: 'warn', REHEARSAL_REAL_HOME: process.env.HOME ?? '' },
    });
    let err = '';
    let killed = false;
    kid.stdout.on('data', (d: Buffer) => {
      const m = [...String(d).matchAll(/batch (\d+)/g)].pop();
      if (opts.killAfter && m && Number(m[1]) >= opts.killAfter && !killed) { killed = true; kid.kill('SIGKILL'); }
    });
    kid.stderr.on('data', (d: Buffer) => { err += String(d); });
    kid.on('exit', (code, signal) => {
      if (signal === 'SIGKILL' && killed) return resolve({ killedAfterBatches: opts.killAfter });
      if (code !== 0 || !fs.existsSync(out)) return reject(new Error(`${phase} on ${home} failed (${code ?? signal}): ${err.slice(-3000)}`));
      resolve(JSON.parse(fs.readFileSync(out, 'utf8')));
    });
  });
}

/** Rows whose texts or whole record differ from the reference. */
function compare(ref: Digest, got: Digest): Record<string, unknown> {
  const out = { sessions: Object.keys(ref).length, aaspEqual: 0, personaEqual: 0, recordEqual: 0, missing: 0, aaspDiff: [] as string[], personaDiff: [] as string[], recordDiff: [] as string[] };
  for (const [sid, [a, p, rec]] of Object.entries(ref)) {
    const g = got[sid];
    if (!g) { out.missing++; continue; }
    if (g[0] === a) out.aaspEqual++; else out.aaspDiff.push(sid);
    if (g[1] === p) out.personaEqual++; else out.personaDiff.push(sid);
    if (g[2] === rec) out.recordEqual++; else out.recordDiff.push(sid);
  }
  for (const k of ['aaspDiff', 'personaDiff', 'recordDiff'] as const) out[k] = out[k].slice(0, 5);
  return out;
}

/** Unsplit payloads against the reference's, byte for byte and with the stubs taken out. */
async function payloadsAgainstRef(file: string): Promise<Record<string, number>> {
  const { default: Database } = await import(path.join(NEW_TREE, 'src/lib/sqlite.ts'));
  const read = (f: string) => {
    const db = new Database(f, { readonly: true, fileMustExist: true });
    const m = new Map((db.prepare('SELECT claude_session_id AS id, payload FROM sessions').all() as Array<{ id: string; payload: string | null }>).map((r) => [r.id, r.payload]));
    db.close();
    return m;
  };
  const ref = read(REF);
  const got = read(file);
  const out = { rows: ref.size, byteEqual: 0, equalKeyOrderAside: 0, differ: 0, withStub: 0 };
  for (const [id, p] of ref) {
    const q = got.get(id) ?? null;
    if (q === p) { out.byteEqual++; out.equalKeyOrderAside++; continue; }
    if (q && /"(appliedAppendSystemPromptRef|systemPromptRef)"/.test(q)) out.withStub++;
    if (canonical(q ? JSON.parse(q) : null) === canonical(p ? JSON.parse(p) : null)) out.equalKeyOrderAside++; else out.differ++;
  }
  return out;
}

async function rollbackCheck(home: string, build: string): Promise<string> {
  const { checkRollbackData } = await import(path.join(NEW_TREE, 'scripts/lib/rollback-data-check.mjs'));
  // A home holding only that sessions store: the check's task-store probe has nothing to read.
  const only = homeFrom(`rc-${path.basename(home)}-${path.basename(build)}`, path.join(home, 'sessions.sqlite'));
  try { return `passes: ${JSON.stringify((await checkRollbackData({ file: build, home: only })).sessions ?? null)}`; } catch (err) { return `refuses: ${(err as Error).message}`; }
}

/** Section 4.3's numbers in three columns: HEAD (before A), A, B (stripped, past its gate). */
function columns(r: Record<string, any>): Record<string, unknown> {
  const pair = (a: any, b: any, f: (m: any) => unknown) => [f(a), f(b)];
  const scan = (m: any) => m?.fullScanMs?.p50;
  const write = (m: any) => (m ? `${m.statusWriteMs.p50} / ${m.statusWriteMs.p95} / ${m.statusWriteMs.max}` : null);
  const wal = (m: any) => m?.walBytesPerWrite;
  const live = (m: any) => m?.sizes?.livePayloadMean;
  return {
    fullScanP50Ms: { HEAD: pair(r.measureOld, r.measureOld2, scan), A: pair(r.measureA, r.measureA2, scan), B: pair(r.measureB, r.measureB2, scan) },
    statusWriteP50P95MaxMs: { HEAD: pair(r.measureOld, r.measureOld2, write), A: pair(r.measureA, r.measureA2, write), B: pair(r.measureB, r.measureB2, write) },
    walBytesPerWrite: { HEAD: pair(r.measureOld, r.measureOld2, wal), A: pair(r.measureA, r.measureA2, wal), B: pair(r.measureB, r.measureB2, wal) },
    livePayloadMeanBytes: { HEAD: live(r.measureOld), A: live(r.measureA2), B: live(r.measureB) },
    bScanPathsPlainGuarded: r.measureB?.scanPaths,
    strip: { ms: r.strip?.pass?.ms, rows: r.strip?.pass?.rows, batches: r.strip?.pass?.batches, longestBatchMs: r.strip?.pass?.longestBatchMs, batchP95Ms: r.strip?.batchMs?.p95, secondPassRows: r.strip?.secondPassRows },
    roundTrip: r.roundTripStripped,
    crash: r.crash,
    unsplit: { ms: r.unsplit?.pass?.ms, rows: r.unsplit?.pass?.rows, oldReads: r.oldReadsUnsplit, payloads: r.unsplitPayloads },
    oldBuildRefusal: r.rollbackCheck,
    olderBuildWroteThenB: r.mixed,
    gateHere: r.gate,
  };
}

async function main(): Promise<void> {
  const phase = args.get('phase');
  if (phase) {
    const tree = args.get('tree') ?? NEW_TREE;
    const run = {
      oldread: () => phaseOldRead(tree), newread: phaseNewRead, measure: () => phaseMeasure(tree, args.get('stubs') === '1'),
      strip: phaseStrip, unsplit: phaseUnsplit, gate: phaseGate, mixed: phaseMixed,
    }[phase];
    if (!run) throw new Error(`unknown phase ${phase}`);
    fs.writeFileSync(args.get('out')!, JSON.stringify(await run()));
    process.exit(0);
  }
  if (!WORK || !REF || !OLD) throw new Error('usage: --ref <sessions.sqlite copy> --work <dir> --old <tree before the split> [--old-build <walnut file>]');
  fs.mkdirSync(WORK, { recursive: true });
  const report: Record<string, unknown> = { at: new Date().toISOString(), ref: REF, refSha256: sha(fs.readFileSync(REF).toString('binary')) };
  const t0 = performance.now();

  // The reference as the build before reads it.
  const refRead: Digest = await child('oldread', homeFrom('ref', REF), { tree: OLD });

  // 1. Status writes and scans: the build before and release A on the same copy, twice in turn
  // (the machine's load moves between runs).
  const aTree = A_TREE || NEW_TREE;
  report.measureOld = await child('measure', homeFrom('m-old', REF), { tree: OLD });
  report.measureA = await child('measure', homeFrom('m-a1', REF), { tree: aTree });
  report.measureOld2 = await child('measure', homeFrom('m-old2', REF), { tree: OLD });
  const aHome = homeFrom('m-a', REF);
  report.measureA2 = await child('measure', aHome, { tree: aTree });
  // The build before reads release A's rows (its status writes included): same texts.
  report.oldReadsA = compare(refRead, await child('oldread', aHome, { tree: OLD }));
  // B before its gate opens writes as A does: its scan and writes on the unstripped copy.
  report.measureBGated = await child('measure', homeFrom('m-b-gated', REF));

  // 2. The strip, then the round trip of every session.
  const sHome = homeFrom('strip', REF);
  report.gate = await child('gate', homeFrom('gate', REF));
  report.strip = await child('strip', sHome);
  const sRead = await child('newread', sHome);
  report.roundTripStripped = { ...compare(refRead, sRead.digest), promptRows: sRead.promptRows, badSha: sRead.badSha };
  report.oldReadsStripped = compare(refRead, await child('oldread', sHome, { tree: OLD }));
  // A build before the split writes some stripped rows again, then B strips once more (review item 1).
  const mixed = await child('mixed', homeFrom('mixed', path.join(sHome, 'sessions.sqlite')));
  const mixedCmp = { rows: mixed.rows, fillRows: mixed.fillRows, stripRows: mixed.stripRows, textRowsLeft: mixed.textRowsLeft, newSpawnPromptEqual: 0, personaEqual: 0, otherRowsRecordEqual: 0, otherRows: 0, diff: [] as string[] };
  for (const [sid, [a, p, rec]] of Object.entries(refRead)) {
    const g = mixed.digest[sid];
    if (sid in mixed.newer) {
      if (g?.[0] === mixed.newer[sid]) mixedCmp.newSpawnPromptEqual++; else mixedCmp.diff.push(sid);
      if (g?.[1] === p) mixedCmp.personaEqual++; else mixedCmp.diff.push(sid);
    } else {
      mixedCmp.otherRows++;
      if (g && g[0] === a && g[1] === p && g[2] === rec) mixedCmp.otherRowsRecordEqual++; else mixedCmp.diff.push(sid);
    }
  }
  mixedCmp.diff = mixedCmp.diff.slice(0, 5);
  report.mixed = mixedCmp;
  // Release B's scan and writes on the stripped store (past its gate), twice; release A's there (a rollback from B to A).
  report.measureB = await child('measure', homeFrom('m-b', path.join(sHome, 'sessions.sqlite')), { stubs: true });
  report.measureB2 = await child('measure', homeFrom('m-b2', path.join(sHome, 'sessions.sqlite')), { stubs: true });
  report.measureAOnStripped = await child('measure', homeFrom('m-a-stripped', path.join(sHome, 'sessions.sqlite')), { tree: aTree });

  // 3. A strip killed after 3, 10 and 20 batches, then finished.
  const cHome = homeFrom('crash', REF);
  const crash: unknown[] = [];
  for (const n of [3, 10, 20]) {
    await child('strip', cHome, { killAfter: n });
    const read = await child('newread', cHome);
    const cmp = compare(refRead, read.digest);
    crash.push({ killedAfter: n, aaspEqual: cmp.aaspEqual, personaEqual: cmp.personaEqual, recordEqual: cmp.recordEqual, missing: cmp.missing, badSha: read.badSha });
  }
  const finished = await child('strip', cHome);
  const finalRead = await child('newread', cHome);
  report.crash = { kills: crash, finish: { rows: finished.pass.rows, integrity: finished.integrity, textRowsLeft: finished.textRowsLeft }, roundTrip: compare(refRead, finalRead.digest) };

  // 4. Unsplit (the down migration) on the stripped store, then the build before reads it.
  const uHome = homeFrom('unsplit', path.join(sHome, 'sessions.sqlite'));
  report.unsplit = await child('unsplit', uHome);
  report.oldReadsUnsplit = compare(refRead, await child('oldread', uHome, { tree: OLD }));
  report.unsplitPayloads = await payloadsAgainstRef(path.join(uHome, 'sessions.sqlite'));

  // 5. The rollback check with a build before the split: refuses the stripped store only. Without
  // --old-build, the old tree's own CLI is that build.
  const oldBuild = args.get('old-build') || path.join(WORK, 'old-build.sh');
  if (!args.get('old-build')) fs.writeFileSync(oldBuild, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(OLD, 'src/cli.ts'))} "$@"\n`, { mode: 0o755 });
  // This tree's CLI as the build the check runs: it reads the split, so it passes the stripped store.
  const newBuild = path.join(WORK, 'new-build.sh');
  fs.writeFileSync(newBuild, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(NEW_TREE, 'src/cli.ts'))} "$@"\n`, { mode: 0o755 });
  report.rollbackCheck = {
    oldBuild, oldBuildReleaseA: await rollbackCheck(aHome, oldBuild), oldBuildStripped: await rollbackCheck(sHome, oldBuild), oldBuildUnsplit: await rollbackCheck(uHome, oldBuild),
    newBuildStripped: await rollbackCheck(sHome, newBuild),
  };
  report.columns = columns(report);
  report.totalSeconds = r2((performance.now() - t0) / 1000);
  console.log(JSON.stringify(report, null, 2));
}

await main();
