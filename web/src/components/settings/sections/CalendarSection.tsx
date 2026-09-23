/**
 * Settings: Calendar Accounts, external calendars (EventKit).
 *
 * Master switch, a `Cached events` row with Refresh now, then one checklist
 * group per account (accounts are added in macOS System Settings, not here).
 * Every visibility write goes through ONE queue with at most one request in
 * flight; quick successive checks resend the latest full hidden list.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SectionCard } from '../inputs/SectionCard';
import { SettingsGroup, SettingsRow, SettingsNotice, SettingsTag, SettingsLoadingRow } from '../SettingsSection';
import { SettingsCheckbox } from '../inputs/SettingsCheckbox';
import { SettingsButton } from '../inputs/SettingsButton';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { useOptimisticSetting, couldntSave } from '../inputs/useOptimisticSetting';
import { saveErrorMessage, useSettingsSaved } from '../settings-pane-context';
import { PermissionFixDialog } from '@/components/common/PermissionFixDialog';
import { getPermissions, type PermissionsReport } from '@/api/permissions';
import {
  listCalendarSources,
  updateCalendarSource,
  refreshCalendar,
  type CalendarInfo,
  type CalendarSourceStatus,
} from '@/api/calendar';
import {
  LatestWriteQueue,
  calendarDisplayName,
  formatLastRefreshed,
  hiddenAfterBulk,
  hiddenAfterToggle,
  shownCount,
} from './addons-format';
import '@/styles/settings-sections-addons.css';

/** Row error for one calendar (`cal:<id>`) or one account (`acct:<name>`). */
interface WriteError { key: string; message: string }

