/**
 * Voice > Dictation model rows, shown once an engine is set up: the Whisper
 * catalog (Large v3 Turbo first, the rest behind "Show all models"), the one
 * Qwen3-ASR model, and the legacy sherpa-onnx catalog.
 */

import { useState, useEffect, useCallback } from 'react';
import type { Config } from '@open-walnut/core';
import {
  activateModel,
  deleteModel as apiDeleteModel,
  activateSherpaModel,
  deleteSherpaModel as apiDeleteSherpaModel,
  fetchSherpaModels,
  startSetup,
  type DetectionResult,
  type SetupEvent,
  MODEL_CATALOG,
  SHERPA_MODEL_CATALOG,
  MLX_MODEL,
  DEFAULT_MLX_MODEL,
} from '@/api/stt';
import { SettingsRow, SettingsTag } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { useOptimisticSetting } from '../inputs/useOptimisticSetting';
import { useCommitField } from '../inputs/useCommitField';
import { useSerialSave, type OnSave } from './GeneralSection';
import { refreshSttStatus } from '@/hooks/useSttStatus';
import { useConfirm } from '@/hooks/useConfirm';
import { clearSttSetupJob, startSttSetupJob, useSttSetupJob } from './stt-setup-job';

export function formatSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/** Active model name from the config path (`/path/ggml-base.en.bin` -> `ggml-base.en`). */
export function activeModelFromConfig(config: Config): string | null {
  const modelPath = config.stt?.whisper_server_model ?? config.stt?.whisper_cpp_model;
  if (!modelPath) return null;
  const filename = modelPath.split('/').pop() ?? '';
  return filename.endsWith('.bin') ? filename.slice(0, -4) : filename;
}

/** The sherpa model whose name the configured directory carries. */
function activeSherpaFromConfig(config: Config): string | null {
  const dir = config.stt?.sherpa_model_dir;
  if (!dir) return null;
  return SHERPA_MODEL_CATALOG.find((m) => dir.includes(m.name))?.name ?? null;
}

interface CatalogModel { name: string; displayName: string; description: string; sizeBytes: number; languageNote: string }

/** The Whisper model the one-button setup installs, and the only one shown by default. */
const WHISPER_DEFAULT = 'ggml-large-v3-turbo';

function ProgressBar({ percent }: { percent: number | null }) {
  return (
    <span className="settings-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
      <span className="settings-progress-track"><span className="settings-progress-fill" style={{ width: `${percent ?? 0}%` }} /></span>
      <span className="settings-progress-pct">{percent === null ? '' : `${percent}%`}</span>
    </span>
  );
}

/**
 * One row per catalog model: name, one line of facts, a status tag and the
 * one action that applies (Download / Activate + Delete). Download progress
 * is a bar inside the row, never a new box.
 */
function ModelCatalogRows({ models, downloaded, active, busy, onDownload, onActivate, onDelete }: {
  models: readonly CatalogModel[];
  downloaded: ReadonlySet<string>;
  active: string | null;
  busy: { downloading: string | null; percent: number | null; activating: string | null; deleting: string | null };
  onDownload: (name: string) => void;
  onActivate: (name: string) => void;
  onDelete: (name: string) => void;
}) {
  return (
    <>
      {models.map((m) => {
        const isActive = m.name === active;
        const isDownloaded = downloaded.has(m.name) || isActive;
        const isDownloading = busy.downloading === m.name;
        return (
          <SettingsRow
            key={m.name}
            indent
            // Not `stt-model-row`: that legacy class in globals.css stacks a
            // row in a column and centres its copy.
            className={`stt-catalog-row${isActive ? ' stt-catalog-row-active' : ''}`}
            data-testid={`stt-model-${m.name}`}
            label={m.displayName}
            help={`${m.description} (${formatSize(m.sizeBytes)}, ${m.languageNote})`}
            control={
              <span className="settings-control-cluster">
                {isActive && <SettingsTag tone="success">Active</SettingsTag>}
                {isDownloaded && !isActive && <SettingsTag>Downloaded</SettingsTag>}
                {isDownloading ? (
                  <ProgressBar percent={busy.percent} />
                ) : !isDownloaded ? (
                  <SettingsButton onClick={() => onDownload(m.name)} disabled={!!busy.downloading}>Download</SettingsButton>
                ) : !isActive ? (
                  <>
                    <SettingsButton variant="primary" busy={busy.activating === m.name} busyLabel="Activating..." disabled={!!busy.activating}
                      onClick={() => onActivate(m.name)}>
                      Activate
                    </SettingsButton>
                    <SettingsButton variant="danger" disabled={!!busy.deleting} onClick={() => onDelete(m.name)} aria-label={`Delete ${m.displayName}`}>
                      Delete
                    </SettingsButton>
                  </>
                ) : null}
              </span>
            }
          />
        );
      })}
    </>
  );
}

type Source = 'prebuilt' | 'manual';
const SOURCE_OPTIONS: { value: Source; label: string }[] = [
  { value: 'prebuilt', label: 'Pre-built' },
  { value: 'manual', label: 'Manual path' },
];

