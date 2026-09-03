/**
 * Settings → Calendar — external calendars (EventKit).
 *
 * Shows the source status (with the TCC permission hint when denied), a
 * per-calendar visibility list grouped by account (this is where the user's
 * Google/iCloud calendars appear — added in macOS System Settings, not here),
 * and a refresh-now button.
 */
import { useCallback, useEffect, useState } from 'react';
import { SectionCard } from '../inputs/SectionCard';
import { PermissionFixDialog } from '@/components/common/PermissionFixDialog';
import { getPermissions, type PermissionsReport } from '@/api/permissions';
import {
  listCalendarSources,
  updateCalendarSource,
  refreshCalendar,
  type CalendarInfo,
  type CalendarSourceStatus,
} from '@/api/calendar';

export function CalendarSection() {
  const [status, setStatus] = useState<CalendarSourceStatus | null>(null);
  const [calendars, setCalendars] = useState<CalendarInfo[]>([]);
  const [busy, setBusy] = useState(false);
  // Permission Doctor handoff: when the source is permission-denied we fetch
  // the live permission report and open the guided fix dialog instead of
  // leaving the user with a static "go find System Settings" sentence.
  const [fixReport, setFixReport] = useState<PermissionsReport | null>(null);

  const openFix = async () => {
    try {
      setFixReport(await getPermissions(true));
    } catch {
      /* fall back to the static hint text already on screen */
    }
  };

  const load = useCallback(async () => {
    try {
      const res = await listCalendarSources();
      setStatus(res.sources[0] ?? null);
      setCalendars(res.calendars);
    } catch {
      /* section renders the unavailable state */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setEnabled = async (enabled: boolean) => {
    setBusy(true);
    try {
      await updateCalendarSource({ enabled });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const toggleCalendar = async (id: string, hidden: boolean) => {
    const nextHidden = calendars.filter((c) => (c.id === id ? hidden : c.hidden)).map((c) => c.id);
    // optimistic
    setCalendars((prev) => prev.map((c) => (c.id === id ? { ...c, hidden } : c)));
    try {
      await updateCalendarSource({ hidden_calendar_ids: nextHidden, visible_calendar_ids: null });
    } catch {
      load();
    }
  };

  const refresh = async () => {
    setBusy(true);
    try {
      await refreshCalendar();
      await load();
    } finally {
      setBusy(false);
    }
  };

  const byAccount = new Map<string, CalendarInfo[]>();
  for (const c of calendars) {
    const list = byAccount.get(c.account);
    if (list) list.push(c);
    else byAccount.set(c.account, [c]);
  }

  return (
    <SectionCard
      id="calendar"
      title="Calendar Accounts"
      description="Show events from the Mac's calendars (iCloud, Google, Exchange — every account added in macOS System Settings → Internet Accounts). Walnut edits write back through macOS; no separate login needed."
    >
      {!status ? (
        <p className="settings-muted">Loading calendar status…</p>
      ) : (
        <>
          <label className="settings-toggle-row">
            <input
              type="checkbox"
              checked={status.enabled}
              disabled={busy}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <span>Show external calendar events</span>
          </label>

          {status.enabled && !status.available && (
            <div className="settings-warning">
              {status.reason === 'permission-denied' ? (
                <>
                  Calendar access is not granted.{' '}
                  <button className="btn btn-sm" onClick={openFix}>
                    Fix it…
                  </button>
                </>
              ) : status.reason === 'cloud' ? (
                <>macOS calendars aren't reachable from the cloud companion — open Walnut on the Mac to see them.</>
              ) : (
                <>{status.message ?? 'Calendar source unavailable.'}</>
              )}
            </div>
          )}

          {status.enabled && status.available && (
            <>
              <div className="settings-row-inline">
                <button className="btn btn-sm" disabled={busy} onClick={refresh}>
                  Refresh now
                </button>
                {status.lastRefresh && (
                  <span className="settings-muted">
                    Last refresh: {new Date(status.lastRefresh).toLocaleTimeString()} · {status.eventCount ?? 0} events cached
                  </span>
                )}
              </div>
              {[...byAccount.entries()].map(([account, list]) => (
                <div key={account} className="cal-settings-account">
                  <div className="cal-settings-account-name">{account}</div>
                  {list.map((c) => (
                    <label key={c.id} className="settings-toggle-row cal-settings-cal-row">
                      <input
                        type="checkbox"
                        checked={!c.hidden}
                        onChange={(e) => toggleCalendar(c.id, !e.target.checked)}
                      />
                      <span className="cal-settings-dot" style={{ background: c.color }} />
                      <span>{c.title}</span>
                      {c.readonly && <span className="settings-muted"> (read-only)</span>}
                    </label>
                  ))}
                </div>
              ))}
              <p className="settings-muted">
                To connect another account (e.g. a second Google account), add it in macOS System Settings → Internet Accounts — its calendars appear here automatically.
              </p>
            </>
          )}
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
