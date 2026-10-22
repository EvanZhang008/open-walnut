import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { SessionPanel } from '@/components/sessions/SessionPanel';
import { DraftSessionPanel } from '@/components/sessions/DraftSessionPanel';
import { draftComposerKey, type DraftColumn } from '@/components/sessions/draft-column';
import { TasksProvider } from '@/contexts/TasksContext';
import { NotificationProvider, useNotifications } from '@/contexts/notifications';
import { FocusBarProvider } from '@/contexts/FocusBarContext';
import { NotificationToaster } from '@/components/common/NotificationToaster';
import { OperationErrorBridge } from '@/components/common/OperationErrorBridge';
import { TransferDialogHost } from '@/components/transfer/TransferDialogHost';
import { useConfirm } from '@/hooks/useConfirm';
import { yieldFullscreen } from '@/hooks/useFullscreen';
import { useProjectRegistry } from '@/hooks/useProjectRegistry';
import { fetchSession, forkSessionInWalnut } from '@/api/sessions';
import type { ImageAttachment } from '@/api/chat';
import { openPopout, popoutPath } from './openPopout';
import './popout-session.css';

export function PopoutSession() {
  return <TasksProvider><NotificationProvider><FocusBarProvider>
    <PopoutSessionPanel />
    <NotificationToaster />
    <OperationErrorBridge />
    <TransferDialogHost />
  </FocusBarProvider></NotificationProvider></TasksProvider>;
}

function PopoutSessionPanel() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const id = params.get('id') ?? '';
  const [fork, setFork] = useState<DraftColumn | null>(null);
  const [forking, setForking] = useState(false);
  const { notify } = useNotifications();
  const confirm = useConfirm();
  const { isKnownProject } = useProjectRegistry();

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    fetchSession(id).then(session => {
      if (!cancelled) document.title = `${session?.title || session?.description || 'Session'} · Walnut`;
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [id]);

  const replaceSession = useCallback((_oldId: string, newId: string) => {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      next.set('id', newId);
      return next;
    }, { replace: true });
  }, [setParams]);

  const closeFork = useCallback(async () => {
    if (!fork || forking) return;
    const text = document.querySelector<HTMLTextAreaElement>('.popout-session-fork textarea')?.value ?? localStorage.getItem(draftComposerKey(fork.id));
    const hasImages = document.querySelector('.popout-session-fork .chat-image-preview') != null;
    if ((text?.trim() || hasImages) && !await confirm({ title: 'Close fork draft?', message: 'The unsent fork message will be discarded.', confirmLabel: 'Discard and Close', cancelLabel: 'Keep Open' })) return;
    localStorage.removeItem(draftComposerKey(fork.id));
    setFork(null);
  }, [fork, forking, confirm]);

  const startFork = useCallback(async (_draftId: string, text: string, images?: ImageAttachment[]) => {
    if (!fork?.forkOf || forking) return false;
    setForking(true);
    try {
      const result = await forkSessionInWalnut(fork.forkOf.sessionId, {
        ...(text.trim() ? { message: text.trim() } : {}),
        ...(images?.length ? { images } : {}),
        ...(fork.metaTouched && fork.meta.model ? { model: fork.meta.model } : {}),
      });
      navigate(popoutPath('session', { id: result.sessionId }));
      setFork(null);
      return true;
    } catch (error) {
      notify({ kind: 'operation-error', severity: 'error', title: 'Could not fork session', body: error instanceof Error ? error.message : 'Try again.', persistent: false, dedupKey: 'popout-fork-error' });
      return false;
    } finally { setForking(false); }
  }, [fork, forking, navigate, notify]);

  if (!id) return <div className="popout-stub"><h2>No session</h2></div>;

  return <div className="popout-session popout-session-interactive">
    <SessionPanel
      key={id}
      sessionId={id}
      embedded
      onClose={() => window.close()}
      onSessionClick={sessionId => openPopout('session', { id: sessionId })}
      onTaskClick={taskId => openPopout('task', { id: taskId })}
      onOpenTaskDetail={taskId => openPopout('task', { id: taskId })}
      onSessionReplaced={replaceSession}
      onOpenForkDraft={seed => {
        if (fork) return;
        yieldFullscreen('popout-fork');
        setFork({ ...seed, id: `popout-fork:${Date.now()}`, meta: { unread: false, priority: 'none', pinTier: undefined, model: seed.model, engine: undefined } });
      }}
    />
    {fork && <div className="popout-session-fork" aria-busy={forking}>
      <DraftSessionPanel
        draft={fork}
        autoFocus
        onStart={startFork}
        onSaveAsTask={() => {}}
        onClose={() => { void closeFork(); }}
        onPathChange={(_id, path, meta) => setFork(current => current && { ...current, cwd: path.cwd, host: path.host ?? null, meta })}
        onProjectChange={(_id, project) => setFork(current => current && { ...current, project })}
        onMetaChange={(_id, update) => setFork(current => current && { ...current, meta: update(current.meta), metaTouched: true })}
        isKnownProject={isKnownProject}
      />
    </div>}
  </div>;
}
