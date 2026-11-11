import { useCallback, useEffect, useRef, useState } from 'react';
import type { Config } from '@open-walnut/core';
import { SettingsGroup, SettingsRow } from '../SettingsSection';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { NumberInput } from '../inputs/NumberInput';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { SettingsButton } from '../inputs/SettingsButton';
import { useSettingsAutoSave } from '../inputs/useSettingsAutoSave';
import { saveErrorMessage } from '../settings-pane-context';
import { apiGet, apiPost } from '@/api/client';
import { fetchAwsProfiles } from '@/api/config';
import { remoteFormConfig, type Method, type Remote, type Target } from './history-remote-model';

interface Status { enabled: boolean; days: number; bucket: string; uploaded: number; remoteOnly: number; remoteBytes: number }
interface TestResult { ok: boolean; step?: string; error?: string; ms?: number }
interface SetupResult { ok: boolean; created?: boolean; steps?: string[]; error?: string }

const fmtBytes = (n: number) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

/**
 * Settings > Sessions > History: the tier after the archive. Sessions compressed and untouched
 * for N more days go to an S3-compatible bucket (AWS S3, Cloudflare R2, MinIO, ...) and come
 * back when opened (core/history-remote/). Saved with the other session settings.
 */
export function HistoryRemoteGroup({ config, save }: { config: Config; save: (patch: { history_remote: Remote }) => Promise<unknown> }) {
  const saved = config.session?.history_remote ?? {};
  const savedForm = () => ({
    enabled: saved.enabled === true,
    target: (saved.endpoint ? 'other' : 'aws') as Target,
    bucket: saved.bucket ?? '',
    region: saved.region ?? '',
    endpoint: saved.endpoint ?? '',
    days: saved.days,
    method: (saved.auth?.method === 'profile' ? 'profile' : 'aws_chain') as Method,
    profile: saved.auth?.profile ?? '',
  });
  const [form, setForm] = useState(savedForm);
  const set = <K extends keyof typeof form>(k: K) => (v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const [profiles, setProfiles] = useState<string[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [settingUp, setSettingUp] = useState(false);
  const [setup, setSetup] = useState<SetupResult | null>(null);

  // A config refresh re-seeds the form only when the saved setting moved.
  const prev = useRef(JSON.stringify(saved));
  useEffect(() => {
    const now = JSON.stringify(saved);
    if (now === prev.current) return;
    prev.current = now;
    setForm(savedForm());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  const loadStatus = useCallback(() => { apiGet<Status>('/api/history-remote/status').then(setStatus).catch(() => {}); }, []);
  useEffect(() => {
    loadStatus();
    fetchAwsProfiles().then(setProfiles).catch(() => {});
  }, [loadStatus]);

  const current = remoteFormConfig(form, saved);
  useSettingsAutoSave({
    current: JSON.stringify(current),
    baseline: JSON.stringify(remoteFormConfig(savedForm(), saved)),
    save: async () => { await save({ history_remote: current }); loadStatus(); },
  });

  const run = async <T,>(path: string, busy: (b: boolean) => void, done: (r: T) => void, fail: (e: string) => T) => {
    busy(true);
    try { done(await apiPost<T>(path, { setting: current }, { timeoutMs: 90000 })); } catch (e) { done(fail(saveErrorMessage(e))); } finally { busy(false); }
  };
  const noBucket = !form.bucket.trim();
  // An S3-compatible store takes 'auto' where it has no regions (R2); AWS needs one.
  const regionHint = form.endpoint.trim() && form.target !== 'aws' ? 'auto' : 'us-west-2';

  const statusLine = status
    ? status.uploaded === 0
      ? status.enabled ? `Nothing is stored remotely yet. Sessions go once compressed and untouched for ${status.days} days.` : 'Nothing is stored remotely.'
      : `${status.uploaded} ${status.uploaded === 1 ? 'session' : 'sessions'} stored remotely (${fmtBytes(status.remoteBytes)}); ${status.remoteOnly} only there.`
    : 'Reading…';

  return (
    <SettingsGroup
      heading="Remote history storage"
      data-testid="history-remote-group"
      footer={<>Walnut never puts credentials in its settings: it reads them from the AWS credential chain or a named profile in <code>~/.aws</code>. Objects stay in the bucket after a session comes back.</>}
    >
      <SettingsRow
        label="Move old history to remote storage"
        htmlFor="history-remote-enabled"
        help="A compressed session nobody opened for this many more days is uploaded, checked against its hash, and only then removed from this machine. Opening it downloads it again, checked the same way. Only this machine's own history goes there."
        control={<ToggleSwitch id="history-remote-enabled" checked={form.enabled} onChange={set('enabled')} />}
      />
      <SettingsRow
        label="After"
        htmlFor="history-remote-days"
        indent
        help="Days since a session was last touched. Empty uses 180, 0 never moves any."
        control={<NumberInput id="history-remote-days" min={0} unit="days" placeholder="180" value={form.days} onChange={set('days')} />}
      />
      <SettingsRow
        label="Storage"
        indent
        control={
          <SegmentedControl
            id="history-remote-target"
            aria-label="Storage"
            value={form.target}
            onChange={(v) => set('target')(v as Target)}
            options={[
              { value: 'aws', label: 'AWS S3', testId: 'history-remote-aws' },
              { value: 'other', label: 'Other S3-compatible', title: 'Cloudflare R2, MinIO, Backblaze B2 and the like', testId: 'history-remote-other' },
            ]}
          />
        }
      />
      {form.target === 'other' && (
        <SettingsRow
          label="Endpoint"
          htmlFor="history-remote-endpoint"
          indent
          help="The storage's S3 address, e.g. https://<account>.r2.cloudflarestorage.com."
          control={<input id="history-remote-endpoint" type="text" data-no-draft="autosave" className="settings-input settings-input--short"
            value={form.endpoint} onChange={(e) => set('endpoint')(e.target.value)} placeholder="https://" />}
        />
      )}
      <SettingsRow
        label="Bucket"
        htmlFor="history-remote-bucket"
        indent
        control={<input id="history-remote-bucket" type="text" data-no-draft="autosave" className="settings-input settings-input--short"
          value={form.bucket} onChange={(e) => set('bucket')(e.target.value)} placeholder="my-walnut-history" />}
      />
      <SettingsRow
        label="Region"
        htmlFor="history-remote-region"
        indent
        control={<input id="history-remote-region" type="text" data-no-draft="autosave" className="settings-input settings-input--short"
          value={form.region} onChange={(e) => set('region')(e.target.value)} placeholder={regionHint} />}
      />
      <SettingsRow
        label="Credentials"
        indent
        control={
          <SegmentedControl
            id="history-remote-auth"
            aria-label="Credentials"
            value={form.method}
            onChange={(v) => set('method')(v as Method)}
            options={[
              { value: 'aws_chain', label: 'Default chain', title: 'The default AWS credential chain', testId: 'history-remote-auth-chain' },
              { value: 'profile', label: 'AWS profile', title: 'A profile from ~/.aws', testId: 'history-remote-auth-profile' },
            ]}
          />
        }
      />
      {form.method === 'profile' && (
        <SettingsRow
          label="Profile"
          htmlFor="history-remote-profile"
          indent
          control={profiles.length > 0 ? (
            <select id="history-remote-profile" className="settings-select" value={form.profile} onChange={(e) => set('profile')(e.target.value)}>
              <option value="">Choose a profile</option>
              {profiles.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          ) : (
            <input id="history-remote-profile" type="text" data-no-draft="autosave" className="settings-input settings-input--short"
              value={form.profile} onChange={(e) => set('profile')(e.target.value)} placeholder="default" />
          )}
        />
      )}
      <SettingsRow
        label="Connection"
        indent
        data-testid="history-remote-connection-row"
        state={test && !test.ok ? 'error' : undefined}
        help={test
          ? test.ok ? `Works: wrote, read back and removed a test object in ${Math.round((test.ms ?? 0) / 100) / 10} s.` : `Couldn't ${test.step ?? 'connect'}: ${test.error}`
          : 'Writes, reads back and removes one small test object.'}
        control={
          <SettingsButton onClick={() => run<TestResult>('/api/history-remote/test', setTesting, setTest, (error) => ({ ok: false, error }))}
            disabled={noBucket} title={noBucket ? 'Enter a bucket first.' : undefined} busy={testing} busyLabel="Testing..." data-testid="history-remote-test">
            Test connection
          </SettingsButton>
        }
      />
      {form.target === 'aws' && (
        <SettingsRow
          label="Set up the bucket"
          indent
          data-testid="history-remote-setup-row"
          state={setup && !setup.ok ? 'error' : undefined}
          help={setup
            ? setup.ok ? `Done: ${(setup.steps ?? []).join(', ')}.` : `Couldn't set it up: ${setup.error}`
            : 'Creates it if missing, private and encrypted. On a bucket that exists, only adds Walnut\'s rule moving its history to the cheaper Standard-IA class after 30 days; its other settings and rules stay as they are.'}
          control={
            <SettingsButton onClick={() => run<SetupResult>('/api/history-remote/setup', setSettingUp, setSetup, (error) => ({ ok: false, error }))}
              disabled={noBucket} title={noBucket ? 'Enter a bucket first.' : undefined} busy={settingUp} busyLabel="Setting up..." data-testid="history-remote-setup">
              Set up
            </SettingsButton>
          }
        />
      )}
      <SettingsRow label="Stored remotely" indent help={statusLine} data-testid="history-remote-status" control={null} />
    </SettingsGroup>
  );
}
