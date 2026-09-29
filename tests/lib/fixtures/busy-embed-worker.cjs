/**
 * Embed-worker stand-in with the real worker's stop protocol ({ stop: true }:
 * finish the jobs in flight, then exit on its own). A text containing "slow"
 * holds its job for holdMs, standing in for an onnxruntime run that must
 * never be cut short (a terminate() mid-run aborts the process). markerFile
 * records "done <id>" per job and "exit-clean" when the thread exits by itself
 * (a terminate() never runs the exit listener). ignoreStop plays a hung run;
 * exitDelayMs delays the exit after the last job, as a run finishing late
 * would.
 */
const { parentPort, workerData } = require('node:worker_threads');
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

function exitIfDrained() {
  if (!stopping || active !== 0) return;
  if (opts.exitDelayMs) setTimeout(() => process.exit(0), opts.exitDelayMs);
  else process.exit(0);
}

parentPort.on('message', (msg) => {
  if (msg && msg.stop) {
    if (opts.ignoreStop) return;
    stopping = true;
    exitIfDrained();
    return;
  }
  const { id, texts } = msg;
  if (stopping) {
    parentPort.postMessage({ id, error: 'embed worker stopping' });
    return;
  }
  active++;
  const hold = texts.some((t) => t.includes('slow')) ? (opts.holdMs || 300) : 0;
  setTimeout(() => {
    const buf = new Int8Array(texts.length * DIMS);
    for (let i = 0; i < texts.length; i++) buf[i * DIMS] = 127;
    mark('done ' + id);
    parentPort.postMessage({ id, buf: buf.buffer, dims: DIMS });
    active--;
    exitIfDrained();
  }, hold);
});
