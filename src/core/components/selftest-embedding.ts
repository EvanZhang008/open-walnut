/**
 * The embedding line of `walnut __selftest` (selftest.ts): the search worker
 * itself, started by the embedder's own code (probeEmbedWorker in
 * src/lib/hybrid-search/embedder.ts), imports the downloaded library from its
 * URL and runs a one-node model on that library's onnxruntime. No model is
 * downloaded.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeEmbedWorker } from '../../lib/hybrid-search/embedder.js';
import { singleFile } from '../../lib/single-file.js';
import { identityModel } from './smoke.js';

export interface EmbedWorkerChoice {
  path: string;
  /** What runs it (a launcher in front of the worker, as the search wiring may set). */
  execPath?: string;
  execArgv?: string[];
}

/** The compiled file's own worker module, or the built dist/lib/hybrid-search/embed-worker.js. */
function defaultEmbedWorker(): string | null {
  const sf = singleFile();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = sf
    ? [path.join(sf.root, 'dist', 'lib', 'hybrid-search', 'embed-worker.js')]
    // Bundled (dist/cli.js, dist/web/server.js), or this file under src/core/components/.
    : [
      path.join(here, 'lib', 'hybrid-search', 'embed-worker.js'),
      path.join(here, '..', 'lib', 'hybrid-search', 'embed-worker.js'),
      path.join(here, '..', '..', '..', 'dist', 'lib', 'hybrid-search', 'embed-worker.js'),
    ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

export async function embeddingThroughWorker(entryUrl: string, choice?: EmbedWorkerChoice): Promise<string> {
  const workerPath = choice?.path ?? defaultEmbedWorker();
  if (!workerPath) throw new Error('no embed worker is built next to this Walnut');
  const launcher = choice?.execPath ? { execPath: choice.execPath, execArgv: choice.execArgv ?? [] } : undefined;
  const out = await probeEmbedWorker({ workerPath, moduleUrl: entryUrl, model: identityModel(), launcher });
  if (out.pipeline !== 'function' || out.y[0] !== 1.5 || out.y[1] !== -2) throw new Error(`the embed worker answered ${JSON.stringify(out)}`);
  return 'the embed worker loads it and ran a model';
}
