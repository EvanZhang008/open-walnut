/**
 * The message a fire delivers: ONE envelope v2 tag, so it renders as a card in
 * the session instead of a wall of pasted text.
 *
 * Order inside the body is fixed and meaningful: the prompt first (what to do),
 * then one line on timing when the fires were batched or are late, then the
 * items as JSON (what happened), then `input` (whatever free text the script
 * wanted the AI to read THIS run). `items` and `input` are never merged
 * and `state` never appears at all — it is the script talking to its next run.
 */

import { buildWalnutMessage } from '../peers/walnut-message-tag.js';
import { CHECK_INPUT_CAP } from '../../providers/trigger-check-core.js';
import type { TriggerFiredEvent, TriggerItem } from '../../providers/trigger-check-core.js';
import type { CronJob } from '../cron/types.js';
import { describeSpan, LATE_DELIVERY_MS } from '../cron/trigger-timing.js';

/**
 * Keep one fire's body bounded even when a script prints 200 fat items.
 *
 * Exported because there must be exactly ONE truncation rule in the repo: the
 * triage batch (src/core/triage/batch.ts) serialises two arrays of its own and
 * shares this budget rather than inventing a second number that would drift.
 */
export const ITEMS_JSON_CAP = 32 * 1024;

export function triggerNote(atMs: number, itemCount: number): string {
  const when = new Date(Number.isFinite(atMs) ? atMs : Date.now()).toISOString();
  return `fired ${when}, ${itemCount} new item${itemCount === 1 ? '' : 's'}`;
}

/**
 * `items` as pretty JSON, bounded by dropping WHOLE items.
 *
 * Truncating the JSON text would hand the model something unparseable, so the
 * rule is: keep as many complete items as fit, then SAY how many are missing.
 * `items` is `unknown[]` because every caller only stringifies it — a trigger's
 * TriggerItem and a triage batch row are different shapes with the same budget.
 */
export function boundedItemsJson(items: readonly unknown[], cap = ITEMS_JSON_CAP): string {
  const json = JSON.stringify(items, null, 2);
  if (json.length <= cap) return json;
  const kept: unknown[] = [];
  for (const item of items) {
    const next = JSON.stringify([...kept, item], null, 2);
    if (next.length > cap) break;
    kept.push(item);
  }
  return `${JSON.stringify(kept, null, 2)}\n[${items.length - kept.length} more item(s) omitted]`;
}

export function buildTriggerBody(prompt: string, items: readonly TriggerItem[], input?: string, timing?: string): string {
  const parts = [prompt.trim()];
  if (timing) parts.push(timing);
  if (items.length > 0) {
    parts.push(`New items:\n\`\`\`json\n${boundedItemsJson(items)}\n\`\`\``);
  }
  const extra = (input ?? '').trim();
  if (extra) parts.push(extra);
  return parts.join('\n\n');
}

type FirePart = Pick<TriggerFiredEvent, 'atMs' | 'items' | 'input'>;

function isoOf(atMs: number): string {
  return new Date(Number.isFinite(atMs) ? atMs : Date.now()).toISOString();
}

/** A backlog's inputs share one budget: two fires' worth, not one per fire held. */
const MERGED_INPUT_CAP = 2 * CHECK_INPUT_CAP;

/**
 * Every distinct `input` of a backlog, oldest first, each labelled with its fire
 * so the model can tell which run printed what. Bounded by dropping the OLDEST
 * whole inputs: the newest one describes the source closest to now.
 */
function mergedInput(fires: readonly FirePart[]): string | undefined {
  const seen = new Set<string>();
  const blocks: Array<{ atMs: number; text: string }> = [];
  for (const fire of fires) {
    const text = (fire.input ?? '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    blocks.push({ atMs: fire.atMs, text });
  }
  if (blocks.length <= 1) return blocks[0]?.text;
  const kept: string[] = [];
  let total = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = `Input from the fire at ${isoOf(blocks[i].atMs)}:\n${blocks[i].text}`;
    if (kept.length > 0 && total + block.length > MERGED_INPUT_CAP) {
      kept.unshift(`[${i + 1} older input(s) omitted]`);
      break;
    }
    kept.unshift(block);
    total += block.length;
  }
  return kept.join('\n\n');
}

/**
 * The full delivery for one fire, or for a BACKLOG of fires delivered as one
 * envelope (a host back from an outage replays every fire it held, and seven
 * separate deliveries are seven turns doing one job). `job.executor.config.prompt`
 * is the routine's own instruction text; everything else comes from the events.
 *
 * `deliveredAtMs` is what makes lateness visible; without it (a caller with no
 * clock of its own) the envelope says nothing about timing, as it always did.
 */
export function buildTriggerMessage(
  job: Pick<CronJob, 'name'>,
  fires: FirePart | readonly FirePart[],
  prompt: string,
  opts: { deliveredAtMs?: number } = {},
): string {
  const list = (Array.isArray(fires) ? fires : [fires]) as readonly FirePart[];
  const ordered = [...list].sort((a, b) => a.atMs - b.atMs);
  const items = ordered.flatMap((f) => (Array.isArray(f.items) ? f.items : []));
  const first = ordered[0]?.atMs ?? Date.now();
  const last = ordered[ordered.length - 1]?.atMs ?? first;
  const age = opts.deliveredAtMs !== undefined ? opts.deliveredAtMs - first : 0;
  const late = age > LATE_DELIVERY_MS;
  const count = `${items.length} new item${items.length === 1 ? '' : 's'}`;

  let note: string;
  let timing: string | undefined;
  if (ordered.length > 1) {
    note = `${ordered.length} fires ${isoOf(first)} to ${isoOf(last)}, ${count}${late ? `, delivered ${describeSpan(age)} late` : ''}`;
    timing = late
      ? `These ${ordered.length} fires arrive together and late: the oldest is ${describeSpan(age)} old.`
      : `These ${ordered.length} fires arrive together.`;
  } else {
    note = `${triggerNote(first, items.length)}${late ? `, delivered ${describeSpan(age)} late` : ''}`;
    if (late) timing = `This fire arrives late: it is ${describeSpan(age)} old.`;
  }
  return buildWalnutMessage({
    kind: 'trigger',
    attrs: { from: `Trigger: ${job.name}`, note },
    body: buildTriggerBody(prompt, items, mergedInput(ordered), timing),
  });
}

/**
 * A plain scheduled run of the `session` executor (a routine with no check):
 * same envelope, so the session sees one shape whether the clock or a script
 * decided.
 */
export function buildScheduledSessionMessage(job: Pick<CronJob, 'name'>, prompt: string): string {
  return buildWalnutMessage({
    kind: 'trigger',
    attrs: { from: `Trigger: ${job.name}`, note: 'scheduled' },
    body: prompt.trim(),
  });
}
