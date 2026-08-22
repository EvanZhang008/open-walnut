#!/usr/bin/env node
/**
 * Search golden-set eval runner (`npm run search:eval`).
 *
 * Merges two query files:
 *   tests/search-golden.yaml                     public, neutral, committed
 *   ~/.open-walnut/search-golden.local.yaml      real terms, NEVER committed
 *
 * Backends:
 *   qmd   (default) — live queries via HTTP GET /api/search on a running
 *                     server (read-only; never mutates any index)
 *   v2              — the in-house hybrid-search engine. Fixture queries run
 *                     against an in-memory index built from the public yaml's
 *                     corpus; live queries need --index-db (a search.sqlite
 *                     built by src/core/search/build.ts — never production's)
 *
 * Usage:
 *   node scripts/search-eval.mjs                      run all, print report
 *   node scripts/search-eval.mjs --dump               print top-10 per query
 *   node scripts/search-eval.mjs --explain <queryId>  full results for one query
 *   node scripts/search-eval.mjs --family cjk         only one family
 *   node scripts/search-eval.mjs --write-baseline     write tests/search-golden-baseline.json
 *   node scripts/search-eval.mjs --check              exit 1 if metrics regress vs baseline
 *   node scripts/search-eval.mjs --server http://localhost:3456
 *
 * The baseline file contains ONLY query ids + numbers (no query text), so the
 * local file's internal terms can never leak into the repo through it.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_GOLDEN = path.join(ROOT, 'tests', 'search-golden.yaml');
// First existing candidate wins. ~/.claude is the durable home: files that
// exist only on this machine get dropped from ~/.open-walnut by the cloud
// git-sync's LWW conflict resolution (observed twice on 2026-08-22).
const LOCAL_GOLDEN_CANDIDATES = [
  path.join(os.homedir(), '.claude', 'walnut-search-golden.local.yaml'),
  path.join(
    process.env.OPEN_WALNUT_HOME ?? path.join(os.homedir(), '.open-walnut'),
    'search-golden.local.yaml',
  ),
];
const LOCAL_GOLDEN = LOCAL_GOLDEN_CANDIDATES.find((p) => fs.existsSync(p))
  ?? LOCAL_GOLDEN_CANDIDATES[0];
const BASELINE_PATH = path.join(ROOT, 'tests', 'search-golden-baseline.json');

// Regression tolerances for --check (absolute for rates, relative for latency).
const TOLERANCE = { recall10: 0.05, mrr: 0.05, top1: 0.05, p90LatencyRatio: 1.5 };

// ── args ──
const args = process.argv.slice(2);
function flag(name) { return args.includes(name); }
function opt(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const BACKEND = opt('--backend', 'qmd');
const SERVER = opt('--server', 'http://localhost:3456');
const INDEX_DB = opt('--index-db', '/tmp/walnut-search-v2/search.sqlite');
const LIMIT = parseInt(opt('--limit', '10'), 10);
const EXPLAIN_ID = opt('--explain', null);
const FAMILY = opt('--family', null);
const DUMP = flag('--dump');
const WRITE_BASELINE = flag('--write-baseline');
const CHECK = flag('--check');

/** Per-kind score multipliers (kept in sync with the walnut adapter). */
const KIND_WEIGHTS = {
  task: { weight: 1.0 },
  memory: { weight: 1.1 },
  session: { weight: 0.9 },
  note: { weight: 1.0 },
  skill: { weight: 1.0 },
};

// ── load golden files ──
function loadGolden(file, source) {
  if (!fs.existsSync(file)) return { corpus: [], queries: [] };
  const doc = yaml.load(fs.readFileSync(file, 'utf8')) ?? {};
  const queries = (doc.queries ?? []).map((q) => ({ ...q, source }));
  return { corpus: doc.corpus ?? [], queries };
}

