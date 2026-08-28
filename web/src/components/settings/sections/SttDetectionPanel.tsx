/**
 * STT Settings panel — Whispering-style UI.
 *
 * - Transcription Service dropdown (grouped Local/Cloud)
 * - Whisper Model manager (download, activate, delete)
 * - Engine-specific config forms (OpenAI, sherpa-onnx)
 */

import { useState, useEffect, useRef, useCallback } from 'react';
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
  type GgmlModel,
  type SetupEvent,
  MODEL_CATALOG,
  SHERPA_MODEL_CATALOG,
} from '@/api/stt';
import { SttSetupProgress } from './SttSetupProgress';
import { invalidateSttStatusCache } from '@/hooks/useSttStatus';
import { useConfirm } from '@/hooks/useConfirm';

// ── Types ──────────────────────────────────────────────

// 'mlx' has no setup card yet — it's configured via config.yaml (stt.mlx_*),
// but the panel must still accept it as the active engine without a type error.
type SttEngine = 'whisper-cpp' | 'whisper-server' | 'sherpa-onnx' | 'openai' | 'mlx';

interface EngineOption {
  value: SttEngine;
  icon: string;
  label: string;
  badge: string;
  description: string;
  features: string[];
  group: 'local' | 'cloud';
  recommended?: boolean;
}

const ENGINE_OPTIONS: EngineOption[] = [
  { value: 'whisper-server', icon: '\u26A1', label: 'Whisper Server', badge: 'Local', description: 'Model stays in memory — fast repeat calls', features: ['Persistent daemon', 'Sub-second latency', 'GPU accelerated'], group: 'local', recommended: true },
  { value: 'whisper-cpp', icon: '\uD83D\uDD0A', label: 'Whisper CLI', badge: 'Local', description: 'Cold-start each call (simpler, more RAM-friendly)', features: ['No background process', 'Lower RAM usage'], group: 'local' },
  { value: 'sherpa-onnx', icon: '\uD83E\uDDE0', label: 'sherpa-onnx', badge: 'Local', description: 'SenseVoice / Paraformer models', features: ['Non-Whisper models', 'Chinese-optimized'], group: 'local' },
  { value: 'openai', icon: '\uD83C\uDF10', label: 'OpenAI-compatible', badge: 'API', description: 'OpenAI / Groq / Fireworks', features: ['No local compute', 'Cloud-hosted'], group: 'cloud' },
];

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
  onConfigured: () => void;
}

// ── Helpers ────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/** Get active model name from config path (e.g. "/path/to/ggml-base.en.bin" → "ggml-base.en") */
function activeModelFromConfig(config: Config): string | null {
  const modelPath = config.stt?.whisper_server_model ?? config.stt?.whisper_cpp_model;
  if (!modelPath) return null;
  const filename = modelPath.split('/').pop() ?? '';
  return filename.endsWith('.bin') ? filename.slice(0, -4) : filename;
}

// ── TranscriptionServiceDropdown ───────────────────────

