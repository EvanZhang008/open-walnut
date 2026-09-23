/**
 * Settings: Cloud Companion, the wizard over /api/cloud-setup.
 *
 * The job lives on the SERVER, not in this component: a provision takes 10+
 * minutes and must survive a tab reload, so every screen here is derived from
 * GET /job plus the replayable 'cloud-setup' SSE stream. Local state holds only
 * what the operator has typed but not yet submitted.
 *
 * Screen selection (single source of truth, `view` below):
 *   no job      → hero / picker / configure, by how far the operator has walked
 *   live job    → step list (+ the manual paste panel while it wants an IP)
 *   done        → success + inline phone pairing
 *   configured  → status card (cloud sync already wired, nothing in flight)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet } from '@/api/client';
import { fetchDevicesList } from './cloud/devices-list';
import {
  cancelJob,
  clearJob,
  getJob,
  getProviders,
  provideInput,
  retryJob,
  startSetup,
  streamJob,
  CLOUD_SETUP_LOG_TAIL_MAX,
  type CloudSetupJob,
  type CloudSetupJobStatus,
  type CloudSetupProvider,
  type CloudSetupStepId,
} from '@/api/cloud-setup';
import { useEvent } from '@/hooks/useWebSocket';
import { log } from '@/utils/log';
import { SectionCard } from '../inputs/SectionCard';
import { SettingsGroup, SettingsRow, SettingsTag, SettingsNotice, SettingsLoadingRow } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { CloudConfigureForm, type ConfigureValues } from './cloud/CloudConfigureForm';
import { CloudManualPaste } from './cloud/CloudManualPaste';
import { CloudProviderPicker } from './cloud/CloudProviderPicker';
import { CloudSetupSteps, SetupLog } from './cloud/CloudSetupSteps';
import { PairPhoneCard } from './cloud/PairPhoneCard';

/** Wizard position while no job exists yet. A live job overrides all of these. */
type Stage = 'hero' | 'picker' | 'configure';

const EMPTY_VALUES: ConfigureValues = {
  domainMode: 'own-domain',
  domain: '',
  region: '',
  instanceType: '',
  credentials: '',
  profile: '',
};

/** A job in one of these states is the screen; the stage machine is bypassed. */
function isLive(job: CloudSetupJob | null): boolean {
  return job != null && (job.status === 'running' || job.status === 'awaiting-input');
}