const pub = loadGolden(PUBLIC_GOLDEN, 'public');
const loc = loadGolden(LOCAL_GOLDEN, 'local');
const ids = new Set();
for (const q of [...pub.queries, ...loc.queries]) {
  if (!q.id || !q.query) throw new Error(`golden query missing id/query: ${JSON.stringify(q)}`);
  if (ids.has(q.id)) throw new Error(`duplicate golden query id: ${q.id}`);
  ids.add(q.id);
}

let queries = [...pub.queries, ...loc.queries];
if (FAMILY) queries = queries.filter((q) => q.family === FAMILY);
if (EXPLAIN_ID) queries = queries.filter((q) => q.id === EXPLAIN_ID);
if (EXPLAIN_ID && queries.length === 0) {
  console.error(`no golden query with id "${EXPLAIN_ID}"`);
  process.exit(2);
}

// ── backends ──
// Each returns { hits: [{ ref: 'kind:id', title, score, coverage? }], ms }.

let v2Lib = null;
async function loadV2() {
  if (!v2Lib) {
    // Requires the tsx-based npm script (plain node cannot import the TS lib).
    v2Lib = await import('../src/lib/hybrid-search/index.js');
  }
  return v2Lib;
}

let v2LiveIndex = null;
async function getV2LiveIndex() {
  if (v2LiveIndex) return v2LiveIndex;
  if (!fs.existsSync(INDEX_DB)) {
    throw new Error(
      `no v2 index at ${INDEX_DB} — build one with src/core/search/build.ts (buildFullSearchIndex) or pass --index-db`,
    );
  }
  const { createSearchIndex } = await loadV2();
  v2LiveIndex = createSearchIndex({ dbPath: INDEX_DB, kinds: KIND_WEIGHTS });
  return v2LiveIndex;
}

let v2FixtureIndex = null;
async function getV2FixtureIndex() {
  if (v2FixtureIndex) return v2FixtureIndex;
  const { createSearchIndex } = await loadV2();
  v2FixtureIndex = createSearchIndex({ dbPath: ':memory:', kinds: KIND_WEIGHTS });
  for (const doc of pub.corpus) {
    v2FixtureIndex.upsert({
      kind: doc.kind,
      ref: doc.ref,
      title: doc.title ?? '',
      summary: doc.summary ?? '',
      note: doc.note ?? '',
      meta: doc.meta ?? '',
      updatedAt: Date.parse(String(doc.updated_at ?? '')) || 0,
      identifiers: doc.identifiers,
    });
  }
  return v2FixtureIndex;
}

function runV2(index, query) {
  const t0 = performance.now();
  const hits = index.search(query.query, { limit: LIMIT });
  const ms = performance.now() - t0;
  return {
    hits: hits.map((h) => ({
      ref: `${h.kind}:${h.ref}`,
      title: h.title,
      score: h.score,
      coverage: h.components.coverage,
    })),
    ms,
  };
}

async function runQmdHttp(query) {
  const url = `${SERVER}/api/search?q=${encodeURIComponent(query.query)}&limit=${LIMIT}`;
  const t0 = performance.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const ms = performance.now() - t0;
  if (!res.ok) throw new Error(`GET /api/search → ${res.status}`);
  const body = await res.json();
  const terms = query.query.trim().split(/\s+/).length;
  const hits = (body.results ?? []).map((r) => ({
    ref: `${r.type}:${r.taskId ?? r.sessionId ?? r.path ?? ''}`,
    title: r.title ?? '',
    score: r.score,
    coverage: typeof r.coveredTermHits === 'number' && terms > 0
      ? r.coveredTermHits / terms
      : undefined,
  }));
  return { hits, ms };
}

async function runBackend(query) {
  if (BACKEND === 'v2') {
    return query.dataset === 'live'
      ? runV2(await getV2LiveIndex(), query)
      : runV2(await getV2FixtureIndex(), query);
  }
  if (query.dataset !== 'live') {
    // QMD cannot index the inline fixture corpus without touching prod.
    return null;
  }
  if (BACKEND === 'qmd') return runQmdHttp(query);
  throw new Error(`unknown backend "${BACKEND}"`);
}

