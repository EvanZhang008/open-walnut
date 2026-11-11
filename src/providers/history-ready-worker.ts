/**
 * The worker thread that builds ready views for the daemon binary and the compiled Walnut file
 * (history-ready-core.ts createReadyWorkerExecutor). Both compile this file in as a second
 * entry (scripts/build-daemon.sh, scripts/build-binary.mjs), which is what lets a compiled file
 * start it as a Worker. The source twin uses its history-ready-core.cjs sidecar instead.
 */
import { parentPort } from 'node:worker_threads';
import { serveReadyWorker } from './history-ready-core.js';

if (parentPort) serveReadyWorker(parentPort);
