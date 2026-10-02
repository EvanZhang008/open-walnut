/**
 * Embed-worker stand-in with the real worker's stop protocol ({ stop: true }:
 * finish the jobs in flight, then exit on its own). A text containing "slow"
 * holds its job for holdMs, standing in for an onnxruntime run that must
 * never be cut short (exiting mid-run aborts the process). markerFile
 * records "done <id>" per job and "exit-clean" when the worker exits by itself
 * (a SIGKILL never runs the exit listener). ignoreStop plays a hung run;
 * exitDelayMs delays the exit after the last job, as a run finishing late
 * would. dieOnSlow kills this process in the middle of a slow job, the way an
 * onnxruntime abort would; markPid records "pid <n>" at start.
 */
// The host forks this as a child process (embedder.ts) with its config in
// this variable, and talks to it over IPC.
const workerData = JSON.parse(process.env.HYBRID_SEARCH_EMBED_WORKER_CONFIG || '{}');
const send = (msg) => { if (process.connected) process.send(msg, undefined, undefined, () => {}); };
const fs = require('node:fs');
const DIMS = 4;
// Knobs ride in the model id ("fake/busy:{json}"): the host forwards only its
// own config fields to a worker.
const modelId = (workerData && workerData.modelId) || '';
const opts = modelId.startsWith('fake/busy:') ? JSON.parse(modelId.slice('fake/busy:'.length)) : {};

let active = 0;
let stopping = false;

function mark(line) {
  if (opts.markerFile) fs.appendFileSync(opts.markerFile, line + '\n');
}

process.on('exit', () => mark('exit-clean'));
if (opts.markPid) mark('pid ' + process.pid);

function exitIfDrained() {
  if (!stopping || active !== 0) return;
  if (opts.exitDelayMs) setTimeout(() => process.exit(0), opts.exitDelayMs);
  else process.exit(0);
}

process.on('message', (msg) => {
  if (msg && msg.stop) {
    if (opts.ignoreStop) return;
    stopping = true;
    exitIfDrained();
    return;
  }
  const { id, texts } = msg;
  if (stopping) {
    send({ id, error: 'embed worker stopping' });
    return;
  }
  active++;
  const slow = texts.some((t) => t.includes('slow'));
  if (slow && opts.dieOnSlow) setTimeout(() => process.kill(process.pid, 'SIGKILL'), 50);
  const hold = slow ? (opts.holdMs || 300) : 0;
  setTimeout(() => {
    const buf = new Int8Array(texts.length * DIMS);
    for (let i = 0; i < texts.length; i++) buf[i * DIMS] = 127;
    mark('done ' + id);
    send({ id, buf: buf.buffer, dims: DIMS });
    active--;
    exitIfDrained();
  }, hold);
});
