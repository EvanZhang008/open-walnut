/**
 * A fold of settings a person changes rarely, under the ones they use (Remote Hosts' "More
 * settings"): one heading row with a chevron and a line saying what is inside and how much
 * of it needs a look. It holds whole groups, so it is a region of the section, never a
 * group inside a group (SettingsGroup's nesting guard).
 *
 * Like SettingsDisclosure, a closed fold keeps its groups MOUNTED (hidden): they read their
 * state and report what needs a look while closed, and a hash link to anything inside opens
 * it. Its open state is remembered for the browser session.
 */
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { useInRouterContext } from 'react-router-dom'
import { hashTargetId, readDisclosureOpen, RouterHashWatcher, sessionStore, writeDisclosureOpen } from './SettingsSection'
import { ChevronGlyph } from './settings-glyphs'
import { landOnRow } from '@/utils/scroll-land'
import '@/styles/settings-fold.css'

type Report = (key: string, count: number) => void
const AttentionContext = createContext<Report | null>(null)

/** A group inside a fold says how many of its rows need a look (0 when none). */
export function useFoldAttention(key: string, count: number): void {
  const report = useContext(AttentionContext)
  useEffect(() => { report?.(key, count) }, [report, key, count])
  useEffect(() => () => report?.(key, 0), [report, key])
}

export function SettingsFold({ id, label, summary, children, 'data-testid': testId }: {
  /** Storage key suffix and the body element id prefix. */
  id: string
  label: string
  /** What is inside, in a few words. */
  summary: string
  children: ReactNode
  'data-testid'?: string
}) {
  const [open, setOpen] = useState(() => readDisclosureOpen(sessionStore(), id, false))
  const [counts, setCounts] = useState<Record<string, number>>({})
  const bodyRef = useRef<HTMLDivElement>(null)
  const foldRef = useRef<HTMLElement>(null)
  const bodyId = `${id}-fold-${useId().replace(/:/g, '')}`

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

  const report = useCallback<Report>((key, count) => {
    setCounts((prev) => ((prev[key] ?? 0) === count ? prev : { ...prev, [key]: count }))
  }, [])
  const needs = useMemo(() => Object.values(counts).reduce((a, b) => a + b, 0), [counts])

  return (
    <section className="settings-fold" ref={foldRef} data-open={open ? 'true' : 'false'} data-testid={testId}>
      {inRouter && <RouterHashWatcher onHash={openForHash} />}
      <button
        type="button"
        className="settings-fold-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        data-testid={testId ? `${testId}-toggle` : undefined}
        onClick={() => {
          setAndStore(!open)
          // Opened near the page end: brought up so what it holds is in view (2026-11-04 review).
          if (!open) requestAnimationFrame(() => { if (foldRef.current) landOnRow(foldRef.current, { focus: false }) })
        }}
      >
        <ChevronGlyph size={12} className="settings-disclosure-chevron" />
        <span className="settings-fold-copy">
          <span className="settings-fold-label">{label}</span>
          <span className="settings-fold-summary">
            {summary}
            {needs > 0 && <span className="settings-fold-needs" data-testid={testId ? `${testId}-needs` : undefined}>{needs === 1 ? '1 needs a look' : `${needs} need a look`}</span>}
          </span>
        </span>
      </button>
      <div id={bodyId} ref={bodyRef} className="settings-fold-body" hidden={!open}>
        <AttentionContext.Provider value={report}>{children}</AttentionContext.Provider>
      </div>
    </section>
  )
}
