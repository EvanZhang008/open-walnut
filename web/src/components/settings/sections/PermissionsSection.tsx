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

  // not-applicable = this box never needs it, or the feature behind it is
  // switched off. A row saying "not applicable" is pure noise, and for a
  // permission as heavy as Full Disk Access it reads like a demand.
  const shown = report?.permissions.filter((p) => p.state !== 'not-applicable') ?? [];

  return (
    <SectionCard
      id="permissions"
      title="Permissions"
      description="macOS access Walnut needs. Each row names exactly what to grant to, shows the live state, and fixes itself in a click."
    >
      {!report ? (
        <p className="settings-muted">Checking permissions…</p>
      ) : (
        <>
          {/* The launcher line is only worth screen space when some grant
              actually depends on it. Every permission Walnut asks for now goes
              to a self-responsible helper, so this normally renders nothing:
              telling someone their launcher can't be verified, above rows where
              the launcher is irrelevant, reads as a problem they need to solve
              and there is nothing to solve. */}
          {shown.some((p) => !p.launcherIndependent) && (
            <p className="settings-muted">
              {report.launcher.kind === 'unknown' ? (
                <>
                  {/* Never tell people to "launch Walnut.app": the npm install has
                      no app bundle at all, and that advice sent browser users
                      looking for a file that does not exist on their machine. */}
                  Launcher unknown (Walnut was started by a script). Grants that follow the launcher can't be
                  verified. Each permission below still names exactly what to grant to.
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
          )}
          {shown.map((p) => (
            <div key={p.id} className="settings-row-inline permission-row">
              <span
                className={`permission-state-dot permission-state-${p.workingVia ? 'working' : p.state}`}
                aria-label={p.workingVia ? 'Working' : STATE_LABEL[p.state] ?? p.state}
              />
              <div className="permission-row-main">
                <div className="permission-row-label">{p.label}</div>
                <div className="settings-muted">{p.why}</div>
              </div>
              {/* A stale grant looks GRANTED in System Settings (the row is there,
                  the toggle is on) while nothing works, so the state word has to
                  say which of the two "not granted" situations this is. */}
              {/* Order matters: "working through a stand-in" is the truth the user
                  can check against their own screen, so it outranks the raw probe
                  result. Reporting "not granted" beside a calendar full of events
                  is what made this whole panel look broken. */}
              <span className="settings-muted permission-row-state">
                {p.workingVia
                  ? 'Working (older copy)'
                  : p.staleGrant ? 'Needs re-adding' : STATE_LABEL[p.state] ?? p.state}
              </span>
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
