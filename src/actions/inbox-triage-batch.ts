/**
 * `inbox-triage-batch` — the init processor that builds one Inbox Triage batch.
 *
 * WHICH REGISTRY. This is the FILE-BASED action registry (src/actions/registry.ts):
 * a module exporting `describe()` + `run(ctx)`, emitted by tsup as its own
 * dist/actions/*.js entry and dynamic-imported by id. `src/core/cron/actions.ts`
 * is a SECOND, parallel registry whose only caller was retired; nothing reads it.
 * This slice uses the file-based one because that is the one the cron engine's
 * `runAction` dep is wired to (src/web/server.ts) and the one the routine form's
 * action dropdown lists.
 *
 * ZERO MODEL CALLS, and a test pins it. Everything here is config, one JSON file
 * and one note read. The reason is cost and honesty: this runs on the server's
 * event loop before every triage fire, including the ones that turn out to have
 * nothing in them, and a model call here would be a second opinion nobody asked
 * for in front of the session that IS the opinion.
 *
 * WHY IT CAN DECLINE. A routine has no "skip this fire" hook, and teaching the
 * generic claude-code executor about triage's clock would make every other
 * routine carry the concept. The init processor runs BEFORE the executor, so it is
 * the only place that can refuse a fire without a session being minted first —
 * hence `status: 'skipped'`, which the engine turns into a skipped run (no error
 * backoff, no red card, the next slot computed as usual).
 *
 * PATHS COME FROM `ctx`. An action module is its own tsup bundle, so its copy of
 * `constants.ts` is not the server's. `ctx.WALNUT_HOME` is the server's value, and
 * everything this action touches is derived from it.
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { ActionDescriptor, ActionContext, ActionResult } from './types.js';
import { readTriageConfig, isTriageWithinActiveHours } from '../core/triage/config.js';
import { claimTriageBatch } from '../core/triage/state.js';
import { buildTriageBatch, TRIAGE_STATE_NOTE } from '../core/triage/batch.js';
import { TRIAGE_ACTION_ID } from '../core/triage/types.js';

export function describe(): ActionDescriptor {
  return {
    id: TRIAGE_ACTION_ID,
    name: 'Inbox Triage batch',
    description:
      'Collect the new mail and Slack that arrived since the last Inbox Triage run and build '
      + 'the batch its session starts with. Pure file I/O — no model call, no network.',
  };
}

/** State.md's bytes, or undefined when the note is not there yet. */
async function readStateNote(home: string): Promise<string | undefined> {
  const file = path.join(home, 'notes', TRIAGE_STATE_NOTE);
  try {
    return await readFile(file, 'utf-8');
  } catch {
    // Missing is the normal first-run case; unreadable is rare and not worth
    // failing a run over — the batch says the note is absent and the run writes it.
    return undefined;
  }
}

export async function run(ctx: ActionContext): Promise<ActionResult> {
  const home = ctx.WALNUT_HOME;
  const { getConfig } = await import('../core/config-manager.js');
  const resolved = readTriageConfig(await getConfig());

  // Active hours are enforced HERE, the one point before a session exists.
  if (!isTriageWithinActiveHours(resolved)) {
    return {
      invoke: false,
      status: 'skipped',
      content: `Outside the Inbox Triage active hours (${resolved.activeHours}) — no batch this run.`,
    };
  }

  const nowMs = Date.now();
  const claimed = await claimTriageBatch(nowMs, home);
  const stateDoc = await readStateNote(home);

  const batch = buildTriageBatch({
    mail: claimed.mail,
    slack: claimed.slack,
    droppedMail: claimed.claim.droppedMail,
    droppedSlack: claimed.claim.droppedSlack,
    sinceMs: claimed.sinceMs,
    nowMs: claimed.claim.atMs,
    sources: resolved.sources,
    ...(stateDoc ? { stateDoc } : {}),
    ...(claimed.lastJournalLine ? { previousJournalLine: claimed.lastJournalLine } : {}),
    ...(claimed.stateStale ? { stateStale: true } : {}),
    ...(claimed.redelivered ? { redelivered: true } : {}),
  });

  return { invoke: true, content: batch.message };
}
