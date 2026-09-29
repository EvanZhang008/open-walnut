#!/usr/bin/env node
/**
 * Search robustness eval (`npm run search:robustness`).
 *
 * The golden set (`npm run search:eval`) asks "does THIS query find THIS doc".
 * This asks the other question: when a person types a doc's name the way people
 * actually type, does the doc still come back? It samples real docs from a copy
 * of a search index, derives a control query from each title (its rarest words,
 * in title order), then rewrites that query one way at a time: a typo, a word
 * cut off mid-typing, a plural, two words run together, the same words in
 * Chinese, and so on. Each class reports how often the doc is still in the top
 * 1 / 3 / 8 (8 = the AI search's seed), overall and over the cases whose control
 * query worked, which isolates what the rewrite alone costs.
 *
 * Everything is derived from the index at run time and only aggregate numbers
 * are printed, so the report carries no document text. `--show <class>` prints
 * failing examples for local debugging; never paste that output anywhere public.
 *
 * Usage (needs tsx: the lib backend imports the TypeScript library):
 *   tsx scripts/search-robustness-eval.mjs --index-db /tmp/copy/search.sqlite
 *   ... --semantic [--deadline 3000]       keyword + vector rescore/recall
 *   ... --backend http --server http://localhost:<port>   the full /api/search stack
 *   ... --n 300 --seed 7 --kinds task,note --json out.json --show typo-1
 *   ... --compare before.json              per-class delta vs an earlier --json run
 *   ... --lib-dir /tmp/head/hybrid-search  run another copy of the library (A/B on the same data)
 *
 * Point --index-db at a COPY: opening an index can run its version gates, and a
 * gate may rewrite the file.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── args ──
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const BACKEND = opt('--backend', 'lib');
const SERVER = opt('--server', '');
const INDEX_DB = opt('--index-db', '');
const N = parseInt(opt('--n', '300'), 10);
const SEED = parseInt(opt('--seed', '7'), 10);
const KINDS = opt('--kinds', 'task').split(',').filter(Boolean);
const LIMIT = 20;
const SEMANTIC = flag('--semantic');
const DEADLINE = parseInt(opt('--deadline', '3000'), 10);
const SHOW = opt('--show', null);
const JSON_OUT = opt('--json', null);
const COMPARE = opt('--compare', null);
const ONLY = opt('--classes', null)?.split(',');

if (!INDEX_DB || !fs.existsSync(INDEX_DB)) {
  console.error('pass --index-db <a COPY of search.sqlite> (also used to sample docs for the http backend)');
  process.exit(2);
}
const liveIndex = path.join(process.env.OPEN_WALNUT_HOME ?? path.join(os.homedir(), '.open-walnut'), 'search.sqlite');
if (path.resolve(INDEX_DB) === path.resolve(liveIndex)) {
  console.error('refusing to open the live index: copy it first (sqlite3 <live> ".backup /tmp/x/search.sqlite")');
  process.exit(2);
}
if (BACKEND === 'http' && !SERVER) {
  console.error('--backend http needs --server http://localhost:<port> (an ephemeral server, never :3456 for writes)');
  process.exit(2);
}

// ── deterministic randomness ──
let rngState = SEED >>> 0;
function rand() {
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (list) => list[Math.floor(rand() * list.length)];

// ── the sample ──
const db = new Database(INDEX_DB, { readonly: true, fileMustExist: true });
const dfStmt = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM doc_fts WHERE doc_fts MATCH ? LIMIT 3000)`);
const dfCache = new Map();
function df(token) {
  let n = dfCache.get(token);
  if (n === undefined) {
    try { n = dfStmt.get(`"${token.replaceAll('"', '""')}"`).n; } catch { n = 0; }
    dfCache.set(token, n);
  }
  return n;
}

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/u;
const CJK_RUN_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]+/gu;
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}_.'-]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu;
const STOP = new Set('the and for with from that this into onto over under about after before when what which your our are was were not but all any can has have had how why who its via per use using new add fix get set run make'.split(' '));

/** Surface words of a title, CJK runs split out as their own words. */
function surfaceWords(text) {
  const out = [];
  for (const w of text.match(WORD_RE) ?? []) {
    if (!CJK_RE.test(w)) { out.push(w); continue; }
    // A Latin word run into a CJK one splits into the two ("EKS" + the CJK run).
    let last = 0;
    for (const m of w.matchAll(CJK_RUN_RE)) {
      if (m.index > last) out.push(w.slice(last, m.index));
      out.push(m[0]);
      last = m.index + m[0].length;
    }
    if (last < w.length) out.push(w.slice(last));
  }
  return out.filter((w) => w.replace(/[_.'-]/g, '').length > 0);
}
const isLatin = (w) => /^[a-z][a-z0-9]*$/i.test(w);
const isContent = (w) => CJK_RE.test(w)
  ? w.length >= 2
  : w.length >= 3 && !/^\d+$/.test(w) && !STOP.has(w.toLowerCase());

function sampleDocs() {
  const rows = db.prepare(
    `SELECT id, kind, ref, title, summary, note FROM doc WHERE kind IN (${KINDS.map(() => '?').join(',')})`,
  ).all(...KINDS);
  const titleCount = new Map();
  for (const r of rows) titleCount.set(r.title.trim().toLowerCase(), (titleCount.get(r.title.trim().toLowerCase()) ?? 0) + 1);
  const usable = rows.filter((r) => {
    const t = r.title.trim();
    if (t.length < 8 || t.length > 160 || titleCount.get(t.toLowerCase()) > 1) return false;
    return surfaceWords(t).filter(isContent).length >= 2;
  });
  // Seeded Fisher-Yates, then the first N.
  for (let i = usable.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [usable[i], usable[j]] = [usable[j], usable[i]];
  }
  return usable.slice(0, N);
}

// ── rewrites ──
const KEY_NEIGHBORS = {
  a: 'sqwz', b: 'vghn', c: 'xdfv', d: 'serfcx', e: 'wsdr', f: 'drtgvc', g: 'ftyhbv', h: 'gyujnb',
  i: 'ujko', j: 'huikmn', k: 'jiolm', l: 'kop', m: 'njk', n: 'bhjm', o: 'iklp', p: 'ol',
  q: 'wa', r: 'edft', s: 'awedxz', t: 'rfgy', u: 'yhji', v: 'cfgb', w: 'qase', x: 'zsdc',
  y: 'tghu', z: 'asx',
};
function oneEdit(word) {
  const i = 1 + Math.floor(rand() * (word.length - 2)); // keep the first and last letters
  const op = pick(['delete', 'transpose', 'substitute', 'insert']);
  if (op === 'delete') return word.slice(0, i) + word.slice(i + 1);
  if (op === 'transpose') return word[i] === word[i + 1] ? word.slice(0, i) + word.slice(i + 1)
    : word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
  if (op === 'insert') return word.slice(0, i) + word[i] + word.slice(i);
  const near = KEY_NEIGHBORS[word[i].toLowerCase()];
  return near ? word.slice(0, i) + pick([...near]) + word.slice(i + 1) : word.slice(0, i) + word.slice(i + 1);
}
function inflect(word) {
  const w = word.toLowerCase();
  const options = [];
  if (/(ch|sh|x|ss)es$/.test(w)) options.push(w.slice(0, -2));
  else if (/ies$/.test(w)) options.push(`${w.slice(0, -3)}y`);
  else if (/[^s]s$/.test(w) && w.length > 4) options.push(w.slice(0, -1));
  else if (/y$/.test(w) && !/[aeiou]y$/.test(w)) options.push(`${w.slice(0, -1)}ies`);
  else if (!/s$/.test(w)) options.push(`${w}s`);
  if (/ing$/.test(w) && w.length > 6) options.push(w.slice(0, -3), `${w.slice(0, -3)}e`);
  else if (/ed$/.test(w) && w.length > 5) options.push(w.slice(0, -2), w.slice(0, -1));
  else if (/e$/.test(w)) options.push(`${w.slice(0, -1)}ing`, `${w}d`);
  else if (!/(ing|ed|s)$/.test(w)) options.push(`${w}ing`, `${w}ed`);
  return options.length ? pick(options) : null;
}
// Pairs people swap freely; both directions are tried.
const SYNONYMS = [
  ['fix', 'repair'], ['bug', 'issue'], ['error', 'failure'], ['delete', 'remove'], ['create', 'add'],
  ['settings', 'config'], ['show', 'display'], ['crash', 'failure'], ['broken', 'failing'],
  ['update', 'upgrade'], ['search', 'find'], ['notification', 'alert'], ['meeting', 'call'],
  ['picture', 'image'], ['photo', 'image'], ['investigate', 'debug'], ['improve', 'optimize'],
  ['slow', 'laggy'], ['doc', 'document'], ['message', 'chat'], ['start', 'launch'], ['stop', 'end'],
  ['page', 'screen'], ['button', 'control'], ['folder', 'directory'], ['host', 'machine'],
];
const ABBREVIATIONS = [
  ['knowledge base', 'kb'], ['pull request', 'pr'], ['user interface', 'ui'], ['kubernetes', 'k8s'],
  ['database', 'db'], ['configuration', 'config'], ['documentation', 'docs'], ['authentication', 'auth'],
  ['application', 'app'], ['repository', 'repo'], ['development', 'dev'], ['production', 'prod'],
  ['environment', 'env'], ['message', 'msg'], ['information', 'info'], ['javascript', 'js'],
  ['typescript', 'ts'], ['directory', 'dir'], ['calendar', 'cal'], ['description', 'desc'],
];
// English → Chinese for common product words (the user mixes both freely).
const EN_ZH = {
  search: '\u641c\u7d22', notification: '\u901a\u77e5', notifications: '\u901a\u77e5', file: '\u6587\u4ef6', files: '\u6587\u4ef6', session: '\u4f1a\u8bdd',
  sessions: '\u4f1a\u8bdd', task: '\u4efb\u52a1', tasks: '\u4efb\u52a1', design: '\u8bbe\u8ba1', test: '\u6d4b\u8bd5', tests: '\u6d4b\u8bd5', deploy: '\u90e8\u7f72',
  fix: '\u4fee\u590d', error: '\u9519\u8bef', errors: '\u9519\u8bef', investigate: '\u8c03\u67e5', permission: '\u6743\u9650', sync: '\u540c\u6b65',
  highlight: '\u9ad8\u4eae', preview: '\u9884\u89c8', drag: '\u62d6\u52a8', pin: '\u7f6e\u9876', tax: '\u62a5\u7a0e', insurance: '\u4fdd\u9669',
  calendar: '\u65e5\u5386', mail: '\u90ae\u4ef6', email: '\u90ae\u4ef6', report: '\u62a5\u544a', meeting: '\u4f1a\u8bae', review: '\u8bc4\u5ba1',
  plan: '\u8ba1\u5212', memory: '\u8bb0\u5fc6', note: '\u7b14\u8bb0', notes: '\u7b14\u8bb0', upload: '\u4e0a\u4f20', download: '\u4e0b\u8f7d',
  login: '\u767b\u5f55', slow: '\u6162', crash: '\u5d29\u6e83', install: '\u5b89\u88c5', update: '\u66f4\u65b0', delete: '\u5220\u9664', image: '\u56fe\u7247',
  voice: '\u8bed\u97f3', audio: '\u97f3\u9891', video: '\u89c6\u9891', phone: '\u624b\u673a', title: '\u6807\u9898', project: '\u9879\u76ee', folder: '\u6587\u4ef6\u5939',
};

/** Control: the (up to) three rarest content words, in title order. */
function controlWords(words) {
  const content = words.map((w, i) => ({ w, i })).filter(({ w }) => isContent(w));
  const ranked = [...content].sort((a, b) => df(a.w.toLowerCase()) - df(b.w.toLowerCase()));
  return ranked.slice(0, 3).sort((a, b) => a.i - b.i);
}

function rewrites(doc) {
  const words = surfaceWords(doc.title);
  const ctl = controlWords(words);
  if (ctl.length === 0) return [];
  const ctlQ = ctl.map((c) => c.w);
  const q = (list) => list.join(' ');
  const out = [['control', q(ctlQ)]];
  const replaceAt = (idx, value) => ctlQ.map((w, i) => (i === idx ? value : w));
  const latinIdx = ctlQ.map((w, i) => (isLatin(w) ? i : -1)).filter((i) => i >= 0);
  const docText = `${doc.title}\n${doc.summary}\n${doc.note}`.toLowerCase();
  const inDoc = (w) => new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}\\p{N}]|$)`, 'u').test(docText);

  if (ctl.length > 1) out.push(['single-rarest', [...ctl].sort((a, b) => df(a.w.toLowerCase()) - df(b.w.toLowerCase()))[0].w]);

  const longest = [...latinIdx].sort((a, b) => ctlQ[b].length - ctlQ[a].length)[0];
  if (longest !== undefined && ctlQ[longest].length >= 5) {
    for (let tries = 0; tries < 6; tries++) {
      const typo = oneEdit(ctlQ[longest]);
      if (typo !== ctlQ[longest] && df(typo.toLowerCase()) === 0) { out.push(['typo-1', q(replaceAt(longest, typo))]); break; }
    }
  }
  if (longest !== undefined && ctlQ[longest].length >= 8) {
    for (let tries = 0; tries < 6; tries++) {
      const typo = oneEdit(oneEdit(ctlQ[longest]));
      if (df(typo.toLowerCase()) === 0) { out.push(['typo-2', q(replaceAt(longest, typo))]); break; }
    }
  }
  const lastIdx = ctlQ.length - 1;
  if (isLatin(ctlQ[lastIdx]) && ctlQ[lastIdx].length >= 5) {
    const w = ctlQ[lastIdx];
    out.push(['prefix', q(replaceAt(lastIdx, w.slice(0, Math.max(3, Math.ceil(w.length / 2)))))]);
  }
  const inflectable = latinIdx.filter((i) => /^[a-z]+$/i.test(ctlQ[i]) && ctlQ[i].length >= 4);
  if (inflectable.length) {
    const i = pick(inflectable);
    const v = inflect(ctlQ[i]);
    if (v && v !== ctlQ[i].toLowerCase() && !inDoc(v)) out.push(['inflect', q(replaceAt(i, v))]);
  }
  // Two adjacent title words, one of them in the control query.
  const ctlAt = new Set(ctl.map((c) => c.i));
  const pairs = [];
  for (let i = 0; i < words.length - 1; i++) {
    if (isLatin(words[i]) && isLatin(words[i + 1]) && (ctlAt.has(i) || ctlAt.has(i + 1))
      && words[i].length >= 2 && words[i + 1].length >= 2 && !/^\d+$/.test(words[i] + words[i + 1])) pairs.push(i);
  }
  if (pairs.length) {
    const i = pick(pairs);
    const around = (joined) => {
      const kept = ctl.filter((c) => c.i !== i && c.i !== i + 1).map((c) => ({ ...c }));
      kept.push({ w: joined, i });
      return q(kept.sort((a, b) => a.i - b.i).map((c) => c.w));
    };
    out.push(['join', around(`${words[i]}${words[i + 1]}`.toLowerCase())]);
    out.push(['hyphen', around(`${words[i]}-${words[i + 1]}`.toLowerCase())]);
  }
  const compound = ctl.find((c) => /[a-z][A-Z]|[A-Za-z][-_][A-Za-z]/.test(c.w));
  if (compound) {
    const parts = compound.w.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').toLowerCase();
    out.push(['split', q(ctlQ.map((w) => (w === compound.w ? parts : w)))]);
  }
  if (ctlQ.length >= 2) out.push(['reorder', q([...ctlQ].reverse())]);
  out.push(['lowercase', q(ctlQ).toLowerCase()]);
  // A version or date typed with another separator: "4.8" as "4-8", "2026-07-01" as "2026.07.01".
  const versioned = ctlQ.findIndex((w) => /\d[._-]\d/.test(w));
  if (versioned >= 0) {
    const w = ctlQ[versioned];
    const swapped = w.includes('.') ? w.replace(/(\d)\.(?=\d)/g, '$1-') : w.replace(/(\d)[-_](?=\d)/g, '$1.');
    if (swapped !== w) out.push(['version-sep', q(replaceAt(versioned, swapped))]);
  }
  // Typed by a CJK input method in full-width mode.
  if (latinIdx.length) out.push(['full-width', q(ctlQ).replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0))]);
  out.push(['question', `where is the ${q(ctlQ)} task`]);
  if (words.length >= 5) out.push(['whole-title', doc.title.trim()]);
  // The first words of the name, as someone looking a task up types them.
  if (words.length >= 5) out.push(['title-head', q(words.slice(0, 3))]);

  const bodyWords = surfaceWords(`${doc.summary}\n${doc.note}`.slice(0, 20_000))
    .filter((w) => isContent(w) && !doc.title.toLowerCase().includes(w.toLowerCase()));
  const uniqueBody = [...new Set(bodyWords.map((w) => w.toLowerCase()))];
  if (uniqueBody.length >= 6) {
    // Words someone could remember from the note: in a handful of docs, not in
    // boilerplate every imported task carries.
    const rare = uniqueBody.map((w) => [w, df(w)]).filter(([, n]) => n >= 2 && n <= 40).sort((a, b) => a[1] - b[1]).slice(0, 3);
    if (rare.length === 3) out.push(['body-words', rare.map(([w]) => w).join(' ')]);
  }
  if (doc.kind === 'task') out.push(['id', doc.ref], ['id-prefix', doc.ref.slice(0, 8)]);

  for (const [a, b] of SYNONYMS) {
    const i = ctlQ.findIndex((w) => w.toLowerCase() === a || w.toLowerCase() === b);
    if (i >= 0) {
      const swap = ctlQ[i].toLowerCase() === a ? b : a;
      if (!inDoc(swap)) { out.push(['synonym', q(replaceAt(i, swap))]); break; }
    }
  }
  const titleLc = doc.title.toLowerCase();
  for (const [long, short] of ABBREVIATIONS) {
    const hasLong = new RegExp(`\\b${long}\\b`).test(titleLc);
    const hasShort = new RegExp(`\\b${short}\\b`).test(titleLc);
    if (hasLong === hasShort) continue;
    const from = hasLong ? long : short;
    const to = hasLong ? short : long;
    if (inDoc(to)) continue;
    const rest = ctlQ.filter((w) => !from.split(' ').includes(w.toLowerCase()));
    out.push(['abbreviation', q([to, ...rest])]);
    break;
  }
  const zhIdx = ctlQ.findIndex((w) => EN_ZH[w.toLowerCase()] && !docText.includes(EN_ZH[w.toLowerCase()]));
  if (zhIdx >= 0) out.push(['to-chinese', q(replaceAt(zhIdx, EN_ZH[ctlQ[zhIdx].toLowerCase()]))]);
  const zhWords = Object.entries(EN_ZH).filter(([, zh]) => docText.includes(zh));
  const cjkRun = ctl.find((c) => CJK_RE.test(c.w) && c.w.length >= 4);
  if (cjkRun) {
    const run = cjkRun.w;
    const at = Math.floor(rand() * (run.length - 1));
    out.push(['cjk-part', q(ctlQ.map((w) => (w === run ? run.slice(at, at + 2) : w)))]);
    const mid = Math.floor(run.length / 2);
    out.push(['cjk-reorder', q(ctlQ.map((w) => (w === run ? `${run.slice(mid)} ${run.slice(0, mid)}` : w)))]);
    out.push(['cjk-chatty', `${q(ctlQ)} \u90a3\u4e2a\u95ee\u9898`]);
  }
  // A Chinese word in the title typed in English (the word for "notification" typed as "notification").
  for (const [en, zh] of zhWords) {
    const i = ctlQ.findIndex((w) => CJK_RE.test(w) && w.includes(zh));
    if (i < 0 || inDoc(en)) continue;
    const mixed = ctlQ[i].replace(zh, ` ${en} `).trim().replace(/\s+/g, ' ');
    out.push(['to-english', q(replaceAt(i, mixed))]);
    break;
  }
  return ONLY ? out.filter(([cls]) => cls === 'control' || ONLY.includes(cls)) : out;
}

// ── backends ──
let libIndex = null;
async function runLib(query) {
  if (!libIndex) {
    // --lib-dir: another checkout of the library, for a before/after run on the same data.
    const libDir = opt('--lib-dir', path.join(ROOT, 'src', 'lib', 'hybrid-search'));
    const { createSearchIndex } = await import(path.join(path.resolve(libDir), 'index.ts'));
    const home = process.env.OPEN_WALNUT_HOME ?? path.join(os.homedir(), '.open-walnut');
    libIndex = createSearchIndex({
      dbPath: INDEX_DB,
      // Mirrors SEARCH_V2_KIND_WEIGHTS in src/core/search/wiring.ts.
      kinds: {
        task: { weight: 1.0 }, memory: { weight: 1.1 }, session: { weight: 0.9, passages: { overflow: 'tail' } },
        note: { weight: 1.0 }, skill: { weight: 1.0 },
      },
      embedder: SEMANTIC ? {
        // Must match the model the index was backfilled with (meta.embed_model),
        // or the open gate empties doc_vec.
        modelId: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
        dims: 1024,
        queryPrefix: 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ',
        passagePrefix: '',
        pooling: 'last',
        workerPath: path.join(ROOT, 'dist', 'lib', 'hybrid-search', 'embed-worker.js'),
        cacheDir: path.join(home, 'cache', 'models'),
      } : undefined,
    });
    if (SEMANTIC) await libIndex.searchSemantic('warmup query', { semanticDeadlineMs: 60_000 });
  }
  const t0 = performance.now();
  const hits = SEMANTIC
    ? await libIndex.searchSemantic(query, { limit: LIMIT, semanticDeadlineMs: DEADLINE })
    : libIndex.search(query, { limit: LIMIT });
  return { ms: performance.now() - t0, refs: hits.map((h) => `${h.kind}:${h.ref}`), titles: hits.map((h) => h.title) };
}

async function runHttp(query) {
  const t0 = performance.now();
  const res = await fetch(`${SERVER}/api/search?q=${encodeURIComponent(query)}&limit=${LIMIT}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`GET /api/search -> ${res.status}`);
  const body = await res.json();
  const rows = body.results ?? [];
  return {
    ms: performance.now() - t0,
    // A session row that belongs to the task counts as the task (the panel shows it on the task).
    refs: rows.map((r) => (r.taskId ? `task:${r.taskId}` : `${r.type}:${r.sessionId ?? r.path ?? ''}`)),
    titles: rows.map((r) => r.title ?? ''),
  };
}