/** Shared download / activate / delete state for one model family. */
function useModelActions(kind: 'ggml' | 'sherpa', onRefresh: () => void, afterDownload?: () => Promise<void>) {
  const confirm = useConfirm();
  const [downloading, setDownloading] = useState<string | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const [activating, setActivating] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

  const download = async (name: string) => {
    setDownloading(name);
    setPercent(0);
    setError(null);
    try {
      await startSetup(kind === 'ggml' ? 'download_ggml_model' : 'download_sherpa_model', { model: name }, (event: SetupEvent) => {
        // A heartbeat without a percent (unknown size) keeps the last one.
        if (event.type === 'progress') setPercent((p) => event.percent ?? p);
        else if (event.type === 'done') setPercent(100);
        else if (event.type === 'error') setError(event.message ?? 'Download failed');
      });
      await afterDownload?.();
    } catch (err) {
      setError(message(err));
    } finally {
      setDownloading(null);
      onRefresh();
    }
  };
  const run = async (setBusy: (v: string | null) => void, name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
      refreshSttStatus();
      onRefresh();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  };
  const remove = async (name: string, what: string, fn: () => Promise<unknown>) => {
    if (!(await confirm({ title: `Delete model "${name}"?`, message: what, confirmLabel: 'Delete', danger: true }))) return;
    await run(setDeleting, name, fn);
  };
  return { busy: { downloading, percent, activating, deleting }, error, download, run, remove, setActivating };
}

export function WhisperModelRows({ detection, config, engine, onSave, onRefresh }: {
  detection: DetectionResult | null;
  config: Config;
  engine: 'whisper-cpp' | 'whisper-server';
  onSave: OnSave;
  onRefresh: () => void;
}) {
  const [source, setSource] = useState<Source>('prebuilt');
  const [showAll, setShowAll] = useState(false);
  const actions = useModelActions('ggml', onRefresh);
  const active = activeModelFromConfig(config);
  const downloaded = new Set(detection?.models.map((m) => m.name) ?? []);
  // Large v3 Turbo, plus whatever this Mac already has or uses; the rest on request.
  const visible = showAll
    ? MODEL_CATALOG
    : MODEL_CATALOG.filter((m) => m.name === WHISPER_DEFAULT || m.name === active || downloaded.has(m.name));
  const hidden = MODEL_CATALOG.length - visible.length;
  const pathKey = engine === 'whisper-server' ? 'whisper_server_model' : 'whisper_cpp_model';
  const save = useSerialSave(config, onSave);
  const manual = useCommitField<string>(
    config.stt?.[pathKey] ?? '',
    (v) => save((c) => ({ stt: { ...c.stt, [pathKey]: v.trim() || undefined } as Config['stt'] }), { rowKey: 'stt.manual-model' }),
    { rowKey: 'stt.manual-model', kind: 'text' },
  );
  return (
    <div className="stt-model-manager settings-rows-contents">
      <SettingsRow label="Whisper model" help="Models run on this Mac and are stored in ~/.local/share/whisper-cpp/." control={
        <SegmentedControl<Source> aria-label="Whisper model source" value={source} options={SOURCE_OPTIONS} onChange={setSource} />
      } />
      {source === 'prebuilt' ? (
        <>
          <ModelCatalogRows
            models={visible}
            downloaded={downloaded}
            active={active}
            busy={actions.busy}
            onDownload={(n) => void actions.download(n)}
            onActivate={(n) => void actions.run(actions.setActivating, n, () => activateModel(n, engine))}
            onDelete={(n) => void actions.remove(n, 'The file will be permanently removed.', () => apiDeleteModel(n))}
          />
          {(hidden > 0 || showAll) && (
            <SettingsRow indent className="stt-show-all-models" control={
              <SettingsButton variant="text" data-testid="stt-show-all-models" onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Show fewer models' : 'Show all models'}
              </SettingsButton>
            } />
          )}
        </>
      ) : (
        <SettingsRow indent wide label="Model file" help="Full path to a GGML model file." htmlFor="stt-manual-model" error={manual.error} control={
          <input id="stt-manual-model" type="text" className="settings-input settings-input--long settings-input--mono" spellCheck={false}
            placeholder="/path/to/ggml-base.en.bin" {...manual.inputProps} />
        } />
      )}
      {actions.error && <p className="settings-row-error settings-row-error-indent" role="alert">{actions.error}</p>}
    </div>
  );
}

/**
 * The Qwen3-ASR model: one row with its status (Not downloaded, Downloading,
 * Ready) and a Download button. The download runs as a setup job, so it keeps
 * going (and keeps its bar) across pane switches.
 */
