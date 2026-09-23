import { useState, useEffect, useCallback } from 'react';
import type { Config } from '@open-walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { SettingsEmpty, SettingsGroup, SettingsRow } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { NumberInput } from '../inputs/NumberInput';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { useSettingsAutoSave } from '../inputs/useSettingsAutoSave';
import { fetchAudioApps, type AppInfo } from '@/api/audio';
import { useAudioCapture } from '@/hooks/useAudioCapture';
import '@/styles/settings-sections-addons.css';

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Well-known music/entertainment apps to pre-populate the exclude list. */
const DEFAULT_EXCLUDE_APPS = [
  { bundleId: 'com.spotify.client', name: 'Spotify' },
  { bundleId: 'com.apple.Music', name: 'Apple Music' },
  { bundleId: 'com.apple.FaceTime', name: 'FaceTime' },
];

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
}

export function AudioCaptureSection({ config, onSave }: Props) {
  const [excludeApps, setExcludeApps] = useState<string[]>(config.audio?.exclude_apps ?? []);
  const [refreshInterval, setRefreshInterval] = useState(config.audio?.refresh_interval_sec ?? 60);
  const [deleteAfterTranscription, setDeleteAfterTranscription] = useState(config.audio?.delete_after_transcription !== false);
  const [retentionDays, setRetentionDays] = useState(config.audio?.retention_days ?? 7);
  const [newApp, setNewApp] = useState('');
  const [runningApps, setRunningApps] = useState<AppInfo[]>([]);
  const [loadingApps, setLoadingApps] = useState(false);
  // The start/stop control lives here (not the sidebar): recording is still an
  // experimental feature, so it should not occupy a top-level nav slot.
  const audio = useAudioCapture();

  // Sync from config when it changes externally
  useEffect(() => {
    setExcludeApps(config.audio?.exclude_apps ?? []);
    setRefreshInterval(config.audio?.refresh_interval_sec ?? 60);
    setDeleteAfterTranscription(config.audio?.delete_after_transcription !== false);
    setRetentionDays(config.audio?.retention_days ?? 7);
  }, [config]);

  const loadRunningApps = useCallback(async () => {
    setLoadingApps(true);
    try {
      const apps = await fetchAudioApps();
      // One row per bundle id: several processes can share one (system text
      // services run a copy per host app), and the id is the option's key.
      const seen = new Set<string>();
      setRunningApps(apps.filter(a => !seen.has(a.bundleIdentifier) && seen.add(a.bundleIdentifier)));
    } catch { /* ignore */ }
    finally { setLoadingApps(false); }
  }, []);

  useEffect(() => { loadRunningApps(); }, [loadRunningApps]);

  const addApp = (bundleId: string) => {
    if (!bundleId.trim() || excludeApps.includes(bundleId.trim())) return;
    setExcludeApps(prev => [...prev, bundleId.trim()]);
  };
  const removeApp = (bundleId: string) => setExcludeApps(prev => prev.filter(a => a !== bundleId));

  const handleSave = async () => {
    // undefined = use server default (true). We omit the field rather than storing true explicitly.
    await onSave({
      audio: {
        ...config.audio,
        exclude_apps: excludeApps.length > 0 ? excludeApps : undefined,
        refresh_interval_sec: refreshInterval !== 60 ? refreshInterval : undefined,
        delete_after_transcription: deleteAfterTranscription ? undefined : false,
        retention_days: retentionDays !== 7 ? retentionDays : undefined,
      },
    });
  };

  useSettingsAutoSave({
    current: JSON.stringify({ excludeApps, refreshInterval, deleteAfterTranscription, retentionDays }),
    baseline: JSON.stringify({
      excludeApps: config.audio?.exclude_apps ?? [],
      refreshInterval: config.audio?.refresh_interval_sec ?? 60,
      deleteAfterTranscription: config.audio?.delete_after_transcription !== false,
      retentionDays: config.audio?.retention_days ?? 7,
    }),
    save: handleSave,
  });

  const availableApps = runningApps.filter(
    a => !excludeApps.includes(a.bundleIdentifier) && !excludeApps.includes(a.applicationName)
  );
  const quickAdd = DEFAULT_EXCLUDE_APPS.filter(d => !excludeApps.includes(d.bundleId));

  return (
    <SectionCard id="audio-capture" title="Audio Capture" onSave={handleSave} showSave={false}>
      <SettingsGroup>
        <SettingsRow
          label="Recording"
          help={
            audio.available === false
              ? 'System audio capture is not available on this machine.'
              : audio.recording
                ? <span className="settings-addons-live">{formatDuration(audio.totalDuration)}</span>
                : 'Records system audio until you stop it.'
          }
          error={audio.lastError || undefined}
          control={audio.available === false ? undefined : (
            <SettingsButton
              variant={audio.recording ? 'danger' : 'default'}
              onClick={audio.toggleRecording}
              disabled={audio.loading || audio.available === null}
              // A disabled button says why (N15): the capture check has not answered yet.
              title={audio.available === null && !audio.loading ? 'Checking whether this Mac can record...' : undefined}
              reserve={['Start recording', 'Stop recording', 'Starting...']}
              data-testid="settings-recording-toggle"
            >
              {audio.loading ? 'Starting...' : audio.recording ? 'Stop recording' : 'Start recording'}
            </SettingsButton>
          )}
        />
      </SettingsGroup>

      <SettingsGroup heading="Excluded apps" footer="Audio from these apps is never recorded.">
        {excludeApps.length === 0 && (
          <SettingsEmpty>Nothing excluded; all system audio is recorded.</SettingsEmpty>
        )}
        {excludeApps.map(app => (
          <SettingsRow
            key={app}
            label={<span className="settings-addons-mono" title={app}>{app}</span>}
            control={
              <SettingsButton variant="danger" onClick={() => removeApp(app)} aria-label={`Remove ${app}`}>
                Remove
              </SettingsButton>
            }
          />
        ))}
        {quickAdd.length > 0 && (
          <SettingsRow
            label="Quick add"
            control={
              <span className="settings-addons-inline">
                {quickAdd.map(d => (
                  <SettingsButton key={d.bundleId} onClick={() => addApp(d.bundleId)}>
                    {`Add ${d.name}`}
                  </SettingsButton>
                ))}
              </span>
            }
          />
        )}
        {availableApps.length > 0 && (
          <SettingsRow
            label="Running apps"
            htmlFor="audio-running-apps"
            control={
              <span className="settings-addons-inline">
                <select
                  id="audio-running-apps"
                  className="settings-select"
                  value=""
                  onChange={(e) => { if (e.target.value) addApp(e.target.value); }}
                >
                  <option value="">Choose an app to exclude</option>
                  {availableApps.map(a => (
                    <option key={a.bundleIdentifier} value={a.bundleIdentifier}>
                      {a.applicationName} ({a.bundleIdentifier})
                    </option>
                  ))}
                </select>
                <SettingsButton onClick={loadRunningApps} busy={loadingApps} busyLabel="Refreshing...">
                  Refresh
                </SettingsButton>
              </span>
            }
          />
        )}
        <SettingsRow
          label="Add app"
          htmlFor="audio-add-app"
          wide
          control={
            <span className="settings-addons-inline">
              <input
                id="audio-add-app"
                type="text"
                className="settings-input settings-input--long settings-input--mono"
                value={newApp}
                onChange={(e) => setNewApp(e.target.value)}
                placeholder="com.example.app or app name"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); addApp(newApp); setNewApp(''); }
                }}
              />
              <SettingsButton onClick={() => { addApp(newApp); setNewApp(''); }} disabled={!newApp.trim()} title={newApp.trim() ? undefined : 'Type an app name first.'}>
                Add
              </SettingsButton>
            </span>
          }
        />
        {/* How often the app list is read again: it belongs with the apps (N3-31). */}
        <SettingsRow
          label="App refresh interval"
          htmlFor="audio-refresh-interval"
          help="How often running apps are scanned again during a recording."
          control={
            <NumberInput id="audio-refresh-interval" min={10} max={600} unit="seconds"
              value={refreshInterval} onChange={(v) => setRefreshInterval(v ?? 60)} />
          }
        />
      </SettingsGroup>

      <SettingsGroup heading="Storage">
        <SettingsRow
          label="Delete audio after transcription"
          htmlFor="audio-delete-after-transcription"
          help="Keeps only the text transcript, about 55 MB less per 10 minute chunk."
          control={
            <ToggleSwitch id="audio-delete-after-transcription" checked={deleteAfterTranscription}
              onChange={setDeleteAfterTranscription} />
          }
        />
        <SettingsRow
          label="Keep recordings for"
          htmlFor="audio-retention-days"
          help="Older recordings and their transcripts are deleted; 0 keeps them forever."
          control={
            <NumberInput id="audio-retention-days" min={0} max={365} unit="days"
              value={retentionDays} onChange={(v) => setRetentionDays(v ?? 0)} />
          }
        />
      </SettingsGroup>
    </SectionCard>
  );
}
