/**
 * The ONE section shell for /settings, plus the content primitives every
 * section is built from (group, row, disclosure, notice, tag, mono block).
 *
 * Contract kept deliberately narrow:
 *   - `id` stays on the outer element and the outer element keeps the
 *     `settings-section` class: hash steering, Cmd+S `requestSubmit`,
 *     SuggestAccuracyPanel's `closest('.settings-section')` and many specs
 *     address sections that way.
 *   - `as="form"` renders a <form> so Cmd+S still submits the focused section.
 *
 * Inside a SettingsPaneProvider the pane's lead section renders the big pane
 * header (tile, h2, one sentence, Saved indicator, pane actions); any other
 * section in the pane renders a folded 17px header. Outside a provider the
 * shell renders a plain header, so tests and other hosts keep working.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useInRouterContext, useLocation } from 'react-router-dom'
import { log } from '@/utils/log'
import {
  SettingsPaneTile,
  SettingsSavedIndicator,
  useSettingsPane,
  useSettingsPaneChrome,
} from './settings-pane-context'
import { ChevronGlyph, SpinnerGlyph } from './settings-glyphs'
import { CopyButton } from './inputs/CopyButton'
import '@/styles/settings-shell.css'
import '@/styles/settings-controls.css'

export interface SettingsSectionProps {
  id: string
  title: string
  /** One plain sentence about what this section is for. */
  description?: ReactNode
  /** Header-right pane-level controls (Refresh, Add host). Never Save. */
  actions?: ReactNode
  /** Rendered above the header: a persistent state banner, not a toast. */
  banner?: ReactNode
  children?: ReactNode
  /** Rendered after the body, e.g. SectionCard's Save row. */
  footer?: ReactNode
  /** `form` when the section saves on submit (Cmd+S), otherwise a plain section. */
  as?: 'form' | 'section'
  onSubmit?: (event: FormEvent) => void
  className?: string
  /** Pass-through for state a spec or stylesheet reads off the section element. */
  [key: `data-${string}`]: string | undefined
}

const hasContent = (n: ReactNode) => n !== undefined && n !== null && n !== false && n !== ''

function PaneHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  const { paneId, leadSectionId, metaFor, compact } = useSettingsPane()
  const { setLeadHeader, stickyActionsHost } = useSettingsPaneChrome()
  const meta = leadSectionId ? metaFor(leadSectionId) : undefined
  const desc = meta?.description || description
  return (
    <header className="settings-pane-header" ref={setLeadHeader}>
      {meta && <SettingsPaneTile meta={meta} />}
      <div className="settings-pane-heading">
        <h2 className="settings-pane-title settings-section-title" id={`${paneId}-title`} tabIndex={-1}>
          {meta?.title ?? title}
        </h2>
        {hasContent(desc) && <p className="settings-pane-desc settings-card-desc">{desc}</p>}
      </div>
      <div className="settings-pane-header-trailing">
        <SettingsSavedIndicator placement="header" />
        {hasContent(actions) &&
          (compact && stickyActionsHost ? (
            createPortal(actions, stickyActionsHost)
          ) : (
            <div className="settings-card-actions">{actions}</div>
          ))}
      </div>
    </header>
  )
}

function FoldedHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="settings-folded-header">
      <div className="settings-card-heading">
        <h3 className="settings-folded-title settings-section-title">{title}</h3>
        {hasContent(description) && <p className="settings-folded-desc settings-card-desc">{description}</p>}
      </div>
      {hasContent(actions) && <div className="settings-card-actions">{actions}</div>}
    </header>
  )
}

function PlainHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="settings-card-head">
      <div className="settings-card-heading">
        <h3 className="settings-section-title">{title}</h3>
        {hasContent(description) && <p className="settings-card-desc">{description}</p>}
      </div>
      {hasContent(actions) && <div className="settings-card-actions">{actions}</div>}
    </header>
  )
}

