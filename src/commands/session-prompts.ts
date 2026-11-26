/**
 * `walnut store-formats` and `walnut sessions-prompts unsplit` (src/core/session-prompts.ts).
 *
 * store-formats answers which store shapes this build reads, opening nothing: the rollback check
 * (scripts/lib/rollback-data-check.mjs) and the leader switch's preflight ask an older build this
 * before they let it open data a newer one wrote. A build without the command fails the probe.
 *
 * `sessions-prompts unsplit` is the down migration: every prompt kept in the prompt table goes back
 * into its session row's payload, the shape every build reads, so a build from before the split can
 * run on this file. Run it from this (newer) build with the server stopped, before the downgrade.
 */
import { outputJson } from '../utils/json-output.js';
import { SESSION_STORE_FORMATS } from '../core/session-prompts.js';
import type { GlobalOptions } from '../core/types.js';

export function runStoreFormats(globals: GlobalOptions): void {
  if (globals.json) { outputJson(SESSION_STORE_FORMATS); return; }
  for (const [k, v] of Object.entries(SESSION_STORE_FORMATS)) console.log(`${k}: ${v}`);
}

export async function runSessionsPromptsUnsplit(globals: GlobalOptions): Promise<void> {
  const [{ runPromptPass }, { closeDb, SESSION_DB_PATH }] = await Promise.all([
    import('../core/session-prompt-jobs.js'), import('../core/session-db.js'),
  ]);
  try {
    const result = await runPromptPass('unsplit');
    const out = { file: SESSION_DB_PATH, rows: result.rows, batches: result.batches, ms: Math.round(result.ms) };
    if (globals.json) outputJson(out);
    else console.log(`Put the prompts of ${out.rows} sessions back into their rows of ${out.file} (${out.batches} batches, ${out.ms} ms).`);
  } finally {
    closeDb();
  }
}
