#!/usr/bin/env node
/**
 * AI task-search lane eval: runs the golden queries through the REAL agent
 * contract (slim claude -p child, Bash + curl searches) once per model, and
 * reports quality, latency and cost side by side.
 *
 * Usage (tsx, because it imports the TypeScript contract directly):
 *   ./node_modules/.bin/tsx scripts/search-agent-eval.mjs --models haiku,sonnet,opus
 *   ... --family human-vague          only one family
 *   ... --limit 10                    first N eligible cases
 *   ... --json /tmp/x/agent-eval.json write per-case results
 *   ... --server http://127.0.0.1:3456
 *
 * Reads only: the seed and every search the child runs are GET /api/search on
 * --server (default the local server). Nothing is created or written there.
 *
 * Cases come from the same golden files as scripts/search-eval.mjs (public +
 * local); a case is eligible when it runs against live data and names at least
 * one task target (top1 / must_include / must_include_any), or is a junk case
 * (the right answer is no confident result). Session-only targets are skipped:
 * the agent answers with task ids.
 *
 * The seed differs from production in one way: production pre-searches
 * in-process and attaches snippets; this script uses the slim HTTP rows, the
 * same shape the child's own searches return.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const SERVER = opt('--server', 'http://127.0.0.1:3456').replace(/\/$/, '');
const MODELS = opt('--models', 'haiku,sonnet,opus').split(',').map((s) => s.trim()).filter(Boolean);
const FAMILY = opt('--family', null);
const LIMIT = Number(opt('--limit', '0')) || 0;
const JSON_OUT = opt('--json', null);
const TIMEOUT_MS = Number(opt('--timeout-ms', '80000'));

const { buildCliSystemPrompt, buildUserPrompt, buildSeedResultsBlock, parseAgentAnswer } =
  await import(path.join(ROOT, 'src/core/task-search-agent-contract.ts'));
const { runMicroClaude } = await import(path.join(ROOT, 'src/providers/micro-claude.ts'));
// Drops the pooled child between models and at the end (the pool is keyed on
// the model, so a leftover child of the previous model would idle until TTL).
const { computeCost } = await import(path.join(ROOT, 'src/core/usage/pricing.ts'));
const { _resetWarmPoolForTesting: resetWarmPool } = await import(path.join(ROOT, 'src/providers/micro-claude-warm.ts'));

// ── cases ──
const LOCAL_CANDIDATES = [
  path.join(os.homedir(), '.claude', 'walnut-search-golden.local.yaml'),
  path.join(process.env.OPEN_WALNUT_HOME ?? path.join(os.homedir(), '.open-walnut'), 'search-golden.local.yaml'),
];
function load(file) {
  if (!file || !fs.existsSync(file)) return [];
  return (yaml.load(fs.readFileSync(file, 'utf8'))?.queries ?? []);
}
const all = [
  ...load(path.join(ROOT, 'tests', 'search-golden.yaml')),
  ...load(LOCAL_CANDIDATES.find((p) => fs.existsSync(p))),
];
const taskIds = (refs) => (refs ?? []).filter((r) => typeof r === 'string' && r.startsWith('task:')).map((r) => r.slice(5));
let cases = all
  .filter((q) => q.dataset === 'live' && q.family !== 'identifier' && q.query?.trim().length >= 4)
  .map((q) => ({
    id: q.id,
    family: q.family,
    query: q.query,
    targets: [...new Set([...taskIds(q.top1 ? [q.top1] : []), ...taskIds(q.must_include), ...taskIds(q.must_include_any)])],
    junk: q.family === 'junk',
  }))
  .filter((c) => c.junk || c.targets.length > 0);
if (FAMILY) cases = cases.filter((c) => c.family === FAMILY);
if (LIMIT) cases = cases.slice(0, LIMIT);
if (cases.length === 0) {
  console.error('no eligible cases');
  process.exit(2);
}

// ── one run ──
async function seedRows(query) {
  const u = new URL(`${SERVER}/api/search`);
  u.searchParams.set('q', query);
  u.searchParams.set('types', 'task,session');
  u.searchParams.set('limit', '8');
  u.searchParams.set('slim', '1');
  const res = await fetch(u, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`seed search ${res.status}`);
  return res.text();
}

const system = buildCliSystemPrompt(SERVER);
async function runOne(model, c) {
  const t0 = Date.now();
  const rows = await seedRows(c.query);
  let seedIds = [];
  try {
    const parsed = JSON.parse(rows);
    const list = Array.isArray(parsed) ? parsed : parsed.results ?? [];
    seedIds = list.map((r) => r.id ?? r.taskId).filter(Boolean);
  } catch { /* rank-in-seed is informational */ }
  let toolCalls = 0;
  try {
    const run = await runMicroClaude({
      system,
      prompt: buildUserPrompt(c.query) + buildSeedResultsBlock(rows),
      model,
      timeoutMs: TIMEOUT_MS,
      tools: ['Bash'],
      toolUseId: `agent-eval-${randomUUID()}`,
      warm: true,
      onBlock: (b) => { if (b.type === 'tool_call' && b.status === 'calling') toolCalls += 1; },
    });
    const ids = parseAgentAnswer(run.response).results
      .map((r) => String(r.task_id ?? ''))
      .filter(Boolean);
    const conf = parseAgentAnswer(run.response).results.map((r) => r.confidence);
    const rank = (list) => {
      const i = list.findIndex((id) => c.targets.some((t) => id === t || (id.length >= 8 && t.startsWith(id))));
      return i >= 0 ? i + 1 : null;
    };
    const usage = transcriptUsage(run.sessionId, run.cwd);
    return {
      ok: true, ids, conf, rank: rank(ids), seedRank: rank(seedIds),
      ms: Date.now() - t0, costUsd: usage?.costUsd ?? 0, cliCostUsd: run.costUsd ?? 0,
      wireModel: usage?.model, tokens: usage?.tokens, rounds: usage?.rounds, toolCalls,
      junkPass: c.junk ? !conf.includes('high') : undefined,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), ms: Date.now() - t0, costUsd: 0, toolCalls, seedRank: null };
  }
}

