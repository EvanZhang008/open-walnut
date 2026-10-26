/**
 * Main's quick actions (main-quick-actions.ts has the words) where the user reaches them:
 *
 *   "+" of Main's own composer   rows under "Quick actions" (useMainQuickPlusActions.tsx)
 *   a project's ⋮ on Tasks       the same actions for that project (useAskMainAbout, here)
 *
 * Never a bar of their own (the user, 2026-10-26: "not that commonly used; at most quick
 * actions in the +"). A click sends at once, as before, and Main answers with a list first, so
 * the click itself changes nothing.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { SparklesIcon } from '@/components/icons/SparklesIcon';
import type { ProjectMenuExtra } from '@/components/tasks/ProjectHeaderMenus';
import { useIsCloudReplica } from '@/hooks/useIsCloudReplica';
import { log } from '@/utils/log';
import { askMain, type AskMainResult } from './ask-main';
import { MAIN_QUICK_ACTIONS_NOTE, quickActionMessage, quickActionsFor, type MainQuickActionId } from './main-quick-actions';
import '@/styles/main-quick-actions.css';

type AskState = { kind: 'idle' } | { kind: 'sending' } | { kind: 'error'; message: string };

/**
 * A project's Main actions for the Tasks page (one project: no project merge). `itemsFor` gives
 * the ⋮ menu rows; `status` is what the page shows while one is sent, or why it was not.
 * `onSent` runs once Main has the message, or holds it because Main waits on the user.
 */
export function useAskMainAbout(onSent: (result: AskMainResult) => void): {
  itemsFor: (project: string) => ProjectMenuExtra[];
  status: ReactNode;
} {
  const replica = useIsCloudReplica();
  const [state, setState] = useState<AskState>({ kind: 'idle' });
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const run = useCallback(async (id: MainQuickActionId, project: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState({ kind: 'sending' });
    try {
      const result = await askMain(quickActionMessage(id, { project }));
      log.info('org', result.held ? 'main quick action held: Main waits on the user' : 'main quick action sent', {
        action: id, project, taskId: result.taskId, sessionId: result.sessionId, started: result.started,
      });
      if (!mounted.current) return;
      setState({ kind: 'idle' });
      onSent(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('org', 'main quick action failed', { action: id, project, error: message });
      if (mounted.current) setState({ kind: 'error', message });
    } finally {
      inFlight.current = false;
    }
  }, [onSent]);

  const itemsFor = useCallback((project: string): ProjectMenuExtra[] => {
    if (replica) return [];
    return quickActionsFor({ project }).map((a) => ({
      key: `main-qa-${a.id}`,
      label: `Ask Main: ${a.label}`,
      title: `${a.hint} (only ${project}). ${MAIN_QUICK_ACTIONS_NOTE}`,
      icon: <SparklesIcon size={14} />,
      run: () => { void run(a.id, project); },
    }));
  }, [replica, run]);

  const status = state.kind === 'sending'
    ? <span className="main-qa-note" role="status" data-testid="main-qa-sending">Asking Main…</span>
    : state.kind === 'error'
      ? <span className="main-qa-error" role="alert" title={state.message} data-testid="main-qa-error">Not sent. Try again.</span>
      : null;
  return { itemsFor, status };
}
