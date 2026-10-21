/**
 * Owns a transfer from the menu click to the new task's column.
 *
 * The request lives here, not in the dialog: packing and copying a workspace
 * can take minutes, so the person may hide the dialog and keep working. The
 * answer still lands: success says "Moved to <title>" and opens the new task's
 * session on Home (the same path a fork's result takes); a refusal brings the
 * dialog back with the server's words and every choice as it was.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '@/api/client';
import { fetchTransferOptions, transferTask, type TransferOptions } from '@/api/transfer';
import { useNotifications } from '@/contexts/notifications';
import { locateTaskOnHome, openSessionOnHome } from '@/utils/open-session';
import { log } from '@/utils/log';
import { registerTransferHost, TRANSFER_OPEN_EVENT } from './transfer-events';
import { buildTransferBody, initialForm, type TransferForm } from './transfer-model';
import { TransferDialog } from './TransferDialog';

interface TransferState {
  taskId: string;
  visible: boolean;
  options: TransferOptions | null;
  loadError: string | null;
  form: TransferForm | null;
  busy: boolean;
  error: string | null;
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message || `The server answered ${err.status}.`;
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return 'The transfer is still running on the server; its new task shows up on the board when it finishes.';
  }
  return err instanceof Error ? err.message : String(err);
}

export function TransferDialogHost() {
  const navigate = useNavigate();
  const { notify } = useNotifications();
  const [state, setState] = useState<TransferState | null>(null);

  const load = useCallback((taskId: string) => {
    setState((s) => (s && s.taskId === taskId ? { ...s, loadError: null } : s));
    fetchTransferOptions(taskId).then((options) => {
      setState((s) => (s && s.taskId === taskId
        ? { ...s, options, form: s.form ?? (options.source ? initialForm(options.source) : null) }
        : s));
    }).catch((err) => {
      log.warn('transfer', 'options failed', { taskId, error: errorText(err) });
      setState((s) => (s && s.taskId === taskId ? { ...s, loadError: errorText(err) } : s));
    });
  }, []);

  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => registerTransferHost(), []);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const taskId = (e as CustomEvent<{ taskId?: string }>).detail?.taskId;
      if (!taskId) return;
      const cur = stateRef.current;
      if (cur && cur.taskId !== taskId && cur.busy) {
        // One transfer at a time: the running one keeps its dialog.
        notify({ kind: 'hint', severity: 'info', title: 'A transfer is still running', body: 'Wait for it to finish, then try again.', dedupKey: 'transfer:busy', persistent: false });
      }
      setState((s) => {
        if (s && (s.taskId === taskId || s.busy)) return { ...s, visible: true };
        return { taskId, visible: true, options: null, loadError: null, form: null, busy: false, error: null };
      });
      log.info('transfer', 'dialog opened', { taskId });
    };
    window.addEventListener(TRANSFER_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(TRANSFER_OPEN_EVENT, onOpen);
  }, [notify]);

  // A fresh dialog (no options yet) loads them.
  const needsLoad = !!state && !state.options && !state.loadError;
  const loadFor = needsLoad ? state!.taskId : null;
  useEffect(() => { if (loadFor) load(loadFor); }, [loadFor, load]);

  const setForm = useCallback((patch: Partial<TransferForm>) => {
    setState((s) => (s?.form && !s.busy ? { ...s, form: { ...s.form, ...patch }, error: null } : s));
  }, []);

  const close = useCallback(() => {
    // A running transfer keeps going with the dialog hidden; otherwise the choices go.
    setState((s) => (s?.busy ? { ...s, visible: false } : null));
  }, []);

  const submit = useCallback(() => {
    const s = state;
    if (!s?.options?.source || !s.form || s.busy) return;
    const { taskId } = s;
    const body = buildTransferBody(s.options.source, s.form);
    setState({ ...s, busy: true, error: null });
    log.info('transfer', 'submit', { taskId, engine: body.engine, host: body.host, mode: body.mode, cwd: body.cwd });
    transferTask(taskId, body).then((res) => {
      log.info('transfer', 'done', { taskId, newTaskId: res.taskId, sessionId: res.sessionId, history: res.history });
      setState((cur) => (cur && cur.taskId === taskId ? null : cur));
      notify({
        kind: 'hint',
        severity: 'success',
        title: `Moved to ${res.title}`,
        ...(res.sourceCompleted ? { body: 'The original task is complete.' } : {}),
        dedupKey: `transfer:${res.taskId}`,
        persistent: false,
      });
      if (res.sessionId) openSessionOnHome(res.sessionId, navigate);
      else locateTaskOnHome(res.taskId, navigate);
    }).catch((err) => {
      const message = errorText(err);
      const code = err instanceof ApiError ? (err.body as { code?: string } | undefined)?.code : undefined;
      log.warn('transfer', 'failed', { taskId, error: message, code });
      setState((cur) => (cur && cur.taskId === taskId ? { ...cur, busy: false, error: message, visible: true } : cur));
    });
  }, [state, notify, navigate]);

  if (!state?.visible) return null;
  return (
    <TransferDialog
      options={state.options}
      loadError={state.loadError}
      form={state.form}
      busy={state.busy}
      error={state.error}
      onChange={setForm}
      onSubmit={submit}
      onClose={close}
      onRetryLoad={() => load(state.taskId)}
    />
  );
}
