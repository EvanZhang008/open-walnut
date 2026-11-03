/**
 * The task kebab's three dots, drawn, not typed. The ⋮ character took its ink from
 * whatever font the system had: on the Mac it sat on the row's center line, on Linux
 * its fallback font put it 2px high (2026-11-03, CI's session-header-alignment). Three
 * circles in a box the button centers land on the same line in every engine and font.
 * Sized in em, so a larger font-size (the phone's top bar) scales it as it scaled the glyph.
 */
export function KebabIcon() {
  return (
    <svg className="task-kebab-dots" viewBox="0 0 3 12" fill="currentColor" aria-hidden="true">
      <circle cx="1.5" cy="1.25" r="1.25" />
      <circle cx="1.5" cy="6" r="1.25" />
      <circle cx="1.5" cy="10.75" r="1.25" />
    </svg>
  );
}
