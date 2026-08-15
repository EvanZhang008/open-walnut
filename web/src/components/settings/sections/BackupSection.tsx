import { useCallback, useEffect, useState } from 'react';
import type { Config } from '@open-walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { apiGet, apiPost } from '@/api/client';
import { fetchAwsProfiles } from '@/api/config';
import { useAutoSave } from '@/hooks/useAutoSave';
import { useEvent } from '@/hooks/useWebSocket';

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
}

interface BackupStatus {
  configured: boolean;
  running: boolean;
  primary?: boolean;
  lastBackupAt?: string;
  lastDurationMs?: number;
  lastFileCount?: number;
  lastTotalBytes?: number;
  progress?: { uploadedBytes: number; totalBytes: number };
  consecutiveFailures: number;
  error?: string;
  versioningEnabled?: boolean;
}

interface TestResult {
  ok: boolean;
  arn?: string;
  versioningEnabled?: boolean;
  error?: string;
}

const fmtBytes = (n?: number): string =>
  n === undefined ? '—' : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;

export function BackupSection({ config, onSave }: Props) {
  const saved = config.backup ?? {};
  const [enabled, setEnabled] = useState(saved.enabled ?? false);
  const [bucket, setBucket] = useState(saved.bucket ?? '');
  const [region, setRegion] = useState(saved.region ?? 'us-west-2');
  const [prefix, setPrefix] = useState(saved.prefix ?? 'walnut');
  const [intervalHours, setIntervalHours] = useState(saved.interval_hours ?? 24);
  const [method, setMethod] = useState(saved.auth?.method ?? 'aws_chain');
  const [profile, setProfile] = useState(saved.auth?.profile ?? '');
  const [accessKey, setAccessKey] = useState(saved.auth?.aws_access_key_id ?? '');
  const [secretKey, setSecretKey] = useState(saved.auth?.aws_secret_access_key ?? '');
  const [profiles, setProfiles] = useState<string[]>([]);

  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [enablingVersioning, setEnablingVersioning] = useState(false);

  useEffect(() => {
    setEnabled(saved.enabled ?? false);
    setBucket(saved.bucket ?? '');
    setRegion(saved.region ?? 'us-west-2');
    setPrefix(saved.prefix ?? 'walnut');
    setIntervalHours(saved.interval_hours ?? 24);
    setMethod(saved.auth?.method ?? 'aws_chain');
    setProfile(saved.auth?.profile ?? '');
    setAccessKey(saved.auth?.aws_access_key_id ?? '');
    setSecretKey(saved.auth?.aws_secret_access_key ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  useEffect(() => {
    apiGet<BackupStatus>('/api/backup/status').then(setStatus).catch(() => {});
    fetchAwsProfiles().then(setProfiles).catch(() => setProfiles([]));
  }, []);

  useEvent('backup:status', useCallback((data: unknown) => {
    setStatus((prev) => ({ ...(prev ?? { configured: false, running: false, consecutiveFailures: 0 }), ...(data as BackupStatus) }));
  }, []));

  const formConfig = () => ({
    enabled,
    bucket: bucket.trim(),
    region: region.trim() || 'us-west-2',
    prefix: prefix.trim() || 'walnut',
    interval_hours: Math.max(1, Number(intervalHours) || 24),
    auth: {
      method,
      ...(method === 'profile' && profile ? { profile } : {}),
      ...(method === 'access_keys' ? { aws_access_key_id: accessKey, aws_secret_access_key: secretKey } : {}),
    },
  });

  const handleSave = async () => {
    await onSave({ backup: formConfig() } as Partial<Config>);
  };

  useAutoSave({
    current: JSON.stringify(formConfig()),
    baseline: JSON.stringify({
      enabled: saved.enabled ?? false,
      bucket: saved.bucket ?? '',
      region: saved.region ?? 'us-west-2',
      prefix: saved.prefix ?? 'walnut',
      interval_hours: saved.interval_hours ?? 24,
      auth: {
        method: saved.auth?.method ?? 'aws_chain',
        ...(saved.auth?.method === 'profile' && saved.auth?.profile ? { profile: saved.auth.profile } : {}),
        ...(saved.auth?.method === 'access_keys'
          ? { aws_access_key_id: saved.auth?.aws_access_key_id ?? '', aws_secret_access_key: saved.auth?.aws_secret_access_key ?? '' }
          : {}),
      },
    }),
    save: handleSave,
  });

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await apiPost<TestResult>('/api/backup/test', formConfig(), { timeoutMs: 45000 }));
    } catch (err) {
      setTestResult({ ok: false, error: (err as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const handleRunNow = async () => {
    setRunError(null);
    try {
      // Fire-and-forget: the server answers 202 and the run continues in the
      // background; progress/completion arrive via backup:status events.
      await apiPost('/api/backup/run', {});
      setStatus((prev) => (prev ? { ...prev, running: true } : prev));
    } catch (err) {
      setRunError((err as Error).message);
    }
  };

  const handleEnableVersioning = async () => {
    setEnablingVersioning(true);
    try {
      await apiPost('/api/backup/enable-versioning', formConfig(), { timeoutMs: 45000 });
      setStatus((prev) => (prev ? { ...prev, versioningEnabled: true } : prev));
      setTestResult((prev) => (prev ? { ...prev, versioningEnabled: true } : prev));
    } catch (err) {
      setRunError((err as Error).message);
    } finally {
      setEnablingVersioning(false);
    }
  };

  const versioningOff =
    (testResult && testResult.ok && testResult.versioningEnabled === false) ||
    (status?.configured && status.versioningEnabled === false);
  const progressPct = status?.progress && status.progress.totalBytes > 0
    ? Math.floor((status.progress.uploadedBytes / status.progress.totalBytes) * 100)
    : null;

  return (
    <SectionCard
      id="backup"
      title="S3 Backup"
      description="Back up your data to your own S3 bucket on a schedule. Changes save automatically."
      onSave={handleSave}
      showSave={false}
    >
      <div className="form-group">
        <ToggleSwitch id="backup-enabled" checked={enabled} onChange={setEnabled} label="Enable scheduled backups" />
      </div>

      <p className="text-sm text-muted" style={{ marginTop: 0 }}>
        <strong>What gets backed up:</strong> everything in your data folder — tasks, notes and
        attachments, chat and session history, memory, config, and credentials (auth.json), so use
        a bucket only you can access. Databases are snapshotted safely while in use.
        <br />
        <strong>Skipped:</strong> caches, temp files, and search indexes — Walnut rebuilds those
        automatically. Only changed files upload after the first run.
      </p>

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="backup-bucket">Bucket</label>
          <input id="backup-bucket" type="text" value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="my-walnut-backup" />
        </div>
        <div className="form-group">
          <label htmlFor="backup-region">Region</label>
          <input id="backup-region" type="text" value={region} onChange={(e) => setRegion(e.target.value)} placeholder="us-west-2" />
        </div>
      </div>

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="backup-prefix">Prefix</label>
          <input id="backup-prefix" type="text" value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="walnut" />
          <p className="text-sm text-muted" style={{ marginTop: 2 }}>
            Folder inside the bucket. Use a distinct prefix per machine.
          </p>
        </div>
        <div className="form-group">
          <label htmlFor="backup-interval">Every N hours</label>
          <input
            id="backup-interval"
            type="number"
            min={1}
            value={intervalHours}
            onChange={(e) => setIntervalHours(Number(e.target.value))}
          />
        </div>
      </div>

      <div className="form-group">
        <label htmlFor="backup-auth-method">Credentials</label>
        <select id="backup-auth-method" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
          <option value="aws_chain">Default AWS credential chain</option>
          <option value="profile">AWS profile (~/.aws)</option>
          <option value="access_keys">Access keys</option>
        </select>
      </div>

      {method === 'profile' && (
        <div className="form-group">
          <label htmlFor="backup-profile">Profile</label>
          {profiles.length > 0 ? (
            <select id="backup-profile" value={profile} onChange={(e) => setProfile(e.target.value)}>
              <option value="">Select a profile…</option>
              {profiles.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          ) : (
            <input id="backup-profile" type="text" value={profile} onChange={(e) => setProfile(e.target.value)} placeholder="default" />
          )}
        </div>
      )}

      {method === 'access_keys' && (
        <div className="form-row">
          <div className="form-group">
            <label htmlFor="backup-access-key">Access Key ID</label>
            <input id="backup-access-key" type="text" value={accessKey} onChange={(e) => setAccessKey(e.target.value)} autoComplete="off" />
          </div>
          <div className="form-group">
            <label htmlFor="backup-secret-key">Secret Access Key</label>
            <input id="backup-secret-key" type="password" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} autoComplete="off" />
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button type="button" className="btn btn-sm" disabled={testing || !bucket.trim()} onClick={handleTest}>
          {testing ? 'Testing…' : 'Test Connection'}
        </button>
        <button type="button" className="btn btn-sm" disabled={!bucket.trim() || status?.running === true} onClick={handleRunNow}>
          {status?.running ? 'Backing up…' : 'Back Up Now'}
        </button>
      </div>

      {testResult && (
        <div className="text-sm" style={{ marginTop: 6, color: testResult.ok ? 'var(--success)' : 'var(--error)' }}>
          {testResult.ok ? `Connected as ${testResult.arn ?? 'unknown identity'}` : `Connection failed: ${testResult.error}`}
        </div>
      )}
      {runError && (
        <div className="text-sm" style={{ marginTop: 6, color: 'var(--error)' }}>{runError}</div>
      )}

      {versioningOff && (
        <div
          className="text-sm"
          style={{
            marginTop: 10, padding: '8px 10px', borderRadius: 8,
            background: 'color-mix(in srgb, var(--warning, #b58900) 12%, transparent)',
            border: '1px solid color-mix(in srgb, var(--warning, #b58900) 35%, transparent)',
          }}
        >
          Bucket versioning is <strong>off</strong> — if someone deletes or overwrites your backup, it cannot be recovered.
          Versioning keeps old copies of every file so deletion is always reversible.{' '}
          <button type="button" className="btn btn-sm" disabled={enablingVersioning} onClick={handleEnableVersioning} style={{ marginLeft: 6 }}>
            {enablingVersioning ? 'Enabling…' : 'Enable Versioning'}
          </button>
        </div>
      )}

      <div className="settings-divider" />

      <div className="text-sm text-muted">
        {status?.running && progressPct !== null ? (
          <>Backup in progress: {progressPct}% ({fmtBytes(status.progress?.uploadedBytes)} of {fmtBytes(status.progress?.totalBytes)})</>
        ) : status?.lastBackupAt ? (
          <>
            Last backup {new Date(status.lastBackupAt).toLocaleString()} · {status.lastFileCount ?? '—'} files · {fmtBytes(status.lastTotalBytes)}
            {status.versioningEnabled ? ' · versioning on' : ''}
          </>
        ) : (
          <>No backup has run yet.</>
        )}
        {status?.error && (
          <span style={{ color: 'var(--error)' }}> · Last error: {status.error}</span>
        )}
      </div>
      <p className="text-sm text-muted" style={{ marginTop: 6 }}>
        Restore from a terminal: <code>open-walnut backup restore</code> (downloads into a fresh folder, never
        overwrites live data). Or let an agent do it: the <code>restore-backup</code> skill in the repo&apos;s{' '}
        <code>skills/</code> folder walks a Claude Code session through find → restore → verify → adopt.
      </p>
    </SectionCard>
  );
}
