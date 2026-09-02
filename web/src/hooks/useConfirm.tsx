import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';

/**
 * App-wide confirm/alert/prompt dialogs — replacing the browser-native
 * `window.confirm` / `window.alert` / `window.prompt` (ugly, un-themeable, and on
 * localhost showed a "don't allow this site to prompt you again" checkbox). One
 * `<ConfirmProvider>` mounts a single portal dialog; the hooks return promise-based APIs:
 *
 *   const confirm = useConfirm();
 *   if (await confirm({ title: 'Delete "foo.md"?', danger: true })) { ... }
 *
 *   const alert = useAlert();
 *   await alert({ title: 'Save failed', message: err.message });
 *
 *   const prompt = usePrompt();
 *   const name = await prompt({ title: 'Rename group', defaultValue: current });
 *   if (name !== null) { ... }   // null = cancelled; default rejects empty (stays open).
 *                                // With allowEmpty:true an empty submit resolves '' (clear).
 *
 * ONE dialog is ever visible: a second ask takes the screen from the first. The
 * displaced ask is not forgotten — it settles as cancelled, because a promise-
 * returning dialog that drops a resolver leaves its caller's `await` parked forever
 * (no error, no timeout, no way for the caller to notice). Same on unmount.
 */

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button for destructive actions. */
  danger?: boolean;
}

interface AlertOptions {
  title: string;
  message?: ReactNode;
  okLabel?: string;
}

export interface PromptOptions {
  title: string;
  message?: ReactNode;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Allow submitting an empty string (resolves ''). Default false: empty is rejected
   *  (dialog stays open). Use for fields where "clear it" is a meaningful action. */
  allowEmpty?: boolean;
}

