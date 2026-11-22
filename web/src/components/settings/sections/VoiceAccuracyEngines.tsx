/**
 * Voice Accuracy's Engines group: one row per engine and the AI judge, each
 * saying where it runs and what it sends, its state, and its "Include in
 * comparisons" switch (the state at the left, the switch always at the right).
 * Anything that sends audio or text off this computer has its own consent tick
 * under it, unticked until the user ticks it (the server refuses to run it
 * before). An engine that is not ready offers its fix in place: the Voice
 * pane's dictation setup, or the Whisper model's download. The ElevenLabs key
 * goes in a secret field under its row, saved only by its Save button or Enter
 * (never on blur, so a half-typed key is never stored).
 */
import { useState } from 'react';
import { useInRouterContext, useNavigate } from 'react-router-dom';
import { NoticeStatus } from '@/components/common/NoticeCard';
import type { CompareEngineRow, CompareEngines, CompareSettingsPatch } from '@/api/stt-compare';
import { startSetup, type SetupEvent } from '@/api/stt';
import { log } from '@/utils/log';
import { SettingsGroup, SettingsRow } from '../SettingsSection';
import { SettingsCheckbox } from '../inputs/SettingsCheckbox';
import { SecretInput } from '../inputs/SecretInput';
import { SettingsButton } from '../inputs/SettingsButton';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { ELEVENLABS_KEYS_URL, ELEVENLABS_KEY_HINT, consentWords, keyProblem, stateWords, wholePct, whereItRuns } from './voice-accuracy-model';

type Field = 'enabled' | 'allow_upload';

/** The engine row's element id (an anchor row): the summary's and the run's links scroll to it. */
export const engineRowId = (id: string) => `va-engine-row-${id}`;

/**
 * Brings an engine's row into view and puts the focus on what changes it: its consent tick when
 * sending is not allowed, else its switch.
 */
export function showEngineRow(id: string): void {
  const row = document.getElementById(engineRowId(id));
  if (!row) return;
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const target = document.querySelector<HTMLElement>(`[data-testid="va-consent-${id}"]:not(:checked)`)
    ?? document.querySelector<HTMLElement>(`[data-testid="va-switch-${id}"]`);
  target?.focus({ preventScroll: true });
}

/** The Voice pane's download that writes the model Whisper large-v2 reads (src/core/stt/compare/engines.ts). */
const WHISPER_DOWNLOAD = 'ggml-large-v2';

interface Props {
  engines: CompareEngines;
  saveError: { row: string; text: string } | null;
  save(row: string, patch: CompareSettingsPatch): Promise<boolean>;
  /** Read the engines again (after a download or a check). */
  reload(): Promise<void>;
}

function quotaLine(engine: CompareEngineRow): string {
  const q = engine.quota;
  if (!q || q.limit <= 0) return '';
  return ` ${q.tier === 'free' ? 'Free' : 'Included'} quota left: ${wholePct(q.left / q.limit)}.${q.overage ? ' Usage-based billing is on, so nothing is uploaded.' : ''}`;
}

/** Downloads the Whisper model through the Voice pane's own download, then reads the engines again. */
function WhisperFix({ reload }: { reload(): Promise<void> }) {
  const [percent, setPercent] = useState<number | null>(null);
  const [busy, setBusy] = useState<'download' | 'check' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const download = async () => {
    setBusy('download');
    setError(null);
    setPercent(null);
    try {
      await startSetup('download_ggml_model', { model: WHISPER_DOWNLOAD }, (event: SetupEvent) => {
        if (event.type === 'progress') setPercent((p) => event.percent ?? p);
        else if (event.type === 'error') setError(event.message ?? 'The download failed');
      });
      log.info('voice-accuracy', 'whisper model download ended');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      await reload();
    }
  };
  const check = async () => {
    setBusy('check');
    try { await reload(); } finally { setBusy(null); }
  };
  return (
    <span className="va-fix">
      <SettingsButton onClick={() => void check()} busy={busy === 'check'} busyLabel="Checking..." disabled={busy === 'download'} data-testid="va-whisper-check">
        Check again
      </SettingsButton>
      <SettingsButton
        onClick={() => void download()}
        busy={busy === 'download'}
        busyLabel={percent !== null ? `Downloading ${Math.round(percent)}%` : 'Downloading...'}
        reserve={['Downloading 100%']}
        disabled={busy === 'check'}
        data-testid="va-whisper-download"
      >
        Download (3 GB)
      </SettingsButton>
      {error && <span className="va-fix-error" role="alert">{`Couldn't download it: ${error}`}</span>}
    </span>
  );
}

function GoToVoice({ testId }: { testId: string }) {
  const navigate = useNavigate();
  return <SettingsButton variant="primary" onClick={() => navigate('/settings#stt')} data-testid={testId}>Set up dictation</SettingsButton>;
}

