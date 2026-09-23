/**
 * Settings: macOS Access, the Permission Doctor's resident panel.
 *
 * One row per macOS permission Walnut needs: state tag, why it matters, and a
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
import { SettingsGroup, SettingsRow, SettingsTag, SettingsLoadingRow, SettingsNotice } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { saveErrorMessage } from '../settings-pane-context';
import { PermissionFixDialog } from '@/components/common/PermissionFixDialog';
import { getPermissions, type PermissionsReport, type PermissionStatus } from '@/api/permissions';
import '@/styles/settings-sections-addons.css';
import { firstSentence } from './EngineSettingRows';

/**
 * One line of help per permission: the first sentence, unless that sentence
 * is only a word or two ("Optional."), which says nothing about what the
 * grant does; then the next sentence rides along (N21, C7).
 */
export function permissionHelp(why: string | undefined): string {
  const first = firstSentence(why ?? '');
  if (!why || first.split(/\s+/).length > 2) return first;
  const rest = why.trim().slice(first.length).trim();
  const second = firstSentence(rest);
  return second ? `${first} ${second}` : first;
}

type Tone = 'neutral' | 'warning' | 'success';

/** The state tag. Order matters: "working through a stand-in" is the truth the
 *  user can check against their own screen, so it outranks the raw probe; a
 *  stale grant looks allowed in System Settings while nothing works, so it has
 *  its own words; an unverifiable grant says so instead of "Unknown". */
export function permissionTag(p: PermissionStatus): { text: string; tone: Tone } {
  if (p.workingVia) return { text: 'Working (older copy)', tone: 'success' };
  if (p.staleGrant) return { text: 'Needs re-adding', tone: 'warning' };
  if (p.unverifiable) return { text: "Can't be checked", tone: 'neutral' };
  if (p.state === 'granted') return { text: 'Allowed', tone: 'success' };
  if (p.state === 'denied') return { text: 'Not allowed', tone: 'warning' };
  if (p.state === 'not-determined') return { text: 'Not asked yet', tone: 'neutral' };
  // Say what is known: the check did not answer (N3-28).
  return { text: "Couldn't check", tone: 'neutral' };
}

/** The action beside the state, named for what it does (N3-28). Pure. */
export function permissionActionLabel(p: Pick<PermissionStatus, 'state' | 'optional'>): string | null {
  if (p.state === 'granted') return null;
  // An optional grant never asked for is a setup step, not a fault.
  if (p.optional) return 'Set up...';
  if (p.state === 'not-determined') return 'Ask...';
  return 'Open System Settings...';
}

export function PermissionsSection() {
  const [report, setReport] = useState<PermissionsReport | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fixing, setFixing] = useState<PermissionStatus | null>(null);

  const load = useCallback(async (force = false) => {
    try {
      setReport(await getPermissions(force));
      setLoadError(null);
    } catch (err) {
      setLoadError(saveErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Off-macOS/cloud there is nothing actionable: omit the section entirely.
  if (report && !report.applicable) return null;

  // not-applicable = this box never needs it, or the feature behind it is
  // switched off. A row saying "not applicable" is pure noise, and for a
  // permission as heavy as Full Disk Access it reads like a demand.
  const shown = report?.permissions.filter((p) => p.state !== 'not-applicable') ?? [];
  // The launcher line is only worth a row when some grant depends on it; every
  // permission Walnut asks for now goes to a self-responsible helper, so this
  // normally renders nothing. Never tell people to "launch Walnut.app": the npm
  // install has no app bundle at all.
  const launcherRow = report && shown.some((p) => !p.launcherIndependent)
    ? report.launcher.kind === 'unknown'
      ? { label: 'Launcher unknown', help: "Walnut was started by a script, so grants that follow the launcher can't be checked." }
      : {
          label: `Launched by ${report.launcher.name}`,
          help: report.launcher.kind === 'mac-app'
            ? 'Grants stick across rebuilds (signed app identity).'
            : 'Grants belong to this launcher; starting Walnut differently may need new grants.',
        }
    : null;

  return (
    <SectionCard id="permissions" title="macOS Access">
      <SettingsGroup footer="Walnut can only ask; macOS decides.">
        {!report ? (
          loadError ? (
            <SettingsNotice
              kind="error"
              role="alert"
              action={<SettingsButton variant="text" onClick={() => load(true)}>Retry</SettingsButton>}
            >
              {`Couldn't load permissions: ${loadError}`}
            </SettingsNotice>
          ) : (
            <SettingsLoadingRow>Checking permissions...</SettingsLoadingRow>
          )
        ) : (
          <>
            {launcherRow && <SettingsRow label={launcherRow.label} help={launcherRow.help} />}
            {shown.map((p) => {
              const tag = permissionTag(p);
              const action = permissionActionLabel(p);
              return (
                <SettingsRow
                  key={p.id}
                  className="permission-row"
                  data-permission-id={p.id}
                  label={<span className="permission-row-label">{p.label}</span>}
                  help={<span title={p.why}>{permissionHelp(p.why)}</span>}
                  control={
                    <>
                      {/* State first, then the action (N3-28). The action slot keeps
                          one width on every row, so the states still read down
                          one column (N26). */}
                      <span className="permission-row-state">
                        <SettingsTag tone={tag.tone}>{tag.text}</SettingsTag>
                      </span>
                      <span className="permission-row-action">
                        {action && <SettingsButton onClick={() => setFixing(p)}>{action}</SettingsButton>}
                      </span>
                    </>
                  }
                />
              );
            })}
          </>
        )}
      </SettingsGroup>
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
