import { useCallback, useEffect, useState } from 'react'
import type { PluginLogger } from '@open-walnut/plugin-api/web'
import type { DayScreenTime, ScreenTimeDevice, TimeApi } from './api'
import { Stat } from './reports'
import { dayLabel, formatDuration } from './time-timeline'

/**
 * Apple Screen Time, per device: the iPhone's day, and this Mac's if asked for.
 *
 * A second, coarser measurement living next to Walnut's own. Two things follow from
 * that and shape everything here:
 *
 *   - It is HOUR resolution, not five seconds, and it comes from Apple rather than
 *     from us. Every number on screen says so once, plainly. A row that looks
 *     identical to a Walnut-sampled row but is an order of magnitude coarser is a
 *     quiet lie about precision.
 *   - Apple's own copy is deleted after a few weeks. So the empty state is not
 *     "nothing happened", it is "we had not started keeping this yet", and the
 *     invite says what turning it on buys: everything from today forward, kept.
 *
 * App rows and website rows stay separate lists. Apple counts a browser's app time
 * and the domains visited inside it as two different measurements, so summing them
 * would double a browsing hour.
 */

/** Rows before the list folds its tail behind a "+N more". */
const ROWS_SHOWN = 10

export function ScreenTimeSection({ api, log, date, day, onChanged }: {
  api: TimeApi
  log: PluginLogger
  date: string
  /** The day's answer, owned by the parent so the device bar can count devices. */
  day: DayScreenTime | null
  /** Called after a toggle or a refresh, so the parent re-reads the day. */
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const enable = useCallback(() => {
    setBusy(true)
    api.setScreenTime({ enabled: true })
      .then(() => onChanged())
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        log.warn('screen time enable failed', { error: message })
        setError(message)
      })
      .finally(() => setBusy(false))
  }, [api, log, onChanged])

  const refresh = useCallback(() => {
    setBusy(true)
    setError(null)
    api.refreshScreenTime()
      .then(() => onChanged())
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        log.warn('screen time refresh failed', { error: message })
        setError(message)
      })
      .finally(() => setBusy(false))
  }, [api, log, onChanged])

  const openSettings = useCallback(() => {
    api.openScreenTimeSettings().catch((err: unknown) => {
      log.warn('screen time open settings failed', { error: err instanceof Error ? err.message : String(err) })
    })
  }, [api, log])

  if (!day) return null
  if (!day.enabled) return <ScreenTimeInvite busy={busy} onEnable={enable} error={error} />

  return (
    <div className="wt-st" data-testid="time-app-screentime">
      {error && <div className="wt-degraded" data-testid="time-app-screentime-error">Error: {error}</div>}
      {day.access !== 'ok' && day.access !== 'off' && (
        <ScreenTimeAccessCard day={day} busy={busy} onRetry={refresh} onOpenSettings={openSettings} />
      )}
      {day.access === 'ok' && day.devices.length === 0 && (day.localDevices?.length ?? 0) === 0 && (
        <ScreenTimeEmpty date={date} day={day} busy={busy} onRefresh={refresh} />
      )}
      {day.devices.map((device) => (
        <ScreenTimeDeviceView key={device.deviceId} device={device} date={date} />
      ))}
      {(day.localDevices ?? []).map((device) => (
        <ScreenTimeDeviceView key={device.deviceId} device={device} date={date} thisMac />
      ))}
    </div>
  )
}

/**
 * The off state. It sells the feature and discloses the cost in the same breath,
 * and it is honest about the one thing that cannot be undone: days before you turn
 * this on are gone, because Apple has already thrown most of them away.
 */
function ScreenTimeInvite({ busy, onEnable, error }: {
  busy: boolean
  onEnable: () => void
  error: string | null
}) {
  return (
    <section className="wt-st-invite" data-testid="time-app-screentime-invite">
      <h2>Add your iPhone's screen time</h2>
      <ul>
        <li>macOS already receives it, if Screen Time's "Share Across Devices" is on. Walnut reads that copy: per app, per website, pickups and notifications.</li>
        <li>Apple deletes its own copy after a few weeks. Walnut keeps every day it has seen, so this starts paying off from today onward and cannot recover the past.</li>
        <li>It needs Full Disk Access for one small helper that can only read one file. Nothing leaves this Mac.</li>
        <li>Hour resolution, since that is how Apple records it. Walnut's own Mac tracking stays five-second.</li>
      </ul>
      {error && <div className="wt-degraded">Error: {error}</div>}
      <button
        type="button"
        className="wt-st-enable"
        data-testid="time-app-screentime-enable"
        disabled={busy}
        onClick={onEnable}
      >
        {busy ? 'Enabling…' : 'Turn on Screen Time reading'}
      </button>
    </section>
  )
}

/**
 * The guided fix. Full Disk Access has no prompt and no API, so this card is the
 * whole mechanism: the exact path, already on the clipboard, and the one instruction
 * people never guess.
 *
 * `stale_grant` gets its own words on purpose. In that state System Settings shows
 * the helper with its toggle ON while nothing works, and toggling it does nothing:
 * the row has to be removed and added back. Telling someone to "add it" while they
 * are looking at it already added is how a correct fix gets ignored.
 */
