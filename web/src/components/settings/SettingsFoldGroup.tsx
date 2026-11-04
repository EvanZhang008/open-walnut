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
import '@/styles/settings-fold.css'

export function SettingsFoldGroup({ id, heading, summary, footer, children, 'data-testid': testId }: {
  /** Storage key suffix. */
  id: string
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
  const openForHash = useCallback(() => {
    const target = hashTargetId(window.location.hash)
    const el = target ? document.getElementById(target) : null
    if (el && bodyRef.current?.contains(el)) setAndStore(true)
  }, [setAndStore])
  useEffect(() => {
    openForHash()
    window.addEventListener('hashchange', openForHash)
    return () => window.removeEventListener('hashchange', openForHash)
  }, [openForHash])

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
          onClick={() => setAndStore(!open)}
        >
          <ChevronGlyph size={12} className="settings-disclosure-chevron" />
          <span className="settings-fold-group-title">{heading}</span>
          <span className="settings-fold-group-summary" data-testid={testId ? `${testId}-summary` : undefined}>{summary}</span>
        </button>
      </h4>
      <div id={bodyId} ref={bodyRef} className="settings-fold-group-body" hidden={!open}>
        <SettingsGroup>{children}</SettingsGroup>
        {footer && <p className="settings-group-footer settings-subcard-desc">{footer}</p>}
      </div>
    </div>
  )
}
