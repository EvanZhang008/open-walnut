/**
 * Manual path: the provider console steps plus the first-boot script in a copy
 * box. This is the ONE surface that shows a blob containing the pairing code;
 * that's the point (it's what gets pasted into the VM), so it warns rather than
 * redacts.
 *
 * Rendered while the job sits on awaiting-input {vm-ip}: the IP field lives in
 * the step list below, so this component stays purely informational and the
 * operator has exactly one place to type.
 */

import { useEffect, useState } from 'react';
import { getUserData, type CloudSetupJob } from '@/api/cloud-setup';
import { log } from '@/utils/log';
import { SettingsGroup, SettingsRow, SettingsNotice } from '../../SettingsSection';
import { SettingsButton } from '../../inputs/SettingsButton';
import '@/styles/settings-sections-addons.css';

interface Props {
  job: CloudSetupJob;
}

export function CloudManualPaste({ job }: Props) {
  const [userData, setUserData] = useState<string | null>(null);
  const [steps, setSteps] = useState<string[]>([]);
  const [consoleUrl, setConsoleUrl] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await getUserData({
          provider: job.provider,
          domainMode: job.domainMode,
          domain: job.domain,
        });
        if (cancelled) return;
        setUserData(res.userData);
        setSteps(res.steps);
        setConsoleUrl(res.consoleUrl);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        // A 409 here means the job has already spent its code (claimed) — the
        // blob is genuinely gone, not a transient failure.
        setError(err instanceof Error ? err.message : String(err));
        log.warn('cloud-setup', 'user-data fetch failed', { jobId: job.id, error: String(err) });
      }
    })();
    return () => { cancelled = true; };
    // Re-fetch when the job's identity or address changes, not on every tick.
  }, [job.id, job.provider, job.domainMode, job.domain]);

  const copy = () => {
    if (!userData) return;
    void navigator.clipboard?.writeText(userData).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1500); },
      () => { /* clipboard blocked: the script text is selectable */ },
    );
  };

  return (
    <SettingsGroup heading="Create the VM yourself" className="cloud-manual">
      {steps.map((step, i) => (
        <SettingsRow key={i} className="cloud-manual-step" label={`${i + 1}. ${step}`} />
      ))}
      {consoleUrl && (
        <SettingsRow
          className="cloud-manual-console"
          label="Provider console"
          control={<a className="settings-addons-link" href={consoleUrl} target="_blank" rel="noreferrer noopener">Open the provider console</a>}
        />
      )}
      {error && <SettingsNotice kind="error" role="alert">{error}</SettingsNotice>}
      {userData && (
        <div className="settings-row settings-row-stacked cloud-userdata" data-wide="true">
          <div className="settings-mono-head">
            <span className="settings-row-label cloud-userdata-label">First-boot script (cloud-init user data)</span>
            <SettingsButton onClick={copy} reserve={['Copy script', 'Copied']}>
              {copied ? 'Copied' : 'Copy script'}
            </SettingsButton>
          </div>
          <p className="settings-row-help cloud-userdata-warn" data-state="warning">
            It holds a one-time pairing code, so paste it into your VM and nowhere else.
          </p>
          <textarea
            className="cloud-userdata-box settings-input settings-input--mono"
            readOnly
            rows={12}
            spellCheck={false}
            aria-label="First-boot script"
            value={userData}
          />
        </div>
      )}
    </SettingsGroup>
  );
}
