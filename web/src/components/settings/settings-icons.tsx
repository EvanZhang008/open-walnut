/**
 * Settings tile glyphs: one inline line icon per pane (24 viewBox, stroke
 * currentColor 1.75, drawn white on the tile tint), plus the nav's own glyphs
 * (magnifier, arrow-up-right, circle-x). No icon fonts, no remote assets.
 *
 * Tiles must stay distinguishable: no two visible tiles share the same
 * (tint, glyph) pair. Plugin panels get a monogram on a tint hashed from the
 * plugin id, shifted to the next tint on a collision (assignPluginTint).
 */
import type { ReactNode } from 'react'

export type SettingsGlyphName =
  | 'two-person' | 'sparkles' | 'slash-in-square' | 'bookmark-stack' | 'bolt'
  | 'puzzle-piece' | 'app-window' | 'gear' | 'checklist' | 'two-speech-bubbles'
  | 'cpu-chip' | 'waveform' | 'microphone' | 'plug' | 'calendar-page'
  | 'hand-raised' | 'heart-pulse' | 'tray' | 'magnifier' | 'archive-box'
  | 'phone' | 'server-stack' | 'sliders' | 'bar-chart' | 'target' | 'display'
  | 'ladybug' | 'layers' | 'cloud' | 'key' | 'arrow-up-right' | 'circle-x'

export const SETTINGS_ICONS: Readonly<Record<SettingsGlyphName, ReactNode>> = {
  'two-person': (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" />
      <circle cx="16.5" cy="9" r="2.6" />
      <path d="M15.5 14.1c2.6-.3 4.5 1.4 5 4.4" />
    </>
  ),
  sparkles: (
    <>
      <path d="M11 3.5l1.6 4.4 4.4 1.6-4.4 1.6L11 15.5l-1.6-4.4L5 9.5l4.4-1.6z" />
      <path d="M18 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
    </>
  ),
  'slash-in-square': (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3.5" />
      <path d="M14.5 7.5l-5 9" />
    </>
  ),
  'bookmark-stack': (
    <>
      <path d="M9 3.5h8.5A1.5 1.5 0 0 1 19 5v15l-5-3.5L9 20V5a1.5 1.5 0 0 1 0-1.5z" />
      <path d="M5.5 6.5v13" />
    </>
  ),
  bolt: <path d="M13 3L5.5 13.5H12L11 21l7.5-10.5H12z" />,
  'puzzle-piece': (
    <path d="M9 4.5a2 2 0 0 1 4 0V6h4a1 1 0 0 1 1 1v4h-1.5a2 2 0 0 0 0 4H18v4a1 1 0 0 1-1 1h-4v-1.5a2 2 0 0 0-4 0V20H5a1 1 0 0 1-1-1v-4h1.5a2 2 0 0 0 0-4H4V7a1 1 0 0 1 1-1h4z" />
  ),
  'app-window': (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <path d="M3.5 9h17M6.5 7h.01M9 7h.01" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="2.8" />
      <circle cx="12" cy="12" r="6.3" />
      <path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4L6 18M18 18l-1.6-1.6M7.6 7.6L6 6" />
    </>
  ),
  checklist: (
    <path d="M4 6.5l1.5 1.5L8 5.5M4 12.5l1.5 1.5L8 11.5M4 18.5l1.5 1.5L8 17.5M11 7h9M11 13h9M11 19h9" />
  ),
  'two-speech-bubbles': (
    <>
      <path d="M4 5h10a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 14 13H8.5l-3 2.5V13H4a1.5 1.5 0 0 1-1.5-1.5v-5A1.5 1.5 0 0 1 4 5z" />
      <path d="M18 9h2a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 20 17h-1v2.5L16 17h-4a1.5 1.5 0 0 1-1.5-1.5" />
    </>
  ),
  'cpu-chip': (
    <>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
      <path d="M10 10h4v4h-4zM9.5 3.5V7M14.5 3.5V7M9.5 17v3.5M14.5 17v3.5M3.5 9.5H7M3.5 14.5H7M17 9.5h3.5M17 14.5h3.5" />
    </>
  ),
  waveform: <path d="M3.5 12h1M7 9v6M10.5 5.5v13M14 8v8M17.5 10v4M20.5 12h.01" />,
  microphone: (
    <>
      <rect x="9" y="3.5" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5" />
    </>
  ),
  plug: <path d="M9 3.5V8M15 3.5V8M6.5 8h11v3a5.5 5.5 0 0 1-11 0zM12 16.5v4" />,
  'calendar-page': (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
  'hand-raised': (
    <path d="M8.5 12.5V6a1.5 1.5 0 0 1 3 0v5M11.5 11V4.5a1.5 1.5 0 0 1 3 0V11M14.5 11V6a1.5 1.5 0 0 1 3 0v7.5a7 7 0 0 1-7 7H10a6 6 0 0 1-4.9-2.6l-1.5-2.3a1.5 1.5 0 0 1 2.3-1.9l2.6 2.3" />
  ),
  'heart-pulse': (
    <>
      <path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7a4.3 4.3 0 0 1 7.5 3c0 5.4-7.5 10-7.5 10z" />
      <path d="M6.5 12.5h3l1.2-2 1.8 3.5 1.2-1.5h3.8" />
    </>
  ),
  tray: (
    <>
      <path d="M4 13.5l2.2-7.4A1.5 1.5 0 0 1 7.6 5h8.8a1.5 1.5 0 0 1 1.4 1.1l2.2 7.4V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18z" />
      <path d="M4 13.5h4.5l1 2h5l1-2H20" />
    </>
  ),
  magnifier: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l5 5" />
    </>
  ),
  'archive-box': (
    <>
      <rect x="3.5" y="4.5" width="17" height="4.5" rx="1" />
      <path d="M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9M10 13h4" />
    </>
  ),
  phone: (
    <>
      <rect x="7" y="3" width="10" height="18" rx="2.5" />
      <path d="M11 17.5h2" />
    </>
  ),
  'server-stack': (
    <>
      <rect x="4" y="4.5" width="16" height="6.5" rx="1.5" />
      <rect x="4" y="13" width="16" height="6.5" rx="1.5" />
      <path d="M7.5 7.75h.01M7.5 16.25h.01" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9M4 12h5M13 12h7" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
      <circle cx="11" cy="12" r="2" />
    </>
  ),
  'bar-chart': <path d="M4 20h16M7 16.5v-5M12 16.5V6M17 16.5v-8" />,
  target: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  display: (
    <>
      <rect x="3" y="4.5" width="18" height="12" rx="2" />
      <path d="M9 20h6M12 16.5V20" />
    </>
  ),
  ladybug: (
    <>
      <ellipse cx="12" cy="14" rx="6" ry="6.5" />
      <path d="M12 7.5v13M9 5l1.5 2.5M15 5l-1.5 2.5M6 12H3.5M20.5 12H18M6.5 17.5l-2 1.5M17.5 17.5l2 1.5" />
    </>
  ),
  layers: <path d="M12 4l8.5 4.5L12 13 3.5 8.5zM3.5 12.5L12 17l8.5-4.5M3.5 16.5L12 21l8.5-4.5" />,
  cloud: <path d="M7 18.5a4.5 4.5 0 0 1-.4-9A6 6 0 0 1 18 9.8a4.4 4.4 0 0 1-.6 8.7z" />,
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l8.5-8.5M16.5 6.5L19 9M14 9l2 2" />
    </>
  ),
  'arrow-up-right': <path d="M7 17L17 7M9 7h8v8" />,
  'circle-x': (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </>
  ),
}

