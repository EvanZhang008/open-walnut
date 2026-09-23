/**
 * Voice > Dictation rows: the engine, what this Mac has for it (install,
 * models), the engine's own fields and the language hint. Everything here is
 * rows of the Dictation group; the section's Save button commits the drafts
 * (language, OpenAI-compatible fields), while an engine pick, a model
 * activation and a manual model path save at once.
 */

import { useState, useEffect, useCallback } from 'react';
import type { Config } from '@open-walnut/core';
import {
  fetchSttDetection,
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
} from '@/api/stt';
import { SettingsRow, SettingsTag } from '../SettingsSection';
import { sttScanSummary } from './stt-scan-summary';
import { SettingsButton } from '../inputs/SettingsButton';
import { SecretInput } from '../inputs/SecretInput';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { useOptimisticSetting } from '../inputs/useOptimisticSetting';
import { useCommitField } from '../inputs/useCommitField';
import { SttSetupProgress } from './SttSetupProgress';
import { useSerialSave, type OnSave } from './GeneralSection';
import { invalidateSttStatusCache } from '@/hooks/useSttStatus';
import { useConfirm } from '@/hooks/useConfirm';

/** Concurrent mounts share one scan in flight: Voice asks once per open (N27). */
let detectInflight: ReturnType<typeof fetchSttDetection> | null = null;
function detectOnce(): ReturnType<typeof fetchSttDetection> {
  if (detectInflight) return detectInflight;
  const p = fetchSttDetection().finally(() => { if (detectInflight === p) detectInflight = null; });
  detectInflight = p;
  return p;
}

// 'mlx' has no setup rows yet (configured via config.yaml stt.mlx_*), but the
// panel must still accept it as the active engine.
export type SttEngine = 'whisper-cpp' | 'whisper-server' | 'sherpa-onnx' | 'openai' | 'mlx';

interface EngineOption {
  value: SttEngine;
  label: string;
  badge: 'Local' | 'API';
  description: string;
  recommended?: boolean;
}

export const ENGINE_OPTIONS: EngineOption[] = [
  { value: 'whisper-server', label: 'Whisper Server', badge: 'Local', description: 'Keeps the model in memory, so repeat calls are fast.', recommended: true },
  { value: 'whisper-cpp', label: 'Whisper CLI', badge: 'Local', description: 'Starts fresh each call; simpler and lighter on memory.' },
  { value: 'sherpa-onnx', label: 'sherpa-onnx', badge: 'Local', description: 'SenseVoice and Paraformer models, tuned for Chinese.' },
  { value: 'openai', label: 'OpenAI-compatible', badge: 'API', description: 'OpenAI, Groq or Fireworks; nothing runs on this Mac.' },
];