function ScreenTimeAccessCard({ day, busy, onRetry, onOpenSettings }: {
  day: DayScreenTime
  busy: boolean
  onRetry: () => void
  onOpenSettings: () => void
}) {
  const stale = day.access === 'stale_grant'
  const grantable = day.access === 'needs_grant' || stale
  return (
    <section className="wt-st-grant" data-testid="time-app-screentime-grant" data-access={day.access}>
      {day.access === 'unavailable' && (
        <p>
          This host cannot read Apple Screen Time. It needs macOS, and the one-time build of the
          reader needs the Xcode command line tools (<code>xcode-select --install</code>).
        </p>
      )}
      {day.access === 'no_store' && (
        <p>
          Screen Time has never written anything on this Mac. Turn it on in System Settings →
          Screen Time, and on the iPhone turn on Share Across Devices.
        </p>
      )}
      {day.access === 'unknown' && (
        <p>
          Could not tell whether Walnut can read Screen Time. Nothing is broken as far as we know,
          so this is worth one retry before changing any permission.
        </p>
      )}
      {grantable && (
        <>
          <h3>{stale ? 'Re-add the reader to Full Disk Access' : 'One permission left'}</h3>
          {stale
            ? (
              <p>
                Walnut rebuilt its reader, and macOS treats a rebuilt program as a new one. The old
                entry is still listed with its switch on, which is why nothing looks wrong. It has
                to be removed and added again: <strong>turning the switch off and on does not
                work.</strong>
              </p>
            )
            : (
              <p>
                Apple keeps Screen Time behind Full Disk Access, and macOS never asks for it. Add
                Walnut's reader by hand, once. It is a small program that can only read one file.
              </p>
            )}
          <ol className="wt-st-steps">
            <li>Press the button below: it opens the right pane and copies the path for you.</li>
            {stale && <li>Select the <code>walnut-reader</code> row and click −.</li>}
            <li>Click + and authenticate.</li>
            <li>Press Cmd+Shift+G, then Cmd+V, and open it.</li>
            <li>Leave the switch on.</li>
          </ol>
          {day.helperPath && (
            <p className="wt-st-path">
              <code data-testid="time-app-screentime-path">{day.helperPath}</code>
            </p>
          )}
        </>
      )}
      <div className="wt-st-actions">
        {/* The button does the two things a human would otherwise have to get right by
            hand: find a pane four levels deep in System Settings, and type a path into
            a hidden directory that the file picker cannot browse to. */}
        {grantable && (
          <button
            type="button"
            className="wt-st-enable"
            data-testid="time-app-screentime-open"
            onClick={onOpenSettings}
          >
            Open Full Disk Access &amp; copy the path
          </button>
        )}
        <button
          type="button"
          className="wt-st-retry"
          data-testid="time-app-screentime-retry"
          disabled={busy}
          onClick={onRetry}
        >
          {busy ? 'Checking…' : 'Check again'}
        </button>
      </div>
    </section>
  )
}

/** Reading works, but this day has nothing. Distinguish "not captured" from "no
 *  usage": one is fixed by a refresh, the other is just a quiet day. */
function ScreenTimeEmpty({ date, day, busy, onRefresh }: {
  date: string
  day: DayScreenTime
  busy: boolean
  onRefresh: () => void
}) {
  const captured = (day.storedDates ?? []).includes(date)
  return (
    <p className="wt-empty" data-testid="time-app-screentime-empty">
      {captured
        ? `Apple reported no device activity on ${dayLabel(date)}.`
        : `Nothing captured for ${dayLabel(date)} yet. Walnut only has the days it snapshotted.`}
      {' '}
      <button type="button" className="wt-st-retry" disabled={busy} onClick={onRefresh}>
        {busy ? 'Reading…' : 'Read Apple Screen Time now'}
      </button>
    </p>
  )
}

function ScreenTimeDeviceView({ device, date, thisMac }: {
  device: ScreenTimeDevice
  date: string
  thisMac?: boolean
}) {
  return (
    <section className="wt-section wt-st-device" data-testid="time-app-screentime-device" data-device={device.deviceId}>
      <div className="wt-section-head">
        <h2>{device.deviceName}</h2>
        <span className="wt-section-hint">
          {thisMac ? "Apple's own count for this Mac, " : ''}from Apple Screen Time, by the hour
        </span>
      </div>

      {device.headerMissing && (
        <div className="wt-degraded">
          This device's day total is missing from our copy, so only its app rows are shown.
        </div>
      )}

      <div className="wt-stat-row">
        <Stat label={`Screen time, ${dayLabel(date)}`} value={formatDuration(device.totalMs)} />
        <Stat label="Pickups" value={String(device.pickups)} />
        <Stat label="Notifications" value={String(device.notifications)} />
      </div>

      <RowList
        title="Apps"
        rows={device.apps.map((app) => ({
          key: app.bundleId,
          label: appLabel(app.bundleId),
          title: app.bundleId,
          ms: app.ms,
          meta: rowMeta(app.pickups, app.notifications),
        }))}
        totalMs={device.appMs}
        dropped={device.dropped.apps}
        droppedMs={device.dropped.appMs}
        testId="time-app-screentime-apps"
      />

      {device.sites.length > 0 && (
        <RowList
          title="Websites"
          // Scaled within the site total, NOT the device total: Apple counts site
          // time inside a browser's app time, so sharing one scale would imply the
          // two lists add up to the day. They do not.
          rows={device.sites.map((site) => ({
            key: site.domain,
            label: site.domain,
            title: site.domain,
            ms: site.ms,
          }))}
          totalMs={device.siteMs}
          dropped={device.dropped.sites}
          droppedMs={device.dropped.siteMs}
          testId="time-app-screentime-sites"
          hint="counted inside the browser's own time, not on top of it"
        />
      )}
    </section>
  )
}

