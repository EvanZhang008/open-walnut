/**
 * `inbox-triage-batch` — the init processor that builds one Inbox Triage batch.
 *
 * WHICH REGISTRY. This is the FILE-BASED action registry (src/actions/registry.ts):
 * a module exporting `describe()` + `run(ctx)`, imported through the host bundle
 * (src/actions/builtin-modules.ts) and run by id. `src/core/cron/actions.ts`
 * is a SECOND, parallel registry; the routine form's action list reads that one
 * (listRoutineActions), not this.
 * This slice uses the file-based one because that is the one the cron engine's
 * `runAction` dep is wired to (src/web/server.ts).
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
import { ackTriageClaimForTask, claimTriageBatch, loadTriageState, releaseTriageClaimHeldBy, triageRunHold, type TriageRunTaskView } from '../core/triage/state.js';
import { buildTriageBatch, TRIAGE_STATE_NOTE } from '../core/triage/batch.js';
import { keepTriageMailOutsideAreas } from '../core/triage/router-mail.js';
import { TRIAGE_ACTION_ID } from '../core/triage/types.js';
import { readRoutingRules, type TriageRoutingRule } from '../core/triage/routing-rules.js';

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

export async function liveRules(rules: TriageRoutingRule[]): Promise<TriageRoutingRule[]> {
  if (rules.length === 0) return rules;
  const { getTask } = await import('../core/task-manager.js');
  const open = await Promise.all(rules.map(async (r) => {
    const task = await getTask(r.taskId).catch(() => null);
    return !!task && task.phase !== 'COMPLETE';
  }));
  return rules.filter((_, i) => open[i]);
}

/**
 * The run the open batch waits in, while it still waits: a run filed when every host was full
 * starts later and takes its batch with it, so a fire meanwhile builds no second batch of the same
 * items. A run whose session came up without its acknowledgement reaching the buffer is
 * acknowledged here (its items are not offered again); one that no longer carries the batch
 * (cancelled, deleted, its start failed) lets the claim go, and this fire's batch holds its items.
 */
async function waitingRun(home: string, nowMs: number): Promise<{ waiting?: string; released: boolean }> {
  const claim = (await loadTriageState(home)).claim;
  if (!claim?.taskId) return { released: false };
  const { getTask } = await import('../core/task-manager.js');
  const task = await getTask(claim.taskId).catch(() => null) as TriageRunTaskView | null;
  const hold = triageRunHold(task, claim, nowMs);
  if (hold === 'waiting') return { waiting: claim.taskId, released: false };
  if (hold === 'delivered') {
    await ackTriageClaimForTask(claim.taskId, {}, home);
    return { released: false };
  }
  return { released: await releaseTriageClaimHeldBy(claim.taskId, home) };
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

  // The standing routing rules ride every batch (routing-rules.ts), read before anything is
  // claimed: a rules file that cannot be read is not "no rules" (every item a rule covers would
  // go to triage as unrouted mail), so the run waits and the items stay for the next one.
  let allRules: TriageRoutingRule[];
  try {
    allRules = await readRoutingRules(home);
  } catch (err) {
    return {
      invoke: false,
      status: 'skipped',
      content: `The routing rules could not be read (${err instanceof Error ? err.message : String(err)}) — no batch this run; the items wait for the next one.`,
    };
  }
  const nowMs = Date.now();
  const held = await waitingRun(home, nowMs);
  if (held.waiting) {
    return {
      invoke: false,
      status: 'skipped',
      content: `The previous Inbox Triage run (task ${held.waiting}) has not started yet (it waits for a free slot or for its session to come up) and carries the open batch; no new batch this run.`,
    };
  }
  const claimed = await claimTriageBatch(nowMs, home);
  const mail = await keepTriageMailOutsideAreas(claimed.mail, home);
  const stateDoc = await readStateNote(home);
  // A rule whose task is complete or gone sits out: it must not win the first match and keep a
  // later rule (to open work) from routing the item.
  const rules = await liveRules(allRules);

  const batch = buildTriageBatch({
    mail,
    slack: claimed.slack,
    droppedMail: claimed.claim.droppedMail,
    droppedSlack: claimed.claim.droppedSlack,
    sinceMs: claimed.sinceMs,
    nowMs: claimed.claim.atMs,
    sources: resolved.sources,
    ...(stateDoc ? { stateDoc } : {}),
    ...(claimed.lastJournalLine ? { previousJournalLine: claimed.lastJournalLine } : {}),
    ...(claimed.stateStale ? { stateStale: true } : {}),
    ...(claimed.redelivered || held.released ? { redelivered: true } : {}),
    ...(rules.length ? { rules } : {}),
  });

  return { invoke: true, content: batch.message };
}
