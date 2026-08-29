#!/usr/bin/env node
/**
 * Notes-search golden eval — runs a LOCAL (never-committed) case file against
 * a live server's /api/notes-v2/search and reports per-family recall.
 *
 * The case file lives OUTSIDE the repo (personal vault paths):
 *   default ~/.claude/walnut-notes-search-golden.local.yaml
 *   override: NOTES_GOLDEN=/path node scripts/notes-search-eval.mjs
 *
 * Case shape:
 *   - { id, query, expect: <vault-relative path>, assert: top1|top5|top10|present,
 *       family, match?: folder }   # match: folder → expect is a FOLDER: pass when
 *                                  # the folders[] rows or any result path is under it
 *
 * Usage:
 *   node scripts/notes-search-eval.mjs                 # run all, summary + failures
 *   node scripts/notes-search-eval.mjs --explain <id>  # dump top-10 for one case
 *   NOTES_EVAL_URL=http://localhost:3456 …             # server (default prod :3456)
 *   --check-paths <vaultDir>                           # only verify expect paths exist
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';

const GOLDEN = process.env.NOTES_GOLDEN
  ?? path.join(os.homedir(), '.claude', 'walnut-notes-search-golden.local.yaml');
const BASE = process.env.NOTES_EVAL_URL ?? 'http://localhost:3456';

const doc = yaml.load(fs.readFileSync(GOLDEN, 'utf8'));
const cases = doc?.cases ?? [];
if (!cases.length) { console.error('no cases in', GOLDEN); process.exit(2); }

const argv = process.argv.slice(2);
const explainId = argv[0] === '--explain' ? argv[1] : null;

if (argv[0] === '--check-paths') {
  const vault = argv[1];
  let missing = 0;
  for (const c of cases) {
    const p = path.join(vault, c.expect);
    if (!fs.existsSync(p)) { missing++; console.log('MISSING', c.id, '→', c.expect); }
  }
  console.log(missing === 0 ? `all ${cases.length} expect paths exist` : `${missing} missing`);
  process.exit(missing ? 1 : 0);
}

const LIMIT = { top1: 1, top5: 5, top10: 10, present: Infinity };

async function search(q) {
  const res = await fetch(`${BASE}/api/notes-v2/search?q=${encodeURIComponent(q)}&all=1`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function judge(c, payload) {
  const results = payload.results ?? [];
  const folders = payload.folders ?? [];
  if (c.match === 'folder') {
    const under = (p) => p === c.expect || p.startsWith(c.expect + '/');
    const inFolders = folders.some((f) => under(f.path));
    const idx = results.findIndex((r) => under(r.path));
    const hit = inFolders || idx >= 0;
    return { pass: hit, rank: inFolders ? 0 : (idx >= 0 ? idx + 1 : null) };
  }
  const idx = results.findIndex((r) => r.path === c.expect);
  const max = LIMIT[c.assert ?? 'present'];
  return { pass: idx >= 0 && idx < max, rank: idx >= 0 ? idx + 1 : null };
}

if (explainId) {
  const c = cases.find((x) => x.id === explainId);
  if (!c) { console.error('no such case', explainId); process.exit(2); }
  const payload = await search(c.query);
  console.log('query:', c.query, '| expect:', c.expect, `(${c.assert}${c.match ? ', folder' : ''})`);
  console.log('folders:', (payload.folders ?? []).map((f) => f.path).join(' | ') || '(none)');
  (payload.results ?? []).slice(0, 10).forEach((r, i) =>
    console.log(String(i + 1).padStart(2), r.matchType.padEnd(10), r.path));
  process.exit(0);
}

const t0 = Date.now();
const rows = [];
for (const c of cases) {
  const qt = Date.now();
  try {
    const payload = await search(c.query);
    const v = judge(c, payload);
    rows.push({ ...c, ...v, ms: Date.now() - qt });
  } catch (err) {
    rows.push({ ...c, pass: false, rank: null, ms: Date.now() - qt, error: String(err) });
  }
}

const fam = new Map();
for (const r of rows) {
  const f = fam.get(r.family) ?? { pass: 0, total: 0 };
  f.total++; if (r.pass) f.pass++;
  fam.set(r.family, f);
}
const passed = rows.filter((r) => r.pass).length;
const lat = rows.map((r) => r.ms).sort((a, b) => a - b);

console.log(`\n${passed}/${rows.length} passed  (p50 ${lat[Math.floor(lat.length / 2)]}ms, p90 ${lat[Math.floor(lat.length * 0.9)]}ms)  ${Date.now() - t0}ms total\n`);
for (const [f, s] of [...fam.entries()].sort()) {
  console.log(`  ${f.padEnd(12)} ${s.pass}/${s.total}`);
}
console.log('\nFAILURES:');
for (const r of rows.filter((x) => !x.pass)) {
  console.log(`  ${r.id.padEnd(20)} [${r.family}] rank=${r.rank ?? '—'} q="${r.query}"${r.error ? ' ERR ' + r.error : ''}`);
}
process.exit(passed === rows.length ? 0 : 1);
