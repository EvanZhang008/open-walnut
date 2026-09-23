import { useCallback, useEffect, useRef, useState } from 'react';
import type { Config } from '@open-walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { SettingsGroup, SettingsRow } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { NumberInput } from '../inputs/NumberInput';
import { SecretInput } from '../inputs/SecretInput';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { useSettingsAutoSave } from '../inputs/useSettingsAutoSave';
import { saveErrorMessage } from '../settings-pane-context';
import { formatAbsoluteTime } from './addons-format';
import { apiGet, apiPost } from '@/api/client';
import { fetchAwsProfiles } from '@/api/config';
import { useEvent } from '@/hooks/useWebSocket';
import '@/styles/settings-sections-addons.css';

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
  n === undefined ? 'unknown size' : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;

export function BackupSection({ config, onSave }: Props) {
  const saved = config.backup ?? {};
  const [enabled, setEnabled] = useState(saved.enabled ?? false);
  const [bucket, setBucket] = useState(saved.bucket ?? '');
  const [region, setRegion] = useState(saved.region ?? 'us-west-2');
  const [prefix, setPrefix] = useState(saved.prefix ?? 'walnut');
  // Empty while the user retypes it; a save falls back to 24.
  const [intervalHours, setIntervalHours] = useState<number | undefined>(saved.interval_hours ?? 24);
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

  // A config refresh re-seeds only the fields whose SAVED value moved: the
  // refresh after one field's auto-save must not wipe text typed meanwhile in
  // another (the bucket typed while the master switch's save was in flight).
  const prevSaved = useRef(saved);
  useEffect(() => {
    const p = prevSaved.current;
    prevSaved.current = saved;
    if (p === saved) return;
    const moved = <T,>(a: T, b: T, set: (v: T) => void) => { if (a !== b) set(b); };
    moved(p.enabled ?? false, saved.enabled ?? false, setEnabled);
    moved(p.bucket ?? '', saved.bucket ?? '', setBucket);
    moved(p.region ?? 'us-west-2', saved.region ?? 'us-west-2', setRegion);
    moved(p.prefix ?? 'walnut', saved.prefix ?? 'walnut', setPrefix);
    moved(p.interval_hours ?? 24, saved.interval_hours ?? 24, setIntervalHours);
    moved(p.auth?.method ?? 'aws_chain', saved.auth?.method ?? 'aws_chain', setMethod);
    moved(p.auth?.profile ?? '', saved.auth?.profile ?? '', setProfile);
    moved(p.auth?.aws_access_key_id ?? '', saved.auth?.aws_access_key_id ?? '', setAccessKey);
    moved(p.auth?.aws_secret_access_key ?? '', saved.auth?.aws_secret_access_key ?? '', setSecretKey);
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

  useSettingsAutoSave({
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
      setTestResult({ ok: false, error: saveErrorMessage(err) });
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
      setRunError(saveErrorMessage(err));
    }
  };

  const handleEnableVersioning = async () => {
    setEnablingVersioning(true);
    try {
      await apiPost('/api/backup/enable-versioning', formConfig(), { timeoutMs: 45000 });
      setStatus((prev) => (prev ? { ...prev, versioningEnabled: true } : prev));
      setTestResult((prev) => (prev ? { ...prev, versioningEnabled: true } : prev));
    } catch (err) {
      setRunError(saveErrorMessage(err));
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


  const lastBackupHelp = status?.running && progressPct !== null
    ? `In progress: ${progressPct}% (${fmtBytes(status.progress?.uploadedBytes)} of ${fmtBytes(status.progress?.totalBytes)})`
    : status?.lastBackupAt
      ? [
          formatAbsoluteTime(status.lastBackupAt),
          `${status.lastFileCount ?? 0} files`,
          fmtBytes(status.lastTotalBytes),
          ...(status.versioningEnabled ? ['versioning on'] : []),
        ].join(', ')
      : 'No backup has run yet.';
  const lastError = status?.error ? `Last error: ${status.error}` : runError;

  return (
    <SectionCard id="backup" title="S3 Backup" onSave={handleSave} showSave={false}>
      <SettingsGroup footer={<>What gets backed up: everything in your data folder, credentials (<code>auth.json</code>) included, so use a bucket only you can access.</>}>
        <SettingsRow
          label="Scheduled backups"
          htmlFor="backup-enabled"
          help="Only changed files upload after the first run; caches and search indexes are skipped."
          control={<ToggleSwitch id="backup-enabled" checked={enabled} onChange={setEnabled} />}
        />
      </SettingsGroup>

      <SettingsGroup heading="Destination">
        <SettingsRow
          label="Bucket"
          htmlFor="backup-bucket"
          control={
            <input id="backup-bucket" type="text" className="settings-input settings-input--short"
              value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="my-walnut-backup" />
          }
        />
        <SettingsRow
          label="Region"
          htmlFor="backup-region"
          control={
            <input id="backup-region" type="text" className="settings-input settings-input--short"
              value={region} onChange={(e) => setRegion(e.target.value)} placeholder="us-west-2" />
          }
        />
        <SettingsRow
          label="Prefix"
          htmlFor="backup-prefix"
          help="Folder inside the bucket; use a distinct prefix per machine."
          control={
            <input id="backup-prefix" type="text" className="settings-input settings-input--short"
              value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="walnut" />
          }
        />
        <SettingsRow
          label="Every"
          htmlFor="backup-interval"
          control={
            <NumberInput id="backup-interval" min={1} unit="hours" value={intervalHours}
              onChange={setIntervalHours} />
          }
        />
      </SettingsGroup>

      <SettingsGroup heading="Credentials">
        <SettingsRow
          label="Method"
          control={
            <SegmentedControl
              id="backup-auth-method"
              aria-label="Credentials method"
              value={method}
              onChange={(v) => setMethod(v)}
              options={[
                { value: 'aws_chain', label: 'Default chain', title: 'The default AWS credential chain', testId: 'backup-auth-aws_chain' },
                { value: 'profile', label: 'AWS profile', title: 'A profile from ~/.aws', testId: 'backup-auth-profile' },
                { value: 'access_keys', label: 'Access keys', testId: 'backup-auth-access_keys' },
              ]}
            />
          }
        />
        {method === 'profile' && (
          <SettingsRow
            label="Profile"
            htmlFor="backup-profile"
            indent
            control={profiles.length > 0 ? (
              <select id="backup-profile" className="settings-select" value={profile} onChange={(e) => setProfile(e.target.value)}>
                <option value="">Choose a profile</option>
                {profiles.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            ) : (
              <input id="backup-profile" type="text" className="settings-input settings-input--short"
                value={profile} onChange={(e) => setProfile(e.target.value)} placeholder="default" />
            )}
          />
        )}
        {method === 'access_keys' && (
          <>
            <SettingsRow
              label="Access key ID"
              htmlFor="backup-access-key"
              indent
              control={
                <input id="backup-access-key" type="text" className="settings-input settings-input--short settings-input--mono"
                  value={accessKey} onChange={(e) => setAccessKey(e.target.value)} autoComplete="off" />
              }
            />
            <SettingsRow
              label="Secret access key"
              htmlFor="backup-secret-key"
              indent
              control={<SecretInput id="backup-secret-key" value={secretKey} onChange={setSecretKey} />}
            />
          </>
        )}
        <SettingsRow
          label="Connection"
          help={testResult
            ? testResult.ok ? `Connected as ${testResult.arn ?? 'unknown identity'}` : `Couldn't connect: ${testResult.error}`
            : 'Checks the bucket with these credentials.'}
          state={testResult && !testResult.ok ? 'error' : undefined}
          data-testid="backup-connection-row"
          control={
            <SettingsButton onClick={handleTest} disabled={!bucket.trim()} title={bucket.trim() ? undefined : 'Enter a bucket first.'} busy={testing} busyLabel="Testing..."
              data-testid="backup-test-connection">
              Test connection
            </SettingsButton>
          }
        />
      </SettingsGroup>

      {versioningOff && (
        // A warning row in a group, on the 14px inset and the control column (F35).
        <SettingsGroup data-testid="backup-versioning-off">
          <SettingsRow
            state="warning"
            label="Bucket versioning is off"
            help="A deleted or overwritten backup can't be recovered."
            control={
              <SettingsButton onClick={handleEnableVersioning} busy={enablingVersioning} busyLabel="Enabling...">
                Enable versioning
              </SettingsButton>
            }
          />
        </SettingsGroup>
      )}

      <SettingsGroup
        footer={
          <>
            Restore from a terminal with <code>open-walnut backup restore</code>, or paste the{' '}
            <a
              href="https://github.com/EvanZhang008/open-walnut/blob/main/skills/restore-backup/SKILL.md"
              target="_blank"
              rel="noreferrer"
            >
              restore-backup skill
            </a>{' '}
            into a Claude Code session.
          </>
        }
      >
        <SettingsRow
          label="Last backup"
          // A greyed Back up now says why, in the row, not only on hover (N3-31).
          help={!bucket.trim() && !status?.lastBackupAt ? 'Enter a bucket above to back up.' : lastBackupHelp}
          error={lastError ?? undefined}
          data-testid="backup-last-row"
          control={
            <SettingsButton onClick={handleRunNow} disabled={!bucket.trim()} title={bucket.trim() ? undefined : 'Enter a bucket first.'} busy={status?.running === true}
              busyLabel="Backing up..." data-testid="backup-run-now">
              Back up now
            </SettingsButton>
          }
        />
      </SettingsGroup>
    </SectionCard>
  );
}
