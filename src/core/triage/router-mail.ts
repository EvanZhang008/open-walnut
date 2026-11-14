// Mail headlines reach the triage model without any op, so they are judged here as an agent with no area.
import { allAreaItems, readRouterAreas } from '../router/areas.js';
import { pendingRuleAreas, readPendingRuleMatches, type PendingRuleMatch } from '../router/rules.js';
import { sourceReaderFor, type SourceReaderDeps } from '../router/source-reader.js';
import type { TriagePendingMail } from './state.js';

const noLookup = (): never => {
  throw new Error('triage mail filter: an agent with no session never looks up a session or task');
};

/** Reads only the registry under `home`; throws when it is unreadable, so the batch is not delivered. */
export async function keepTriageMailOutsideAreas(
  rows: readonly TriagePendingMail[],
  home: string,
): Promise<TriagePendingMail[]> {
  const file = await readRouterAreas(home);
  let pending: ReadonlyArray<PendingRuleMatch> = [];
  const deps: SourceReaderDeps = {
    readAreas: async () => file,
    // Rules under the same home: a headline a live rule would capture is held back too.
    readPendingRules: async (areas) => (pending = await readPendingRuleMatches(areas, home)),
    session: noLookup,
    task: noLookup,
    sessionsForTask: noLookup,
  };
  const reader = await sourceReaderFor({ kind: 'agent' }, deps);
  if (reader.kind !== 'scoped') throw new Error('triage mail filter: the incoming-item area registry could not be checked');
  const classified = new Set(allAreaItems(file).filter((item) => item.source.kind === 'mail').map((item) => item.source.account));
  // A bound mailbox's arrival its area's router handles: it restricts no reader, and triage leaves it to the router.
  const routed = new Set((file.openItems ?? []).filter((item) => item.source.kind === 'mail')
    .map((item) => JSON.stringify([item.source.account, item.source.message, item.source.version ?? ''])));
  return rows.map((row) => ({
    ...row,
    headlines: row.headlines.filter((headline) => {
      const meta = { ...(headline.from ? { sender: headline.from } : {}), subject: headline.subject };
      if (!headline.messageId) return !classified.has(row.accountId) && pendingRuleAreas(pending, { kind: 'mail', ...meta }).size === 0;
      if (routed.has(JSON.stringify([row.accountId, headline.messageId, headline.version ?? '']))) return false;
      return reader.allows({
        kind: 'mail',
        account: row.accountId,
        message: headline.messageId,
        ...(headline.version ? { version: headline.version } : {}),
        ...(headline.canonicalKey ? { canonicalKey: headline.canonicalKey } : {}),
        ...meta,
      });
    }),
  }));
}