/** Opens Settings › Voice, where dictation is set up (a plain hash change outside a router). */
function SetUpDictation({ testId }: { testId: string }) {
  if (useInRouterContext()) return <GoToVoice testId={testId} />;
  return <SettingsButton variant="primary" onClick={() => { window.location.hash = '#stt'; }} data-testid={testId}>Set up dictation</SettingsButton>;
}

export function VoiceAccuracyEngines({ engines, saveError, save, reload }: Props) {
  // A flip shows at once; the server's answer replaces it (or the row's error puts it back).
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [key, setKey] = useState('');
  const valueOf = (engine: CompareEngineRow, field: Field) => pending[`${engine.id}.${field}`] ?? engine[field];
  const flip = async (engine: CompareEngineRow, field: Field, value: boolean) => {
    const k = `${engine.id}.${field}`;
    setPending((p) => ({ ...p, [k]: value }));
    await save(`${field === 'enabled' ? 'engine' : 'consent'}:${engine.id}`, { engines: { [engine.id]: { [field]: value } } });
    setPending((p) => { const { [k]: _gone, ...rest } = p; return rest; });
  };
  const errorOf = (row: string) => (saveError?.row === row ? `Couldn't save: ${saveError.text}` : undefined);
  const [keyError, setKeyError] = useState<string | null>(null);
  const saveKey = async () => {
    const value = key.trim();
    const problem = keyProblem(value);
    setKeyError(problem);
    if (problem) return;
    if (await save('key', { elevenlabs_api_key: value })) setKey('');
  };

  return (
    <SettingsGroup heading="Engines" data-testid="va-engines">
      {engines.engines.map((engine) => {
        const words = consentWords(engine);
        const enabled = valueOf(engine, 'enabled');
        const state = stateWords(engine);
        const fix = engine.state === 'not-installed' && enabled ? engine.fix : undefined;
        return (
          <div key={engine.id} className="settings-rows-contents" data-testid={`va-engine-${engine.id}`} data-state={engine.state}>
            <SettingsRow
              label={engine.label}
              anchor={engineRowId(engine.id)}
              help={(
                <>
                  {`${whereItRuns(engine)}${engine.detail ? ` ${engine.detail}.` : ''}${quotaLine(engine)}`}
                  {engine.model && <span className="va-model-line" data-testid={`va-model-${engine.id}`}>{`Model: ${engine.model}`}</span>}
                </>
              )}
              error={errorOf(`engine:${engine.id}`)}
              control={(
                <span className="va-engine-control">
                  <NoticeStatus tone={state.tone} whole>{state.word}</NoticeStatus>
                  <ToggleSwitch
                    checked={enabled}
                    onChange={(v) => void flip(engine, 'enabled', v)}
                    aria-label={`Include ${engine.label} in comparisons`}
                    data-testid={`va-switch-${engine.id}`}
                  />
                </span>
              )}
            />
            {fix === 'set-up-dictation' && (
              <SettingsRow
                indent
                label="Set up dictation first"
                help="Walnut compares other engines with the one your dictation uses; set it up in Settings › Voice."
                control={<SetUpDictation testId={`va-setup-${engine.id}`} />}
              />
            )}
            {fix === 'download-whisper' && (
              <SettingsRow
                indent
                label="Get the Whisper large-v2 model"
                help="Download it here (about 3 GB, to the folder named above), or put the file there yourself and check again."
                control={<WhisperFix reload={reload} />}
              />
            )}
            {words && (
              <SettingsCheckbox
                checked={valueOf(engine, 'allow_upload')}
                onChange={(v) => void flip(engine, 'allow_upload', v)}
                label={words}
                data-testid={`va-consent-${engine.id}`}
              />
            )}
            {errorOf(`consent:${engine.id}`) && <p className="settings-row-error" role="alert">{errorOf(`consent:${engine.id}`)}</p>}
            {engine.id === 'elevenlabs-scribe' && (
              <SettingsRow
                indent
                label="ElevenLabs API key"
                htmlFor="va-elevenlabs-key"
                help={(
                  <>
                    {ELEVENLABS_KEY_HINT}
                    <a className="settings-addons-link" href={ELEVENLABS_KEYS_URL} target="_blank" rel="noreferrer" data-testid="va-elevenlabs-key-link">Get a key at ElevenLabs</a>
                  </>
                )}
                error={keyError ?? errorOf('key')}
                control={(
                  <>
                    <SecretInput
                      id="va-elevenlabs-key"
                      value={key}
                      onChange={(v) => { setKey(v); setKeyError(null); }}
                      onEnter={() => void saveKey()}
                      placeholder="Paste a key"
                      saved={engines.hasElevenLabsKey}
                      onRemove={() => save('key', { elevenlabs_api_key: '' })}
                      aria-invalid={!!keyError}
                      data-testid="va-elevenlabs-key"
                    />
                    {key.trim() && (
                      <SettingsButton onClick={() => void saveKey()} data-testid="va-elevenlabs-key-save">Save</SettingsButton>
                    )}
                  </>
                )}
              />
            )}
          </div>
        );
      })}
    </SettingsGroup>
  );
}
