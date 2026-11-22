import { useCallback, useState, type ReactNode } from 'react';
import { SessionDiffView } from './SessionDiffView';
import { SessionTurnsView } from './SessionTurnsView';
import { SegmentedControl, type SegmentedOption } from '@/components/controls';
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

const CHANGED_VIEWS: ReadonlyArray<SegmentedOption<ChangedView>> = [
  { value: 'files', label: 'Files', title: 'Files this session changed' },
  { value: 'turns', label: 'Turns', title: 'The working tree as each turn left it' },
];

export function ChangedViewSwitch({ view, onChange }: { view: ChangedView; onChange: (v: ChangedView) => void }) {
  return <SegmentedControl className="changed-view-switch" aria-label="Changed view" value={view} options={CHANGED_VIEWS} onChange={onChange} />;
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
