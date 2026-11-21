/**
 * A group whose heading folds it (Remote Hosts > More settings: Relay, Walnut on a host, Tasks
 * using other hosts, Secrets, Session limits). Closed, its heading row says in one line what
 * is inside, so an open More settings reads at a glance instead of running five groups down
 * the page (2026-11-04 review). The box keeps the group's look and stays MOUNTED while closed,
 * like SettingsDisclosure, and a hash link to a row inside opens it. Its open state is
 * remembered for the browser session.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useInRouterContext } from 'react-router-dom'
import { hashTargetId, readDisclosureOpen, RouterHashWatcher, sessionStore, SettingsGroup, writeDisclosureOpen } from './SettingsSection'
import { ChevronGlyph } from './settings-glyphs'
import { lastSettingsAnchor, SETTINGS_ANCHOR_EVENT } from './settings-anchor-event'
import '@/styles/settings-fold.css'

/** How long after a hash a row that mounts late still opens its fold. */
const LATE_ROW_MS = 5_000

export function SettingsFoldGroup({ id, heading, summary, footer, bare, children, 'data-testid': testId }: {
  /** Storage key suffix. */
  id: string
  /** Children are whole groups of their own (headings and all), not rows for one box. */
  bare?: boolean
  heading: string
  /** What is inside, in a few words (and what needs a look). */
  summary: ReactNode
  footer?: ReactNode
  children: ReactNode
  'data-testid'?: string
}) {
  const [open, setOpen] = useState(() => readDisclosureOpen(sessionStore(), id, false))
  const bodyRef = useRef<HTMLDivElement>(null)
  const bodyId = `${id}-group-${useId().replace(/:/g, '')}`
  const setAndStore = useCallback((next: boolean) => {
    setOpen(next)
    writeDisclosureOpen(sessionStore(), id, next)
  }, [id])

  const inRouter = useInRouterContext()
  // The row asked for last (the hash, or Settings scrolling to a Find a setting hit) and when:
  // a row that mounts late opens the fold only shortly after it was asked for.
  const asked = useRef<{ id: string | null; at: number }>({ id: null, at: 0 })
  const openFor = useCallback((id: string | null) => {
    asked.current = { id, at: Date.now() }
    const el = id ? document.getElementById(id) : null
    if (el && bodyRef.current?.contains(el)) setAndStore(true)
  }, [setAndStore])
  const openForHash = useCallback(() => openFor(hashTargetId(window.location.hash)), [openFor])
  useEffect(() => {
    // Mounted after Settings asked for a row (this group's data came later): that row first.
    const anchor = lastSettingsAnchor()
    if (anchor && Date.now() - anchor.at < LATE_ROW_MS) openFor(anchor.id)
    else openForHash()
    const onAnchor = (e: Event) => openFor((e as CustomEvent<{ id?: string }>).detail?.id ?? null)
    window.addEventListener('hashchange', openForHash)
    window.addEventListener(SETTINGS_ANCHOR_EVENT, onAnchor)
    return () => {
      window.removeEventListener('hashchange', openForHash)
      window.removeEventListener(SETTINGS_ANCHOR_EVENT, onAnchor)
    }
  }, [openFor, openForHash])
  // A row inside that mounts after its data loads (Manage cloud companion's groups) is not there
  // yet when the hash arrives: open once it shows up, within a few seconds of the hash (never
  // later, so a fold the person closed stays closed while its rows refresh).
  useEffect(() => {
    const body = bodyRef.current
    if (open || !body || typeof MutationObserver === 'undefined') return
    const watch = new MutationObserver(() => {
      const { id, at } = asked.current
      if (!id || Date.now() - at > LATE_ROW_MS) return
      const el = document.getElementById(id)
      if (el && body.contains(el)) setAndStore(true)
    })
    watch.observe(body, { childList: true, subtree: true })
    return () => watch.disconnect()
  }, [open, setAndStore])

  return (
    <div className="settings-group-block settings-fold-group" data-testid={testId} data-open={open ? 'true' : 'false'}>
      {inRouter && <RouterHashWatcher onHash={openForHash} />}
      <h4 className="settings-fold-group-heading">
        <button
          type="button"
          tabIndex={0}
          className="settings-fold-group-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          data-testid={testId ? `${testId}-toggle` : undefined}
          onClick={() => { asked.current = { id: null, at: 0 }; setAndStore(!open) }}
        >
          <ChevronGlyph size={12} className="settings-disclosure-chevron" />
          <span className="settings-fold-group-title">{heading}</span>
          <span className="settings-fold-group-summary" data-testid={testId ? `${testId}-summary` : undefined}>{summary}</span>
        </button>
      </h4>
      <div id={bodyId} ref={bodyRef} className="settings-fold-group-body" hidden={!open}>
        {bare ? children : <SettingsGroup>{children}</SettingsGroup>}
        {footer && <p className="settings-group-footer settings-subcard-desc">{footer}</p>}
      </div>
    </div>
  )
}