interface Row {
  key: string
  label: string
  title: string
  ms: number
  meta?: string
}

function RowList({ title, rows, totalMs, dropped, droppedMs, testId, hint }: {
  title: string
  rows: Row[]
  totalMs: number
  dropped: number
  droppedMs: number
  testId: string
  hint?: string
}) {
  const [expanded, setExpanded] = useState(false)
  if (rows.length === 0) return null
  const visible = expanded ? rows : rows.slice(0, ROWS_SHOWN)
  const hiddenRows = rows.length - visible.length

  return (
    <div className="wt-st-list" data-testid={testId}>
      <div className="wt-section-head">
        <h3>{title}</h3>
        <span className="wt-section-hint">{hint ?? 'longest first'}</span>
      </div>
      <div className="wt-bars">
        {visible.map((row) => (
          <div className="wt-bar-row" key={row.key} data-row={row.key}>
            <div className="wt-bar-label" title={row.title}>
              <span className="wt-bar-title">{row.label}</span>
              {row.meta && <em className="wt-st-meta">{row.meta}</em>}
            </div>
            <div className="wt-bar-track">
              <div className="wt-bar-fill wt-st-fill" style={{ width: share(row.ms, totalMs) }} />
            </div>
            <span className="wt-bar-value">{formatDuration(row.ms)}</span>
          </div>
        ))}
      </div>
      {hiddenRows > 0 && (
        <button type="button" className="wt-ap-more" onClick={() => setExpanded(true)}>
          +{hiddenRows} more
        </button>
      )}
      {expanded && rows.length > ROWS_SHOWN && (
        <button type="button" className="wt-ap-more" onClick={() => setExpanded(false)}>Fewer</button>
      )}
      {/* Never truncate silently: a capped list that says nothing reads as the
          complete answer, and the missing time is real time. */}
      {dropped > 0 && (
        <p className="wt-section-hint">
          {dropped} more not shown ({formatDuration(droppedMs)} in total).
        </p>
      )}
    </div>
  )
}

function rowMeta(pickups?: number, notifications?: number): string | undefined {
  const parts: string[] = []
  if (pickups) parts.push(`${pickups} pickup${pickups === 1 ? '' : 's'}`)
  if (notifications) parts.push(`${notifications} notification${notifications === 1 ? '' : 's'}`)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/**
 * A readable name out of a bundle id, since Apple's store holds no display names
 * for apps installed on another device.
 *
 * Deliberately mechanical rather than a lookup table: a table would be a
 * never-finished list of the apps we happened to think of, and it would show a
 * polished name for the popular apps and a raw identifier for everything else,
 * which reads as a bug. The full identifier is always the row's tooltip, so nothing
 * is hidden by the prettier form.
 */
export function appLabel(bundleId: string): string {
  const last = bundleId.split('.').filter(Boolean).pop() ?? bundleId
  const spaced = last
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
  if (!spaced) return bundleId
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** A floor, so a real but tiny share is still visible as a mark. */
function share(ms: number, of: number): string {
  if (ms <= 0 || of <= 0) return '0%'
  return `max(3px, ${Math.min(100, (ms / of) * 100)}%)`
}

/**
 * One day of Apple Screen Time, as a hook.
 *
 * Pass an EMPTY date to mean "do not ask": a caller behind a toggle then costs
 * nothing while it is off, instead of sending the server a date it must reject.
 */
export function useScreenTime(api: TimeApi, log: PluginLogger, date: string) {
  const [day, setDay] = useState<DayScreenTime | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!date) return
    let live = true
    api.screenTime(date)
      .then((next) => { if (live) setDay(next) })
      .catch((err: unknown) => {
        log.warn('screen time fetch failed', { date, error: err instanceof Error ? err.message : String(err) })
        // Leave the previous answer standing: a transient failure must not blank a
        // day the user is reading.
      })
    return () => { live = false }
  }, [api, log, date, nonce])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  // Only ever the day being SHOWN: rendering yesterday's devices under today's
  // label is a visible flash of wrong data.
  return { day: day && day.date === date ? day : null, reload }
}
