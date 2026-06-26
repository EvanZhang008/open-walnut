import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
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

type DialogState =
  | { kind: 'confirm'; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: 'alert'; opts: AlertOptions; resolve: () => void }
  | { kind: 'prompt'; opts: PromptOptions; resolve: (v: string | null) => void }
  | null;

interface ConfirmContextValue {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  alert: (opts: AlertOptions) => Promise<void>;
  prompt: (opts: PromptOptions) => Promise<string | null>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DialogState>(null);
  // Keep the latest resolver reachable from the dialog callbacks without stale closures.
  const stateRef = useRef<DialogState>(null);
  stateRef.current = state;

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setState({ kind: 'confirm', opts, resolve });
    });
  }, []);

  const alert = useCallback((opts: AlertOptions) => {
    return new Promise<void>((resolve) => {
      setState({ kind: 'alert', opts, resolve });
    });
  }, []);

  const prompt = useCallback((opts: PromptOptions) => {
    return new Promise<string | null>((resolve) => {
      setState({ kind: 'prompt', opts, resolve });
    });
  }, []);

  // value is supplied by the dialog only in prompt mode.
  const handleConfirm = useCallback((value?: string) => {
    const s = stateRef.current;
    setState(null);
    if (s?.kind === 'confirm') s.resolve(true);
    else if (s?.kind === 'alert') s.resolve();
    else if (s?.kind === 'prompt') s.resolve(value ?? null);
  }, []);

  const handleCancel = useCallback(() => {
    const s = stateRef.current;
    setState(null);
    if (s?.kind === 'confirm') s.resolve(false);
    else if (s?.kind === 'alert') s.resolve();
    else if (s?.kind === 'prompt') s.resolve(null);
  }, []);

  return (
    <ConfirmContext.Provider value={{ confirm, alert, prompt }}>
      {children}
      {state && (
        <ConfirmDialog
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
