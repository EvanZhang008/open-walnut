import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PluginLogger } from '@open-walnut/plugin-api/web'
import type { DayApps, OutsideApp, OutsideSite, TimeApi } from './api'
import { DayNav, type DayNavTestIds } from './day-nav'
import { Stat } from './reports'
import { dayLabel, formatDuration } from './time-timeline'

/**
 * Apps — where the REST of the screen time went: which Mac app, and for a browser,
 * which site.
 *
 * The other three tabs only ever see Walnut's own surfaces, so a day spent in a
 * terminal and a browser reads there as a day off. This tab is the counterweight, and
 * the number it leads with is the one the others cannot answer: `Outside`, which is
 * `totalMs - walnutMs`. That subtraction is bucket-accurate on the server, so a
 * browser row that mixes Walnut with other sites still splits correctly — which is why
 * the strip cites the server's `walnutMs` and never sums the rows' `walnut` flags.
 *
 * Like the Timeline, it owns its own DAY: a day is its own question, and switching one
 * must not re-read the shell's window. The arrows are bounded by that window for the
 * same reason the Timeline's are — a day the shell never fetched has no summary to
 * agree with.
 *
 * OFF by default, and the empty state is an invitation rather than a warning: sampling
 * which app someone is in has to be an explicit choice, so the tab's whole job while
 * disabled is to say plainly what it would collect.
 */

/** Sites shown before the row folds the tail behind a "+N more". */
const SITES_SHOWN = 8

const APPS_NAV_IDS: DayNavTestIds = {
  prev: 'time-app-apps-prev',
  next: 'time-app-apps-next',
  date: 'time-app-apps-date',
  today: 'time-app-apps-today',
}

export function TimeApps({ api, log, dates, today }: {
  api: TimeApi
  log: PluginLogger
  /** The days the shell already fetched, ascending. Bounds the day nav. */
  dates: string[]
  today: string
}) {
  const [date, setDate] = useState(today)
  const [day, setDay] = useState<DayApps | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** Bumped by the toggle so the day is re-read once the setting has landed. */
  const [nonce, setNonce] = useState(0)

  const oldest = dates[0] ?? today
  const newest = dates[dates.length - 1] ?? today
  useEffect(() => {
    if (dates.length > 0 && (date < oldest || date > newest)) setDate(today)
  }, [dates.length, date, oldest, newest, today])

  useEffect(() => {
    let live = true
    api.appsDay(date)
      .then((next) => {
        if (!live) return
        setDay(next)
        setError(null)
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        log.warn('apps fetch failed', { date, error: message })
        if (live) setError(message)
      })
    return () => { live = false }
  }, [api, log, date, nonce])

  const setTracking = useCallback((enabled: boolean) => {
    setBusy(true)
    api.setAppsEnabled(enabled)
      .then(() => setNonce((n) => n + 1))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        log.warn('apps toggle failed', { enabled, error: message })
        setError(message)
      })
      .finally(() => setBusy(false))
  }, [api, log])

  // The answer for the day being SHOWN. A day switch keeps the previous answer in
  // state until the new one lands, and rendering yesterday's rows under today's label
  // is a visible flash of wrong data.
  const shown = day && day.date === date ? day : null
  /**
   * The SETTING, which is not a property of the day: read from the last answer of any
   * date, so a day switch cannot blink the day nav out from under the arrow being
   * clicked. While tracking is off there is no day question at all, so no nav.
   */
  const enabled = day?.enabled === true
  const disabled = day !== null && !day.enabled

  return (
    <div className="wt-ap" data-testid="time-app-apps">
      {enabled && (
        <DayNav
          date={date}
          today={today}
          oldest={oldest}
          newest={newest}
          testIds={APPS_NAV_IDS}
          onDate={setDate}
        />
      )}

      {error && <div className="wt-degraded" data-testid="time-app-apps-error">Error: {error}</div>}
      {shown?.degraded && (
        <div className="wt-degraded">Showing a partial answer: the day was still being read.</div>
      )}

      {!shown && !error && !disabled && <p className="wt-empty">Loading…</p>}
      {disabled && <AppsInvite busy={busy} onEnable={() => setTracking(true)} />}
      {shown?.enabled && (
        <AppsDay day={shown} date={date} busy={busy} onPause={() => setTracking(false)} />
      )}
    </div>
  )
}

/**
 * The disabled state. It sells the feature and discloses the cost in the same breath,
 * because those are the two things someone deciding needs: what it would tell them,
 * and what it would watch. No dark patterns, no "recommended" badge.
 */
function AppsInvite({ busy, onEnable }: { busy: boolean; onEnable: () => void }) {
  return (
    <section className="wt-ap-invite" data-testid="time-app-apps-invite">
      <h2>See where the rest of your screen time went</h2>
      <ul>
        <li>Walnut notes which app is in front every few seconds, so the day adds up without you starting a timer.</li>
        <li>Browsers break down by site (the host only, never a full address). macOS asks once per browser to allow that, the first time it looks.</li>
        <li>Idle and locked time never counts, and none of it leaves this Mac.</li>
      </ul>
      <button
        type="button"
        className="wt-ap-enable"
        data-testid="time-app-apps-enable"
        disabled={busy}
        onClick={onEnable}
      >
        {busy ? 'Enabling…' : 'Enable tracking'}
      </button>
    </section>
  )
}

