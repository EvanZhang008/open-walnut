/**
 * Inline SVG icons for the plugin update chip and the provenance trigger. No text glyphs
 * anywhere in this feature: a glyph like U+26A0 renders as a colour emoji on Apple WebKit
 * and the rest fall to different fallback fonts with different baselines. These are
 * stroke-only 24-unit paths, drawn at 14 px (chip) or 16 px (trigger) in currentColor.
 */
import type { ReactElement, SVGProps } from 'react'
import type { IconName } from './plugin-update-view'

export interface PluginUpdateIconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName
  size?: number
}

const PATHS: Record<IconName, ReactElement> = {
  check: <path d="M5 12.5l4.2 4.2L19 7.5" />,
  'arrow-up': <path d="M12 19V5m0 0l-6 6m6-6l6 6" />,
  pencil: <path d="M4 20l4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20zm11-13l3 3" />,
  'arrows-up-down': <path d="M8 20V4m0 0L4.5 7.5M8 4l3.5 3.5M16 4v16m0 0l3.5-3.5M16 20l-3.5-3.5" />,
  'cloud-off': (
    <>
      <path d="M7.5 18.5h10a3.5 3.5 0 0 0 .8-6.9 5.5 5.5 0 0 0-9-3.3M4.3 9.7A5.5 5.5 0 0 0 6.5 18.5" />
      <path d="M3 3l18 18" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="M10.8 12.2L20 3m-3 3l3 3m-6 0l2 2" />
    </>
  ),
  'slash-circle': (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M6 18L18 6" />
    </>
  ),
  'circle-dashed': (
    <path d="M12 3.5a8.5 8.5 0 0 1 4.3 1.2M20.5 12a8.5 8.5 0 0 1-1.2 4.3M12 20.5a8.5 8.5 0 0 1-4.3-1.2M3.5 12a8.5 8.5 0 0 1 1.2-4.3M18.2 5.8a8.6 8.6 0 0 1 1.4 1.7M18.2 18.2a8.6 8.6 0 0 1-1.7 1.4M5.8 18.2a8.6 8.6 0 0 1-1.4-1.7M5.8 5.8a8.6 8.6 0 0 1 1.7-1.4" />
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5M12 7.8v.3" />
    </>
  ),
  spinner: <path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5" />,
}

export function PluginUpdateIcon({ name, size = 14, className, ...rest }: PluginUpdateIconProps) {
  const cls = ['plugin-update-icon', `plugin-update-icon--${name}`, className].filter(Boolean).join(' ')
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={cls}
      {...rest}
    >
      {PATHS[name]}
    </svg>
  )
}
