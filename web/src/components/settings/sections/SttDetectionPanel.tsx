/**
 * Voice > Dictation rows: the engine, what this Mac has for it, and then ONE
 * of: the "Set up dictation" row (the engine is not working yet), the setup
 * progress, or the engine's own rows (models, API fields). Then the language.
 *
 * Offered engines: Qwen3-ASR (Apple Silicon), Whisper, an OpenAI-compatible
 * API; the legacy engines appear only for an install already using one. With
 * no engine in config the recommended one is PRESELECTED here but not written:
 * config changes only when Set up finishes or the user picks an engine. The
 * section's Save button commits the drafts (language, API fields).
 */

import { useState, useEffect, useCallback } from 'react';
import type { Config } from '@open-walnut/core';
import { fetchSttDetection, DEFAULT_MLX_MODEL, type DetectionResult } from '@/api/stt';
import { SettingsRow, SettingsTag } from '../SettingsSection';
import { sttScanSummary } from './stt-scan-summary';
import { SettingsButton } from '../inputs/SettingsButton';
import { SecretInput } from '../inputs/SecretInput';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { useOptimisticSetting } from '../inputs/useOptimisticSetting';
import { SttSetupProgress } from './SttSetupProgress';
import { SttSetupRow } from './SttSetupRow';
import { WhisperModelRows, QwenModelRow, SherpaModelRows, activeModelFromConfig } from './SttModelRows';
import { useSerialSave, type OnSave } from './GeneralSection';
import { refreshSttStatus, useSttStatus } from '@/hooks/useSttStatus';
import { engineOptionsFor, planSetup, recommendedEngine, setupConfigPatch, type SetupEngine, type SttEngine } from './stt-setup-plan';
import {
  claimSttSetupJob, clearSttSetupJob, cancelSttSetupJob, startSttSetupJob, useSttSetupJob, type SttSetupJob,
} from './stt-setup-job';

export type { SttEngine } from './stt-setup-plan';
export { formatSize } from './SttModelRows';

/** Concurrent mounts share one scan in flight: Voice asks once per open (N27). */
let detectInflight: ReturnType<typeof fetchSttDetection> | null = null;
function detectOnce(): ReturnType<typeof fetchSttDetection> {
  if (detectInflight) return detectInflight;
  const p = fetchSttDetection().finally(() => { if (detectInflight === p) detectInflight = null; });
  detectInflight = p;
  return p;
}

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

const isSetupEngine = (e: SttEngine | null): e is SetupEngine => e === 'mlx' || e === 'whisper-server';

/**
 * Readiness from the scan alone, for the moment the status check has not
 * answered for this engine yet (just after a pick, or when it failed).
 */
