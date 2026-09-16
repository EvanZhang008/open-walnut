/**
 * The message a fire delivers: ONE envelope v2 tag, so it renders as a card in
 * the session instead of a wall of pasted text.
 *
 * Order inside the body is fixed and meaningful: the prompt first (what to do),
 * then the items as JSON (what happened), then `input` (whatever free text the
 * script wanted the AI to read THIS run). `items` and `input` are never merged
 * and `state` never appears at all — it is the script talking to its next run.
 */

import { buildWalnutMessage } from '../peers/walnut-message-tag.js';
import type { TriggerFiredEvent, TriggerItem } from '../../providers/trigger-check-core.js';
import type { CronJob } from '../cron/types.js';

/** Keep one fire's body bounded even when a script prints 200 fat items. */
const ITEMS_JSON_CAP = 32 * 1024;

export function triggerNote(atMs: number, itemCount: number): string {
  const when = new Date(Number.isFinite(atMs) ? atMs : Date.now()).toISOString();
  return `fired ${when}, ${itemCount} new item${itemCount === 1 ? '' : 's'}`;
}

export function buildTriggerBody(prompt: string, items: TriggerItem[], input?: string): string {
  const parts = [prompt.trim()];
  if (items.length > 0) {
    let json = JSON.stringify(items, null, 2);
    if (json.length > ITEMS_JSON_CAP) {
      // Truncating the JSON would hand the model something unparseable, so drop
      // whole items and SAY how many are missing.
      const kept: TriggerItem[] = [];
      for (const item of items) {
        const next = JSON.stringify([...kept, item], null, 2);
        if (next.length > ITEMS_JSON_CAP) break;
        kept.push(item);
      }
      json = `${JSON.stringify(kept, null, 2)}\n[${items.length - kept.length} more item(s) omitted]`;
    }
    parts.push(`New items:\n\`\`\`json\n${json}\n\`\`\``);
  }
  const extra = (input ?? '').trim();
  if (extra) parts.push(extra);
  return parts.join('\n\n');
}

/**
 * The full delivery for a fire. `job.executor.config.prompt` is the routine's
 * own instruction text; everything else comes from the daemon's event.
 */
export function buildTriggerMessage(
  job: Pick<CronJob, 'name'>,
  event: Pick<TriggerFiredEvent, 'atMs' | 'items' | 'input'>,
  prompt: string,
): string {
  const items = Array.isArray(event.items) ? event.items : [];
  return buildWalnutMessage({
    kind: 'trigger',
    attrs: {
      from: `Trigger: ${job.name}`,
      note: triggerNote(event.atMs, items.length),
    },
    body: buildTriggerBody(prompt, items, event.input),
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