function AppsDay({ day, date, busy, onPause }: {
  day: DayApps
  date: string
  busy: boolean
  onPause: () => void
}) {
  const outsideMs = Math.max(0, day.totalMs - day.walnutMs)

  return (
    <>
      <div className="wt-stat-row wt-ap-strip">
        <Stat
          label={`Outside Walnut, ${dayLabel(date)}`}
          value={formatDuration(outsideMs)}
          testId="time-app-apps-outside"
        />
        <Stat label="In Walnut" value={formatDuration(day.walnutMs)} tone="human" testId="time-app-apps-inside" />
        <Stat label="Total screen time" value={formatDuration(day.totalMs)} testId="time-app-apps-total" />
      </div>

      {!day.running && (
        <p className="wt-empty" data-testid="time-app-apps-idle">
          Tracker is starting (or unavailable on this host)…
        </p>
      )}

      {!day.browserHostsSeen && (
        <div className="wt-ap-hint" data-testid="time-app-apps-automation">
          A browser was used, but no site came back. Sites need one more grant: System Settings →
          Privacy &amp; Security → Automation, then allow the Walnut activity helper to control your
          browser. macOS asks for it once per browser, as a prompt.
        </div>
      )}

      {day.apps.length === 0
        ? (
          <p className="wt-empty" data-testid="time-app-apps-empty">
            Nothing sampled on {dayLabel(date)} yet.
          </p>
        )
        : (
          <section className="wt-section" data-testid="time-app-apps-list">
            <div className="wt-section-head">
              <h2>By app</h2>
              <span className="wt-section-hint">
                {day.apps.length} {day.apps.length === 1 ? 'app' : 'apps'}, longest first
              </span>
            </div>
            <div className="wt-bars">
              {day.apps.map((app) => (
                <AppRow key={app.bundleId || app.app} app={app} totalMs={day.totalMs} />
              ))}
            </div>
          </section>
        )}

      <button
        type="button"
        className="wt-ap-pause"
        data-testid="time-app-apps-pause"
        disabled={busy}
        onClick={onPause}
      >
        {busy ? 'Pausing…' : 'Pause tracking'}
      </button>
    </>
  )
}

/**
 * One app, and its sites underneath. Same three-column geometry as a report row (the
 * `wt-bar-*` classes), but its own component: a report row is a TASK, and this one
 * carries a chip, an expander and a nested scale that a task row has no use for.
 */
function AppRow({ app, totalMs }: { app: OutsideApp; totalMs: number }) {
  const [expanded, setExpanded] = useState(false)
  const sites = app.sites ?? []
  const visible = useMemo(
    () => (expanded ? sites : sites.slice(0, SITES_SHOWN)),
    [sites, expanded],
  )
  const hidden = sites.length - visible.length

  return (
    <div className="wt-ap-app" data-testid="time-app-apps-row" data-app={app.app}>
      <div className="wt-bar-row">
        <div className="wt-bar-label" title={app.app}>
          <span className="wt-bar-title">{app.app}</span>
          {app.walnut && <em className="wt-ap-chip" data-testid="time-app-apps-chip">Walnut</em>}
        </div>
        <div className="wt-bar-track">
          <div className="wt-bar-fill wt-ap-fill" style={{ width: share(app.ms, totalMs) }} />
        </div>
        <span className="wt-bar-value">{formatDuration(app.ms)}</span>
      </div>

      {visible.length > 0 && (
        <div className="wt-ap-sites" data-testid="time-app-apps-sites">
          {visible.map((site) => <SiteRow key={site.host} site={site} appMs={app.ms} />)}
          {(hidden > 0 || expanded) && (
            <button
              type="button"
              className="wt-ap-more"
              data-testid="time-app-apps-more"
              onClick={() => setExpanded((prev) => !prev)}
            >
              {expanded ? 'Fewer sites' : `+${hidden} more`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** A site's bar is scaled within its OWN app, so the nesting reads as a breakdown of
 *  that row rather than as another row competing on the page's scale. */
function SiteRow({ site, appMs }: { site: OutsideSite; appMs: number }) {
  return (
    <div className="wt-bar-row wt-ap-site" data-host={site.host}>
      <div className="wt-bar-label" title={site.host}>
        <span className="wt-bar-title">{site.host}</span>
      </div>
      <div className="wt-bar-track">
        <div className="wt-bar-fill wt-ap-fill-site" style={{ width: share(site.ms, appMs) }} />
      </div>
      <span className="wt-bar-value">{formatDuration(site.ms)}</span>
    </div>
  )
}

/** A floor, so a real but tiny share is still visible as a mark. */
function share(ms: number, of: number): string {
  if (ms <= 0 || of <= 0) return '0%'
  return `max(3px, ${Math.min(100, (ms / of) * 100)}%)`
}
