import { useCallback, useState, type ReactNode } from 'react';
import { SessionDiffView } from './SessionDiffView';
import { SessionTurnsView } from './SessionTurnsView';
import '@/styles/turn-snapshots.css';

/**
 * The session panel's Changed tab: the session's file changes (SessionDiffView)
 * or its per-turn snapshots (SessionTurnsView), one switch leading the toolbar
 * of either. The choice is remembered per session.
 */

type ChangedView = 'files' | 'turns';

const VIEW_KEY_PREFIX = 'open-walnut-changed-view:';

function loadView(sessionId: string): ChangedView {
  try {
    return localStorage.getItem(VIEW_KEY_PREFIX + sessionId) === 'turns' ? 'turns' : 'files';
  } catch {
    return 'files';
  }
}

function saveView(sessionId: string, view: ChangedView): void {
  try {
    if (view === 'files') localStorage.removeItem(VIEW_KEY_PREFIX + sessionId);
    else localStorage.setItem(VIEW_KEY_PREFIX + sessionId, view);
  } catch { /* storage full or blocked: the choice lasts this mount */ }
}

interface SessionChangedTabProps {
  sessionId: string;
  sessionCwd?: string;
  sessionHost?: string;
  onSelectCode: (filePath: string, line: number | undefined, code: string) => void;
  onComment?: (message: string) => boolean | void | Promise<boolean | void>;
  barRightSlot?: ReactNode;
  onOpenFile?: (path: string, line?: number, term?: string) => void;
}

export function ChangedViewSwitch({ view, onChange }: { view: ChangedView; onChange: (v: ChangedView) => void }) {
  return (
    <div className="session-diff-viewtoggle changed-view-switch" role="tablist" aria-label="Changed view">
      <button
        type="button"
        role="tab"
        aria-selected={view === 'files'}
        className={`session-diff-viewtoggle-btn${view === 'files' ? ' is-active' : ''}`}
        onClick={() => onChange('files')}
        title="Files this session changed"
      >Files</button>
      <button
        type="button"
        role="tab"
        aria-selected={view === 'turns'}
        className={`session-diff-viewtoggle-btn${view === 'turns' ? ' is-active' : ''}`}
        onClick={() => onChange('turns')}
        title="The working tree as each turn left it"
      >Turns</button>
    </div>
  );
}

export function SessionChangedTab(props: SessionChangedTabProps) {
  const { sessionId } = props;
  const [view, setViewState] = useState<{ sid: string; view: ChangedView }>(() => ({ sid: sessionId, view: loadView(sessionId) }));
  // A panel that switches sessions reads that session's choice.
  const current = view.sid === sessionId ? view.view : loadView(sessionId);
  const setView = useCallback((v: ChangedView) => {
    saveView(sessionId, v);
    setViewState({ sid: sessionId, view: v });
  }, [sessionId]);
  const lead = <ChangedViewSwitch view={current} onChange={setView} />;

  if (current === 'turns') {
    return (
      <SessionTurnsView
        sessionId={sessionId}
        sessionCwd={props.sessionCwd}
        sessionHost={props.sessionHost}
        onComment={props.onComment}
        toolbarLeadingSlot={lead}
        barRightSlot={props.barRightSlot}
      />
    );
  }
  return <SessionDiffView {...props} toolbarLeadingSlot={lead} />;
}
