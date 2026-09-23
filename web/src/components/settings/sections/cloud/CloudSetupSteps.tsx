/**
 * The running-job checklist: one row per step, plus the interactions a step can
 * demand (an A record to create, a VM IP to type, a DNS override to confirm, a
 * provider token to supply).
 *
 * Each step is a row of one group with a status tag; details a step asks for
 * are indented rows under it, never a nested box.
 */

import { Fragment, useState } from 'react';
import {
  CLOUD_SETUP_STEP_IDS,
  type CloudSetupJob,
  type CloudSetupStepId,
  type CloudSetupStepStatus,
} from '@/api/cloud-setup';
import { SettingsGroup, SettingsRow, SettingsTag, SettingsDisclosure, SettingsMonoBlock } from '../../SettingsSection';
import { SettingsButton } from '../../inputs/SettingsButton';
import { CopyButton } from '../../inputs/CopyButton';
import '@/styles/settings-sections-addons.css';

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

const STATUS_TAG: Record<CloudSetupStepStatus, { text: string; tone: 'neutral' | 'warning' | 'success' } | null> = {
  done: { text: 'Done', tone: 'success' },
  error: { text: 'Failed', tone: 'warning' },
  running: { text: 'Running', tone: 'neutral' },
  skipped: { text: 'Not needed', tone: 'neutral' },
  pending: null,
};

/** A copyable value as an indented row. */
function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <SettingsRow
      indent
      className="cloud-copy-row"
      label={label}
      help={<code className="cloud-copy-value settings-addons-mono">{value}</code>}
      control={<CopyButton text={value} />}
    />
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

  const awaiting = job.status === 'awaiting-input' ? job.awaitingInput : undefined;
  const terminal = job.status === 'failed' || job.status === 'cancelled';

  return (
    <>
      <SettingsGroup className="cloud-steps">
        {CLOUD_SETUP_STEP_IDS.map((id) => {
          const step = job.steps[id] ?? { status: 'pending' as const };
          const isCurrent = job.currentStep === id;
          const tag = STATUS_TAG[step.status];
          return (
            <Fragment key={id}>
              <SettingsRow
                className={`cloud-step cloud-step-${step.status}`}
                data-step={id}
                label={<span className="cloud-step-label">{STEP_LABELS[id]}</span>}
                error={step.error || undefined}
                control={tag ? <SettingsTag tone={tag.tone}>{tag.text}</SettingsTag> : undefined}
              />

              {/* The A record is the one thing only the operator can do, so it gets
                  the IP and the hostname side by side instead of buried in the log. */}
              {id === 'dns' && step.status === 'running' && job.domain && job.ip && (
                <>
                  <SettingsRow
                    indent
                    className="cloud-step-note"
                    label="Create this record at your DNS provider"
                    help="DNS only, no CDN proxy (Caddy terminates TLS itself); Walnut keeps checking until it matches."
                  />
                  <CopyRow label="Type" value="A" />
                  <CopyRow label="Name" value={job.domain} />
                  <CopyRow label="Value" value={job.ip} />
                  <SettingsRow indent className="cloud-step-waiting" label="Waiting for DNS..." />
                </>
              )}

              {isCurrent && awaiting && (
                <SettingsRow
                  indent
                  className="cloud-step-awaiting"
                  label={<span className="cloud-step-prompt">{awaiting.prompt}</span>}
                  control={
                    awaiting.kind === 'vm-ip' ? (
                      <span className="settings-addons-inline">
                        <input
                          type="text"
                          className="settings-input settings-input--short settings-input--mono"
                          value={ip}
                          placeholder="203.0.113.10"
                          aria-label="VM public IPv4 address"
                          onChange={(e) => setIp(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); onProvideIp(ip); }
                          }}
                        />
                        <SettingsButton variant="primary" disabled={busy || !ip.trim()} onClick={() => onProvideIp(ip)}>
                          Continue
                        </SettingsButton>
                      </span>
                    ) : awaiting.kind === 'dns-confirm' ? (
                      <SettingsButton variant="primary" disabled={busy} onClick={onConfirmDns}>
                        I&apos;ve added the record, continue
                      </SettingsButton>
                    ) : awaiting.kind === 'credentials' ? (
                      <span className="settings-addons-inline">
                        <input
                          type="password"
                          className="settings-input settings-input--short settings-input--mono"
                          value={token}
                          placeholder="Provider API token"
                          aria-label="Provider API token"
                          autoComplete="off"
                          onChange={(e) => setToken(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); onProvideCredentials(token); }
                          }}
                        />
                        <SettingsButton
                          variant="primary"
                          disabled={busy || !token.trim()}
                          onClick={() => { onProvideCredentials(token); setToken(''); }}
                        >
                          Continue
                        </SettingsButton>
                      </span>
                    ) : undefined
                  }
                />
              )}
            </Fragment>
          );
        })}
        {job.error && <p className="settings-row-error cloud-job-error" role="alert">{job.error}</p>}
        <SetupLog lines={logLines} defaultOpen={job.status === 'failed'} />
      </SettingsGroup>

      <div className="cloud-actions settings-addons-actions">
        {job.status === 'failed' && (
          <SettingsButton variant="primary" disabled={busy} onClick={onRetry}>
            Retry this step
          </SettingsButton>
        )}
        {!terminal && (
          <SettingsButton disabled={busy} onClick={onCancel}>
            Cancel setup
          </SettingsButton>
        )}
        {terminal && (
          <SettingsButton disabled={busy} onClick={onClear}>
            Start over
          </SettingsButton>
        )}
      </div>
    </>
  );
}

/** `Setup log` disclosure: the tail as a read-only mono block (240px, scrolls). */
export function SetupLog({ lines, defaultOpen = false }: { lines: string[]; defaultOpen?: boolean }) {
  return (
    <SettingsDisclosure
      id="cloud-setup-log"
      label="Setup log"
      summary={`${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`}
      defaultOpen={defaultOpen}
      data-testid="cloud-setup-log"
    >
      <SettingsMonoBlock
        label="Last 60 lines"
        text={lines.slice(-60).join('\n') || 'No output yet.'}
        maxHeight={240}
        data-testid="cloud-log-body"
      />
    </SettingsDisclosure>
  );
}
