/**
 * The Mac's side of the companion's journal (docs/plan/walnut-companion-unified-replica.md,
 * stage 3): the same handover a host gets (offline-handover.ts runOfflineHandover),
 * over HTTPS to the companion's `POST /bridge/journal` (cloud-ingest.ts
 * postToCloudJournal), host key `companion`, journal v2.
 *
 * The companion asks for it (`server.journal.due`, session-controls.ts) when its
 * bridge to this Mac connects and on its 60 s sweep while records wait, as its
 * queues flush; a call while a drain runs joins it.
 */

import { log } from '../logging/index.js';
import type { HandoverConnection, HandoverResult } from './offline-handover.js';

export const COMPANION_HANDOVER_HOST = 'companion';

export function companionHandoverConnection(): HandoverConnection {
  return {
    hostKey: COMPANION_HANDOVER_HOST,
    journalV2: true,
    send: async (cmd, params, timeoutMs) => (await import('./cloud-ingest.js')).postToCloudJournal(cmd, params ?? {}, { ...(timeoutMs ? { timeoutMs } : {}) }),
  };
}

/** Drain the companion's journal now (joined when one runs). Never rejects. */
export async function drainCompanionJournalNow(): Promise<HandoverResult | null> {
  try {
    const { runOfflineHandover } = await import('./offline-handover.js');
    return await runOfflineHandover(companionHandoverConnection());
  } catch (err) {
    // The records stay on the companion; it asks again on its next sweep.
    log.session.warn('companion journal: the drain did not finish', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