// ── assertions ──
function rankOf(hits, ref) {
  const i = hits.findIndex((h) => h.ref === ref);
  return i === -1 ? null : i + 1;
}

function evalAssertions(query, hits, ms) {
  const failures = [];
  const includeRefs = query.must_include ?? [];
  const anyRefs = query.must_include_any ?? [];

  let bestRank = null;
  for (const ref of [...includeRefs, ...anyRefs]) {
    const r = rankOf(hits, ref);
    if (r !== null && (bestRank === null || r < bestRank)) bestRank = r;
  }
  for (const ref of includeRefs) {
    if (rankOf(hits, ref) === null) failures.push(`must_include missing: ${ref}`);
  }
  if (anyRefs.length > 0 && !anyRefs.some((ref) => rankOf(hits, ref) !== null)) {
    failures.push(`must_include_any: none of ${anyRefs.length} refs found`);
  }
  if (query.top1 && hits[0]?.ref !== query.top1) {
    failures.push(`top1 is ${hits[0]?.ref ?? '(empty)'}, wanted ${query.top1}`);
  }
  if (query.top1_kind && hits[0]?.ref.split(':')[0] !== query.top1_kind) {
    failures.push(`top1_kind is ${hits[0]?.ref.split(':')[0] ?? '(empty)'}, wanted ${query.top1_kind}`);
  }
  for (const [above, below] of query.must_rank_above ?? []) {
    const ra = rankOf(hits, above);
    const rb = rankOf(hits, below);
    if (ra === null) failures.push(`must_rank_above: ${above} not in results`);
    else if (rb !== null && ra >= rb) failures.push(`must_rank_above: ${above} (#${ra}) not above ${below} (#${rb})`);
  }
  for (const ref of query.must_exclude ?? []) {
    const r = rankOf(hits, ref);
    if (r !== null) failures.push(`must_exclude: ${ref} appeared at #${r}`);
  }
  if (typeof query.min_coverage === 'number' && bestRank !== null) {
    const cov = hits[bestRank - 1]?.coverage;
    if (typeof cov === 'number' && cov < query.min_coverage) {
      failures.push(`coverage ${cov.toFixed(2)} < ${query.min_coverage}`);
    }
  }
  if (typeof query.max_latency_ms === 'number' && ms > query.max_latency_ms) {
    failures.push(`latency ${Math.round(ms)}ms > ${query.max_latency_ms}ms`);
  }
  return { failures, bestRank };
}

// ── run ──
const results = [];
let skipped = 0;
for (const query of queries) {
  let out;
  try {
    out = await runBackend(query);
  } catch (err) {
    results.push({ query, error: err instanceof Error ? err.message : String(err) });
    continue;
  }
  if (out === null) { skipped++; continue; }
  const { failures, bestRank } = evalAssertions(query, out.hits, out.ms);
  results.push({ query, hits: out.hits, ms: out.ms, failures, bestRank });

  if (DUMP || EXPLAIN_ID) {
    console.log(`\n━━ ${query.id} [${query.family}] (${Math.round(out.ms)}ms)`);
    console.log(`   query: ${query.query}`);
    out.hits.forEach((h, i) => {
      const cov = typeof h.coverage === 'number' ? ` cov=${h.coverage.toFixed(2)}` : '';
      console.log(`   ${String(i + 1).padStart(2)}. ${h.ref}${cov}  ${h.title.slice(0, 78)}`);
    });
    if (failures.length) console.log(`   FAIL: ${failures.join(' | ')}`);
    else console.log('   PASS');
  }
}
if (EXPLAIN_ID) process.exit(0);

// ── aggregate ──
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

const ran = results.filter((r) => !r.error);
const errored = results.filter((r) => r.error);
const recallQ = ran.filter((r) => (r.query.must_include?.length ?? 0) + (r.query.must_include_any?.length ?? 0) > 0);
const recallHits = recallQ.filter((r) => r.bestRank !== null);
const mrr = recallQ.length
  ? recallQ.reduce((s, r) => s + (r.bestRank ? 1 / r.bestRank : 0), 0) / recallQ.length
  : 0;