// ── run ──
const docs = sampleDocs();
const cases = [];
for (const doc of docs) for (const [cls, query] of rewrites(doc)) cases.push({ cls, query, doc });
console.error(`${docs.length} docs, ${cases.length} queries, backend=${BACKEND}${SEMANTIC ? ` semantic deadline=${DEADLINE}ms` : ''}`);

const results = [];
const controlRank = new Map();
let done = 0;
let errors = 0;
for (const c of cases) {
  let out;
  try {
    out = BACKEND === 'http' ? await runHttp(c.query) : await runLib(c.query);
  } catch (err) {
    results.push({ cls: c.cls, ref: c.doc.ref, rank: -2, ms: 0, error: String(err) });
    errors++;
    // A broken backend must not read as "the engine found nothing".
    if (errors >= 5 && errors > done / 10) {
      console.error(`aborting: ${errors} of ${done + errors} queries failed, first: ${results.find((r) => r.error).error}`);
      process.exit(1);
    }
    continue;
  }
  const want = `${c.doc.kind}:${c.doc.ref}`;
  const rank = out.refs.indexOf(want);
  if (c.cls === 'control') controlRank.set(want, rank);
  results.push({ cls: c.cls, ref: want, rank, ms: out.ms, query: c.query, top: out.titles.slice(0, 3), title: c.doc.title });
  if (++done % 200 === 0) console.error(`  ${done}/${cases.length}`);
}
if (libIndex) libIndex.close();