function TranscriptionServiceDropdown({
  engine,
  detection,
  onChange,
}: {
  engine: SttEngine | null;
  detection: DetectionResult | null;
  onChange: (e: SttEngine) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const selected = ENGINE_OPTIONS.find(o => o.value === engine);
  const localEngines = ENGINE_OPTIONS.filter(o => o.group === 'local');
  const cloudEngines = ENGINE_OPTIONS.filter(o => o.group === 'cloud');

  return (
    <div className="stt-service-dropdown" ref={ref}>
      <label className="stt-dropdown-label">Transcription Service</label>
      <button
        type="button"
        className="stt-dropdown-trigger"
        onClick={() => setOpen(!open)}
      >
        {selected ? (
          <span className="stt-dropdown-selected">
            <span className="stt-dropdown-icon">{selected.icon}</span>
            <span>{selected.label}</span>
            <span className={`stt-badge stt-badge-${selected.group === 'local' ? 'local' : 'cloud'}`}>
              {selected.badge}
            </span>
            {selected.recommended && <span className="stt-badge stt-badge-recommended">Recommended</span>}
          </span>
        ) : (
          <span className="text-muted">Select an engine...</span>
        )}
        <span className="stt-dropdown-chevron">{open ? '\u25B2' : '\u25BC'}</span>
      </button>

      {open && (
        <div className="stt-dropdown-menu">
          <div className="stt-dropdown-group-label">Local (Offline)</div>
          {localEngines.map(opt => (
            <button
              key={opt.value}
              type="button"
              className={`stt-dropdown-option ${engine === opt.value ? 'stt-dropdown-option-active' : ''}`}
              onClick={() => { onChange(opt.value); setOpen(false); }}
            >
              <span className="stt-dropdown-icon">{opt.icon}</span>
              <span className="stt-dropdown-option-body">
                <span className="stt-dropdown-option-name">
                  {opt.label}
                  <span className={`stt-badge stt-badge-local`}>{opt.badge}</span>
                  {opt.recommended && <span className="stt-badge stt-badge-recommended">Recommended</span>}
                </span>
                <span className="stt-dropdown-option-desc">{opt.description}</span>
                <span className="stt-dropdown-option-features">
                  {opt.features.map(f => <span key={f} className="stt-feature-tag">{f}</span>)}
                </span>
              </span>
              {engine === opt.value && <span className="stt-dropdown-check">{'\u2713'}</span>}
            </button>
          ))}
          <div className="stt-dropdown-divider" />
          <div className="stt-dropdown-group-label">Cloud (API)</div>
          {cloudEngines.map(opt => (
            <button
              key={opt.value}
              type="button"
              className={`stt-dropdown-option ${engine === opt.value ? 'stt-dropdown-option-active' : ''}`}
              onClick={() => { onChange(opt.value); setOpen(false); }}
            >
              <span className="stt-dropdown-icon">{opt.icon}</span>
              <span className="stt-dropdown-option-body">
                <span className="stt-dropdown-option-name">
                  {opt.label}
                  <span className="stt-badge stt-badge-cloud">{opt.badge}</span>
                </span>
                <span className="stt-dropdown-option-desc">{opt.description}</span>
                <span className="stt-dropdown-option-features">
                  {opt.features.map(f => <span key={f} className="stt-feature-tag">{f}</span>)}
                </span>
              </span>
              {engine === opt.value && <span className="stt-dropdown-check">{'\u2713'}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── WhisperModelManager ────────────────────────────────

function WhisperModelManager({
  detection,
  config,
  engine: whisperEngine,
  onRefresh,
}: {
  detection: DetectionResult | null;
  config: Config;
  engine: 'whisper-cpp' | 'whisper-server';
  onRefresh: () => void;
}) {
  const [tab, setTab] = useState<'prebuilt' | 'manual'>('prebuilt');
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadMsg, setDownloadMsg] = useState('');
  const [activating, setActivating] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualPath, setManualPath] = useState(config.stt?.whisper_cpp_model ?? '');
  const confirm = useConfirm();

  const downloadedNames = new Set(detection?.models.map(m => m.name) ?? []);
  const activeModel = activeModelFromConfig(config);
  // Active model is always considered downloaded (config knows about it)
  if (activeModel) downloadedNames.add(activeModel);

  const handleDownload = async (modelName: string) => {
    setDownloading(modelName);
    setDownloadProgress(0);
    setDownloadMsg('Starting...');
    setError(null);

    try {
      await startSetup(
        'download_ggml_model',
        { model: modelName },
        (event: SetupEvent) => {
          if (event.type === 'progress') {
            setDownloadProgress(event.percent ?? 0);
            setDownloadMsg(event.message ?? '');
          } else if (event.type === 'done') {
            setDownloadProgress(100);
            setDownloadMsg('Done');
          } else if (event.type === 'error') {
            setError(event.message ?? 'Download failed');
          }
        },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(null);
      onRefresh();
    }
  };

  const handleActivate = async (modelName: string) => {
    setActivating(modelName);
    setError(null);
    try {
      await activateModel(modelName, whisperEngine);
      invalidateSttStatusCache();
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActivating(null);
    }
  };

  const handleDelete = async (modelName: string) => {
    if (!(await confirm({ title: `Delete model “${modelName}”?`, message: 'The file will be permanently removed.', confirmLabel: 'Delete', danger: true }))) return;
    setDeleting(modelName);
    setError(null);
    try {
      await apiDeleteModel(modelName);
      invalidateSttStatusCache();
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="stt-model-manager">
      <div className="stt-model-header">
        <h4>Whisper Model</h4>
        <p className="text-sm text-muted">Select a pre-built model. Models run locally.</p>
      </div>

      <div className="stt-model-tabs">
        <button
          type="button"
          className={`stt-model-tab ${tab === 'prebuilt' ? 'stt-model-tab-active' : ''}`}
          onClick={() => setTab('prebuilt')}
        >
          Pre-built Models
        </button>
        <button
          type="button"
          className={`stt-model-tab ${tab === 'manual' ? 'stt-model-tab-active' : ''}`}
          onClick={() => setTab('manual')}
        >
          Manual Path
        </button>
      </div>

      {tab === 'prebuilt' && (
        <div className="stt-model-list">
          {MODEL_CATALOG.map(m => {
            const isDownloaded = downloadedNames.has(m.name);
            const isActive = m.name === activeModel;
            const isDownloading = downloading === m.name;

            return (
              <div key={m.name} className={`stt-model-row ${isActive ? 'stt-model-row-active' : ''}`}>
                <div className="stt-model-row-top">
                  <span className="stt-model-name">{m.displayName}</span>
                  {isActive && <span className="stt-badge stt-badge-active">Active</span>}
                  {isDownloaded && !isActive && <span className="stt-badge stt-badge-downloaded">Downloaded</span>}
                  <span className="stt-model-actions">
                    {isDownloading ? (
                      <span className="stt-model-downloading">
                        <span className="stt-model-download-pct">{downloadProgress}%</span>
                      </span>
                    ) : !isDownloaded ? (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => handleDownload(m.name)}
                        disabled={!!downloading}
                      >
                        Download
                      </button>
                    ) : isActive ? (
                      <span className="stt-model-activated">{'\u2713'} Activated</span>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          onClick={() => handleActivate(m.name)}
                          disabled={!!activating}
                        >
                          {activating === m.name ? '...' : 'Activate'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm stt-model-delete-btn"
                          onClick={() => handleDelete(m.name)}
                          disabled={!!deleting}
                          title="Delete model"
                        >
                          {'\u00D7'}
                        </button>
                      </>
                    )}
                  </span>
                </div>
                <div className="stt-model-row-bottom">
                  <span className="stt-model-desc">{m.description}</span>
                  <span className="stt-model-meta">{formatSize(m.sizeBytes)} · {m.languageNote}</span>
                </div>
                {isDownloading && (
                  <div className="stt-progress-bar-track" style={{ marginLeft: 0 }}>
                    <div className="stt-progress-bar-fill" style={{ width: `${downloadProgress}%` }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {tab === 'manual' && (
        <div className="stt-manual-path">
          <label htmlFor="stt-manual-model">Model file path</label>
          <input
            id="stt-manual-model"
            type="text"
            value={manualPath}
            onChange={(e) => setManualPath(e.target.value)}
            placeholder="/path/to/ggml-base.en.bin"
          />
          <p className="text-sm text-muted">Full path to a GGML model file.</p>
        </div>
      )}

      {error && <p className="text-sm" style={{ color: 'var(--error)', marginTop: 8 }}>{error}</p>}

      <p className="text-sm text-muted" style={{ marginTop: 10 }}>
        Models from Hugging Face, stored in ~/.local/share/whisper-cpp/
      </p>
    </div>
  );
}

// ── SherpaModelManager ─────────────────────────────────

function SherpaModelManager({
  config,
  onRefresh,
}: {
  config: Config;
  onRefresh: () => void;
}) {
  const [tab, setTab] = useState<'prebuilt' | 'manual'>('prebuilt');
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [activating, setActivating] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloadedNames, setDownloadedNames] = useState<Set<string>>(new Set());
  const confirm = useConfirm();
  const [manualDir, setManualDir] = useState(config.stt?.sherpa_model_dir ?? '');
  const [manualType, setManualType] = useState(config.stt?.sherpa_model_type ?? 'sense_voice');

  // Get active sherpa model name from config
  const activeSherpaModel = (() => {
    const dir = config.stt?.sherpa_model_dir;
    if (!dir) return null;
    const match = SHERPA_MODEL_CATALOG.find(m => dir.includes(m.name) || dir.endsWith(m.name.replace('sense-voice-zh-en', 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17')));
    // Match by dirName embedded in the path
    for (const m of SHERPA_MODEL_CATALOG) {
      if (dir.includes(m.name) || dir.endsWith('/' + m.name)) return m.name;
      // Check the actual directory name from the catalog
      const catEntry = SHERPA_MODEL_CATALOG.find(c => c.name === m.name);
      if (catEntry) {
        // We need to compare the dir ending with the dirName from server catalog
        // Since we don't have dirName on client, match by name patterns
        if (m.name === 'sense-voice-zh-en' && dir.includes('sense-voice-zh-en')) return m.name;
        if (m.name === 'paraformer-zh' && dir.includes('paraformer-zh')) return m.name;
        if (m.name === 'whisper-tiny.en' && dir.includes('whisper-tiny.en')) return m.name;
        if (m.name === 'whisper-base.en' && dir.includes('whisper-base.en')) return m.name;
      }
    }
    return null;
  })();

  // Load downloaded sherpa models
  useEffect(() => {
    fetchSherpaModels().then(({ models }) => {
      setDownloadedNames(new Set(models.map(m => m.name)));
    }).catch(() => {});
  }, []);

  const handleDownload = async (modelName: string) => {
    setDownloading(modelName);
    setDownloadProgress(0);
    setError(null);
    try {
      await startSetup(
        'download_sherpa_model',
        { model: modelName },
        (event: SetupEvent) => {
          if (event.type === 'progress') setDownloadProgress(event.percent ?? 0);
          else if (event.type === 'done') setDownloadProgress(100);
          else if (event.type === 'error') setError(event.message ?? 'Download failed');
        },
      );
      // Refresh downloaded list
      const { models } = await fetchSherpaModels();
      setDownloadedNames(new Set(models.map(m => m.name)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(null);
      onRefresh();
    }
  };

  const handleActivate = async (modelName: string) => {
    setActivating(modelName);
    setError(null);
    try {
      await activateSherpaModel(modelName);
      invalidateSttStatusCache();
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActivating(null);
    }
  };

  const handleDelete = async (modelName: string) => {
    if (!(await confirm({ title: `Delete model “${modelName}”?`, message: 'All model files will be removed.', confirmLabel: 'Delete', danger: true }))) return;
    setDeleting(modelName);
    setError(null);
    try {
      await apiDeleteSherpaModel(modelName);
      setDownloadedNames(prev => { const next = new Set(prev); next.delete(modelName); return next; });
      invalidateSttStatusCache();
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="stt-model-manager">
      <div className="stt-model-header">
        <h4>sherpa-onnx Model</h4>
        <p className="text-sm text-muted">Select a model. Models run locally via sherpa-onnx.</p>
      </div>

      <div className="stt-model-tabs">
        <button type="button" className={`stt-model-tab ${tab === 'prebuilt' ? 'stt-model-tab-active' : ''}`} onClick={() => setTab('prebuilt')}>Pre-built Models</button>
        <button type="button" className={`stt-model-tab ${tab === 'manual' ? 'stt-model-tab-active' : ''}`} onClick={() => setTab('manual')}>Manual Path</button>
      </div>

      {tab === 'prebuilt' && (
        <div className="stt-model-list">
          {SHERPA_MODEL_CATALOG.map(m => {
            const isDownloaded = downloadedNames.has(m.name);
            const isActive = m.name === activeSherpaModel;
            const isDownloading = downloading === m.name;
            // Active = downloaded
            const effectiveDownloaded = isDownloaded || isActive;

            return (
              <div key={m.name} className={`stt-model-row ${isActive ? 'stt-model-row-active' : ''}`}>
                <div className="stt-model-row-top">
                  <span className="stt-model-name">{m.displayName}</span>
                  {isActive && <span className="stt-badge stt-badge-active">Active</span>}
                  {effectiveDownloaded && !isActive && <span className="stt-badge stt-badge-downloaded">Downloaded</span>}
                  <span className="stt-model-actions">
                    {isDownloading ? (
                      <span className="stt-model-downloading"><span className="stt-model-download-pct">{downloadProgress}%</span></span>
                    ) : !effectiveDownloaded ? (
                      <button type="button" className="btn btn-sm" onClick={() => handleDownload(m.name)} disabled={!!downloading}>Download</button>
                    ) : isActive ? (
                      <span className="stt-model-activated">{'\u2713'} Activated</span>
                    ) : (
                      <>
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => handleActivate(m.name)} disabled={!!activating}>{activating === m.name ? '...' : 'Activate'}</button>
                        <button type="button" className="btn btn-sm stt-model-delete-btn" onClick={() => handleDelete(m.name)} disabled={!!deleting} title="Delete model">{'\u00D7'}</button>
                      </>
                    )}
                  </span>
                </div>
                <div className="stt-model-row-bottom">
                  <span className="stt-model-desc">{m.description}</span>
                  <span className="stt-model-meta">{formatSize(m.sizeBytes)} · {m.languageNote}</span>
                </div>
                {isDownloading && (
                  <div className="stt-progress-bar-track" style={{ marginLeft: 0 }}>
                    <div className="stt-progress-bar-fill" style={{ width: `${downloadProgress}%` }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {tab === 'manual' && (
        <div className="stt-manual-path">
          <label htmlFor="stt-sherpa-manual-dir">Model directory</label>
          <input id="stt-sherpa-manual-dir" type="text" value={manualDir} onChange={e => setManualDir(e.target.value)} placeholder="~/.local/share/sherpa-onnx/my-model" />
          <div style={{ marginTop: 8 }}>
            <label htmlFor="stt-sherpa-manual-type">Model type</label>
            <select id="stt-sherpa-manual-type" value={manualType} onChange={e => setManualType(e.target.value as typeof manualType)}>
              <option value="sense_voice">SenseVoice</option>
              <option value="whisper">Whisper</option>
              <option value="paraformer">Paraformer</option>
            </select>
          </div>
        </div>
      )}

      {error && <p className="text-sm" style={{ color: 'var(--error)', marginTop: 8 }}>{error}</p>}

      <p className="text-sm text-muted" style={{ marginTop: 10 }}>
        Models from Hugging Face, stored in ~/.local/share/sherpa-onnx/
      </p>
    </div>
  );
}

// ── Main Panel ─────────────────────────────────────────

export function SttDetectionPanel({ config, onSave, onConfigured }: Props) {
  const [detection, setDetection] = useState<DetectionResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [engine, setEngine] = useState<SttEngine | null>(config.stt?.engine ?? null);

  // Install flow
  const [installSteps, setInstallSteps] = useState<{ action: string; params: Record<string, string>; label: string }[] | null>(null);

  // OpenAI config state
  const [openaiApiKey, setOpenaiApiKey] = useState(config.stt?.openai_api_key ?? '');
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState(config.stt?.openai_base_url ?? 'https://api.openai.com/v1');
  const [openaiModel, setOpenaiModel] = useState(config.stt?.openai_model ?? 'whisper-1');

  // Language
  const [language, setLanguage] = useState(config.stt?.language ?? '');

  const runDetection = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchSttDetection();
      setDetection(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { runDetection(); }, [runDetection]);

  // Sync from config when it changes
  useEffect(() => {
    setEngine(config.stt?.engine ?? null);
    setOpenaiApiKey(config.stt?.openai_api_key ?? '');
    setOpenaiBaseUrl(config.stt?.openai_base_url ?? 'https://api.openai.com/v1');
    setOpenaiModel(config.stt?.openai_model ?? 'whisper-1');
    setLanguage(config.stt?.language ?? '');
  }, [config]);

  const handleEngineChange = async (e: SttEngine) => {
    setEngine(e);
    // Save engine selection immediately
    await onSave({
      stt: { ...config.stt, engine: e },
    });
    invalidateSttStatusCache();
    onConfigured();
  };

  const handleSaveOpenAi = async () => {
    await onSave({
      stt: {
        ...config.stt,
        engine: 'openai',
        openai_api_key: openaiApiKey || undefined,
        openai_base_url: openaiBaseUrl || undefined,
        openai_model: openaiModel || undefined,
        language: language || undefined,
      },
    });
    invalidateSttStatusCache();
    onConfigured();
  };

  const handleSaveLanguage = async () => {
    await onSave({
      stt: { ...config.stt, language: language || undefined },
    });
  };

  const handleInstallWhisperCpp = () => {
    const steps: { action: string; params: Record<string, string>; label: string }[] = [];
    if (!detection?.ffmpeg.found) {
      steps.push({ action: 'install_brew_pkg', params: { pkg: 'ffmpeg' }, label: 'Install ffmpeg' });
    }
    // whisper-server is part of the whisper-cpp brew formula
    const needsWhisperBinary = engine === 'whisper-server'
      ? !detection?.whisperServer?.found
      : !detection?.whisperCli.found;
    if (needsWhisperBinary) {
      steps.push({ action: 'install_brew_pkg', params: { pkg: 'whisper-cpp' }, label: 'Install whisper-cpp' });
    }
    if (steps.length > 0) setInstallSteps(steps);
  };

  const handleInstallComplete = async () => {
    setInstallSteps(null);
    setLoading(true);
    // Retry detection — the binary may not be immediately visible in PATH
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await fetchSttDetection();
        setDetection(result);
        setError(null);
        setLoading(false);
        return;
      } catch {
        if (attempt < 2) await new Promise(r => setTimeout(r, 500));
      }
    }
    // All retries failed — still run once more to set the error state
    runDetection();
  };

  // OpenAI presets
  const OPENAI_PRESETS = [
    { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' },
    { label: 'Groq (fast)', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo' },
    { label: 'Fireworks', baseUrl: 'https://api.fireworks.ai/inference/v1', model: 'whisper-v3' },
  ];

  // whisper-cpp / whisper-server: check if binary is missing
  const whisperNotInstalled = engine === 'whisper-cpp' && detection && !detection.whisperCli.found;
  const whisperServerNotInstalled = engine === 'whisper-server' && detection && !detection.whisperServer?.found;
  const canInstallViaBrew = detection?.homebrew.found;
  /** Either whisper-cpp or whisper-server engine — both use ggml models */
  const isWhisperEngine = engine === 'whisper-cpp' || engine === 'whisper-server';
  const whisperBinaryReady = engine === 'whisper-cpp'
    ? detection?.whisperCli.found
    : engine === 'whisper-server'
      ? (detection as any)?.whisperServer?.found
      : false;

  return (
    <div className="stt-detection-panel">
      {/* 1. Transcription Service Dropdown */}
      <TranscriptionServiceDropdown
        engine={engine}
        detection={detection}
        onChange={handleEngineChange}
      />

      {/* Loading indicator */}
      {loading && <p className="text-sm text-muted" style={{ marginTop: 8 }}>Scanning system...</p>}

      {/* whisper-cpp / whisper-server: binary not installed warning + install button */}
      {!loading && (whisperNotInstalled || whisperServerNotInstalled) && (
        <div className="stt-install-banner">
          <p>{engine === 'whisper-server' ? 'whisper-server' : 'whisper-cli'} is not installed.</p>
          {canInstallViaBrew && !installSteps && (
            <button type="button" className="btn btn-sm btn-primary" onClick={handleInstallWhisperCpp}>
              Install via Homebrew
            </button>
          )}
          {!canInstallViaBrew && (
            <p className="text-sm text-muted">Install Homebrew first, then retry.</p>
          )}
        </div>
      )}

      {/* Install progress */}
      {installSteps && (
        <SttSetupProgress
          steps={installSteps}
          onComplete={handleInstallComplete}
          onCancel={() => setInstallSteps(null)}
        />
      )}

      {/* 2. Whisper Model Manager (for whisper-cpp and whisper-server — both use ggml models) */}
      {isWhisperEngine && whisperBinaryReady && (
        <WhisperModelManager
          detection={detection}
          config={config}
          engine={engine as 'whisper-cpp' | 'whisper-server'}
          onRefresh={() => { runDetection(); onConfigured(); }}
        />
      )}

      {/* 3. OpenAI config */}
      {engine === 'openai' && (
        <div className="stt-engine-config">
          <div className="form-group">
            <label>Provider Preset</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {OPENAI_PRESETS.map(p => (
                <button
                  key={p.label}
                  type="button"
                  className={`btn btn-sm${openaiBaseUrl === p.baseUrl ? ' btn-primary' : ''}`}
                  onClick={() => { setOpenaiBaseUrl(p.baseUrl); setOpenaiModel(p.model); }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="form-group">
            <label htmlFor="stt-openai-key">API Key</label>
            <input
              id="stt-openai-key"
              type="password"
              value={openaiApiKey}
              onChange={e => setOpenaiApiKey(e.target.value)}
              placeholder="sk-... or ${env:OPENAI_API_KEY}"
            />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="stt-openai-url">Base URL</label>
              <input id="stt-openai-url" type="text" value={openaiBaseUrl} onChange={e => setOpenaiBaseUrl(e.target.value)} />
            </div>
            <div className="form-group">
              <label htmlFor="stt-openai-model">Model</label>
              <input id="stt-openai-model" type="text" value={openaiModel} onChange={e => setOpenaiModel(e.target.value)} />
            </div>
          </div>
          <button type="button" className="btn btn-sm btn-primary" onClick={handleSaveOpenAi}>Save</button>
        </div>
      )}

      {/* 4. Sherpa-onnx model manager */}
      {engine === 'sherpa-onnx' && (
        <SherpaModelManager
          config={config}
          onRefresh={() => { runDetection(); onConfigured(); }}
        />
      )}

      {/* 5. Language setting (shown for all engines) */}
      {engine && (
        <div className="stt-engine-config" style={{ marginTop: 12 }}>
          <div className="form-group">
            <label htmlFor="stt-language">Language</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <select
                id="stt-language"
                value={language}
                onChange={e => { setLanguage(e.target.value); }}
                style={{ maxWidth: 220 }}
              >
                <option value="">Auto-detect</option>
                <option value="en">English</option>
                <option value="zh">Chinese (中文)</option>
                <option value="ja">Japanese (日本語)</option>
                <option value="ko">Korean (한국어)</option>
                <option value="es">Spanish (Español)</option>
                <option value="fr">French (Français)</option>
                <option value="de">German (Deutsch)</option>
                <option value="pt">Portuguese (Português)</option>
                <option value="ru">Russian (Русский)</option>
                <option value="ar">Arabic (العربية)</option>
              </select>
              <span className="text-sm text-muted">Hint only — auto-detect works for most cases.</span>
            </div>
          </div>
          {(engine === 'whisper-cpp' || engine === 'whisper-server') && (
            <button type="button" className="btn btn-sm" onClick={handleSaveLanguage}>Save Language</button>
          )}
        </div>
      )}

      {error && <p className="text-sm" style={{ color: 'var(--error)', marginTop: 8 }}>{error}</p>}
    </div>
  );
}
