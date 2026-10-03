/**
 * "Ask for a board": a message to the board's owner asking it to write one. It
 * goes through this session's composer when the owner IS this session's task
 * (the user sees it in the chat), else to the owner's session as a peer message.
 * Shared by the Overview's small link and the empty state of a pane without a
 * task store (TaskBoardPane.tsx BoardEmptyState).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiPost } from '@/api/client';
import { log } from '@/utils/log';
import { boardErrorMessage } from './useTaskBoard';

export const ASK_FOR_BOARD_TEXT = 'Please start a Board for this task: read the walnut-board skill '
  + '(walnut tools call skill_read \'{"dirName":"walnut-board"}\'), write it with board_set, and keep it current.';

/** How long "Asked." stays before the button reads "Ask for a board" again. */
const ASKED_MS = 3000;

export type AskState = 'idle' | 'sending' | 'asked';

export function useAskForBoard(
  taskId: string,
  onSendToSession?: (text: string) => Promise<unknown> | void,
): { state: AskState; askError: string | null; ask: () => Promise<void> } {
  const [state, setState] = useState<AskState>('idle');
  const [askError, setAskError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const ask = useCallback(async () => {
    setState('sending');
    setAskError(null);
    try {
      let ok = true;
      if (onSendToSession) ok = (await onSendToSession(ASK_FOR_BOARD_TEXT)) !== false;
      else await apiPost('/api/v1/messages', { to: taskId, text: ASK_FOR_BOARD_TEXT });
      if (!ok) throw new Error('The message was not sent');
      log.info('board', 'asked the leader for a board', { taskId });
      setState('asked');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState('idle'), ASKED_MS);
    } catch (err) {
      const message = boardErrorMessage(err);
      log.error('board', 'ask for a board failed', { taskId, error: message });
      setAskError(message);
      setState('idle');
    }
  }, [taskId, onSendToSession]);

  return { state, askError, ask };
}