// ── report ──
const byClass = new Map();
for (const r of results) {
  if (!byClass.has(r.cls)) byClass.set(r.cls, []);
  byClass.get(r.cls).push(r);
}
const pct = (x) => `${Math.round(x * 100)}%`.padStart(5);
const quantile = (xs, q) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const summary = {};
console.log(`\nclass            n   @1    @3    @8   MRR   | ctl-ok n   @8   | p50ms p90ms`);
for (const [cls, rs] of byClass) {
  const ok = rs.filter((r) => r.rank >= 0);
  const at = (k) => rs.filter((r) => r.rank >= 0 && r.rank < k).length / rs.length;
  const mrr = ok.reduce((s, r) => s + 1 / (r.rank + 1), 0) / rs.length;
  const cond = rs.filter((r) => { const c = controlRank.get(r.ref); return c !== undefined && c >= 0 && c < 3; });
  const condAt8 = cond.length ? cond.filter((r) => r.rank >= 0 && r.rank < 8).length / cond.length : 0;
  const ms = rs.map((r) => r.ms);
  summary[cls] = { n: rs.length, at1: at(1), at3: at(3), at8: at(8), mrr, condN: cond.length, condAt8, p50: quantile(ms, 0.5), p90: quantile(ms, 0.9) };
  console.log(`${cls.padEnd(15)} ${String(rs.length).padStart(4)} ${pct(at(1))} ${pct(at(3))} ${pct(at(8))}  ${mrr.toFixed(2)} | ${String(cond.length).padStart(8)} ${pct(condAt8)} | ${String(Math.round(quantile(ms, 0.5))).padStart(5)} ${String(Math.round(quantile(ms, 0.9))).padStart(5)}`);
}