type DialogRequest =
  | { id: number; kind: 'confirm'; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { id: number; kind: 'alert'; opts: AlertOptions; resolve: () => void }
  | { id: number; kind: 'prompt'; opts: PromptOptions; resolve: (v: string | null) => void };

type DialogState = DialogRequest | null;

/**
 * Settle a request the user never answered — displaced by a later ask, or the
 * provider unmounted under it. The only safe answer is the one that does nothing:
 * confirm → false, prompt → null (cancelled), alert → just returns. Silently
 * dropping the resolver instead parks the caller's `await` forever with no error
 * and no timeout, which is how a single-slot dialog turned a second ask into a
 * dead first caller (and, for the drag path, a half-finished move).
 */
function settleDismissed(s: DialogState): void {
  if (!s) return;
  if (s.kind === 'confirm') s.resolve(false);
  else if (s.kind === 'alert') s.resolve();
  else s.resolve(null);
}

interface ConfirmContextValue {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  alert: (opts: AlertOptions) => Promise<void>;
  prompt: (opts: PromptOptions) => Promise<string | null>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DialogState>(null);
  // The outstanding request, tracked at CALL time, not render time.
  //
  // The defect this replaces was NOT merely "one slot, no occupant check". It was
  // that the occupant was published by a RENDER-PHASE write (`stateRef.current =
  // state`), and a ref assigned during render cannot see a second event that
  // arrives in the same tick — no render has happened yet, so both asks read the
  // pre-render value (`null`), both called setState, the last write won, and the
  // first resolver became unreachable from every callback: its `await` parked
  // forever with no error, no rejection and no timeout. Generalise it: any pair of
  // same-tick events racing through a render-phase ref loses one of them, and the
  // loser is unreachable. Anything that must survive that race (a resolver, a
  // subscription, a queued item) belongs in a ref written where the EVENT happens.
  const pendingRef = useRef<DialogState>(null);
  const nextIdRef = useRef(0);

  // Show `next` as THE dialog. Single-visible-dialog UX is unchanged (latest ask
  // wins the screen, no stacked queue); what changes is that whatever it displaced
  // now settles instead of parking.
  const openRequest = useCallback((next: DialogRequest) => {
    const displaced = pendingRef.current;
    pendingRef.current = next;
    setState(next);
    // After the swap, so the displaced caller's continuation never observes a
    // half-installed provider.
    settleDismissed(displaced);
  }, []);

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      openRequest({ id: ++nextIdRef.current, kind: 'confirm', opts, resolve });
    });
  }, [openRequest]);

  const alert = useCallback((opts: AlertOptions) => {
    return new Promise<void>((resolve) => {
      openRequest({ id: ++nextIdRef.current, kind: 'alert', opts, resolve });
    });
  }, [openRequest]);

  const prompt = useCallback((opts: PromptOptions) => {
    return new Promise<string | null>((resolve) => {
      openRequest({ id: ++nextIdRef.current, kind: 'prompt', opts, resolve });
    });
  }, [openRequest]);

  // Close the visible dialog and settle its request exactly once. `value` is
  // supplied by the dialog only in prompt mode.
  const close = useCallback((answered: boolean, value?: string) => {
    const s = pendingRef.current;
    pendingRef.current = null;
    setState(null);
    if (!s) return;
    if (!answered) { settleDismissed(s); return; }
    if (s.kind === 'confirm') s.resolve(true);
    else if (s.kind === 'alert') s.resolve();
    else s.resolve(value ?? null);
  }, []);

  const handleConfirm = useCallback((value?: string) => close(true, value), [close]);
  const handleCancel = useCallback(() => close(false), [close]);

  // A provider that goes away (popout window closed, route torn down) must not
  // park its callers either — the awaiting code is usually mid-flow and would
  // never run its cleanup.
  useEffect(() => () => {
    const s = pendingRef.current;
    pendingRef.current = null;
    settleDismissed(s);
  }, []);

  return (
    <ConfirmContext.Provider value={{ confirm, alert, prompt }}>
      {children}
      {state && (
        <ConfirmDialog
          // Per-request key: a superseded dialog must not hand its internal state
          // (a prompt's typed text, the focus effect) to the request that replaced it.
          key={state.id}
          title={state.opts.title}
          message={state.opts.message}
          confirmLabel={
            state.kind === 'alert'
              ? (state.opts.okLabel ?? 'OK')
              : state.kind === 'prompt'
                ? (state.opts.confirmLabel ?? 'OK')
                : (state.opts.confirmLabel ?? 'Confirm')
          }
          cancelLabel={
            state.kind === 'confirm'
              ? (state.opts.cancelLabel ?? 'Cancel')
              : state.kind === 'prompt'
                ? (state.opts.cancelLabel ?? 'Cancel')
                : undefined
          }
          danger={state.kind === 'confirm' && !!state.opts.danger}
          promptDefaultValue={state.kind === 'prompt' ? (state.opts.defaultValue ?? '') : undefined}
          promptPlaceholder={state.kind === 'prompt' ? state.opts.placeholder : undefined}
          promptAllowEmpty={state.kind === 'prompt' && !!state.opts.allowEmpty}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      )}
    </ConfirmContext.Provider>
  );
}

function useConfirmContext(): ConfirmContextValue {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    // Fallback to native dialogs if a consumer is mounted outside the provider
    // (shouldn't happen — provider wraps the whole app + popouts).
    return {
      // eslint-disable-next-line no-alert
      confirm: async (opts) => window.confirm(opts.title),
      // eslint-disable-next-line no-alert
      alert: async (opts) => window.alert(opts.title),
      // eslint-disable-next-line no-alert
      prompt: async (opts) => window.prompt(opts.title, opts.defaultValue ?? ''),
    };
  }
  return ctx;
}

export function useConfirm(): (opts: ConfirmOptions) => Promise<boolean> {
  return useConfirmContext().confirm;
}

export function useAlert(): (opts: AlertOptions) => Promise<void> {
  return useConfirmContext().alert;
}

export function usePrompt(): (opts: PromptOptions) => Promise<string | null> {
  return useConfirmContext().prompt;
}
