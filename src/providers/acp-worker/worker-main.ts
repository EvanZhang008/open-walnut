/**
 * ACP worker process entry — built to dist/providers/acp-worker/worker-main.js
 * by tsup and spawned by the daemon as:
 *   node worker-main.js --journal <path>
 * stdin/stdout = NDJSON JSON-RPC with the daemon; stderr = diagnostics.
 */
import { runWorkerMain } from './worker.js'

runWorkerMain()
