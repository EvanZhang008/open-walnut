#!/usr/bin/env node
/**
 * E2E verify: index a real local session JSONL via the production filter +
 * the real default QMD embedding pipeline (temp DB, does NOT touch prod), then search for
 * a phrase that appears in the conversation. Prints PASS/FAIL.
 *
 *   node scripts/verify-session-search.mjs <sessionId.jsonl> "<search phrase>"
 */
import { createStore } from '@tobilu/qmd';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Build the indexer to a temp esm bundle first:
//   npx esbuild src/core/session-content-indexer.ts --bundle --format=esm --platform=node --outfile=/tmp/sci.mjs
import { buildIndexedContent } from '/tmp/sci.mjs';

const MODEL = process.env.QMD_EMBED_MODEL
  || 'hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf';

// Minimal raw-JSONL → SessionHistoryMessage[] (Claude Code schema): each line
// has { type:'user'|'assistant', message:{ role, content }, timestamp }.
function parse(content) {
  const out = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const m = e.message;
    if (!m || (e.type !== 'user' && e.type !== 'assistant')) continue;
    let text = ''; const tools = [];
    const c = m.content;
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (b?.type === 'text') text += (b.text || '') + '\n';
        else if (b?.type === 'tool_use') tools.push({ name: b.name, input: b.input || {} });
      }
    }
    if (!text.trim() && tools.length === 0) continue;
    out.push({ role: m.role, text: text.trim(), timestamp: e.timestamp || '', tools });
  }
  return out;
}

async function main() {
  const [file, phrase] = process.argv.slice(2);
  if (!file || !phrase) { console.error('usage: verify-session-search.mjs <file.jsonl> "<phrase>"'); process.exit(1); }

  const messages = parse(fs.readFileSync(file, 'utf-8'));
  const { body, turnCount, truncated } = buildIndexedContent(messages);
  console.log(`parsed ${messages.length} msgs → ${turnCount} turns, body ${(Buffer.byteLength(body)/1024).toFixed(1)}KB, truncated=${truncated}`);
  console.log(`phrase "${phrase}" present in filtered body: ${body.includes(phrase)}`);

  const dbPath = path.join(os.tmpdir(), `verify-${Date.now()}.sqlite`);
  const collDir = path.join(os.tmpdir(), `verify-coll-${Date.now()}`);
  fs.mkdirSync(collDir, { recursive: true });
  const store = await createStore({
    dbPath,
    config: {
      models: { embed: MODEL },
      collections: {
        sessions: { path: collDir, pattern: '__qmd_programmatic_only__' },
      },
    },
  });

  const sid = path.basename(file, '.jsonl');
  const docText = `# Session Metadata\nProject: walnut\n\n${body}`;
  const hash = createHash('sha256').update(docText).digest('hex');
  const ts = new Date().toISOString();
  store.internal.insertContent(hash, docText, ts);
  store.internal.insertDocument('sessions', `sess-${sid}`, sid, hash, ts, ts);
  await store.embed({ model: MODEL });

  const results = await store.search({ query: phrase, rerank: false });
  const rpath = (r) => r.file || r.displayPath || r.path || '';
  const hit = results.find(r => rpath(r).includes(sid));
  console.log(`\nsearch returned ${results.length} results; target session ${hit ? 'FOUND' : 'NOT FOUND'}`);
  if (results[0]) console.log(`top result: path=${rpath(results[0])} score=${results[0].score?.toFixed?.(3) ?? results[0].score}`);
  if (hit) console.log(`matched chunk: ${(hit.bestChunk || '').slice(0, 160).replace(/\n/g, ' ')}`);

  await store.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(collDir, { recursive: true, force: true });

  console.log(`\n${hit ? 'PASS ✅' : 'FAIL ❌'}`);
  process.exit(hit ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