const top1Q = ran.filter((r) => r.query.top1 || r.query.top1_kind);
const top1Pass = top1Q.filter((r) => !r.failures.some((f) => f.startsWith('top1')));
const latencies = ran.map((r) => r.ms).sort((a, b) => a - b);
const passed = ran.filter((r) => r.failures.length === 0);

const aggregate = {
  queries: ran.length,
  passed: passed.length,
  recall10: recallQ.length ? recallHits.length / recallQ.length : null,
  mrr: recallQ.length ? Number(mrr.toFixed(4)) : null,
  top1: top1Q.length ? top1Pass.length / top1Q.length : null,
  p50LatencyMs: Math.round(percentile(latencies, 0.5)),
  p90LatencyMs: Math.round(percentile(latencies, 0.9)),
};

const byFamily = {};
for (const r of ran) {
  const f = r.query.family ?? 'other';
  byFamily[f] ??= { total: 0, passed: 0 };
  byFamily[f].total++;
  if (r.failures.length === 0) byFamily[f].passed++;
}

console.log(`\n═══ search-eval  backend=${BACKEND}  server=${SERVER} ═══`);
console.log(`ran ${ran.length} live queries (${skipped} fixture queries skipped, ${errored.length} errored)`);
console.log(`pass ${passed.length}/${ran.length}   recall@${LIMIT} ${aggregate.recall10 !== null ? (aggregate.recall10 * 100).toFixed(0) + '%' : '—'}   MRR ${aggregate.mrr ?? '—'}   top1 ${aggregate.top1 !== null ? (aggregate.top1 * 100).toFixed(0) + '%' : '—'}   p50 ${aggregate.p50LatencyMs}ms   p90 ${aggregate.p90LatencyMs}ms`);
for (const [fam, s] of Object.entries(byFamily).sort()) {
  console.log(`  ${fam.padEnd(14)} ${s.passed}/${s.total}`);
}
for (const r of ran.filter((x) => x.failures.length > 0)) {
  console.log(`  ✗ ${r.query.id}: ${r.failures.join(' | ')}`);
}
for (const r of errored) console.log(`  ⚠ ${r.query.id}: ${r.error}`);

// ── baseline ──
if (WRITE_BASELINE) {
  const baseline = {
    backend: BACKEND,
    generatedAt: new Date().toISOString(),
    aggregate,
    perQuery: Object.fromEntries(ran.map((r) => [r.query.id, {
      pass: r.failures.length === 0,
      rank: r.bestRank,
      ms: Math.round(r.ms),
    }])),
  };
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`\nbaseline written → ${BASELINE_PATH}`);
}

if (CHECK) {
  if (!fs.existsSync(BASELINE_PATH)) {
    console.error('no baseline to check against (run with --write-baseline first)');
    process.exit(2);
  }
  const base = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  const regressions = [];
  for (const key of ['recall10', 'mrr', 'top1']) {
    const was = base.aggregate[key];
    const now = aggregate[key];
    if (was !== null && now !== null && now < was - TOLERANCE[key]) {
      regressions.push(`${key}: ${was} → ${now}`);
    }
  }
  if (base.aggregate.p90LatencyMs > 0
    && aggregate.p90LatencyMs > base.aggregate.p90LatencyMs * TOLERANCE.p90LatencyRatio) {
    regressions.push(`p90 latency: ${base.aggregate.p90LatencyMs}ms → ${aggregate.p90LatencyMs}ms`);
  }
  if (regressions.length) {
    console.error(`\nREGRESSION vs baseline (${base.backend}, ${base.generatedAt}):`);
    for (const r of regressions) console.error(`  ${r}`);
    process.exit(1);
  }
  console.log('\nno regression vs baseline ✓');
}