export function SettingsSection({
  id,
  title,
  description,
  actions,
  banner,
  children,
  footer,
  as = 'section',
  onSubmit,
  className,
  ...rest
}: SettingsSectionProps) {
  const { leadSectionId } = useSettingsPane()
  const { inProvider } = useSettingsPaneChrome()
  const isLead = inProvider && leadSectionId === id
  const header = !inProvider ? (
    <PlainHeader title={title} description={description} actions={actions} />
  ) : isLead ? (
    <PaneHeader title={title} description={description} actions={actions} />
  ) : (
    <FoldedHeader title={title} description={description} actions={actions} />
  )
  const inner = (
    <>
      {isLead ? (
        <>
          {header}
          {banner}
        </>
      ) : (
        <>
          {banner}
          {header}
        </>
      )}
      {hasContent(children) && <div className="settings-card-body">{children}</div>}
      {footer}
    </>
  )

  const classes =
    `settings-section settings-card${isLead ? ' is-lead' : inProvider ? ' is-folded' : ''}` +
    (className ? ` ${className}` : '')

  if (as === 'form') {
    return (
      <form id={id} className={classes} onSubmit={onSubmit} {...rest}>
        {inner}
      </form>
    )
  }
  return (
    <section id={id} className={classes} {...rest}>
      {inner}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export interface SettingsGroupProps {
  /** Sentence-case heading ABOVE the box. */
  heading?: ReactNode
  /** Right side of the heading line, e.g. `3 of 21 shown`. */
  headingTrailing?: ReactNode
  /** One sentence BELOW the box about the whole group. */
  footer?: ReactNode
  disabled?: boolean
  children?: ReactNode
  /** Goes on the box (the element with `settings-group`). */
  className?: string
  id?: string
  'data-testid'?: string
}

export function SettingsGroup({
  heading,
  headingTrailing,
  footer,
  disabled,
  children,
  className,
  id,
  'data-testid': testId,
}: SettingsGroupProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  // Nesting guard: one closest() per group mount, cheap enough to run always.
  useEffect(() => {
    const el = boxRef.current
    if (el?.parentElement?.closest('.settings-group')) {
      log.warn('settings', 'nested settings group', { sectionId: el.closest('.settings-section')?.id ?? null })
    }
  }, [])
  const framed = hasContent(heading) || hasContent(headingTrailing) || hasContent(footer)
  const dim = disabled ? { 'aria-disabled': true as const, inert: true } : {}
  const box = (
    <div
      ref={boxRef}
      className={`settings-group settings-subcard${className ? ` ${className}` : ''}`}
      {...(framed ? {} : { id, 'data-testid': testId, ...dim })}
    >
      {children}
    </div>
  )
  if (!framed) return box
  return (
    <div className="settings-group-block" id={id} data-testid={testId} {...dim}>
      {(hasContent(heading) || hasContent(headingTrailing)) && (
        <div className="settings-group-heading">
          <h4 className="settings-group-title settings-subcard-title">{heading}</h4>
          {hasContent(headingTrailing) && <span className="settings-group-heading-trailing">{headingTrailing}</span>}
        </div>
      )}
      {box}
      {hasContent(footer) && <p className="settings-group-footer settings-subcard-desc">{footer}</p>}
    </div>
  )
}

/** Old name. `title` becomes the heading, `description` the footer. */
export function SettingsSubCard({
  title,
  description,
  children,
  className,
}: {
  title?: ReactNode
  description?: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <SettingsGroup heading={title} footer={description} className={className}>
      {children}
    </SettingsGroup>
  )
}

/** A multi-select list group (calendars, session modes): 36px checkbox rows. */
export function SettingsChecklist({
  children,
  heading,
  headingTrailing,
}: {
  children?: ReactNode
  heading?: ReactNode
  headingTrailing?: ReactNode
}) {
  return (
    <SettingsGroup heading={heading} headingTrailing={headingTrailing} className="settings-checklist">
      {children}
    </SettingsGroup>
  )
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

export interface SettingsRowProps extends Omit<HTMLAttributes<HTMLElement>, 'children' | 'className'> {
  /** 14px label on the left. With `htmlFor` it is a real <label>. */
  label?: ReactNode
  /** One sentence under the label, 12.5px muted. */
  help?: ReactNode
  /** The control, right-aligned at the group edge. */
  control?: ReactNode
  htmlFor?: string
  /** Child row (36px left inset, hairline from 36px). */
  indent?: boolean
  /** Wide control (380px input, editor): wraps below the label under 600px. */
  wide?: boolean
  state?: 'warning' | 'error'
  /** Row error shown under the row (role=alert). Never timed. */
  error?: ReactNode
  disabled?: boolean
  /** Deep-link target id for this row (gets scroll-margin under the sticky bar). */
  anchor?: string
  /** Legacy API: children = copy column, actions = control column. */
  children?: ReactNode
  actions?: ReactNode
  className?: string
  /** Rows are what specs address, so `data-testid` / `data-*` state must pass through. */
  [key: `data-${string}`]: string | undefined
}

export function SettingsRow({
  label,
  help,
  control,
  htmlFor,
  indent,
  wide,
  state,
  error,
  disabled,
  anchor,
  children,
  actions,
  className,
  id,
  ...rest
}: SettingsRowProps) {
  const hasError = hasContent(error)
  const rowState = hasError ? 'error' : state
  const classes =
    'settings-row' +
    (indent ? ' settings-row-indent' : '') +
    (anchor ? ' settings-row-anchored' : '') +
    (className ? ` ${className}` : '')
  const hasControl = hasContent(control) || hasContent(actions)
  const row = (
    <article
      className={classes}
      id={anchor ?? id}
      data-wide={wide ? 'true' : undefined}
      data-state={rowState}
      // A warning keeps its tone when an error joins it (N3-16).
      data-warning={state === 'warning' && hasError ? 'true' : undefined}
      data-indent={indent ? 'true' : undefined}
      aria-disabled={disabled ? true : undefined}
      {...rest}
    >
      <div className="settings-row-copy">
        {hasContent(label) &&
          (htmlFor ? (
            <label className="settings-row-label" htmlFor={htmlFor}>
              {label}
            </label>
          ) : (
            <span className="settings-row-label">{label}</span>
          ))}
        {hasContent(help) && <p className="settings-row-help">{help}</p>}
        {children}
      </div>
      {hasControl && (
        <div className="settings-row-actions">
          {control}
          {actions}
        </div>
      )}
    </article>
  )
  if (!hasError) return row
  return (
    <>
      {row}
      <p className={`settings-row-error${indent ? ' settings-row-error-indent' : ''}`} role="alert">
        {error}
      </p>
    </>
  )
}

// ---------------------------------------------------------------------------
// Disclosure row
// ---------------------------------------------------------------------------

export const DISCLOSURE_STORAGE_PREFIX = 'walnut.settings.disclosure.'

export function disclosureStorageKey(id: string): string {
  return DISCLOSURE_STORAGE_PREFIX + id
}

type StoreLike = Pick<Storage, 'getItem' | 'setItem'> | null | undefined

export function readDisclosureOpen(storage: StoreLike, id: string, fallback: boolean): boolean {
  try {
    const v = storage?.getItem(disclosureStorageKey(id))
    if (v === '1') return true
    if (v === '0') return false
  } catch {
    /* storage blocked: fall back */
  }
  return fallback
}

export function writeDisclosureOpen(storage: StoreLike, id: string, open: boolean): void {
  try {
    storage?.setItem(disclosureStorageKey(id), open ? '1' : '0')
  } catch {
    /* storage blocked or full: state just is not remembered */
  }
}

/** The hash target id, decoded; null when empty. */
export function hashTargetId(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (!raw) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function sessionStore(): StoreLike {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

/** Router navigations (navigate({ hash })) fire no hashchange; watch them too. */
function RouterHashWatcher({ onHash }: { onHash: () => void }) {
  const { hash } = useLocation()
  useEffect(() => {
    if (hash) onHash()
  }, [hash, onHash])
  return null
}

export interface SettingsDisclosureProps {
  /** Stable id: storage key suffix and the content element id prefix. */
  id: string
  label: ReactNode
  help?: ReactNode
  /** Current value summary on the right, e.g. `On, every 30 s`. */
  summary?: ReactNode
  forceOpen?: boolean
  defaultOpen?: boolean
  children?: ReactNode
  'data-testid'?: string
}

/**
 * A row inside a group that shows/hides the indent rows after it. Closed rows
 * stay MOUNTED with `hidden`: uncontrolled sections read every field through
 * `new FormData(form)`, and an unmounted field would save as false/undefined.
 */
export function SettingsDisclosure({
  id,
  label,
  help,
  summary,
  forceOpen,
  defaultOpen = false,
  children,
  'data-testid': testId,
}: SettingsDisclosureProps) {
  const [open, setOpen] = useState(() => readDisclosureOpen(sessionStore(), id, defaultOpen))
  const contentRef = useRef<HTMLDivElement>(null)
  const contentId = `${id}-disclosure`
  const shown = open || !!forceOpen

  const setAndStore = useCallback(
    (next: boolean) => {
      setOpen(next)
      writeDisclosureOpen(sessionStore(), id, next)
    },
    [id],
  )

  const inRouter = useInRouterContext()
  const openForHash = useCallback(() => {
    const target = hashTargetId(window.location.hash)
    const el = target ? document.getElementById(target) : null
    if (el && contentRef.current?.contains(el)) setAndStore(true)
  }, [setAndStore])

  useEffect(() => {
    openForHash()
    window.addEventListener('hashchange', openForHash)
    return () => window.removeEventListener('hashchange', openForHash)
  }, [openForHash])

  return (
    <>
      {inRouter && <RouterHashWatcher onHash={openForHash} />}
      <button
        type="button"
        className="settings-row settings-disclosure-row"
        tabIndex={0}
        aria-expanded={shown}
        aria-controls={contentId}
        data-testid={testId}
        data-open={shown ? 'true' : 'false'}
        onClick={() => setAndStore(!shown)}
      >
        <span className="settings-row-copy">
          <span className="settings-row-label">{label}</span>
          {hasContent(help) && <span className="settings-row-help">{help}</span>}
        </span>
        <span className="settings-row-actions">
          {hasContent(summary) && <span className="settings-disclosure-summary">{summary}</span>}
          <ChevronGlyph size={12} className="settings-disclosure-chevron" />
        </span>
      </button>
      <div id={contentId} ref={contentRef} className="settings-disclosure-content" hidden={!shown}>
        {children}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/** The single empty state. A section says what is missing, in one line. */
export function SettingsEmpty({ children }: { children: ReactNode }) {
  return <div className="settings-empty">{children}</div>
}

/** The single notice (info / success / warn / error), optional trailing action. */
export function SettingsNotice({
  kind = 'info',
  children,
  role,
  action,
}: {
  kind?: 'info' | 'success' | 'warn' | 'error'
  children: ReactNode
  role?: string
  action?: ReactNode
}) {
  if (!hasContent(action)) {
    return (
      <p className={`settings-notice settings-notice-${kind}`} role={role}>
        {children}
      </p>
    )
  }
  return (
    <div className={`settings-notice settings-notice-${kind} settings-notice-with-action`} role={role}>
      <span className="settings-notice-text">{children}</span>
      <span className="settings-notice-action">{action}</span>
    </div>
  )
}

/** Status tag: `Built-in`, `Needs setup`, `Signed in`. */
export function SettingsTag({
  tone = 'neutral',
  title,
  children,
}: {
  tone?: 'neutral' | 'warning' | 'success' | 'error'
  title?: string
  children: ReactNode
}) {
  return (
    <span className={`settings-tag settings-tag-${tone}`} title={title}>
      {children}
    </span>
  )
}

/** In-place loading line for a group (44px, spinner, muted text). */
export function SettingsLoadingRow({ children = 'Loading...' }: { children?: ReactNode }) {
  return (
    <div className="settings-row settings-loading-row" aria-busy="true">
      <span className="settings-row-copy">
        <span className="settings-loading-text">
          <SpinnerGlyph size={12} />
          {children}
        </span>
      </span>
    </div>
  )
}

/** Read-only mono text (Raw config, Setup log): a row, not a box, with Copy. */
export function SettingsMonoBlock({
  label,
  text,
  maxHeight = 320,
  'data-testid': testId,
}: {
  label: ReactNode
  text: string
  maxHeight?: 320 | 240
  'data-testid'?: string
}) {
  const labelId = useId()
  return (
    <div className="settings-row settings-row-stacked settings-mono-row" data-wide="true">
      <div className="settings-mono-head">
        <span className="settings-row-label" id={labelId}>
          {label}
        </span>
        <CopyButton text={text} />
      </div>
      <pre
        className="settings-mono-block"
        style={{ maxHeight }}
        data-testid={testId}
        tabIndex={0}
        aria-labelledby={labelId}
      >
        {text}
      </pre>
    </div>
  )
}
