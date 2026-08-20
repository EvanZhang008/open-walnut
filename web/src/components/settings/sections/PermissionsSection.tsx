/**
 * Settings → Permissions — the Permission Doctor's resident panel.
 *
 * One row per macOS permission Walnut needs: state dot, why it matters, and a
 * Fix button that opens the guided PermissionFixDialog. Also names the current
 * launcher, because that IS the identity macOS checks grants against — users
 * who don't know this grant to the wrong app and conclude Walnut is broken
 * (the calendar outage in a sentence).
 *
 * Renders nothing off-macOS/cloud (report.applicable=false): showing rows of
 * "not applicable" would just be noise on those platforms.
 */
import { useCallback, useEffect, useState } from 'react';
import { SectionCard } from '../inputs/SectionCard';
import { PermissionFixDialog } from '@/components/common/PermissionFixDialog';
import { getPermissions, type PermissionsReport, type PermissionStatus } from '@/api/permissions';

const STATE_LABEL: Record<string, string> = {
  granted: 'Granted',
  denied: 'Not granted',
  'not-determined': 'Not asked yet',
  unknown: 'Unknown',
};

export function PermissionsSection() {
  const [report, setReport] = useState<PermissionsReport | null>(null);
  const [fixing, setFixing] = useState<PermissionStatus | null>(null);

  const load = useCallback(async (force = false) => {
    try {
      setReport(await getPermissions(force));
    } catch {
      /* leave the loading state; the section is informational */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Off-macOS/cloud there is nothing actionable — omit the section entirely.
  if (report && !report.applicable) return null;

  return (
    <SectionCard
      id="permissions"
      title="Permissions"
      description="macOS access Walnut needs. Grants follow the app that launched Walnut, so a launcher change can silently drop them — this panel shows the live state and fixes each one in a click."
    >
      {!report ? (
        <p className="settings-muted">Checking permissions…</p>
      ) : (
        <>
          {/* Naming the launcher is the point of this line — it IS the identity
              macOS checks grants against. 'unknown' (deploy-script parent
              already exited) gets honest copy instead of a fake process name. */}
          <p className="settings-muted">
            {report.launcher.kind === 'unknown' ? (
              <>
                Launcher unknown (started by a script). Grants can't be verified against the right app —
                for permissions that stick, launch Walnut from <strong>Walnut.app</strong>.
              </>
            ) : (
              <>
                Launched by <strong>{report.launcher.name}</strong>
                {report.launcher.kind === 'mac-app'
                  ? ' — grants stick across rebuilds (signed app identity).'
                  : ' — grants belong to this launcher; starting Walnut differently may need new grants.'}
              </>
            )}
          </p>
          {report.permissions.map((p) => (
            <div key={p.id} className="settings-row-inline permission-row">
              <span
                className={`permission-state-dot permission-state-${p.state}`}
                aria-label={STATE_LABEL[p.state] ?? p.state}
              />
              <div className="permission-row-main">
                <div className="permission-row-label">{p.label}</div>
                <div className="settings-muted">{p.why}</div>
              </div>
              <span className="settings-muted permission-row-state">{STATE_LABEL[p.state] ?? p.state}</span>
              {p.state !== 'granted' && (
                <button className="btn btn-sm" onClick={() => setFixing(p)}>
                  Fix…
                </button>
              )}
            </div>
          ))}
        </>
      )}
      {fixing && report && (
        <PermissionFixDialog
          permission={fixing}
          launcherName={report.launcher.name}
          onClose={() => {
            setFixing(null);
            load(true); // re-probe so the row reflects whatever just happened
          }}
          onGranted={() => load(true)}
        />
      )}
    </SectionCard>
  );
}
