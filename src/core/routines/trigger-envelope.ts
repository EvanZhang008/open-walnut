/**
 * The message a fire delivers. The builder lives in
 * src/providers/trigger-envelope-core.ts because a host daemon builds the same
 * envelope for a fire no server claimed, and the session must not be able to
 * tell who built it; this module keeps the server's import path.
 */

import { buildWalnutMessage } from '../peers/walnut-message-tag.js';
import type { CronJob } from '../cron/types.js';

export {
  ITEMS_JSON_CAP, boundedItemsJson, buildTriggerBody, buildTriggerMessage, triggerNote,
} from '../../providers/trigger-envelope-core.js';

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
