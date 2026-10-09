/**
 * What the Search settings say about the cloud companion's copy of the index
 * (`search.companion_semantic`; server side core/replication/search-replica.ts).
 * Pure, so the wording and the warning rule are unit tested.
 */

export type CompanionSearchMode = 'auto' | 'on' | 'off';

/** GET /api/search-index/status → `companion` (null before the Mac's first round). */
export interface CompanionSearchStatus {
  mode: CompanionSearchMode;
  state: 'no-companion' | 'unsupported' | 'mac-keyword-only' | 'off' | 'memory' | 'model' | 'syncing' | 'ready' | 'error';
  reason?: 'auto' | 'on' | 'forced' | 'off' | 'memory' | 'model';
  totalMb?: number;
  needMb?: number;
  autoMinMb?: number;
  docs?: number;
  pending?: number;
  syncedAt?: number | null;
  checkedAt: number;
  error?: string;
}

/** Same numbers as the server (search-replica-wire.ts), for a status that has none yet. */
export const DEFAULT_NEED_MB = 2_600;
export const DEFAULT_AUTO_MIN_MB = 5_600;

export function gb(mb: number): string {
  return `${(mb / 1024).toFixed(1)} GB`;
}

const count = (n: number): string => n.toLocaleString('en-US');

/** The row is shown only once the Mac has a companion to talk to. */
export function showCompanionSearchRow(s: CompanionSearchStatus | null | undefined): s is CompanionSearchStatus {
  return !!s && s.state !== 'no-companion';
}

/** One sentence under the row, and whether it is a warning. */
export function companionSearchHelp(s: CompanionSearchStatus): { text: string; warning?: boolean } {
  const need = s.needMb ?? DEFAULT_NEED_MB;
  const autoMin = s.autoMinMb ?? DEFAULT_AUTO_MIN_MB;
  switch (s.state) {
    case 'ready':
      if (s.reason === 'forced' && s.totalMb) {
        return { text: `On with little memory: the model takes about ${gb(need)} of the companion's ${gb(s.totalMb)}.`, warning: true };
      }
      return { text: s.docs ? `Ready: the companion searches ${count(s.docs)} items by meaning while this Mac is away.` : 'Ready: the companion searches by meaning while this Mac is away.' };
    case 'syncing':
      return { text: s.pending ? `Copying this index to the companion: ${count(s.pending)} items left.` : 'Copying this index to the companion.' };
    case 'memory':
      return { text: s.totalMb ? `Off: Auto needs ${gb(autoMin)} of memory and the companion has ${gb(s.totalMb)}.` : `Off: Auto needs ${gb(autoMin)} of memory on the companion.` };
    case 'off':
      return { text: 'Off: the companion searches by keyword while this Mac is away.' };
    case 'model':
      return { text: 'Off: the companion uses another search model than this Mac.' };
    case 'unsupported':
      return { text: 'The companion runs an older build that keeps no copy yet.' };
    case 'mac-keyword-only':
      return { text: 'This Mac searches by keyword only, so there is nothing to copy.' };
    case 'error':
      return { text: `Couldn't reach the companion: ${s.error ?? 'no answer'}.`, warning: true };
    default:
      return { text: '' };
  }
}

/** Choosing On warns unless the companion is known to have the memory Auto asks for. */
export function onNeedsMemoryWarning(next: CompanionSearchMode, s: CompanionSearchStatus | null | undefined): boolean {
  if (next !== 'on') return false;
  const autoMin = s?.autoMinMb ?? DEFAULT_AUTO_MIN_MB;
  return !(s?.totalMb && s.totalMb >= autoMin);
}

export function memoryWarningMessage(s: CompanionSearchStatus | null | undefined): string {
  const need = s?.needMb ?? DEFAULT_NEED_MB;
  const autoMin = s?.autoMinMb ?? DEFAULT_AUTO_MIN_MB;
  if (s?.totalMb) {
    return `The companion has ${gb(s.totalMb)} of memory. The search model takes about ${gb(need)}, which can leave too little for the companion itself and make it slow.`;
  }
  return `The search model takes about ${gb(need)} of the companion's memory. Auto turns it on only when the companion has ${gb(autoMin)}.`;
}