export function CalendarSection() {
  const [status, setStatus] = useState<CalendarSourceStatus | null>(null);
  const [calendars, setCalendars] = useState<CalendarInfo[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // Local target of the hidden list while writes are queued (null = server truth).
  const [target, setTarget] = useState<Set<string> | null>(null);
  const [writeError, setWriteError] = useState<WriteError | null>(null);
  const lastKey = useRef('');
  const { notifySaved, notifySaveFailed } = useSettingsSaved();
  // Permission Doctor handoff: when the source is permission-denied we fetch
  // the live permission report and open the guided fix dialog.
  const [fixReport, setFixReport] = useState<PermissionsReport | null>(null);

  const openFix = async () => {
    try {
      setFixReport(await getPermissions(true));
    } catch {
      /* the notice already names the fix */
    }
  };

  const load = useCallback(async () => {
    try {
      const res = await listCalendarSources();
      setStatus(res.sources[0] ?? null);
      setCalendars(res.calendars);
      setLoadError(null);
    } catch (err) {
      setLoadError(saveErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const enabled = useOptimisticSetting(
    status?.enabled ?? false,
    async (next: boolean) => {
      await updateCalendarSource({ enabled: next });
      await load();
    },
    { rowKey: 'calendar-enabled' },
  );

  const allIds = useMemo(() => calendars.map((c) => c.id), [calendars]);
  const serverHidden = useMemo(() => new Set(calendars.filter((c) => c.hidden).map((c) => c.id)), [calendars]);
  const hidden = target ?? serverHidden;

  const queueRef = useRef<LatestWriteQueue<string[]> | null>(null);
  if (!queueRef.current) {
    queueRef.current = new LatestWriteQueue<string[]>(
      (list) => updateCalendarSource({ hidden_calendar_ids: list, visible_calendar_ids: null }),
      (result) => {
        if (result.ok) {
          const done = new Set(result.value);
          setCalendars((prev) => prev.map((c) => ({ ...c, hidden: done.has(c.id) })));
          setTarget(null);
          setWriteError(null);
          notifySavedRef.current();
          return;
        }
        const message = saveErrorMessage(result.error);
        setTarget(null);
        setWriteError({ key: lastKey.current, message });
        notifyFailedRef.current(message);
        load();
      },
    );
  }
  const notifySavedRef = useRef(notifySaved);
  notifySavedRef.current = notifySaved;
  const notifyFailedRef = useRef(notifySaveFailed);
  notifyFailedRef.current = notifySaveFailed;

  const write = (key: string, list: string[]) => {
    lastKey.current = key;
    if (writeError?.key === key) setWriteError(null);
    setTarget(new Set(list));
    queueRef.current?.push(list);
  };

  const toggleCalendar = (id: string, hide: boolean) => write(`cal:${id}`, hiddenAfterToggle(allIds, hidden, id, hide));
  const bulk = (account: string, ids: string[], hide: boolean) =>
    write(`acct:${account}`, hiddenAfterBulk(allIds, hidden, ids, hide));

  const refresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      await refreshCalendar();
      await load();
    } catch (err) {
      setRefreshError(saveErrorMessage(err));
    } finally {
      setRefreshing(false);
    }
  };

  const byAccount = new Map<string, CalendarInfo[]>();
  for (const c of calendars) {
    const list = byAccount.get(c.account);
    if (list) list.push(c);
    else byAccount.set(c.account, [c]);
  }
  const on = enabled.value;
  const denied = !!status && !status.available && status.reason === 'permission-denied';

  const rowError = (key: string) => (writeError?.key === key ? couldntSave(writeError.message) : undefined);

  return (
    <SectionCard id="calendar" title="Calendar Accounts">
      {!status ? (
        <SettingsGroup>
          {loadError ? (
            <SettingsNotice
              kind="error"
              role="alert"
              action={<SettingsButton variant="text" onClick={load}>Retry</SettingsButton>}
            >
              {`Couldn't load calendars: ${loadError}`}
            </SettingsNotice>
          ) : (
            <SettingsLoadingRow />
          )}
        </SettingsGroup>
      ) : (
        <>
          <SettingsGroup>
            <SettingsRow
              label="Show external calendar events"
              htmlFor="calendar-enabled"
              help="Events from every account added in macOS Internet Accounts."
              error={enabled.error ?? undefined}
              control={
                <ToggleSwitch
                  id="calendar-enabled"
                  checked={on}
                  busy={enabled.busy}
                  onChange={enabled.set}
                  data-testid="calendar-enabled-switch"
                />
              }
            />
            {status.available && (
              <SettingsRow
                // Names what the line reports, so "Not refreshed yet" never
                // sits under a "Last refreshed" label (N3-31).
                label="Cached events"
                help={refreshError ? `Refresh failed: ${refreshError}` : formatLastRefreshed(status.lastRefresh, status.eventCount)}
                state={refreshError ? 'error' : undefined}
                disabled={!on}
                data-testid="calendar-last-refreshed"
                control={
                  <SettingsButton
                    onClick={refresh}
                    busy={refreshing}
                    busyLabel="Refreshing..."
                    disabled={!on}
                    data-testid="calendar-refresh-now"
                  >
                    Refresh now
                  </SettingsButton>
                }
              />
            )}
          </SettingsGroup>

          {!status.available && on && (
            denied ? (
              <SettingsNotice
                kind="warn"
                action={
                  <span className="settings-addons-inline">
                    <a className="settings-button settings-button-default" href="#permissions">
                      <span className="settings-button-stack">
                        <span className="settings-button-label">Open macOS Access</span>
                      </span>
                    </a>
                    <SettingsButton onClick={openFix}>Fix it...</SettingsButton>
                  </span>
                }
              >
                Walnut can't read calendars until macOS allows it.
              </SettingsNotice>
            ) : (
              <SettingsNotice kind="warn">
                {status.reason === 'cloud'
                  ? "macOS calendars can't be reached from the cloud companion; open Walnut on the Mac to see them."
                  : (status.message ?? 'Calendar source unavailable.')}
              </SettingsNotice>
            )
          )}

          {status.available && calendars.length === 0 && (
            <SettingsGroup>
              <SettingsRow label="No calendars on this Mac yet." />
            </SettingsGroup>
          )}

          {[...byAccount.entries()].map(([account, list]) => {
            const ids = list.map((c) => c.id);
            const acctKey = `acct:${account}`;
            return (
              <SettingsGroup
                key={account}
                className="settings-checklist"
                disabled={!on}
                data-testid="calendar-account-group"
                heading={account}
                headingTrailing={
                  <span className="settings-addons-inline">
                    {/* A bulk action that would change nothing is disabled (F31). */}
                    <button type="button" className="settings-addons-link" onClick={() => bulk(account, ids, false)}
                      disabled={ids.every((id) => !hidden.has(id))}>
                      Show all
                    </button>
                    <button type="button" className="settings-addons-link" onClick={() => bulk(account, ids, true)}
                      disabled={ids.every((id) => hidden.has(id))}>
                      Hide all
                    </button>
                    <span className="settings-addons-muted settings-heading-count" data-testid="calendar-account-count">
                      {shownCount(ids, hidden)}
                    </span>
                  </span>
                }
              >
                {rowError(acctKey) && (
                  <p className="settings-row-error" role="alert">{rowError(acctKey)}</p>
                )}
                {list.map((c) => {
                  const display = calendarDisplayName(c.title);
                  const err = rowError(`cal:${c.id}`);
                  return (
                    <Fragment key={c.id}>
                      <SettingsCheckbox
                        data-testid={`calendar-checkbox-${c.id}`}
                        checked={!hidden.has(c.id)}
                        onChange={(checked) => toggleCalendar(c.id, !checked)}
                        title={display.untitled ? c.title || 'Untitled calendar' : c.title}
                        leading={<span className="settings-addons-dot" style={{ background: c.color }} aria-hidden="true" />}
                        label={display.name}
                        trailing={c.readonly ? <SettingsTag>Read only</SettingsTag> : undefined}
                      />
                      {err && <p className="settings-row-error" role="alert">{err}</p>}
                    </Fragment>
                  );
                })}
              </SettingsGroup>
            );
          })}
        </>
      )}
      {fixReport && (() => {
        const perm = fixReport.permissions.find((p) => p.id === 'calendar');
        if (!perm) return null;
        return (
          <PermissionFixDialog
            permission={perm}
            launcherName={fixReport.launcher.name}
            onClose={() => {
              setFixReport(null);
              load(); // pick up whatever changed while the dialog was open
            }}
            // The server already refreshed events post-grant; reload the
            // section so available:true + the calendar list appear.
            onGranted={() => load()}
          />
        );
      })()}
    </SectionCard>
  );
}
