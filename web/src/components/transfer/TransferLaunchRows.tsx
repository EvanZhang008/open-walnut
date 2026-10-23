/**
 * The Transfer dialog's launch rows: the new session's model and effort (one
 * pill that opens the same picker a new session uses, so the harness, model and
 * effort read the way they do everywhere else) and the permission mode it starts
 * in. Each starts on the source session's setting (on the same harness) and says
 * so with a "Now" tag.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SESSION_EFFORTS, SESSION_MODES } from '@open-walnut/core';
import type { SessionEffort, SessionMode } from '@open-walnut/core';
import type { TransferOptions, TransferSource } from '@/api/transfer';
import { ModelPicker } from '@/components/sessions/ModelPicker';
import { shortAcpModelName } from '@/components/sessions/acp-model-id';
import { useEngineCatalog } from '@/hooks/useEngineCatalog';
import { useEnabledModes } from '@/hooks/useEnabledModes';
import { engineCaps } from '@/utils/engine-capabilities';
import { formatModelName } from '@/utils/model-name';
import { blockedReason, launchDefaults, withEngine, type TransferForm } from './transfer-model';

const EFFORT_LABELS: Record<string, string> = Object.fromEntries(SESSION_EFFORTS.map((e) => [e.id, e.label]));

/** "Opus 5.5 1M · High", "Auto (Opus 5.5 1M)", "gpt-5 (high)": what the new session runs. */
export function launchLabel(form: TransferForm, acp: boolean, source?: TransferSource): string {
  // Auto on the source's own harness runs what the source runs: name it.
  const running = !form.model && source && form.engine === source.engine && source.runningModel
    ? (acp ? shortAcpModelName(source.runningModel) : formatModelName(source.runningModel))
    : '';
  const model = form.model
    ? (acp ? shortAcpModelName(form.model) : formatModelName(form.model))
    : running ? `Auto (${running})` : 'Auto';
  const effort = !acp && form.effort ? EFFORT_LABELS[form.effort] ?? form.effort : null;
  return effort ? `${model} · ${effort}` : model;
}

export function TransferLaunchRows({ options, source, form, onChange, group }: {
  options: TransferOptions;
  source: TransferSource;
  form: TransferForm;
  onChange: (patch: Partial<TransferForm>) => void;
  /** The dialog's labelled row (kept there so every row looks the same). */
  group: (label: string, children: ReactNode, wide?: boolean) => ReactNode;
}) {
  const catalog = useEngineCatalog();
  const enabledModes = useEnabledModes();
  const [open, setOpen] = useState(false);
  const pillRef = useRef<HTMLButtonElement | null>(null);
  // The dialog and the picker both close on Escape from a document listener, so one
  // press would close both: while the picker is open, take Escape first (window
  // capture runs before either) and close only the picker.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // The picker's model filter clears its text on the first Escape.
      const t = e.target as HTMLInputElement | null;
      if (t?.classList?.contains('model-picker-filter') && t.value) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);
  const acp = engineCaps(form.engine, catalog).providerModelCatalog;
  const defaults = launchDefaults(source, form.engine);
  const isDefault = (form.model ?? '') === (defaults.model ?? '') && (acp || (form.effort ?? '') === (defaults.effort ?? ''));
  // The modes the person has turned on, plus the source's own (it may be one they turned off).
  const modes = SESSION_MODES.filter((m) => enabledModes.includes(m.id) || m.id === source.permissionMode || m.id === form.permissionMode);

  return (
    <>
      {group('Model', (
        <>
          <button
            ref={pillRef}
            type="button"
            className={`xfer-opt xfer-model-pill${open ? ' is-checked' : ''}`}
            aria-haspopup="dialog"
            aria-expanded={open}
            title="Pick the model and reasoning effort the new session runs with"
            onClick={() => setOpen((v) => !v)}
            data-testid="xfer-model"
          >
            <span className="xfer-opt-line">
              <span className="xfer-opt-name">{launchLabel(form, acp, source)}</span>
              {isDefault && form.engine === source.engine && <span className="xfer-now">Now</span>}
              <span className="xfer-model-caret" aria-hidden="true">▾</span>
            </span>
            <span className="xfer-opt-sub">
              {form.engine === source.engine ? 'Starts on the current model and effort. Click to change.' : "Starts on the harness's default. Click to change."}
            </span>
          </button>
          {open && (
            <ModelPicker
              currentModel={acp ? undefined : form.model}
              currentEffort={acp ? undefined : form.effort as SessionEffort | undefined}
              host={form.host}
              cwd={source.cwd ?? undefined}
              engine={form.engine as Parameters<typeof ModelPicker>[0]['engine']}
              onSwitch={(model) => { setOpen(false); onChange({ model: model || undefined }); }}
              onEffortSwitch={acp ? undefined : (effort) => onChange({ effort })}
              onClose={() => setOpen(false)}
              onProviderSwitch={(provider) => onChange(withEngine(form, source, provider))}
              providerLockReason={(provider) => blockedReason(options, provider, form.host)
                ?? (options.engines.some((e) => e.id === provider) ? null : 'Not available for a transfer')}
              autoRow={{ resolvedLabel: '', active: !form.model }}
              acpCurrentModelId={acp ? form.model : undefined}
              onAcpSwitch={(modelId) => { setOpen(false); onChange({ model: modelId || undefined }); }}
              anchorRef={pillRef}
            />
          )}
        </>
      ), true)}
      {group('Permissions', modes.map((m) => (
        <button
          key={m.id}
          type="button"
          role="radio"
          aria-checked={form.permissionMode === m.id}
          className={`xfer-opt${form.permissionMode === m.id ? ' is-checked' : ''}`}
          title={m.description}
          onClick={() => onChange({ permissionMode: m.id as SessionMode })}
          data-testid={`xfer-perm-${m.id}`}
        >
          <span className="xfer-opt-line">
            <span className="xfer-opt-dot" aria-hidden="true" />
            <span className="xfer-opt-name">{m.label}</span>
            {source.permissionMode === m.id && <span className="xfer-now">Now</span>}
          </span>
        </button>
      )))}
    </>
  );
}