export function CloudSection() {
  const [job, setJob] = useState<CloudSetupJob | null>(null);
  const [providers, setProviders] = useState<CloudSetupProvider[] | null>(null);
  const [stage, setStage] = useState<Stage>('hero');
  const [selected, setSelected] = useState<string | null>(null);
  const [values, setValues] = useState<ConfigureValues>(EMPTY_VALUES);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** Cloud sync already configured (a `cloud` pairing target exists). */
  const [cloudOrigin, setCloudOrigin] = useState<string | null>(null);

  /** Last SSE id, so a remount resumes from the ring instead of re-reading all. */
  const lastEventIdRef = useRef<string | undefined>(undefined);
  /**
   * Mirror of `job` readable from the stream/bus callbacks. Those fire far more
   * often than React re-renders and must compare against the live job without
   * re-subscribing on every state change.
   */
  const jobRef = useRef<CloudSetupJob | null>(null);
  /** Collapses overlapping refreshJob calls — both callers arrive in bursts. */
  const refreshInFlightRef = useRef<Promise<CloudSetupJob | null> | null>(null);
  /** True while the SSE stream is delivering; false once it errors out. */
  const streamLiveRef = useRef(false);

  /** Single writer for the job, so `jobRef` can never lag `job`. */
  const commitJob = useCallback((next: CloudSetupJob | null) => {
    jobRef.current = next;
    setJob(next);
  }, []);

  const refreshJob = useCallback(async (): Promise<CloudSetupJob | null> => {
    // GET /job carries the whole logTail, so a burst of callers must share one
    // fetch rather than each pulling their own copy.
    const inFlight = refreshInFlightRef.current;
    if (inFlight) return inFlight;
    const pending = (async () => {
      try {
        const next = await getJob();
        commitJob(next);
        // logTail is the authoritative tail; SSE deltas append to it between fetches.
        if (next) setLogLines(next.logTail ?? []);
        return next;
      } catch (err) {
        log.warn('cloud-setup', 'job fetch failed', { error: String(err) });
        return null;
      } finally {
        refreshInFlightRef.current = null;
      }
    })();
    refreshInFlightRef.current = pending;
    return pending;
  }, [commitJob]);

  // Mount probe: is a job in flight, and is a companion already wired up?
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [, targets] = await Promise.all([
        refreshJob(),
        fetchDevicesList<{ targets?: { kind: string; origin: string }[] }>().catch(() => ({ targets: [] })),
      ]);
      if (cancelled) return;
      setCloudOrigin(targets.targets?.find((t) => t.kind === 'cloud')?.origin ?? null);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [refreshJob]);

  // Live progress. Attaching unconditionally (not only while a job runs) means a
  // job started from another surface — the Personal AI skill, a second tab — lights
  // this panel up without a reload.
  useEffect(() => {
    const close = streamJob({
      onSnapshot: (snapshot) => {
        streamLiveRef.current = true;
        commitJob(snapshot);
        setLogLines(snapshot.logTail ?? []);
      },
      onProgress: (progress) => {
        streamLiveRef.current = true;
        const prev = jobRef.current;
        // A progress frame for a job we've never fetched (started elsewhere):
        // pull the full state rather than rendering half of it. The latch inside
        // refreshJob keeps the frame burst down to one fetch.
        if (!prev || prev.id !== progress.jobId) {
          void refreshJob();
          // Lines from a job we're not rendering would contaminate the tail of
          // the one we are; the fetch brings the right tail with it.
          return;
        }
        commitJob({
          ...prev,
          status: progress.status,
          currentStep: progress.currentStep,
          steps: progress.steps,
          awaitingInput: progress.awaitingInput,
          error: progress.error,
          updatedAt: progress.updatedAt,
        });
        if (progress.logLines?.length) {
          setLogLines((lines) => [...lines, ...progress.logLines!].slice(-CLOUD_SETUP_LOG_TAIL_MAX));
        }
      },
      onEventId: (id) => { lastEventIdRef.current = id; },
      onError: () => {
        // The stream is best-effort; the bus event below is the belt.
        streamLiveRef.current = false;
        log.warn('cloud-setup', 'progress stream dropped, relying on bus events');
      },
    }, lastEventIdRef.current);
    return () => {
      streamLiveRef.current = false;
      close();
    };
  }, [commitJob, refreshJob]);

  // Belt for a dropped/absent stream. The server also emits this event on every
  // 250ms log batch, so an ungated refetch would mean several full GET /job
  // (each carrying the whole logTail) per second for the minutes a deploy runs.
  // Refetch only for what the belt exists to catch: a status/step transition the
  // stream didn't deliver, a job id we don't know, or a dead stream.
  useEvent('cloud-setup:update', (data) => {
    const payload = data as { jobId?: string; status?: CloudSetupJobStatus; currentStep?: CloudSetupStepId } | null;
    const current = jobRef.current;
    const transitioned = !current
      || current.id !== payload?.jobId
      || current.status !== payload?.status
      || current.currentStep !== payload?.currentStep;
    if (transitioned || !streamLiveRef.current) void refreshJob();
  });

  /**
   * `awsProfile` re-probes the aws driver with that profile, which is how the
   * card's verdict changes from "signed out" to the account it authenticated.
   */
  const loadProviders = useCallback(async (awsProfile?: string) => {
    setError(null);
    try {
      const res = await getProviders(awsProfile);
      setProviders(res.providers);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  /** Re-probe with the newly chosen profile; the card verdict updates in place. */
  const handleProfileChange = useCallback(async (profile: string) => {
    setValues((prev) => ({ ...prev, profile }));
    setBusy(true);
    try {
      await loadProviders(profile || undefined);
    } finally {
      setBusy(false);
    }
  }, [loadProviders]);

  const handleStart = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const res = await startSetup({
        provider: selected as CloudSetupProvider['id'],
        domainMode: values.domainMode,
        ...(values.domainMode === 'own-domain' && values.domain ? { domain: values.domain } : {}),
        ...(values.region ? { region: values.region } : {}),
        ...(values.instanceType ? { instanceType: values.instanceType } : {}),
        ...(values.profile ? { profile: values.profile } : {}),
        ...(values.credentials ? { credentials: values.credentials } : {}),
      });
      commitJob(res.job);
      setLogLines(res.job.logTail ?? []);
      // The token was handed to the server; don't keep a copy in React state.
      setValues((prev) => ({ ...prev, credentials: '' }));
      log.info('cloud-setup', 'setup started', { jobId: res.job.id, provider: res.job.provider });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [selected, values, commitJob]);

  /** Every job action shares this shape: run it, adopt the returned state. */
  const act = useCallback(async (
    name: string,
    fn: () => Promise<{ job: CloudSetupJob } | { ok: boolean }>,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if ('job' in res) {
        commitJob(res.job);
        setLogLines(res.job.logTail ?? []);
      } else {
        commitJob(null);
        setLogLines([]);
        setStage('hero');
        setSelected(null);
        setValues(EMPTY_VALUES);
      }
      log.info('cloud-setup', `action ${name}`, { jobId: job?.id ?? null });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // A rejected action may mean our view is stale (e.g. 409 not-awaiting).
      void refreshJob();
    } finally {
      setBusy(false);
    }
  }, [job?.id, refreshJob, commitJob]);

  const selectedProvider = providers?.find((p) => p.id === selected) ?? null;

  /** A finished-unhappily job record. Kept, but it must not outrank reality. */
  const terminalJob = job?.status === 'failed' || job?.status === 'cancelled';

  const view: 'loading' | 'live' | 'done' | 'configured' | Stage = loading
    ? 'loading'
    : isLive(job)
      ? 'live'
      : job?.status === 'done'
        ? 'done'
        // A working companion outranks a stale failed/cancelled record: an
        // operator whose cloud sync is fine shouldn't land on a failure screen
        // from a setup they already worked around. The record stays dismissible
        // from the configured card below.
        : cloudOrigin
          ? 'configured'
          : terminalJob
            ? 'live'
            : stage;

  const errorNotice = error ? <SettingsNotice kind="error" role="alert">{error}</SettingsNotice> : null;
  const liveHead = job?.status === 'failed'
    ? 'Setup stopped at a step that needs attention.'
    : job?.status === 'cancelled'
      ? 'Setup was cancelled.'
      : job?.status === 'awaiting-input'
        ? 'Setup is waiting on you.'
        : 'Setting up your companion; you can close this tab and it keeps going.';

  return (
    <SectionCard
      id="cloud"
      title="Cloud Companion"
      description="A server you run in the cloud keeps sessions reachable from your phone while this Mac sleeps."
    >
      <div className="cloud-section">
        {view === 'loading' && (
          <SettingsGroup>
            <SettingsLoadingRow>Checking for an existing setup...</SettingsLoadingRow>
          </SettingsGroup>
        )}

        {view === 'hero' && (
          <SettingsGroup
            heading="Set up"
            className="cloud-hero"
            footer={<>You can also tell Ask Walnut: &ldquo;set up my cloud companion&rdquo;.</>}
          >
            <SettingsRow
              label="Your own cloud companion"
              help="Walnut provisions a small server, gets it a certificate, claims it and wires your data repo to it."
              control={
                <SettingsButton variant="primary" onClick={() => { setStage('picker'); void loadProviders(); }}>
                  Get started
                </SettingsButton>
              }
            />
          </SettingsGroup>
        )}

        {view === 'picker' && (
          <div className="cloud-picker">
            {providers === null && !error && (
              <SettingsGroup heading="Where should the companion live?">
                <SettingsLoadingRow>Checking your credentials...</SettingsLoadingRow>
              </SettingsGroup>
            )}
            {providers !== null && (
              <CloudProviderPicker
                providers={providers}
                selected={selected}
                onSelect={(id) => {
                  setSelected(id);
                  setStage('configure');
                  // sslip needs no registrar, so it's the sane default for a
                  // driver the operator can't one-click provision anyway.
                  const p = providers.find((x) => x.id === id);
                  if (p && !p.canProvision) setValues((prev) => ({ ...prev, domainMode: 'sslip' }));
                }}
              />
            )}
            {errorNotice}
            <div className="cloud-actions settings-addons-actions">
              <SettingsButton onClick={() => setStage('hero')}>Back</SettingsButton>
            </div>
          </div>
        )}

        {view === 'configure' && selectedProvider && (
          <CloudConfigureForm
            provider={selectedProvider}
            values={values}
            onChange={setValues}
            onBack={() => { setStage('picker'); setError(null); }}
            onStart={() => void handleStart()}
            onProfileChange={(p) => void handleProfileChange(p)}
            busy={busy}
            error={error}
          />
        )}

        {view === 'live' && job && (
          <>
            <SettingsGroup>
              <SettingsRow
                className="cloud-live-head"
                label={liveHead}
                help={job.domain ? <code className="settings-addons-mono">{job.domain}</code> : undefined}
              />
            </SettingsGroup>
            {/* The paste path only makes sense while the box doesn't exist yet. */}
            {!job.ip && job.steps.provision?.status !== 'done' && job.awaitingInput?.kind === 'vm-ip' && (
              <CloudManualPaste job={job} />
            )}
            <CloudSetupSteps
              job={job}
              logLines={logLines}
              busy={busy}
              onProvideIp={(ip) => void act('provide-ip', () => provideInput({ ip }))}
              onConfirmDns={() => void act('confirm-dns', () => provideInput({ confirmDnsSkip: true }))}
              onProvideCredentials={(credentials) => void act('provide-credentials', () => provideInput({ credentials }))}
              onRetry={() => void act('retry', retryJob)}
              onCancel={() => void act('cancel', cancelJob)}
              onClear={() => void act('clear', clearJob)}
            />
            {errorNotice}
          </>
        )}

        {view === 'done' && job && (
          <div className="cloud-done">
            <SettingsGroup>
              <SettingsRow
                label="Your cloud companion is live"
                help={job.domain
                  ? <><code className="settings-addons-mono">{job.domain}</code>; data sync is wired and the first push succeeded.</>
                  : 'Data sync is wired and the first push succeeded.'}
                control={<SettingsTag tone="success">Connected</SettingsTag>}
              />
            </SettingsGroup>
            <PairPhoneCard domain={job.domain} />
            <SettingsGroup>
              <SetupLog lines={logLines} />
            </SettingsGroup>
            <div className="cloud-actions settings-addons-actions">
              <SettingsButton disabled={busy} onClick={() => void act('clear', clearJob)}>Dismiss</SettingsButton>
            </div>
            {errorNotice}
          </div>
        )}

        {view === 'configured' && (
          <SettingsGroup
            className="cloud-configured"
            footer="Replacing a companion isn't supported here yet; remove the cloud git remote first to start over."
          >
            <SettingsRow
              label="Cloud sync"
              help={<code className="settings-addons-mono">{cloudOrigin?.replace(/^https?:\/\//, '')}</code>}
              control={<SettingsTag tone="success">Connected</SettingsTag>}
            />
            <SettingsRow
              label="Phones"
              help={<>Pair phones under Paired phones; they point at this companion and work off <span className="settings-nowrap">Wi-Fi</span>.</>}
            />
            {terminalJob && (
              <SettingsRow
                label="Old setup attempt"
                help={`An earlier attempt ${job?.status === 'failed' ? 'failed' : 'was cancelled'}; your companion works, so you can clear it.`}
                control={
                  <SettingsButton disabled={busy} onClick={() => void act('clear', clearJob)}>
                    Clear old attempt
                  </SettingsButton>
                }
              />
            )}
          </SettingsGroup>
        )}
        {view === 'configured' && errorNotice}
      </div>
    </SectionCard>
  );
}
