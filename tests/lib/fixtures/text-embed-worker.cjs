/**
 * Embed-worker stand-in whose vectors depend on the text (text-vec.cjs), with
 * the real worker's stop protocol ({ stop: true }: finish the jobs in flight,
 * then exit). Knobs ride in the model id ("fake/text:{json}"), because the host
 * forwards only its own config fields to a worker:
 *   logFile  one line per embedded text: the sha1 of the text as received
 *   holdMs   how long each job takes, standing in for a slow inference
 *   crashOn  a job whose text contains this exits the process (a doc that
 *            crashes the runtime), errorOn: it gets an error reply instead,
 *            stoppingOn: the reply a stopping worker gives (not the doc's fault)
 *   crashJobs with jobFile: jobs number crashFrom+1 .. crashFrom+crashJobs,
 *            counted across worker processes, exit the process whatever their
 *            text (a worker that is unhealthy, not a bad doc)
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const { textVec } = require('./text-vec.cjs');

const workerData = JSON.parse(process.env.HYBRID_SEARCH_EMBED_WORKER_CONFIG || '{}');
const modelId = (workerData && workerData.modelId) || '';
const opts = modelId.startsWith('fake/text:') ? JSON.parse(modelId.slice('fake/text:'.length)) : {};
const send = (msg) => { if (process.connected) process.send(msg, undefined, undefined, () => {}); };
const DIMS = 4;

let active = 0;
let stopping = false;
const exitIfDrained = () => { if (stopping && active === 0) process.exit(0); };

process.on('message', (msg) => {
  if (msg && msg.stop) { stopping = true; exitIfDrained(); return; }
  const { id, texts } = msg;
  if (stopping) { send({ id, error: 'embed worker stopping' }); return; }
  if (opts.crashOn && texts.some((t) => t.includes(opts.crashOn))) process.exit(1);
  if (opts.errorOn && texts.some((t) => t.includes(opts.errorOn))) { send({ id, error: 'input rejected' }); return; }
  if (opts.stoppingOn && texts.some((t) => t.includes(opts.stoppingOn))) { send({ id, error: 'embed worker stopping' }); return; }
  if (opts.jobFile) {
    const n = (fs.existsSync(opts.jobFile) ? Number(fs.readFileSync(opts.jobFile, 'utf8')) : 0) + 1;
    fs.writeFileSync(opts.jobFile, String(n));
    const from = opts.crashFrom || 0;
    if (n > from && n <= from + (opts.crashJobs || 0)) process.exit(1);
  }
  active++;
  setTimeout(() => {
    const buf = new Int8Array(texts.length * DIMS);
    texts.forEach((t, i) => {
      buf.set(textVec(t), i * DIMS);
      if (opts.logFile) {
        fs.appendFileSync(opts.logFile, crypto.createHash('sha1').update(t).digest('hex') + '\n');
      }
    });
    send({ id, buf: buf.buffer, dims: DIMS });
    active--;
    exitIfDrained();
  }, opts.holdMs || 0);
});
