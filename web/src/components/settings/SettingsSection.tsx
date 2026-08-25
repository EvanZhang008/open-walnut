/**
 * The ONE section shell for /settings.
 *
 * Every section on the page renders through this component — the sixteen that go
 * through SectionCard (which now delegates here) and the seven that used to
 * hand-roll `card settings-section [settings-section-wide]` with their own header
 * row. That is what makes the widths, the card chrome, the title/description type
 * and the header-action slot identical everywhere instead of per-section.
 *
 * Contract kept deliberately narrow:
 *   - `id` stays on the outer element. The page's scroll-spy, the nav's
 *     `scrollIntoView`, Cmd+S `requestSubmit`, and several specs all address
 *     sections by id, so it must not move to an inner wrapper.
 *   - the outer element keeps the `settings-section` class. It is not decoration:
 *     SuggestAccuracyPanel does `el.closest('.settings-section')`.
 *   - `as="form"` renders a <form> so Cmd+S still submits the focused section.
 *
 * A section with a genuinely unique interior (Usage's charts, Timeline's tape)
 * passes its own markup as children and gets the shell's box and header for free.
 */
import type { FormEvent, HTMLAttributes, ReactNode } from 'react'
import '@/styles/settings-shell.css'

export interface SettingsSectionProps {
  id: string
  title: string
  /** One plain sentence about what this section is for. */
  description?: ReactNode
  /** Header-right controls (Restore defaults, Refresh, + Add …). */
  actions?: ReactNode
  /** Rendered above the header — a persistent state banner, not a transient toast. */
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
  const inner = (
    <>
      {banner}
      <header className="settings-card-head">
        <div className="settings-card-heading">
          <h3 className="settings-section-title">{title}</h3>
          {description !== undefined && description !== null && description !== '' && (
            <p className="settings-card-desc">{description}</p>
          )}
        </div>
        {actions && <div className="settings-card-actions">{actions}</div>}
      </header>
      {children !== undefined && children !== null && children !== false && (
        <div className="settings-card-body">{children}</div>
      )}
      {footer}
    </>
  )

  const classes = `settings-section settings-card${className ? ` ${className}` : ''}`

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

/**
 * One list row: copy on the left, controls on the right. Generalises
 * `.app-manager-row` so the Apps manager, the Repositories list and the plugin
 * store all read as the same object.
 */
export interface SettingsRowProps extends Omit<HTMLAttributes<HTMLElement>, 'children' | 'className'> {
  children: ReactNode
  actions?: ReactNode
  className?: string
  /** Rows are what specs address, so `data-testid` / `data-*` state must pass through. */
  [key: `data-${string}`]: string | undefined
}

export function SettingsRow({
  children,
  actions,
  className,
  ...rest
}: SettingsRowProps) {
  return (
    <article className={`settings-row${className ? ` ${className}` : ''}`} {...rest}>
      <div className="settings-row-copy">{children}</div>
      {actions && <div className="settings-row-actions">{actions}</div>}
    </article>
  )
}

/** A grouping inside a section (a labelled block of related controls). */
export function SettingsSubCard({
  title,
  description,
  children,
  className,
}: {
  title?: string
  description?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={`settings-subcard${className ? ` ${className}` : ''}`}>
      {title && <h4 className="settings-subcard-title">{title}</h4>}
      {description && <p className="settings-subcard-desc">{description}</p>}
      {children}
    </div>
  )
}

/** The single empty state. A section says what is missing, in one line. */
export function SettingsEmpty({ children }: { children: ReactNode }) {
  return <div className="settings-empty">{children}</div>
}

/**
 * The single notice. Replaces per-section inline colours — including Timeline's
 * hardcoded `#FF3B30`, which stayed red-on-red in dark mode.
 */
export function SettingsNotice({
  kind = 'info',
  children,
  role,
}: {
  kind?: 'info' | 'success' | 'warn' | 'error'
  children: ReactNode
  role?: string
}) {
  return (
    <p className={`settings-notice settings-notice-${kind}`} role={role}>
      {children}
    </p>
  )
}
