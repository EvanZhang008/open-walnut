import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchCodexModelCatalog,
  setCodexSessionModel,
  type CodexModelInfo,
} from '@/api/sessions';
import { useNotifications } from '@/contexts/notifications';
import { log } from '@/utils/log';

interface CodexModelPickerProps {
  sessionId: string;
  currentModelId?: string;
  contextPercent?: number | null;
  onModelChange?: (modelId?: string) => void;
}

function shortModelName(modelId: string): string {
  return modelId
    .replace(/^(?:openai|codex|mock)[.:/_\s-]+/i, '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase() === 'gpt'
      ? 'GPT'
      : part.toLowerCase() === 'codex'
        ? 'Codex'
        : part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function CodexModelPicker({
  sessionId,
  currentModelId,
  contextPercent,
  onModelChange,
}: CodexModelPickerProps) {
  const { notify } = useNotifications();
  const rootRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<CodexModelInfo[]>([]);
  const [current, setCurrent] = useState(currentModelId);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState<string>();

  useEffect(() => {
    setCurrent(currentModelId);
  }, [currentModelId, sessionId]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    fetchCodexModelCatalog(sessionId)
      .then((catalog) => {
        if (cancelled) return;
        setModels(catalog.models);
        setCurrent(catalog.currentModelId);
      })
      .catch((error) => {
        if (cancelled) return;
        log.error('codex-model-picker', 'catalog fetch failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        notify({
          kind: 'operation-error',
          severity: 'error',
          title: 'Could not load Codex models',
          body: error instanceof Error ? error.message : String(error),
          persistent: false,
          dedupKey: `codex-model-catalog:${sessionId}:${Date.now()}`,
          sessionId,
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, notify, sessionId]);

  const selected = useMemo(
    () => models.find((model) => model.modelId === current),
    [current, models],
  );
  const label = selected?.name
    ? shortModelName(selected.name)
    : current ? shortModelName(current) : 'Codex';

  const switchModel = async (modelId: string) => {
    if (modelId === current || switching) {
      setOpen(false);
      return;
    }
    const previous = current;
    setCurrent(modelId);
    setSwitching(modelId);
    onModelChange?.(modelId);
    try {
      await setCodexSessionModel(sessionId, modelId);
      setOpen(false);
    } catch (error) {
      setCurrent(previous);
      onModelChange?.(previous);
      log.error('codex-model-picker', 'model switch failed', {
        sessionId,
        modelId,
        error: error instanceof Error ? error.message : String(error),
      });
      notify({
        kind: 'operation-error',
        severity: 'error',
        title: 'Codex model switch failed',
        body: error instanceof Error ? error.message : String(error),
        persistent: false,
        dedupKey: `codex-model-switch:${sessionId}:${Date.now()}`,
        sessionId,
      });
    } finally {
      setSwitching(undefined);
    }
  };

  return (
    <span className="codex-model-picker" ref={rootRef}>
      <button
        type="button"
        className="session-detail-model-pill session-detail-model-pill-clickable"
        title="Switch Codex model"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
        {contextPercent != null && (
          <span className="session-detail-context-pct"> {contextPercent}%</span>
        )}
      </button>
      {open && (
        <span className="codex-model-menu" role="listbox" aria-label="Codex models">
          {loading && <span className="codex-model-menu-status">Loading models...</span>}
          {!loading && models.length === 0 && (
            <span className="codex-model-menu-status">No models available</span>
          )}
          {!loading && models.map((model) => {
            const active = model.modelId === current;
            return (
              <button
                type="button"
                role="option"
                aria-selected={active}
                className={`codex-model-option${active ? ' codex-model-option-active' : ''}`}
                key={model.modelId}
                disabled={Boolean(switching)}
                onClick={() => { void switchModel(model.modelId); }}
              >
                <span className="codex-model-option-check" aria-hidden>{active ? '\u2713' : ''}</span>
                <span className="codex-model-option-copy">
                  <span className="codex-model-option-name">{model.name}</span>
                  {model.description && (
                    <span className="codex-model-option-description">{model.description}</span>
                  )}
                </span>
              </button>
            );
          })}
        </span>
      )}
    </span>
  );
}
