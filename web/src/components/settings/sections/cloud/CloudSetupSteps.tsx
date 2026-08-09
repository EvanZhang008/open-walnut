/**
 * The running-job checklist: one row per step, plus the interactions a step can
 * demand (an A record to create, a VM IP to type, a DNS override to confirm, a
 * provider token to supply).
 *
 * Row visuals follow SttSetupProgress's pattern (indicator + label + message)
 * rather than inventing a second progress idiom in Settings.
 */

import { useState } from 'react';
import {
  CLOUD_SETUP_STEP_IDS,
  type CloudSetupJob,
  type CloudSetupStepId,
  type CloudSetupStepStatus,
} from '@/api/cloud-setup';

const STEP_LABELS: Record<CloudSetupStepId, string> = {
  preflight: 'Check this machine',
  generate: 'Generate the boot script',
  provision: 'Create the server',
  'await-vm': 'Wait for your VM',
  dns: 'Point DNS at the server',
  'await-server': 'First boot (clone, build, certificate)',
  'claim-and-wire': 'Claim the companion and wire sync',
  'verify-sync': 'Verify the first sync',
  done: 'Finish',
};

const INDICATOR: Record<CloudSetupStepStatus, string> = {
  done: '✓',
  error: '✗',
  running: '○',
  skipped: '–',
  pending: '•',
};

/** A copyable value with a button that reports success in place. */
function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="cloud-copy-row">
      <span className="cloud-copy-label">{label}</span>
      <code className="cloud-copy-value">{value}</code>
      <button
        type="button"
        className="cloud-copy-btn"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(
            () => { setCopied(true); setTimeout(() => setCopied(false), 1500); },
            () => { /* clipboard blocked — the value is selectable on screen */ },
          );
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

interface Props {
  job: CloudSetupJob;
  /** Live log tail (job.logTail plus SSE deltas since the last fetch). */
  logLines: string[];
  busy: boolean;
  onProvideIp: (ip: string) => void;
  onConfirmDns: () => void;
  onProvideCredentials: (token: string) => void;
  onRetry: () => void;
  onCancel: () => void;
  onClear: () => void;
}

export function CloudSetupSteps({
  job, logLines, busy, onProvideIp, onConfirmDns, onProvideCredentials, onRetry, onCancel, onClear,
}: Props) {
  const [ip, setIp] = useState('');
  const [token, setToken] = useState('');
  const [logOpen, setLogOpen] = useState(job.status === 'failed');

  const awaiting = job.status === 'awaiting-input' ? job.awaitingInput : undefined;
  const terminal = job.status === 'failed' || job.status === 'cancelled';

  return (
    <div className="cloud-steps">
      {CLOUD_SETUP_STEP_IDS.map((id) => {
        const step = job.steps[id] ?? { status: 'pending' as const };
        const isCurrent = job.currentStep === id;
        return (
          <div key={id} className={`cloud-step cloud-step-${step.status}`} data-step={id}>
            <div className="cloud-step-header">
              <span className="cloud-step-indicator">{INDICATOR[step.status]}</span>
              <span className="cloud-step-label">{STEP_LABELS[id]}</span>
              {step.status === 'skipped' && <span className="cloud-step-tag">not needed</span>}
            </div>
            {step.error && <p className="cloud-step-errmsg">{step.error}</p>}

            {/* The A record is the one thing only the operator can do, so it gets
                the IP and the hostname side by side instead of buried in the log. */}
            {id === 'dns' && step.status === 'running' && job.domain && job.ip && (
              <div className="cloud-step-detail">
                <p className="cloud-step-note">
                  Create this record at your DNS provider — DNS-only, no CDN proxy (Caddy
                  terminates TLS itself). Walnut keeps checking until it matches.
                </p>
                <CopyRow label="Type" value="A" />
                <CopyRow label="Name" value={job.domain} />
                <CopyRow label="Value" value={job.ip} />
                <p className="cloud-step-waiting">Waiting for DNS…</p>
              </div>
            )}

            {isCurrent && awaiting && (
              <div className="cloud-step-detail cloud-step-awaiting">
                <p className="cloud-step-prompt">{awaiting.prompt}</p>

                {awaiting.kind === 'vm-ip' && (
                  <div className="devices-add-row">
                    <input
                      type="text"
                      value={ip}
                      placeholder="203.0.113.10"
                      aria-label="VM public IPv4 address"
                      onChange={(e) => setIp(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); onProvideIp(ip); }
                      }}
                    />
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={busy || !ip.trim()}
                      onClick={() => onProvideIp(ip)}
                    >
                      Continue
                    </button>
                  </div>
                )}

                {awaiting.kind === 'dns-confirm' && (
                  <button type="button" className="btn-primary" disabled={busy} onClick={onConfirmDns}>
                    I&apos;ve added the record — continue
                  </button>
                )}

                {awaiting.kind === 'credentials' && (
                  <div className="devices-add-row">
                    <input
                      type="password"
                      value={token}
                      placeholder="Provider API token"
                      aria-label="Provider API token"
                      autoComplete="off"
                      onChange={(e) => setToken(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); onProvideCredentials(token); }
                      }}
                    />
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={busy || !token.trim()}
                      onClick={() => { onProvideCredentials(token); setToken(''); }}
                    >
                      Continue
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {job.error && <p className="cloud-job-error">{job.error}</p>}

      <details className="cloud-log" open={logOpen} onToggle={(e) => setLogOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary>Setup log ({logLines.length} {logLines.length === 1 ? 'line' : 'lines'})</summary>
        <pre className="cloud-log-body">{logLines.slice(-60).join('\n') || 'No output yet.'}</pre>
      </details>

      <div className="cloud-actions">
        {job.status === 'failed' && (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={onRetry}>
            Retry this step
          </button>
        )}
        {!terminal && (
          <button type="button" className="btn" disabled={busy} onClick={onCancel}>
            Cancel setup
          </button>
        )}
        {terminal && (
          <button type="button" className="btn" disabled={busy} onClick={onClear}>
            Start over
          </button>
        )}
      </div>
    </div>
  );
}
