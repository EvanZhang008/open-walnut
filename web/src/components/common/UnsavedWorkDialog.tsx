import { appUpdateBridge, hasAppUpdater } from '@/hooks/useAppUpdate';
import { log } from '@/utils/log';
import { describeUnsavedWork, listUnsavedWork, revealUnsavedWork } from '@/utils/unsaved-work';
import { ConfirmDialog } from './ConfirmDialog';

export interface UnsavedRow { what: string; where: string; reveal: () => void }
export interface UnsavedGroup { key: string; title: string; rows: UnsavedRow[] }

export interface UnsavedWork {
  groups: UnsavedGroup[];
  /** Other app windows nobody could look into (an app shell older than this check). */
  unchecked: number;
  /** Every app window answered, so the restart helper need not refuse on the window count. */
  allChecked: boolean;
  /** Other app windows the shell looked into (their drafts were just saved there). */
  otherWindows: number;
}

const SHELL_DEADLINE_MS = 4_000;

/**
 * What a restart (`app`: every Mac app window) or a reload (`window`: this page)
 * would lose. The Mac app shell answers for its other windows; a shell too old
 * to answer leaves those windows counted in `unchecked`. `windowCount` is the
 * restart helper's count: absent from an older helper, negative when it could
 * not read the window list (counted as one window nobody checked).
 */
export async function gatherUnsavedWork(scope: 'app' | 'window', openSession: (sessionId: string) => void, windowCount?: number): Promise<UnsavedWork> {
  const own = listUnsavedWork(document, document.activeElement, scope === 'app' ? 'leave' : 'reload');
  const othersUnknown = windowCount == null ? 0 : windowCount < 0 ? 1 : Math.max(0, windowCount - 1);
  const here: UnsavedGroup = { key: 'this', title: '', rows: own.map((it) => ({ what: it.what, where: it.where, reveal: () => revealUnsavedWork(it, openSession) })) };
  const groups: UnsavedGroup[] = [];
  let unchecked = 0;
  let otherWindows = 0;
  let allChecked = scope === 'window';
  if (scope === 'app' && hasAppUpdater()) {
    try {
      const answer = await Promise.race([
        appUpdateBridge.unsavedWindows(),
        new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('timeout')), SHELL_DEADLINE_MS)),
      ]);
      allChecked = true;
      for (const w of answer.windows) {
        if (w.isSource) continue;
        otherWindows++;
        const reveal = (index: number) => () => { void appUpdateBridge.revealUnsaved(w.id, index).catch(() => {}); };
        const rows = w.items === null
          ? [{ what: 'Work in this window could not be checked', where: '', reveal: reveal(-1) }]
          : w.items.map((it, i) => ({ what: it.what, where: it.where, reveal: reveal(i) }));
        if (rows.length) groups.push({ key: w.id, title: `Window ${w.title ? `“${w.title}”` : ''}`.trim(), rows });
      }
    } catch {
      unchecked = othersUnknown;
    }
  } else if (scope === 'app') {
    unchecked = othersUnknown;
  }
  if (here.rows.length) groups.unshift({ ...here, title: groups.length ? 'This window' : '' });
  if (groups.length || unchecked) {
    log.info('update', 'unsaved work holds the update', { scope, here: describeUnsavedWork(own), otherWindows: groups.length - (here.rows.length ? 1 : 0), unchecked });
  }
  return { groups, unchecked, allChecked, otherWindows };
}

export function hasAny(work: UnsavedWork): boolean {
  return work.groups.length > 0 || work.unchecked > 0;
}

/** Where the work is, a way to get there, and the choice to go ahead anyway. */
export function UnsavedWorkDialog({ work, verb, onAnyway, onCancel }: {
  work: UnsavedWork; verb: 'restart' | 'reload'; onAnyway: () => void; onCancel: () => void;
}) {
  const restart = verb === 'restart';
  return <ConfirmDialog
    title={restart ? 'Restart Walnut anyway?' : 'Reload anyway?'}
    danger
    confirmLabel={restart ? 'Restart Anyway' : 'Reload Anyway'}
    cancelLabel="Cancel"
    onCancel={onCancel}
    onConfirm={onAnyway}
    message={<div className="unsaved-work" data-testid="unsaved-work">
      <p>{restart ? 'Restarting closes every Walnut window, and this is not saved yet:' : 'Reloading this page loses what is not saved yet:'}</p>
      {work.groups.map((g) => <div key={g.key} className="unsaved-work-group">
        {g.title && <div className="unsaved-work-window">{g.title}</div>}
        <ul className="unsaved-work-list">
          {g.rows.map((row, i) => <li key={i} className="unsaved-work-item">
            <span className="unsaved-work-what">{row.what}{row.where ? <> in <strong>{row.where}</strong></> : null}</span>
            <button type="button" className="app-modal-btn unsaved-work-go" onClick={() => { onCancel(); row.reveal(); }}>Go there</button>
          </li>)}
        </ul>
      </div>)}
      {work.unchecked > 0 && <p className="unsaved-work-unchecked">
        {work.unchecked === 1 ? 'Another Walnut window is open' : `${work.unchecked} other Walnut windows are open`}, and this version of the app cannot check {work.unchecked === 1 ? 'it' : 'them'} for unsent work.
      </p>}
      <p className="unsaved-work-note">Messages typed in session boxes are kept. Running sessions keep going.</p>
    </div>}
  />;
}
