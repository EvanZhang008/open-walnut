/**
 * The rescore job of the embed-worker protocol (embed-worker.ts), for the
 * fixture workers: the same read and math as the real worker
 * (src/lib/hybrid-search/doc-vec-cosine.ts) on a readonly connection to the
 * host's index file. Returns the reply to send.
 */
const path = require('node:path');

const SRC = path.join(__dirname, '../../../src/lib');

function rescoreReply(msg, workerData) {
  const { id, rescore } = msg;
  try {
    if (!workerData || !workerData.dbPath) return { id, error: 'no index db for the rescore' };
    // The real worker opens SQLite through src/lib/sqlite.ts (bun:sqlite).
    const Database = require(path.join(SRC, 'sqlite.ts')).default;
    const { readMaxCosines } = require(path.join(SRC, 'hybrid-search', 'doc-vec-cosine.ts'));
    const db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
    try {
      const best = readMaxCosines(db, new Int8Array(rescore.vec), rescore.ids);
      return { id, rescore: { ids: [...best.keys()], cos: [...best.values()] } };
    } finally {
      db.close();
    }
  } catch (err) {
    return { id, error: String((err && err.message) || err) };
  }
}

module.exports = { rescoreReply };