const OPENAI_PRESETS = [
  { value: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' },
  { value: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo' },
  { value: 'fireworks', label: 'Fireworks', baseUrl: 'https://api.fireworks.ai/inference/v1', model: 'whisper-v3' },
];

const LANGUAGES: Array<[string, string]> = [
  ['', 'Auto-detect'], ['en', 'English'], ['zh', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean'],
  ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['pt', 'Portuguese'], ['ru', 'Russian'], ['ar', 'Arabic'],
];

/** Fields the section's Save button commits. */
export interface SttDraft {
  language: string;
  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiModel: string;
}

export function sttDraftOf(config: Config): SttDraft {
  return {
    language: config.stt?.language ?? '',
    openaiApiKey: config.stt?.openai_api_key ?? '',
    openaiBaseUrl: config.stt?.openai_base_url ?? 'https://api.openai.com/v1',
    openaiModel: config.stt?.openai_model ?? 'whisper-1',
  };
}

export function formatSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/** Active model name from the config path (`/path/ggml-base.en.bin` -> `ggml-base.en`). */
function activeModelFromConfig(config: Config): string | null {
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

/**
 * One row per catalog model: name, one line of facts, a status tag and the
 * one action that applies (Download / Activate + Delete). Download progress
 * is a bar inside the row, never a new box.
 */
function ModelCatalogRows({ models, downloaded, active, busy, onDownload, onActivate, onDelete }: {
  models: readonly CatalogModel[];
  downloaded: ReadonlySet<string>;
  active: string | null;
  busy: { downloading: string | null; percent: number; activating: string | null; deleting: string | null };
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
                  <span className="settings-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={busy.percent}>
                    <span className="settings-progress-track"><span className="settings-progress-fill" style={{ width: `${busy.percent}%` }} /></span>
                    <span className="settings-progress-pct">{busy.percent}%</span>
                  </span>
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
  const [percent, setPercent] = useState(0);
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
        if (event.type === 'progress') setPercent(event.percent ?? 0);
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
      invalidateSttStatusCache();
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

function WhisperModelRows({ detection, config, engine, onSave, onRefresh }: {
  detection: DetectionResult | null;
  config: Config;
  engine: 'whisper-cpp' | 'whisper-server';
  onSave: OnSave;
  onRefresh: () => void;
}) {
  const [source, setSource] = useState<Source>('prebuilt');
  const actions = useModelActions('ggml', onRefresh);
  const active = activeModelFromConfig(config);
  const downloaded = new Set(detection?.models.map((m) => m.name) ?? []);
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
        <ModelCatalogRows
          models={MODEL_CATALOG}
          downloaded={downloaded}
          active={active}
          busy={actions.busy}
          onDownload={(n) => void actions.download(n)}
          onActivate={(n) => void actions.run(actions.setActivating, n, () => activateModel(n, engine))}
          onDelete={(n) => void actions.remove(n, 'The file will be permanently removed.', () => apiDeleteModel(n))}
        />
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

function SherpaModelRows({ config, onSave, onRefresh }: { config: Config; onSave: OnSave; onRefresh: () => void }) {
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

interface Props {
  config: Config;
  onSave: OnSave;
  onConfigured: () => void;
  draft: SttDraft;
  onDraft: (patch: Partial<SttDraft>) => void;
}

export function SttDetectionPanel({ config, onSave, onConfigured, draft, onDraft }: Props) {
  const [detection, setDetection] = useState<DetectionResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installSteps, setInstallSteps] = useState<{ action: string; params: Record<string, string>; label: string }[] | null>(null);
  const save = useSerialSave(config, onSave);

  const engineSetting = useOptimisticSetting<SttEngine | ''>(
    (config.stt?.engine as SttEngine | undefined) ?? '',
    async (e) => {
      await save((c) => ({ stt: { ...c.stt, engine: e || undefined } as Config['stt'] }), { rowKey: 'stt.engine' });
      invalidateSttStatusCache();
      onConfigured();
    },
    { rowKey: 'stt.engine' },
  );
  const engine = engineSetting.value || null;

  const runDetection = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDetection(await detectOnce());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void runDetection(); }, [runDetection]);

  const installWhisper = () => {
    const steps: { action: string; params: Record<string, string>; label: string }[] = [];
    if (!detection?.ffmpeg.found) steps.push({ action: 'install_brew_pkg', params: { pkg: 'ffmpeg' }, label: 'Install ffmpeg' });
    // whisper-server ships in the whisper-cpp brew formula.
    const missing = engine === 'whisper-server' ? !detection?.whisperServer?.found : !detection?.whisperCli.found;
    if (missing) steps.push({ action: 'install_brew_pkg', params: { pkg: 'whisper-cpp' }, label: 'Install whisper-cpp' });
    if (steps.length > 0) setInstallSteps(steps);
  };

  const installDone = async () => {
    setInstallSteps(null);
    setLoading(true);
    // The binary may not be visible on PATH at once: retry the scan.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        setDetection(await fetchSttDetection());
        setError(null);
        setLoading(false);
        return;
      } catch {
        if (attempt < 2) await new Promise((r) => setTimeout(r, 500));
      }
    }
    void runDetection();
  };

  const isWhisper = engine === 'whisper-cpp' || engine === 'whisper-server';
  const binaryName = engine === 'whisper-server' ? 'whisper-server' : 'whisper-cli';
  const binaryReady = engine === 'whisper-cpp' ? detection?.whisperCli.found : engine === 'whisper-server' ? detection?.whisperServer?.found : false;
  const selected = ENGINE_OPTIONS.find((o) => o.value === engine);
  const preset = OPENAI_PRESETS.find((p) => p.baseUrl === draft.openaiBaseUrl)?.value ?? '';
  const refresh = () => { void runDetection(); onConfigured(); };

  return (
    <div className="stt-detection-panel settings-rows-contents">
      <SettingsRow
        label="Engine"
        htmlFor="stt-engine"
        help={selected?.description ?? 'Pick how dictation turns speech into text.'}
        error={engineSetting.error}
        className="stt-service-dropdown"
        control={
          <span className="settings-control-cluster">
            {selected && <SettingsTag>{selected.badge}</SettingsTag>}
            {selected?.recommended && <SettingsTag tone="success">Recommended</SettingsTag>}
            <select
              id="stt-engine"
              data-testid="stt-engine-select"
              className="settings-select"
              value={engineSetting.value}
              onChange={(e) => engineSetting.set(e.target.value as SttEngine)}
            >
              {!engine && <option value="">Choose an engine</option>}
              <optgroup label="On this Mac">
                {ENGINE_OPTIONS.filter((o) => o.badge === 'Local').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </optgroup>
              <optgroup label="Cloud">
                {ENGINE_OPTIONS.filter((o) => o.badge === 'API').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </optgroup>
              {engine === 'mlx' && <option value="mlx">MLX (set in config.yaml)</option>}
            </select>
          </span>
        }
      />

      {/* One row for the scan: its line changes in place, so nothing below moves (N3-05). */}
      <SettingsRow
        label="This Mac"
        className="stt-scan-row"
        data-testid="stt-scan-row"
        state={error && !loading ? 'warning' : undefined}
        help={
          <span className="stt-scan-status" data-scan={loading ? 'scanning' : error ? 'failed' : 'done'}>
            {loading ? 'Scanning this Mac...' : error ? `Couldn't scan this Mac: ${error}` : detection ? sttScanSummary(detection) : ''}
          </span>
        }
        control={!loading && error ? <SettingsButton variant="text" onClick={() => void runDetection()}>Retry</SettingsButton> : undefined}
      />

      {!loading && isWhisper && detection && !binaryReady && (
        <SettingsRow
          indent
          className="stt-install-banner"
          state="warning"
          label={`${binaryName} is not installed.`}
          help={detection.homebrew.found ? 'Walnut can install it with Homebrew.' : 'Install Homebrew first, then retry.'}
          control={detection.homebrew.found && !installSteps ? (
            <SettingsButton variant="primary" onClick={installWhisper}>Install via Homebrew</SettingsButton>
          ) : undefined}
        />
      )}

      {installSteps && <SttSetupProgress steps={installSteps} onComplete={() => void installDone()} onCancel={() => setInstallSteps(null)} />}

      {isWhisper && binaryReady && (
        <WhisperModelRows detection={detection} config={config} engine={engine as 'whisper-cpp' | 'whisper-server'} onSave={onSave} onRefresh={refresh} />
      )}

      {engine === 'openai' && (
        <>
          <SettingsRow indent label="Service" control={
            <SegmentedControl<string>
              aria-label="Service preset"
              value={preset}
              options={OPENAI_PRESETS.map((p) => ({ value: p.value, label: p.label, testId: `stt-preset-${p.value}` }))}
              onChange={(v) => {
                const p = OPENAI_PRESETS.find((x) => x.value === v);
                if (p) onDraft({ openaiBaseUrl: p.baseUrl, openaiModel: p.model });
              }}
            />
          } />
          <SettingsRow indent label="API key" htmlFor="stt-openai-key" control={
            <SecretInput id="stt-openai-key" value={draft.openaiApiKey} onChange={(v) => onDraft({ openaiApiKey: v })} placeholder="sk-... or ${env:OPENAI_API_KEY}" />
          } />
          <SettingsRow indent wide label="Base URL" htmlFor="stt-openai-url" control={
            <input id="stt-openai-url" type="text" className="settings-input settings-input--long settings-input--mono" spellCheck={false}
              value={draft.openaiBaseUrl} onChange={(e) => onDraft({ openaiBaseUrl: e.target.value })} />
          } />
          <SettingsRow indent wide label="Transcription model" htmlFor="stt-openai-model" control={
            <input id="stt-openai-model" type="text" className="settings-input settings-input--long settings-input--mono" spellCheck={false}
              value={draft.openaiModel} onChange={(e) => onDraft({ openaiModel: e.target.value })} />
          } />
        </>
      )}

      {engine === 'sherpa-onnx' && <SherpaModelRows config={config} onSave={onSave} onRefresh={refresh} />}

      {engine && (
        <SettingsRow label="Language" help="A hint only; auto-detect works for most speech." htmlFor="stt-language" control={
          <select id="stt-language" className="settings-select" value={draft.language} onChange={(e) => onDraft({ language: e.target.value })}>
            {LANGUAGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        } />
      )}

    </div>
  );
}
