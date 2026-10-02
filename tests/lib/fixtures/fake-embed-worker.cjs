/**
 * Deterministic stand-in for the embed worker (same message protocol): every
 * text embeds to the unit vector [127, 0, 0, ...], so tests control ranking
 * purely through the doc vectors they write. When the job asks for recall and
 * workerData carries a dbPath, it runs the same level-0 KNN the real worker
 * does — against that fixed query vector.
 */
// The host forks this as a child process (embedder.ts) with its config in
// this variable, and talks to it over IPC.
const workerData = JSON.parse(process.env.HYBRID_SEARCH_EMBED_WORKER_CONFIG || '{}');
const send = (msg) => { if (process.connected) process.send(msg, undefined, undefined, () => {}); };
const DIMS = 4;

function recallTopK(k) {
  if (!workerData || !workerData.dbPath) return undefined;
  try {
    const Database = require('better-sqlite3');
    const db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare('SELECT doc_id, vec FROM doc_vec WHERE seq = 0').all();
      const scored = [];
      for (const row of rows) {
        if (row.vec.byteLength !== DIMS) continue;
        const v = new Int8Array(row.vec.buffer, row.vec.byteOffset, DIMS);
        let dot = 0; let n = 0;
        for (let i = 0; i < DIMS; i++) { dot += (i === 0 ? 127 : 0) * v[i]; n += v[i] * v[i]; }
        if (n === 0) continue;
        scored.push({ docId: row.doc_id, cos: dot / Math.sqrt(127 * 127 * n) });
      }
      return scored.sort((a, b) => b.cos - a.cos).slice(0, k);
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

process.on('message', (msg) => {
  // The host's stop request (embedder.ts terminate): nothing runs here, so exit.
  if (msg && msg.stop) process.exit(0);
  const { id, texts, recallK } = msg;
  const buf = new Int8Array(texts.length * DIMS);
  for (let i = 0; i < texts.length; i++) buf[i * DIMS] = 127;
  send({ id, buf: buf.buffer, dims: DIMS, recall: recallK ? recallTopK(recallK) : undefined });
});