if (COMPARE && fs.existsSync(COMPARE)) {
  const before = JSON.parse(fs.readFileSync(COMPARE, 'utf8')).summary;
  console.log(`\nvs ${COMPARE}:   @8 (all)        @8 (ctl-ok)     p90ms`);
  for (const [cls, s] of Object.entries(summary)) {
    const b = before[cls];
    if (!b) continue;
    const d = (x, y) => `${pct(y)} -> ${pct(x)}`;
    console.log(`${cls.padEnd(15)} ${d(s.at8, b.at8)}   ${d(s.condAt8, b.condAt8)}   ${Math.round(b.p90)} -> ${Math.round(s.p90)}`);
  }
}

if (SHOW) {
  console.log(`\nfailures for ${SHOW} (LOCAL ONLY, contains document text):`);
  for (const r of byClass.get(SHOW) ?? []) {
    if (r.rank >= 0 && r.rank < 8) continue;
    const ctl = results.find((x) => x.cls === 'control' && x.ref === r.ref);
    console.log(`  #${r.rank < 0 ? '-' : r.rank + 1}  q="${r.query}"  (control "${ctl?.query}" #${ctl && ctl.rank >= 0 ? ctl.rank + 1 : '-'})`);
    console.log(`       want: ${r.title}`);
    for (const t of r.top) console.log(`       got:  ${t}`);
  }
}
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ backend: BACKEND, semantic: SEMANTIC, n: N, seed: SEED, summary, results }, null, 1));
