/**
 * Manual path: the provider console steps plus the first-boot script in a copy
 * box. This is the ONE surface that shows a blob containing the pairing code —
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

  return (
    <div className="cloud-manual">
      <h4 className="cloud-manual-title">Create the VM yourself</h4>
      {steps.length > 0 && (
        <ol className="cloud-manual-steps">
          {steps.map((step, i) => <li key={i}>{step}</li>)}
        </ol>
      )}
      {consoleUrl && (
        <p className="cloud-manual-console">
          <a href={consoleUrl} target="_blank" rel="noreferrer noopener">Open the provider console</a>
        </p>
      )}

      {error && <p className="devices-error">{error}</p>}

      {userData && (
        <div className="cloud-userdata">
          <div className="cloud-userdata-head">
            <span className="cloud-userdata-label">First-boot script (cloud-init / user-data)</span>
            <button
              type="button"
              className="cloud-copy-btn"
              onClick={() => {
                void navigator.clipboard?.writeText(userData).then(
                  () => { setCopied(true); setTimeout(() => setCopied(false), 1500); },
                  () => { /* clipboard blocked — the textarea is selectable */ },
                );
              }}
            >
              {copied ? 'Copied' : 'Copy script'}
            </button>
          </div>
          <p className="cloud-userdata-warn">
            This script contains a one-time pairing code. Treat it like a password: paste it into
            your VM and nowhere else.
          </p>
          <textarea
            className="cloud-userdata-box"
            readOnly
            rows={12}
            spellCheck={false}
            aria-label="First-boot script"
            value={userData}
          />
        </div>
      )}
    </div>
  );
}