function readyFromDetection(engine: SetupEngine, d: DetectionResult, config: Config): boolean {
  if (!d.ffmpeg.found) return false;
  if (engine === 'whisper-server') {
    const active = activeModelFromConfig(config);
    return !!d.whisperServer?.found && !!active && d.models.some((m) => m.name === active);
  }
  const python = config.stt?.mlx_python_path;
  // A Python the user set by hand in config.yaml is theirs to keep working.
  return python && python !== d.mlx?.pythonPath ? true : !!d.mlx?.ready;
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
  const [applyError, setApplyError] = useState<string | null>(null);
  const save = useSerialSave(config, onSave);
  const status = useSttStatus();
  const job = useSttSetupJob();

  const engineSetting = useOptimisticSetting<SttEngine | ''>(
    (config.stt?.engine as SttEngine | undefined) ?? '',
    async (e) => {
      await save((c) => ({ stt: { ...c.stt, engine: e || undefined } as Config['stt'] }), { rowKey: 'stt.engine' });
      refreshSttStatus();
      onConfigured();
    },
    { rowKey: 'stt.engine' },
  );
  const configured = engineSetting.value || null;
  // Nothing configured: preselect the recommended engine (shown, not saved).
  const engine: SttEngine | null = configured ?? (detection ? recommendedEngine(detection.platform) : null);
  const options = engineOptionsFor(detection?.platform, configured);

  const runDetection = useCallback(async (fresh = false) => {
    setLoading(true);
    setError(null);
    try {
      setDetection(await (fresh ? fetchSttDetection() : detectOnce()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void runDetection(); }, [runDetection]);

  // The binary may not be visible on PATH at once after an install: retry the scan.
  const rescanAfterInstall = useCallback(async () => {
    setLoading(true);
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
    void runDetection(true);
  }, [runDetection]);

  const refresh = useCallback(() => { void runDetection(true); onConfigured(); }, [runDetection, onConfigured]);

  // A finished one-button setup turns the engine on, exactly once, from
  // whichever Voice pane is mounted (the job may have finished while none was).
  useEffect(() => {
    if (!job || job.kind !== 'setup' || job.status !== 'done' || !claimSttSetupJob(job.id)) return;
    void applySetup(job);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job]);

  async function applySetup(done: SttSetupJob) {
    setApplyError(null);
    setLoading(true);
    try {
      const fresh = await fetchSttDetection();
      setDetection(fresh);
      setError(null);
      await save((c) => ({
        stt: {
          ...c.stt,
          ...setupConfigPatch(done.engine as SetupEngine, fresh, {
            activateModel: done.apply?.activateModel,
            whisperServerPath: c.stt?.whisper_server_path,
            defaultMlxModel: DEFAULT_MLX_MODEL,
          }),
        } as Config['stt'],
      }), { rowKey: 'stt.engine' });
    } catch (err) {
      setApplyError(`Setup finished, but turning dictation on failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearSttSetupJob(done.id);
      setLoading(false);
      refreshSttStatus();
      onConfigured();
    }
  }

  const startOneClickSetup = () => {
    if (!detection || !isSetupEngine(engine)) return;
    const plan = planSetup(engine, detection, activeModelFromConfig(config));
    setApplyError(null);
    startSttSetupJob({
      kind: 'setup', engine, steps: plan.steps,
      apply: { activateModel: plan.activateModel },
    });
  };

  // Legacy Whisper CLI: the old install banner, kept for installs that use it.
  const installWhisperCli = () => {
    const steps: SttSetupJob['steps'] = [];
    if (!detection?.ffmpeg.found) steps.push({ action: 'install_brew_pkg', params: { pkg: 'ffmpeg' }, label: 'Install ffmpeg' });
    if (!detection?.whisperCli.found) steps.push({ action: 'install_brew_pkg', params: { pkg: 'whisper-cpp' }, label: 'Install whisper-cpp' });
    if (steps.length > 0) startSttSetupJob({ kind: 'install', engine: 'whisper-cpp', steps });
  };

  const progressJob = job && (job.kind === 'setup' || job.kind === 'install') ? job : null;
  const jobRunning = job?.status === 'running';

  // Is the chosen engine already working? The server's status check is the
  // truth; until it has answered for THIS engine, the scan stands in.
  const statusKnown = !status.isLoading && status.engine === configured;
  const ready = !!detection && isSetupEngine(engine) && configured === engine
    && (statusKnown ? status.isAvailable : readyFromDetection(engine, detection, config));
  const plan = detection && isSetupEngine(engine) ? planSetup(engine, detection, activeModelFromConfig(config)) : null;
  const showSetupRow = !loading && !!plan && !ready && !progressJob;
  const cliReady = !!detection?.whisperCli.found;
  const selected = options.find((o) => o.value === engine);
  const preset = OPENAI_PRESETS.find((p) => p.baseUrl === draft.openaiBaseUrl)?.value ?? '';

  return (
    <div className="stt-detection-panel settings-rows-contents">
      <SettingsRow
        // The tags ride on the label line, not beside the select: there they
        // narrowed the copy column, so the help wrapped to a second line the
        // moment the scan preselected an engine and every row below jumped (N3-05).
        label={
          <>
            <label htmlFor="stt-engine">Engine</label>
            {selected && (
              <span className="stt-engine-tags" data-testid="stt-engine-tags" style={{ display: 'inline-flex', gap: 6, marginLeft: 8, verticalAlign: 'top' }}>
                <SettingsTag>{selected.badge}</SettingsTag>
                {selected.recommended && <SettingsTag tone="success">Recommended</SettingsTag>}
              </span>
            )}
          </>
        }
        help={selected?.description ?? 'Pick how dictation turns speech into text.'}
        error={engineSetting.error}
        className="stt-service-dropdown"
        control={
          <span className="settings-control-cluster">
            <select
              id="stt-engine"
              data-testid="stt-engine-select"
              className="settings-select"
              value={engine ?? ''}
              disabled={(!engine && loading) || jobRunning}
              onChange={(e) => engineSetting.set(e.target.value as SttEngine)}
            >
              {!engine && <option value="">{loading ? 'Checking this Mac...' : 'Choose an engine'}</option>}
              <optgroup label="On this Mac">
                {options.filter((o) => o.badge === 'Local').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </optgroup>
              <optgroup label="Cloud">
                {options.filter((o) => o.badge === 'Cloud').map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </optgroup>
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
        control={!loading && error ? <SettingsButton variant="text" onClick={() => void runDetection(true)}>Retry</SettingsButton> : undefined}
      />

      {showSetupRow && plan && <SttSetupRow plan={plan} onSetup={startOneClickSetup} error={applyError} />}

      {progressJob && (
        <SttSetupProgress
          job={progressJob}
          onDone={progressJob.kind === 'install' ? () => { clearSttSetupJob(progressJob.id); void rescanAfterInstall(); } : undefined}
          onRetry={() => startSttSetupJob({ kind: progressJob.kind, engine: progressJob.engine, steps: progressJob.steps, apply: progressJob.apply })}
          onCancel={() => { cancelSttSetupJob(); void runDetection(true); }}
        />
      )}

      {engine === 'whisper-server' && ready && (
        <WhisperModelRows detection={detection} config={config} engine="whisper-server" onSave={onSave} onRefresh={refresh} />
      )}

      {engine === 'mlx' && ready && <QwenModelRow detection={detection} config={config} onRefresh={refresh} />}

      {engine === 'whisper-cpp' && !loading && detection && !cliReady && !progressJob && (
        <SettingsRow
          indent
          className="stt-install-banner"
          state="warning"
          label="whisper-cli is not installed."
          help={detection.homebrew.found ? 'Walnut can install it with Homebrew.' : 'Install Homebrew first, then retry.'}
          control={detection.homebrew.found ? (
            <SettingsButton variant="primary" onClick={installWhisperCli}>Install via Homebrew</SettingsButton>
          ) : undefined}
        />
      )}

      {engine === 'whisper-cpp' && cliReady && (
        <WhisperModelRows detection={detection} config={config} engine="whisper-cpp" onSave={onSave} onRefresh={refresh} />
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
