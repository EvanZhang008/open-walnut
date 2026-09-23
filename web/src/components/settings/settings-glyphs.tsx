/**
 * Line glyphs for the settings page. Inline SVG, stroke = currentColor, always
 * aria-hidden: the text next to a glyph carries the meaning, so the page never
 * needs a Unicode symbol (chevrons, check marks, crosses) in its visible text.
 */
import type { ReactNode, SVGProps } from 'react'

interface GlyphProps extends Omit<SVGProps<SVGSVGElement>, 'ref'> {
  /** Square size in px. */
  size?: number
}

function Glyph({ size = 12, children, className, ...rest }: GlyphProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`settings-glyph${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {children}
    </svg>
  )
}

/** Points right; a disclosure rotates it 90deg when open. */
export function ChevronGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M6 3.5 10.5 8 6 12.5" />
    </Glyph>
  )
}

export function CheckGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
    </Glyph>
  )
}

/** Exclamation in a circle: failure states. */
export function AlertGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.75v3.75" />
      <path d="M8 11.1v.15" />
    </Glyph>
  )
}

export function CloseGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" />
    </Glyph>
  )
}

/** Three-quarter ring; the CSS class spins it unless reduced motion is set. */
export function SpinnerGlyph({ className, ...props }: GlyphProps) {
  return (
    <Glyph className={`settings-spinner${className ? ` ${className}` : ''}`} {...props}>
      <path d="M8 1.75a6.25 6.25 0 1 1-6.25 6.25" />
    </Glyph>
  )
}
