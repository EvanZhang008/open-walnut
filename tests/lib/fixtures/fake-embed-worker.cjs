/**
 * Deterministic stand-in for the embed worker (same message protocol): every
 * text embeds to the unit vector [127, 0, 0, ...], so tests control ranking
 * purely through the doc vectors they write.
 */
const { parentPort } = require('node:worker_threads');
const DIMS = 4;
parentPort.on('message', ({ id, texts }) => {
  const buf = new Int8Array(texts.length * DIMS);
  for (let i = 0; i < texts.length; i++) buf[i * DIMS] = 127;
  parentPort.postMessage({ id, buf: buf.buffer, dims: DIMS });
});
