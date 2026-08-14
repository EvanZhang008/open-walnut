import { useState, useEffect, useCallback } from 'react';
import type { Config } from '@open-walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { fetchAudioApps, type AppInfo } from '@/api/audio';
import { useAutoSave } from '@/hooks/useAutoSave';
import { useAudioCapture } from '@/hooks/useAudioCapture';

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
  // The start/stop control lives here (not the sidebar) — recording is still an
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
      setRunningApps(apps);
    } catch { /* ignore */ }
    finally { setLoadingApps(false); }
  }, []);

  // Load running apps on mount
  useEffect(() => { loadRunningApps(); }, [loadRunningApps]);

  const addApp = (bundleId: string) => {
    if (!bundleId.trim() || excludeApps.includes(bundleId.trim())) return;
    setExcludeApps(prev => [...prev, bundleId.trim()]);
  };

  const removeApp = (bundleId: string) => {
    setExcludeApps(prev => prev.filter(a => a !== bundleId));
  };

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

  useAutoSave({
    current: JSON.stringify({ excludeApps, refreshInterval, deleteAfterTranscription, retentionDays }),
    baseline: JSON.stringify({
      excludeApps: config.audio?.exclude_apps ?? [],
      refreshInterval: config.audio?.refresh_interval_sec ?? 60,
      deleteAfterTranscription: config.audio?.delete_after_transcription !== false,
      retentionDays: config.audio?.retention_days ?? 7,
    }),
    save: handleSave,
  });

  // Running apps NOT in exclude list (candidates to add)
  const availableApps = runningApps.filter(
    a => !excludeApps.includes(a.bundleIdentifier) && !excludeApps.includes(a.applicationName)
  );

  return (
    <SectionCard
      id="audio-capture"
      title="Audio Capture"
      description="Configure system audio recording. Exclude apps like music players so only meeting/work audio is captured. Changes save automatically."
      onSave={handleSave}
      showSave={false}
    >
      {/* Start/stop control — moved out of the sidebar (experimental feature). */}
      <div className="form-group">
        <label>Recording</label>
        {audio.available === false ? (
          <p className="text-sm text-muted" style={{ margin: 0 }}>
            System audio capture is not available on this machine.
          </p>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              className={`btn${audio.recording ? ' btn-danger' : ''}`}
              onClick={audio.toggleRecording}
              disabled={audio.loading || audio.available === null}
              data-testid="settings-recording-toggle"
            >
              {audio.loading ? 'Starting...' : audio.recording ? 'Stop recording' : 'Start recording'}
            </button>
            {audio.recording && (
              <span className="text-sm" style={{ color: 'var(--error)', fontVariantNumeric: 'tabular-nums' }}>
                {formatDuration(audio.totalDuration)}
              </span>
            )}
          </div>
        )}
        {audio.lastError && (
          <p className="text-sm" style={{ color: 'var(--error)', margin: '6px 0 0' }}>
            {audio.lastError}
          </p>
        )}
      </div>

      {/* Exclude list */}
      <div className="form-group">
        <label>Excluded Apps</label>
        <p className="text-sm text-muted" style={{ margin: '0 0 8px' }}>
          Audio from these apps will NOT be recorded. Use bundle IDs (e.g. com.spotify.client) or app names.
        </p>

        {excludeApps.length === 0 && (
          <p className="text-sm text-muted" style={{ fontStyle: 'italic', margin: '4px 0 8px' }}>
            No apps excluded — all system audio will be recorded.
          </p>
        )}

        {excludeApps.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {excludeApps.map(app => (
              <span key={app} className="stt-feature-tag" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {app}
                <button
                  type="button"
                  onClick={() => removeApp(app)}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                    color: 'var(--text-muted)', fontSize: 14, lineHeight: 1,
                  }}
                  title={`Remove ${app}`}
                >
                  {'\u00D7'}
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Quick-add defaults */}
        {DEFAULT_EXCLUDE_APPS.some(d => !excludeApps.includes(d.bundleId)) && (
          <div style={{ marginBottom: 8 }}>
            <span className="text-sm text-muted">Quick add: </span>
            {DEFAULT_EXCLUDE_APPS.filter(d => !excludeApps.includes(d.bundleId)).map(d => (
              <button
                key={d.bundleId}
                type="button"
                className="btn btn-sm"
                style={{ marginLeft: 4, marginBottom: 2 }}
                onClick={() => addApp(d.bundleId)}
              >
                + {d.name}
              </button>
            ))}
          </div>
        )}

        {/* Add from running apps dropdown */}
        {availableApps.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <span className="text-sm text-muted">Running apps: </span>
            <select
              value=""
              onChange={(e) => { if (e.target.value) addApp(e.target.value); }}
              style={{ maxWidth: 300 }}
            >
              <option value="">Select an app to exclude...</option>
              {availableApps.map(a => (
                <option key={a.bundleIdentifier} value={a.bundleIdentifier}>
                  {a.applicationName} ({a.bundleIdentifier})
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-sm"
              style={{ marginLeft: 4 }}
              onClick={loadRunningApps}
              disabled={loadingApps}
            >
              {loadingApps ? '...' : 'Refresh'}
            </button>
          </div>
        )}

        {/* Manual entry */}
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="text"
            value={newApp}
            onChange={(e) => setNewApp(e.target.value)}
            placeholder="com.example.app or App Name"
            style={{ flex: 1, maxWidth: 300 }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); addApp(newApp); setNewApp(''); }
            }}
          />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => { addApp(newApp); setNewApp(''); }}
            disabled={!newApp.trim()}
          >
            Add
          </button>
        </div>
      </div>

      {/* Refresh interval */}
      <div className="form-group" style={{ marginTop: 16 }}>
        <label htmlFor="audio-refresh-interval">App Refresh Interval</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            id="audio-refresh-interval"
            type="number"
            min={10}
            max={600}
            value={refreshInterval}
            onChange={(e) => setRefreshInterval(Number(e.target.value))}
            style={{ width: 80 }}
          />
          <span className="text-sm text-muted">seconds (how often to re-scan running apps during recording)</span>
        </div>
      </div>

      {/* Storage settings */}
      <div className="form-group" style={{ marginTop: 16 }}>
        <label>Storage</label>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <input
            id="audio-delete-after-transcription"
            type="checkbox"
            checked={deleteAfterTranscription}
            onChange={(e) => setDeleteAfterTranscription(e.target.checked)}
          />
          <label htmlFor="audio-delete-after-transcription" style={{ margin: 0, fontWeight: 'normal' }}>
            Delete audio after transcription
          </label>
        </div>
        <p className="text-sm text-muted" style={{ margin: '0 0 12px 24px' }}>
          Keep only the text transcript. Saves ~55 MB per 10-min chunk.
        </p>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label htmlFor="audio-retention-days" style={{ margin: 0, fontWeight: 'normal' }}>
            Retention days
          </label>
          <input
            id="audio-retention-days"
            type="number"
            min={0}
            max={365}
            value={retentionDays}
            onChange={(e) => setRetentionDays(Number(e.target.value))}
            style={{ width: 80 }}
          />
          <span className="text-sm text-muted">days (0 = keep forever)</span>
        </div>
        <p className="text-sm text-muted" style={{ margin: '4px 0 0 0' }}>
          Auto-delete recordings (including transcripts) older than this.
        </p>
      </div>
    </SectionCard>
  );
}
