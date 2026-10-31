/**
 * The session's working folder is gone (server: src/core/sessions/folder-gone.ts). Says so
 * plainly, says whether the conversation's history was found, and offers ONE way on:
 * continue in the task's own folder (history kept), or, with the history gone too, a new
 * conversation there that carries the waiting messages. The old folder is never recreated.
 *
 * Shown above the chat while `record.cwdGone` is set; the parked message row offers the same
 * button through ContinueInNewFolderButton.
 */
import { useCallback, useState } from 'react';
import { continueInNewFolder, type ContinueInNewFolderResult } from '@/api/sessions';
import { log } from '@/utils/log';
import { WarningTriangleIcon } from '@/components/common/PhoneIcons';

type CwdGone = { cwd: string; at: string; history: 'found' | 'missing' | 'unknown'; newCwd?: string };

export function folderGoneButtonLabel(history: CwdGone['history'] | undefined): string {
  return history === 'missing' ? 'Start a new conversation in a new folder' : 'Continue in a new folder';
}

export function ContinueInNewFolderButton({ sessionId, history, onDone, className }: {
  sessionId: string;
  history?: CwdGone['history'];
  onDone?: (result: ContinueInNewFolderResult) => void;
  className?: string;
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle');
  const [failure, setFailure] = useState<string | null>(null);
  const run = useCallback(async () => {
    setState('busy');
    setFailure(null);
    try {
      const result = await continueInNewFolder(sessionId);
      log.info('session-panel', 'continued in a new folder', { sessionId, status: result.status, cwd: result.cwd });
      setState('idle');
      onDone?.(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('session-panel', 'continue in a new folder failed', { sessionId, error: message });
      setFailure(message);
      setState('error');
    }
  }, [sessionId, onDone]);
  return (
    <>
      <button type="button" className={className ?? 'session-retry-btn'} onClick={run} disabled={state === 'busy'}
        title="Walnut does not recreate the old folder. The session moves to this task's own folder, which survives reboots.">
        {state === 'busy' ? 'Moving…' : state === 'error' ? 'Failed, try again' : folderGoneButtonLabel(history)}
      </button>
      {failure && <div className="folder-gone-failure" role="alert">{failure}</div>}
    </>
  );
}

export function FolderGoneBanner({ sessionId, cwdGone, onDone }: {
  sessionId: string;
  cwdGone: CwdGone;
  onDone?: (result: ContinueInNewFolderResult) => void;
}) {
  const where = cwdGone.newCwd ? `this task's own folder, ${cwdGone.newCwd}` : "this task's own folder";
  const text = cwdGone.history === 'missing'
    ? `Its conversation history is gone too, so it cannot be resumed. Walnut can start a new conversation for this task in ${where}, and send it the messages that waited together with what Walnut recorded about the earlier work.`
    : cwdGone.history === 'found'
      ? `Walnut found its conversation history, so it can continue in ${where}, with the whole conversation. The old folder is not recreated.`
      : `Walnut could not check yet whether its conversation history is still there. It can continue in ${where}; the old folder is not recreated.`;
  return (
    <div className="session-error-banner session-error-banner--idle session-folder-gone-banner" data-testid="folder-gone-banner">
      <span className="session-error-banner-icon"><WarningTriangleIcon size={14} /></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="session-error-banner-text"><strong>This session's folder is gone:</strong> <code>{cwdGone.cwd}</code></div>
        <div className="session-error-banner-text folder-gone-detail">{text}</div>
      </div>
      <div className="folder-gone-actions">
        <ContinueInNewFolderButton sessionId={sessionId} history={cwdGone.history} onDone={onDone} />
      </div>
    </div>
  );
}
