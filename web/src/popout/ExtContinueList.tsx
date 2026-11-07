/**
 * The asks to continue, over the side panel's New chat composer (PopoutExtPanel, the Ask page).
 */
import type { DrawerRow } from '@/components/chat/AskWalnutDrawer';
import { ContinueRow } from './ExtAskChrome';
import { sessionOfTask } from './useExtAsks';
import type { KeptAsk } from './ext-continue-kept';

/**
 * The recent asks to continue, newest first. While the board loads, the rows of the last open
 * (`kept`) show in their places, and the real ones replace them; the loading line shows only with
 * none kept.
 */
export function ContinueList({ rows, kept, max, loading, onPick, className = '' }: { rows: DrawerRow[]; kept: readonly KeptAsk[]; max: number; loading: boolean; onPick: (id: string, sessionId?: string) => void; className?: string }) {
  const shown = rows.slice(0, max);
  const old = loading && shown.length === 0 ? kept.slice(0, max) : [];
  if (!shown.length && !old.length && !loading) return null;
  return (
    <div className={`ext-continue ${className}`.trim()} data-testid="ext-continue" data-rows={old.length ? 'kept' : loading ? 'loading' : 'fresh'}>
      <div className="ext-continue-label">Continue</div>
      {shown.map((row) => <ContinueRow key={row.id} row={row} onPick={() => onPick(row.id, sessionOfTask(row.task) ?? undefined)} />)}
      {old.map((k) => <ContinueRow key={k.id} row={{ id: k.id, title: k.title }} kept={k} onPick={() => onPick(k.id, k.sessionId)} />)}
      {loading && shown.length === 0 && old.length === 0 && <p className="ext-continue-empty"><span className="spinner" /> Loading your asks…</p>}
    </div>
  );
}
