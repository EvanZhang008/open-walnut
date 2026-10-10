/**
 * What the Search settings say about each follower's copy of the index: the
 * cloud companion and every server on a host (`search.companion_semantic`;
 * server side core/replication/search-replica.ts). Pure, so the wording and
 * the warning rule are unit tested.
 */

export type CompanionSearchMode = 'auto' | 'on' | 'off';

/** GET /api/search-index/status → `followers[]` (empty before the Mac's first round). */
export interface FollowerSearchStatus {
  id: string;
  kind: 'companion' | 'host';
  label: string;
  mode: CompanionSearchMode;
  state: 'unavailable' | 'unsupported' | 'mac-keyword-only' | 'off' | 'memory' | 'model' | 'syncing' | 'ready' | 'error';
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

/** The servers Settings lists: one the Mac cannot reach (no companion set up, a host server not running) is left out. */
export function visibleFollowers(list: FollowerSearchStatus[] | null | undefined): FollowerSearchStatus[] {
  return (list ?? []).filter((s) => s.state !== 'unavailable');
}

/** One sentence under a server's row, and whether it is a warning. The row's label names the server. */
export function followerSearchHelp(s: FollowerSearchStatus): { text: string; warning?: boolean } {
  const need = s.needMb ?? DEFAULT_NEED_MB;
  const autoMin = s.autoMinMb ?? DEFAULT_AUTO_MIN_MB;
  switch (s.state) {
    case 'ready':
      if (s.reason === 'forced' && s.totalMb) {
        return { text: `On with little memory: the model takes about ${gb(need)} of its ${gb(s.totalMb)}.`, warning: true };
      }
      return { text: s.docs ? `Ready: ${count(s.docs)} items.` : 'Ready.' };
    case 'syncing':
      return { text: s.pending ? `Copying this index: ${count(s.pending)} items left.` : 'Copying this index.' };
    case 'memory':
      return { text: s.totalMb ? `Off: Auto needs ${gb(autoMin)} of memory and it has ${gb(s.totalMb)}.` : `Off: Auto needs ${gb(autoMin)} of memory.` };
    case 'off':
      return { text: 'Off: it searches by keyword while this Mac is away.' };
    case 'model':
      return { text: 'Off: it uses another search model than this Mac.' };
    case 'unsupported':
      return { text: 'It runs an older build that keeps no copy yet.' };
    case 'mac-keyword-only':
      return { text: 'This Mac searches by keyword only, so there is nothing to copy.' };
    case 'error':
      return { text: `Couldn't reach it: ${s.error ?? 'no answer'}.`, warning: true };
    default:
      return { text: '' };
  }
}

/** The servers not known to have the memory Auto asks for. */
function short(list: FollowerSearchStatus[]): FollowerSearchStatus[] {
  return list.filter((s) => !(s.totalMb && s.totalMb >= (s.autoMinMb ?? DEFAULT_AUTO_MIN_MB)));
}

/** Choosing On warns unless every listed server is known to have the memory Auto asks for. */
export function onNeedsMemoryWarning(next: CompanionSearchMode, list: FollowerSearchStatus[]): boolean {
  if (next !== 'on') return false;
  return list.length === 0 || short(list).length > 0;
}

export function memoryWarningMessage(list: FollowerSearchStatus[]): string {
  const need = list[0]?.needMb ?? DEFAULT_NEED_MB;
  const autoMin = list[0]?.autoMinMb ?? DEFAULT_AUTO_MIN_MB;
  const known = short(list).filter((s) => s.totalMb);
  if (known.length > 0) {
    const has = known.map((s) => `${s.label} has ${gb(s.totalMb!)}`).join(', ');
    return `${has} of memory. The search model takes about ${gb(need)} on each server, which can leave too little for the server itself and make it slow.`;
  }
  return `The search model takes about ${gb(need)} of each server's memory. Auto turns it on only on a server with ${gb(autoMin)}.`;
}
