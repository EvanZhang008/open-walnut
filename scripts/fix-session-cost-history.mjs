#!/usr/bin/env node
/**
 * One-shot repair for the inflated `session` usage rows.
 *
 * Root cause (see usage/tracker.ts + web/server.ts session:result handler):
 * the CLI's `total_cost_usd` is a RUNNING TOTAL for one CLI process, but Walnut
 * recorded that cumulative value on every turn — so the same dollars were billed
 * dozens of times (a real ~$36K of session spend showed as $223K, 13× inflated).
 * Two compounding bugs: (A) cumulative-as-increment, (B) replayed JSONL result
 * events re-recorded the whole ascending series.
 *
 * This script recomputes each session_id's REAL cost with the same gap-aware
 * high-watermark walk the live fix now does per-process, and rewrites cost_usd.
 *
 *   - Within one session_id, events are ordered by timestamp.
 *   - A rise above the watermark bills the increment (and advances the watermark).
 *   - A value == watermark bills 0 (idempotent replay).
 *   - A DROP below the watermark:
 *       · gap to previous event > GAP_SECONDS  → a --resume restarted the CLI
 *         process (total_cost_usd reset to 0): start a fresh run, bill in full.
 *       · gap <= GAP_SECONDS                    → replayed burst: bill 0.
 *
 * It collapses each session_id to ONE corrected row (sum of real increments),
 * preserving the original cumulative max in external_cost_usd for audit, and
 * deletes the redundant rows. Other sources (subagent/triage/agent/…) are token-
 * based and correct — they are left untouched.
 *
 * Usage:
 *   node scripts/fix-session-cost-history.mjs            # dry-run (prints plan)
 *   node scripts/fix-session-cost-history.mjs --apply    # writes (backs up first)
 *   DB=/path/to/usage.sqlite node scripts/...            # override db path
 */
import Database from '../node_modules/better-sqlite3/lib/index.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const GAP_SECONDS = 300; // > 5 min drop = resume (new process), else replay
const APPLY = process.argv.includes('--apply');
const DB_PATH = process.env.DB || path.join(os.homedir(), '.open-walnut', 'usage.sqlite');

if (!fs.existsSync(DB_PATH)) {
  console.error(`usage db not found: ${DB_PATH}`);
  process.exit(1);
}

const fmt = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Backup before any write.
if (APPLY) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${DB_PATH}.bak-${stamp}`;
  fs.copyFileSync(DB_PATH, backup);
  console.log(`backup written: ${backup}`);
}

const db = new Database(DB_PATH);

const rows = db.prepare(`
  SELECT id, session_id, timestamp, cost_usd AS cum
  FROM usage WHERE source = 'session'
  ORDER BY session_id, timestamp ASC
`).all();

const bySess = new Map();
for (const r of rows) {
  if (!bySess.has(r.session_id)) bySess.set(r.session_id, []);
  bySess.get(r.session_id).push(r);
}

let buggyTotal = 0, realTotal = 0, rowsBefore = rows.length, sessions = bySess.size;
const corrections = []; // { session_id, keepId, realCost, cumMax, dropIds[] }

for (const [sid, evs] of bySess) {
  let hwm = 0, lastT = null, real = 0, cumMax = 0;
  for (const e of evs) {
    buggyTotal += e.cum;
    cumMax = Math.max(cumMax, e.cum);
    const t = Date.parse(e.timestamp) / 1000;
    let delta;
    if (lastT === null) { delta = e.cum; hwm = e.cum; }
    else if (e.cum > hwm) { delta = e.cum - hwm; hwm = e.cum; }
    else if (e.cum === hwm) { delta = 0; }
    else { const gap = t - lastT; if (gap > GAP_SECONDS) { delta = e.cum; hwm = e.cum; } else { delta = 0; } }
    real += delta;
    lastT = t;
  }
  realTotal += real;
  corrections.push({
    session_id: sid,
    keepId: evs[evs.length - 1].id,          // keep the last row as the canonical one
    realCost: Math.round(real * 1e6) / 1e6,
    cumMax,
    dropIds: evs.slice(0, -1).map((e) => e.id),
  });
}

console.log('');
console.log('=== session cost history repair (gap-aware) ===');
console.log('mode:                ', APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)');
console.log('db:                  ', DB_PATH);
console.log('session rows before: ', rowsBefore, `across ${sessions} sessions`);
console.log('session rows after:  ', sessions, '(1 canonical row per session)');
console.log('buggy SUM (current):  ', fmt(buggyTotal));
console.log('real cost (corrected):', fmt(realTotal));
console.log('inflation removed:    ', fmt(buggyTotal - realTotal), `(${(buggyTotal / realTotal).toFixed(1)}×)`);

if (!APPLY) {
  console.log('\nDry-run only. Re-run with --apply to rewrite (a .bak copy is made first).');
  db.close();
  process.exit(0);
}

const updateOne = db.prepare('UPDATE usage SET cost_usd = ?, external_cost_usd = ? WHERE id = ?');
const deleteOne = db.prepare('DELETE FROM usage WHERE id = ?');
const tx = db.transaction(() => {
  for (const c of corrections) {
    // Canonical row carries the real cost; external_cost_usd keeps the cumulative max for audit.
    updateOne.run(c.realCost, c.cumMax, c.keepId);
    for (const id of c.dropIds) deleteOne.run(id);
  }
});
tx();

const after = db.prepare(`SELECT COALESCE(SUM(cost_usd),0) AS c, COUNT(*) AS n FROM usage WHERE source='session'`).get();
console.log('\napplied. session rows now:', after.n, ' total session cost:', fmt(after.c));
db.close();
