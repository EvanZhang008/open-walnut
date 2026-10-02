/**
 * Embed-worker stand-in that answers the FIRST job immediately and stalls every
 * later one for a second (same message protocol as the real worker).
 *
 * Exists to make the deadline path deterministic: with the always-instant fake
 * worker, `setTimeout(0)` and a worker 'message' event are both macrotasks and
 * either can win, so a "the deadline blew" test flaps. Here the first job warms
 * the cache and every later job is guaranteed to lose to a small deadline.
 */
// The host forks this as a child process (embedder.ts) and talks to it over IPC.
const send = (msg) => { if (process.connected) process.send(msg, undefined, undefined, () => {}); };
const DIMS = 4;
const STALL_MS = 1000;

let served = 0;

process.on('message', (msg) => {
  // The host's stop request (embedder.ts terminate): exit at once.
  if (msg && msg.stop) process.exit(0);
  const { id, texts } = msg;
  const buf = new Int8Array(texts.length * DIMS);
  for (let i = 0; i < texts.length; i++) buf[i * DIMS] = 127;
  const reply = () => send({ id, buf: buf.buffer, dims: DIMS });
  if (served++ === 0) reply();
  else setTimeout(reply, STALL_MS);
});