export function isSettingsGlyph(name: string): name is SettingsGlyphName {
  return Object.prototype.hasOwnProperty.call(SETTINGS_ICONS, name)
}

/** One line glyph. `aria-hidden`: the label next to it carries the meaning. */
export function SettingsIcon({ glyph, size = 13, className }: { glyph: SettingsGlyphName; size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-glyph={glyph}
      className={className}
    >
      {SETTINGS_ICONS[glyph]}
    </svg>
  )
}

/** Tints a plugin panel tile may take, in hash order. */
export const PLUGIN_TINTS = ['#FF9500', '#34C759', '#5AC8FA', '#AF52DE', '#FF2D55', '#A2845E'] as const

export function hashPluginId(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h
}

/** A tile's identity for the uniqueness rule: tint plus glyph (or monogram). */
export function tileKey(tint: string, mark: string): string {
  return `${tint.toUpperCase()}|${mark}`
}

/**
 * Tint for a plugin tile: hashed from the plugin id, then shifted along
 * PLUGIN_TINTS until (tint, mark) is not already taken. Adds its own key.
 */
export function assignPluginTint(pluginId: string, mark: string, taken: Set<string>): string {
  const start = hashPluginId(pluginId) % PLUGIN_TINTS.length
  for (let i = 0; i < PLUGIN_TINTS.length; i++) {
    const tint = PLUGIN_TINTS[(start + i) % PLUGIN_TINTS.length]
    const key = tileKey(tint, mark)
    if (!taken.has(key)) {
      taken.add(key)
      return tint
    }
  }
  // Six tints all taken for this mark: accept the hashed one (never throw in a nav).
  return PLUGIN_TINTS[start]
}

/** First letter (or digit) of a plugin name, uppercased: the monogram mark. */
export function monogramFor(name: string): string {
  const m = name.trim().match(/[\p{L}\p{N}]/u)
  return (m ? m[0] : '?').toUpperCase()
}
