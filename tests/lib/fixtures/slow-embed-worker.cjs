/**
 * Embed-worker stand-in that answers the FIRST job immediately and stalls every
 * later one for a second (same message protocol as the real worker).
 *
 * Exists to make the deadline path deterministic: with the always-instant fake
 * worker, `setTimeout(0)` and a worker 'message' event are both macrotasks and
 * either can win, so a "the deadline blew" test flaps. Here the first job warms
 * the cache and every later job is guaranteed to lose to a small deadline.
 */
const { parentPort } = require('node:worker_threads');
const DIMS = 4;
const STALL_MS = 1000;

let served = 0;

parentPort.on('message', ({ id, texts }) => {
  const buf = new Int8Array(texts.length * DIMS);
  for (let i = 0; i < texts.length; i++) buf[i * DIMS] = 127;
  const reply = () => parentPort.postMessage({ id, buf: buf.buffer, dims: DIMS });
  if (served++ === 0) reply();
  else setTimeout(reply, STALL_MS);
});
