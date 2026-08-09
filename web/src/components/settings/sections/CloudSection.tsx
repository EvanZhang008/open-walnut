/**
 * Settings → Cloud Companion: the wizard over /api/cloud-setup.
 *
 * The job lives on the SERVER, not in this component — a provision takes 10+
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
import {
  cancelJob,
  clearJob,
  getJob,
  getProviders,
  provideInput,
  retryJob,
  startSetup,
  streamJob,
  type CloudSetupJob,
  type CloudSetupProvider,
} from '@/api/cloud-setup';
import { useEvent } from '@/hooks/useWebSocket';
import { log } from '@/utils/log';
import { SectionCard } from '../inputs/SectionCard';
import { CloudConfigureForm, type ConfigureValues } from './cloud/CloudConfigureForm';
import { CloudManualPaste } from './cloud/CloudManualPaste';
import { CloudProviderPicker } from './cloud/CloudProviderPicker';
import { CloudSetupSteps } from './cloud/CloudSetupSteps';
import { PairPhoneCard } from './cloud/PairPhoneCard';

/** Wizard position while no job exists yet. A live job overrides all of these. */
type Stage = 'hero' | 'picker' | 'configure';

const EMPTY_VALUES: ConfigureValues = {
  domainMode: 'own-domain',
  domain: '',
  region: '',
  instanceType: '',
  credentials: '',
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

  const refreshJob = useCallback(async (): Promise<CloudSetupJob | null> => {
    try {
      const next = await getJob();
      setJob(next);
      // logTail is the authoritative tail; SSE deltas append to it between fetches.
      if (next) setLogLines(next.logTail ?? []);
      return next;
    } catch (err) {
      log.warn('cloud-setup', 'job fetch failed', { error: String(err) });
      return null;
    }
  }, []);

  // Mount probe: is a job in flight, and is a companion already wired up?
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [, targets] = await Promise.all([
        refreshJob(),
        apiGet<{ targets?: { kind: string; origin: string }[] }>('/api/devices').catch(() => ({ targets: [] })),
      ]);
      if (cancelled) return;
      setCloudOrigin(targets.targets?.find((t) => t.kind === 'cloud')?.origin ?? null);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [refreshJob]);

  // Live progress. Attaching unconditionally (not only while a job runs) means a
  // job started from another surface — the butler skill, a second tab — lights
  // this panel up without a reload.
  useEffect(() => {
    const close = streamJob({
      onSnapshot: (snapshot) => {
        setJob(snapshot);
        setLogLines(snapshot.logTail ?? []);
      },
      onProgress: (progress) => {
        setJob((prev) => {
          // A progress frame for a job we've never fetched (started elsewhere):
          // pull the full state rather than rendering half of it.
          if (!prev || prev.id !== progress.jobId) {
            void refreshJob();
            return prev;
          }
          return {
            ...prev,
            status: progress.status,
            currentStep: progress.currentStep,
            steps: progress.steps,
            awaitingInput: progress.awaitingInput,
            error: progress.error,
            updatedAt: progress.updatedAt,
          };
        });
        if (progress.logLines?.length) {
          setLogLines((prev) => [...prev, ...progress.logLines!].slice(-200));
        }
      },
      onEventId: (id) => { lastEventIdRef.current = id; },
      onError: () => {
        // The stream is best-effort; the bus event below is the belt.
        log.warn('cloud-setup', 'progress stream dropped — relying on bus events');
      },
    }, lastEventIdRef.current);
    return close;
  }, [refreshJob]);

  // Belt for a dropped/absent stream: the bus event carries only ids, so refetch.
  useEvent('cloud-setup:update', () => { void refreshJob(); });

  const loadProviders = useCallback(async () => {
    setError(null);
    try {
      const res = await getProviders();
      setProviders(res.providers);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

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
        ...(values.credentials ? { credentials: values.credentials } : {}),
      });
      setJob(res.job);
      setLogLines(res.job.logTail ?? []);
      // The token was handed to the server; don't keep a copy in React state.
      setValues((prev) => ({ ...prev, credentials: '' }));
      log.info('cloud-setup', 'setup started', { jobId: res.job.id, provider: res.job.provider });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [selected, values]);

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
        setJob(res.job);
        setLogLines(res.job.logTail ?? []);
      } else {
        setJob(null);
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
  }, [job?.id, refreshJob]);

  const selectedProvider = providers?.find((p) => p.id === selected) ?? null;

  const view: 'loading' | 'live' | 'done' | 'configured' | Stage = loading
    ? 'loading'
    : isLive(job) || job?.status === 'failed' || job?.status === 'cancelled'
      ? 'live'
      : job?.status === 'done'
        ? 'done'
        : cloudOrigin
          ? 'configured'
          : stage;

  return (
    <SectionCard
      id="cloud"
      title="Cloud Companion"
      description="Your own cloud instance of Walnut — reachable from your phone anywhere, and the sync hub for your data. Walnut sets it up end to end."
    >
      <div className="cloud-section">
        {view === 'loading' && <p className="cloud-hint">Checking for an existing setup…</p>}

        {view === 'hero' && (
          <div className="cloud-hero">
            <h4 className="cloud-hero-title">Set up your own cloud companion</h4>
            <p className="cloud-hero-body">
              Walnut provisions a small server, gets it a certificate, claims it, and wires your data
              repo to it. Own domain or a free auto-address — both take one pass through this wizard.
            </p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => { setStage('picker'); void loadProviders(); }}
            >
              Get started
            </button>
            <p className="cloud-hint">
              You can also ask your butler: &ldquo;set up my cloud companion&rdquo;.
            </p>
          </div>
        )}

        {view === 'picker' && (
          <div className="cloud-picker">
            <p className="cloud-hint">Where should the companion live?</p>
            {providers === null && !error && <p className="cloud-hint">Checking your credentials…</p>}
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
            {error && <p className="devices-error">{error}</p>}
            <div className="cloud-actions">
              <button type="button" className="btn" onClick={() => setStage('hero')}>Back</button>
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
            busy={busy}
            error={error}
          />
        )}

        {view === 'live' && job && (
          <>
            <p className="cloud-live-head">
              {job.status === 'failed'
                ? 'Setup stopped at a step that needs attention.'
                : job.status === 'cancelled'
                  ? 'Setup was cancelled.'
                  : job.status === 'awaiting-input'
                    ? 'Setup is waiting on you.'
                    : 'Setting up your companion — you can close this tab, it keeps going.'}
              {job.domain && <> Target: <code>{job.domain}</code>.</>}
            </p>
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
            {error && <p className="devices-error">{error}</p>}
          </>
        )}

        {view === 'done' && job && (
          <div className="cloud-done">
            <div className="settings-banner settings-banner-success">
              Your cloud companion is live{job.domain ? ` at ${job.domain}` : ''}.
            </div>
            <p className="cloud-done-body">
              Data sync is wired to it and the first push succeeded. Pair a phone below, then reach
              Walnut from anywhere.
            </p>
            <PairPhoneCard domain={job.domain} />
            <details className="cloud-log">
              <summary>Setup log ({logLines.length} lines)</summary>
              <pre className="cloud-log-body">{logLines.slice(-60).join('\n')}</pre>
            </details>
            <div className="cloud-actions">
              <button type="button" className="btn" disabled={busy} onClick={() => void act('clear', clearJob)}>
                Dismiss
              </button>
            </div>
            {error && <p className="devices-error">{error}</p>}
          </div>
        )}

        {view === 'configured' && (
          <div className="cloud-configured">
            <div className="settings-banner settings-banner-success">
              Cloud sync is configured — <code>{cloudOrigin?.replace(/^https?:\/\//, '')}</code>
            </div>
            <p className="cloud-hint">
              Pair phones from the Devices section above; they&apos;ll point at this companion and work
              off Wi-Fi. Replacing an existing companion isn&apos;t supported from this screen yet —
              remove the cloud git remote first if you need to start over.
            </p>
          </div>
        )}
      </div>
    </SectionCard>
  );
}
