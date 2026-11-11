/**
 * Mounts the first-run setup dialog (FirstRunDialog.tsx) once per page: on load when the
 * server says this install still asks a question (GET /api/first-run), and whenever
 * Settings › Remote Hosts asks for the hosts step again (FIRST_RUN_OPEN_EVENT).
 *
 * The person closing the first-run dialog records the answer (Done, Not now, Escape alike),
 * so it never opens again by itself, in this window or another; Walnut closing it for them
 * (a link that navigates away) records nothing. A cloud companion and a host replica
 * ask nothing (the server answers no step there).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useIsCloudReplica } from '@/hooks/useIsCloudReplica';
import { useEvent } from '@/hooks/useWebSocket';
import { log } from '@/utils/log';
import {
  answerFirstRun, fetchFirstRunPending, FIRST_RUN_OPEN_EVENT, requestAddSshHost, type FirstRunStep,
} from '@/api/first-run';
import { FirstRunDialog, type FirstRunMode } from './FirstRunDialog';

interface Open { steps: FirstRunStep[]; mode: FirstRunMode }

export function FirstRunHost() {
  const replica = useIsCloudReplica();
  const navigate = useNavigate();
  const [open, setOpen] = useState<Open | null>(null);
  const openRef = useRef<Open | null>(null);
  openRef.current = open;

  const check = useCallback(() => {
    if (replica) return;
    fetchFirstRunPending()
      .then((pending) => {
        setOpen((cur) => {
          // Another window answered: the first-run dialog here closes too (a picker stays).
          if (cur?.mode === 'first-run' && pending.length === 0) return null;
          if (!cur && pending.length > 0) return { steps: pending, mode: 'first-run' };
          return cur;
        });
      })
      .catch((err) => log.warn('first-run', 'could not read the first-run steps', { error: err instanceof Error ? err.message : String(err) }));
  }, [replica]);
  useEffect(check, [check]);
  useEvent('config:changed', check);

  useEffect(() => {
    const onOpen = () => setOpen((cur) => cur ?? { steps: ['hosts'], mode: 'picker' });
    window.addEventListener(FIRST_RUN_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(FIRST_RUN_OPEN_EVENT, onOpen);
  }, []);

  const answer = useCallback((steps: FirstRunStep[]) => {
    for (const step of steps) {
      void answerFirstRun(step).catch((err) => log.warn('first-run', 'could not record the answer', { step, error: err instanceof Error ? err.message : String(err) }));
    }
  }, []);

  const close = useCallback((how: { added: boolean; answered: boolean }) => {
    const cur = openRef.current;
    if (cur?.mode === 'first-run') {
      log.info('first-run', 'setup closed', how);
      if (how.answered) answer(cur.steps);
    }
    setOpen(null);
  }, [answer]);

  const addByHand = useCallback(() => {
    const cur = openRef.current;
    if (cur?.mode === 'first-run') answer(cur.steps);
    setOpen(null);
    requestAddSshHost();
    navigate('/settings#remote-hosts');
  }, [answer, navigate]);

  if (!open || replica) return null;
  return <FirstRunDialog steps={open.steps} mode={open.mode} onClose={close} onAddByHand={addByHand} />;
}