export function QwenModelRow({ detection, config, onRefresh }: {
  detection: DetectionResult | null;
  config: Config;
  onRefresh: () => void;
}) {
  const job = useSttSetupJob();
  const running = job?.kind === 'model' ? job : null;
  const state = running?.states[0];
  const custom = config.stt?.mlx_model && config.stt.mlx_model !== DEFAULT_MLX_MODEL ? config.stt.mlx_model : null;
  useEffect(() => {
    if (running?.status !== 'done') return;
    clearSttSetupJob(running.id);
    onRefresh();
  }, [running?.status, running?.id, onRefresh]);
  if (custom) {
    return (
      <SettingsRow indent className="stt-catalog-row" data-testid="stt-model-qwen" label={custom}
        help="Set in config.yaml; it downloads on first use." control={<SettingsTag>Custom</SettingsTag>} />
    );
  }
  const cached = !!detection?.mlx?.modelCached;
  const failed = running?.status === 'failed';
  const download = () => startSttSetupJob({
    kind: 'model', engine: 'mlx',
    steps: [{ action: 'download_mlx_model', params: {}, label: `Download ${MLX_MODEL.displayName}` }],
  });
  return (
    <>
      <SettingsRow
        indent
        className={`stt-catalog-row${cached ? ' stt-catalog-row-active' : ''}`}
        data-testid="stt-model-qwen"
        label={MLX_MODEL.displayName}
        help={state?.status === 'running' && state.message ? state.message : `${MLX_MODEL.description} (${MLX_MODEL.sizeLabel}).`}
        control={
          <span className="settings-control-cluster">
            {state?.status === 'running' ? (
              <ProgressBar percent={state.percent} />
            ) : cached ? (
              <SettingsTag tone="success">Ready</SettingsTag>
            ) : (
              <>
                <SettingsTag>Not downloaded</SettingsTag>
                <SettingsButton onClick={download} disabled={!!job && job.status === 'running'}>Download</SettingsButton>
              </>
            )}
          </span>
        }
      />
      {failed && state && (
        <p className="settings-row-error settings-row-error-indent" role="alert">{state.message}</p>
      )}
    </>
  );
}

export function SherpaModelRows({ config, onSave, onRefresh }: { config: Config; onSave: OnSave; onRefresh: () => void }) {
  const [source, setSource] = useState<Source>('prebuilt');
  const [downloaded, setDownloaded] = useState<Set<string>>(new Set());
  const loadDownloaded = useCallback(async () => {
    const { models } = await fetchSherpaModels();
    setDownloaded(new Set(models.map((m) => m.name)));
  }, []);
  useEffect(() => { loadDownloaded().catch(() => {}); }, [loadDownloaded]);
  const actions = useModelActions('sherpa', () => { onRefresh(); loadDownloaded().catch(() => {}); }, loadDownloaded);
  const save = useSerialSave(config, onSave);
  const saveStt = (patch: Record<string, unknown>, rowKey: string) =>
    save((c) => ({ stt: { ...c.stt, ...patch } as Config['stt'] }), { rowKey });
  const dir = useCommitField<string>(
    config.stt?.sherpa_model_dir ?? '',
    (v) => saveStt({ sherpa_model_dir: v.trim() || undefined }, 'stt.sherpa-dir'),
    { rowKey: 'stt.sherpa-dir', kind: 'text' },
  );
  const type = useOptimisticSetting<string>(
    config.stt?.sherpa_model_type ?? 'sense_voice',
    (v) => saveStt({ sherpa_model_type: v }, 'stt.sherpa-type'),
    { rowKey: 'stt.sherpa-type' },
  );
  return (
    <div className="stt-model-manager settings-rows-contents">
      <SettingsRow label="sherpa-onnx model" help="Models run on this Mac and are stored in ~/.local/share/sherpa-onnx/." control={
        <SegmentedControl<Source> aria-label="sherpa-onnx model source" value={source} options={SOURCE_OPTIONS} onChange={setSource} />
      } />
      {source === 'prebuilt' ? (
        <ModelCatalogRows
          models={SHERPA_MODEL_CATALOG}
          downloaded={downloaded}
          active={activeSherpaFromConfig(config)}
          busy={actions.busy}
          onDownload={(n) => void actions.download(n)}
          onActivate={(n) => void actions.run(actions.setActivating, n, () => activateSherpaModel(n))}
          onDelete={(n) => void actions.remove(n, 'All model files will be removed.', async () => {
            await apiDeleteSherpaModel(n);
            setDownloaded((prev) => { const next = new Set(prev); next.delete(n); return next; });
          })}
        />
      ) : (
        <>
          <SettingsRow indent wide label="Model folder" htmlFor="stt-sherpa-manual-dir" error={dir.error} control={
            <input id="stt-sherpa-manual-dir" type="text" className="settings-input settings-input--long settings-input--mono" spellCheck={false}
              placeholder="~/.local/share/sherpa-onnx/my-model" {...dir.inputProps} />
          } />
          <SettingsRow indent label="Model type" htmlFor="stt-sherpa-manual-type" error={type.error} control={
            <select id="stt-sherpa-manual-type" className="settings-select" value={type.value} onChange={(e) => type.set(e.target.value)}>
              <option value="sense_voice">SenseVoice</option>
              <option value="whisper">Whisper</option>
              <option value="paraformer">Paraformer</option>
            </select>
          } />
        </>
      )}
      {actions.error && <p className="settings-row-error settings-row-error-indent" role="alert">{actions.error}</p>}
    </div>
  );
}