/** Tokens + list-price cost from the child's own transcript. The CLI's
 *  total_cost_usd prices a model id it does not know (Haiku 5.5 on 2.1.284)
 *  with some other model's table, so it cannot compare models. */
function transcriptUsage(sessionId, cwd) {
  if (!sessionId || !cwd) return undefined;
  const file = path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
  if (!fs.existsSync(file)) return undefined;
  const byMsg = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"usage"')) continue;
    try {
      const rec = JSON.parse(line);
      const m = rec.message;
      if (rec.type === 'assistant' && m?.usage) byMsg.set(m.id ?? rec.uuid, { model: m.model, usage: m.usage });
    } catch { /* partial line */ }
  }
  let costUsd = 0;
  const tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  let model;
  for (const { model: mm, usage: u } of byMsg.values()) {
    model ??= mm;
    tokens.input += u.input_tokens ?? 0;
    tokens.output += u.output_tokens ?? 0;
    tokens.cacheWrite += u.cache_creation_input_tokens ?? 0;
    tokens.cacheRead += u.cache_read_input_tokens ?? 0;
    costUsd += computeCost({
      model: mm ?? '', input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0, cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    });
  }
  return { model, tokens, costUsd, rounds: byMsg.size };
}

// ── run ──
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '-');
const quant = (xs, q) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
console.log(`search-agent-eval  server=${SERVER}  cases=${cases.length}  models=${MODELS.join(',')}`);
const out = {};
for (const model of MODELS) {
  out[model] = [];
  for (const c of cases) {
    const r = await runOne(model, c);
    out[model].push({ id: c.id, family: c.family, ...r });
    const mark = !r.ok ? 'ERR ' : c.junk ? (r.junkPass ? 'pass' : 'FAIL') : r.rank === 1 ? '@1  ' : r.rank ? `@${r.rank}  ` : 'miss';
    console.log(`  [${model}] ${mark} ${c.id.padEnd(34)} ${String(r.ms).padStart(6)}ms  $${r.costUsd.toFixed(4)}  tools=${r.toolCalls}  ${r.wireModel ?? ''}${r.ok ? '' : `  ${r.error}`}`);
  }
  resetWarmPool();
}

console.log('\nmodel     cases  hit@1  hit@3  hit@5  seed@1  junk-ok  errors  p50ms   p90ms   $total   $/query');
for (const model of MODELS) {
  const rs = out[model];
  const scored = rs.filter((r, i) => !cases[i].junk);
  const junk = rs.filter((r, i) => cases[i].junk);
  const hit = (k) => scored.filter((r) => r.rank && r.rank <= k).length;
  const ms = rs.filter((r) => r.ok).map((r) => r.ms);
  const cost = rs.reduce((a, r) => a + r.costUsd, 0);
  console.log([
    model.padEnd(9), String(rs.length).padStart(5),
    pct(hit(1), scored.length).padStart(6), pct(hit(3), scored.length).padStart(6), pct(hit(5), scored.length).padStart(6),
    pct(scored.filter((r) => r.seedRank === 1).length, scored.length).padStart(7),
    `${junk.filter((r) => r.junkPass).length}/${junk.length}`.padStart(8),
    String(rs.filter((r) => !r.ok).length).padStart(7),
    String(quant(ms, 0.5)).padStart(7), String(quant(ms, 0.9)).padStart(7),
    cost.toFixed(3).padStart(8), (cost / rs.length).toFixed(4).padStart(9),
  ].join(' '));
}
if (JSON_OUT) {
  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  fs.writeFileSync(JSON_OUT, JSON.stringify({ server: SERVER, models: MODELS, results: out }, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}
process.exit(0);
