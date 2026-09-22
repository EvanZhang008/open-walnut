/**
 * ✦ sparkles — the ONE mark for "this row asks Walnut".
 *
 * Every AI action a surface offers (the Mail row menu's Summarize / Draft a reply / Ask, the Slack
 * menus' twins) draws this glyph, so the user learns one shape rather than one per console. It is a
 * stroke icon on purpose: the action rows it leads are text, and a filled star reads as "favourite".
 * The Slack plugin carries its own copy of the same path (a plugin cannot import core); keep them
 * identical if either changes.
 *
 * Not to be confused with NotesPage's private filled sparkle on the notes AI toggle — that one is a
 * button's own glyph, not the shared action mark.
 */

interface SparklesIconProps {
  size?: number;
  className?: string;
}

export function SparklesIcon({ size = 14, className }: SparklesIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {/* The four-pointed star: concave sides, so it reads as a sparkle and not as a diamond. */}
      <path d="M10 2.5l1.9 5.1L17 9.5l-5.1 1.9L10 16.5l-1.9-5.1L3 9.5l5.1-1.9z" />
      {/* The small companion is what makes the pair read as "AI" at 14px. */}
      <path d="M17.6 14l.85 2.25 2.25.85-2.25.85-.85 2.25-.85-2.25-2.25-.85 2.25-.85z" />
    </svg>
  );
}
