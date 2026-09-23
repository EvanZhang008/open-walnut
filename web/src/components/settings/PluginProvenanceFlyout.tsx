/**
 * "Where this plugin runs from": the checkout path, branch, commit and remote of a linked
 * plugin (or the URL, installed ref, integrity and id of a source), demoted from the row
 * into a small portalled flyout behind an info trigger. The row itself never shows a full
 * path or URL; this dialog is the one place the full value appears, with a Copy button.
 *
 * Overlay rules (web/src/AGENTS.md): placed by useMenuPlacement, portalled to <body>,
 * root stops pointerdown propagation, closers exempt `.plugin-provenance-flyout`.
 */
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement'
import { formatAbsoluteTime } from './sections/addons-format'
import { PluginUpdateIcon } from './plugin-update-icons'
import { shortRemote, shortenHome } from './plugin-update-view'
import '@/styles/plugin-updates.css'

export interface LinkedProvenanceRows {
  /** Full checkout path; displayed through shortenHome, copied in full. */
  checkout: string
  branch: string
  sha: string
  remote?: string
}

export interface SourceProvenanceRows {
  /** Full (credential-masked) URL or npm spec; copied in full. */
  url: string
  /** sha7 for git, `v1.2.0` for npm; already formatted by the caller. */
  installedAt?: string
  integrity?: string
  id: string
}

export type PluginProvenanceFlyoutProps = {
  rowId: string
  checkedAt: string | null
  homeDir?: string | null
  now?: number
} & (
  | { kind: 'linked'; rows: LinkedProvenanceRows }
  | { kind: 'source'; rows: SourceProvenanceRows }
)

const FOCUSABLE = 'button, [href], input, [tabindex]:not([tabindex="-1"])'

/**
 * Copy through a synthetic `copy` event (so a listener can read text/plain, and so the
 * default action writes the clipboard without a permission prompt), then also through the
 * async clipboard API where it is allowed. Either path alone fails somewhere.
 */
export function copyText(text: string): void {
  if (typeof document === 'undefined') return
  const onCopy = (e: ClipboardEvent) => {
    e.clipboardData?.setData('text/plain', text)
    e.preventDefault()
  }
  document.addEventListener('copy', onCopy, true)
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    ta.style.pointerEvents = 'none'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  } finally {
    document.removeEventListener('copy', onCopy, true)
  }
  void navigator.clipboard?.writeText(text).catch(() => undefined)
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <button
      type="button"
      className="plugin-provenance-copy"
      onClick={(e) => {
        // The textarea trick moves focus to the textarea and then to <body>; put it back
        // on the button so the next Tab continues inside the dialog (N2-9).
        const button = e.currentTarget
        copyText(value)
        button.focus()
        setCopied(true)
      }}
      aria-live="polite"
    >
      {copied ? 'Copied' : label}
    </button>
  )
}

export function PluginProvenanceFlyout(props: PluginProvenanceFlyoutProps) {
  const { rowId, checkedAt, homeDir, now } = props
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // 'start': the flyout's left edge sits on the trigger's left edge, so it reads as
  // hanging off the info button rather than starting where the button ends.
  const placement = useMenuPlacement(open, triggerRef, menuRef, {
    align: 'start',
    preferSide: 'down',
    minHeight: 120,
    onAnchorLost: () => setOpen(false),
  })

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }, [])

  // Outside pointerdown closes it; clicks inside (this flyout is portalled, so the class
  // check is the test) do not. Scrolling does NOT close it (N2-4): the click that opens the
  // flyout often scrolls its trigger into view first, and a trackpad keeps emitting scroll
  // events after the fingers lift, so a scroll listener swallowed the first click. The
  // placement hook already follows the anchor on scroll and calls `onAnchorLost` when the
  // trigger leaves the viewport, which is the one scroll that should close a popover.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null
      if (!target) return
      if (target.closest('.plugin-provenance-flyout')) return
      if (triggerRef.current?.contains(target)) return
      close(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open, close])

  // Focus moves into the dialog on open (first focusable), back to the trigger on Esc.
  useEffect(() => {
    if (!open) return
    const first = menuRef.current?.querySelector<HTMLElement>(FOCUSABLE)
    first?.focus()
  }, [open])

  // Esc closes while open, wherever focus is: a click on non-focusable text inside the
  // dialog drops focus to <body>, and a React handler on the dialog root never hears it.
  // Capture phase, so a settings pane's own Esc handler (close panel) does not run first.
  useEffect(() => {
    if (!open) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      close(true)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, close])

  const checked = checkedAt
    ? `Checked ${formatAbsoluteTime(checkedAt, now !== undefined ? new Date(now) : undefined)}`
    : 'Not checked yet'
  const isLinked = props.kind === 'linked'
  const copyValue = isLinked ? props.rows.checkout : props.rows.url

  const rows: Array<{ label: string; value: ReactNode; action?: ReactNode }> = isLinked
    ? [
        {
          label: 'Checkout',
          value: <span className="plugin-provenance-path">{shortenHome(props.rows.checkout, homeDir)}</span>,
          action: <CopyButton value={copyValue} label="Copy path" />,
        },
        {
          label: 'Branch',
          value: props.rows.branch === 'HEAD'
            ? <>detached at <code>{props.rows.sha.slice(0, 7)}</code></>
            : props.rows.branch,
        },
        { label: 'Commit', value: <code>{props.rows.sha.slice(0, 7)}</code> },
        { label: 'Remote', value: props.rows.remote ? shortRemote(props.rows.remote) : 'No remote' },
      ]
    : [
        {
          label: 'Source',
          value: <span className="plugin-provenance-path">{props.rows.url}</span>,
          action: <CopyButton value={copyValue} label="Copy URL" />,
        },
        ...(props.rows.installedAt ? [{ label: 'Installed at', value: <code>{props.rows.installedAt}</code> }] : []),
        ...(props.rows.integrity
          ? [{ label: 'Integrity', value: <code>{props.rows.integrity.replace(/^sha\d+-/, '').slice(0, 12)}</code> }]
          : []),
        { label: 'Id', value: <code className="plugin-provenance-muted">{props.rows.id}</code> },
      ]

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="plugin-provenance-trigger"
        aria-label="Where this plugin runs from"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid={`provenance-trigger-${rowId}`}
        onClick={(e) => { e.preventDefault(); setOpen((v) => !v) }}
      >
        <PluginUpdateIcon name="info" size={16} />
      </button>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={menuRef}
              className="plugin-provenance-flyout"
              role="dialog"
              aria-label={isLinked ? 'Plugin checkout' : 'Plugin source'}
              data-testid={`provenance-flyout-${rowId}`}
              style={menuPlacementStyle(placement)}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <dl className="plugin-provenance-list">
                {rows.map((row) => (
                  <div className="plugin-provenance-row" key={row.label}>
                    <dt>{row.label}</dt>
                    <dd>
                      {row.value}
                      {row.action}
                    </dd>
                  </div>
                ))}
              </dl>
              <div className="plugin-provenance-foot">{checked}</div>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
