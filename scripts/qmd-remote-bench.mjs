#!/usr/bin/env node
/**
 * QMD remote benchmark — gating experiment for session-content indexing.
 *
 * Decides remote architecture: A (filter on remote, embed on local) vs
 * B (run QMD + its configured embedding model on the remote host). Measures the two unknowns
 * that hardware specs can't answer: embed throughput and search latency.
 *
 * Run on the remote host (Node >= 22):
 *   node qmd-remote-bench.mjs <sample.jsonl> [sample2.jsonl ...]
 *
 * Emits a JSON block (between BENCH_JSON markers) for the caller to parse.
 */
import { createStore } from '@tobilu/qmd';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MODEL = process.env.QMD_EMBED_MODEL
  || 'hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf';

function now() { return Number(process.hrtime.bigint() / 1_000_000n); }
function mb(bytes) { return (bytes / 1024 / 1024).toFixed(1); }

/**
 * Minimal JSONL → filtered text. Mirrors the real buildIndexedContent() intent:
 * keep user/assistant text + per-turn tool-name footer, drop tool payloads,
 * collapse big code blocks, strip base64. Kept self-contained so the script
 * has zero deps beyond @tobilu/qmd.
 */
function filterJsonl(content, maxBytes = 50_000) {
  const turns = [];
  let toolNames = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    const msg = evt.message ?? evt;
    const role = evt.type === 'assistant' || msg?.role === 'assistant' ? 'Assistant'
               : (evt.type === 'user' || msg?.role === 'user') ? 'User' : null;
    if (!role) continue;
    let text = '';
    const c = msg?.content;
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) {
      for (const block of c) {
        if (block?.type === 'text' && typeof block.text === 'string') text += block.text + '\n';
        else if (block?.type === 'tool_use' && block.name) toolNames.push(block.name);
        // tool_result blocks dropped entirely
      }
    }
    if (!text.trim()) continue;
    // collapse code blocks >20 lines
    text = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (m, lang, body) => {
      const n = body.split('\n').length;
      return n > 20 ? `\`\`\`${lang || ''}\n<code ${n} lines omitted>\n\`\`\`` : m;
    });
    // strip base64 / huge no-whitespace tokens
    text = text.replace(/data:[\w/]+;base64,[A-Za-z0-9+/=]+/g, '<blob>');
    text = text.replace(/\S{600,}/g, '<blob>');
    turns.push({ role, text: text.trim(), tools: toolNames });
    if (role === 'Assistant') toolNames = [];
  }
  const parts = [];
  let i = 0;
  for (const t of turns) {
    i++;
    let block = `## Turn ${i}\n${t.role}: ${t.text}`;
    if (t.tools?.length) block += `\nTools: ${[...new Set(t.tools)].slice(0, 10).join(', ')}`;
    parts.push(block);
  }
  let body = parts.join('\n\n');
  let truncated = false;
  if (Buffer.byteLength(body) > maxBytes) {
    // tail-keep: drop oldest turns until under cap (recompute body each step)
    while (parts.length > 1 && Buffer.byteLength(parts.join('\n\n')) > maxBytes) parts.shift();
    body = '[...earlier turns omitted]\n\n' + parts.join('\n\n');
    truncated = true;
  }
  return { body, turnCount: turns.length, truncated };
}

async function main() {
  const samples = process.argv.slice(2);
  if (samples.length === 0) {
    console.error('usage: node qmd-remote-bench.mjs <sample.jsonl> [...]');
    process.exit(1);
  }

  const result = {
    host: os.hostname(),
    arch: `${os.platform()}-${os.arch()}`,
    cpus: os.cpus().length,
    totalMemGB: (os.totalmem() / 1024 ** 3).toFixed(0),
    node: process.version,
    model: MODEL,
    samples: [],
    searchMs: null,
    peakRssMB: null,
    error: null,
  };

  const dbPath = path.join(os.tmpdir(), `qmd-bench-${Date.now()}.sqlite`);
  const collDir = path.join(os.tmpdir(), `qmd-bench-coll-${Date.now()}`);
  fs.mkdirSync(collDir, { recursive: true });

  try {
    const tStore = now();
    const store = await createStore({
      dbPath,
      config: {
        models: { embed: MODEL },
        collections: {
          bench: { path: collDir, pattern: '__qmd_programmatic_only__' },
        },
      },
    });
    result.storeInitMs = now() - tStore;

    let firstEmbedDone = false;
    for (const file of samples) {
      const raw = fs.readFileSync(file, 'utf-8');
      const rawBytes = Buffer.byteLength(raw);
      const tFilter = now();
      const { body, turnCount, truncated } = filterJsonl(raw);
      const filterMs = now() - tFilter;
      const filteredBytes = Buffer.byteLength(body);

      const hash = createHash('sha256').update(body).digest('hex');
      const docPath = `sess-${path.basename(file, '.jsonl')}`;
      const ts = new Date().toISOString();
      store.internal.insertContent(hash, body, ts);
      store.internal.insertDocument('bench', docPath, docPath, hash, ts, ts);

      // embed: first call includes model load (cold); measure both cold & warm
      const tEmbed = now();
      await store.embed({ model: MODEL });
      const embedMs = now() - tEmbed;

      result.samples.push({
        file: path.basename(file),
        rawMB: mb(rawBytes),
        filteredKB: (filteredBytes / 1024).toFixed(1),
        turnCount,
        truncated,
        filterMs: Math.round(filterMs),
        embedMs: Math.round(embedMs),
        cold: !firstEmbedDone,
      });
      firstEmbedDone = true;
    }

    // search latency (warm)
    const tSearch = now();
    await store.search({ query: 'how does the service handle errors', rerank: false });
    result.searchMs = Math.round(now() - tSearch);

    await store.close();
    result.peakRssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  } catch (err) {
    result.error = err?.stack || String(err);
  } finally {
    try { fs.rmSync(dbPath, { force: true }); } catch {}
    try { fs.rmSync(collDir, { recursive: true, force: true }); } catch {}
  }

  console.log('BENCH_JSON_START');
  console.log(JSON.stringify(result, null, 2));
  console.log('BENCH_JSON_END');
}

main().catch(e => { console.error(e); process.exit(1); });
