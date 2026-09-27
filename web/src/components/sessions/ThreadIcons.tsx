/**
 * Inline SVG icons for the question stack and the tree drawer. Never a Unicode
 * glyph (list, check, reopen arrows): glyph icons render at different baselines
 * in Chromium and WebKit and some sit in the Arrows block the UI keeps free.
 * 16-unit viewBox, currentColor, aria-hidden (the button carries the label).
 */
import type { ReactNode } from 'react';

export interface ThreadIconProps {
  size?: number;
  className?: string;
}

function Svg({ size = 14, className, children, name, fill = 'none' }: ThreadIconProps & { children: ReactNode; name: string; fill?: string }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 16 16" fill={fill} stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
      className={className ? `thread-icon ${className}` : 'thread-icon'} data-thread-icon={name}
    >
      {children}
    </svg>
  );
}

export function ThreadListIcon(p: ThreadIconProps) {
  return <Svg {...p} name="list"><path d="M2.5 4h11M2.5 8h11M2.5 12h11" /></Svg>;
}

export function ThreadCheckIcon(p: ThreadIconProps) {
  return <Svg {...p} name="check"><path d="M3 8.5l3.2 3.2L13 4.8" /></Svg>;
}

/** Counter-clockwise loop: back to open. */
export function ThreadReopenIcon(p: ThreadIconProps) {
  return <Svg {...p} name="reopen"><path d="M3.5 6.5A5 5 0 1 1 3 9.5" /><path d="M3.2 2.8v3.9h3.9" /></Svg>;
}

/** "Not yet": keep the question open (an open ring, like an open question's dot). */
export function ThreadNotYetIcon(p: ThreadIconProps) {
  return <Svg {...p} name="not-yet"><circle cx="8" cy="8" r="5" /></Svg>;
}

export function ThreadTrashIcon(p: ThreadIconProps) {
  return (
    <Svg {...p} name="trash">
      <path d="M2.5 4.5h11M6.5 4.5V3a.8.8 0 0 1 .8-.8h1.4a.8.8 0 0 1 .8.8v1.5" />
      <path d="M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.6M6.8 7v4.5M9.2 7v4.5" />
    </Svg>
  );
}

export function ThreadPinIcon(p: ThreadIconProps) {
  return <Svg {...p} name="pin"><path d="M6 2.5h4l-.6 4 2.3 2.2v1H4.3v-1l2.3-2.2zM8 9.7v3.8" /></Svg>;
}

/** Points right; rotate with CSS for down/left. */
export function ThreadChevronIcon(p: ThreadIconProps) {
  return <Svg {...p} name="chevron"><path d="M6 3.5L10.5 8 6 12.5" /></Svg>;
}

export function ThreadMoreIcon(p: ThreadIconProps) {
  return (
    <Svg {...p} name="more" fill="currentColor">
      <circle cx="3.5" cy="8" r="1.2" stroke="none" /><circle cx="8" cy="8" r="1.2" stroke="none" /><circle cx="12.5" cy="8" r="1.2" stroke="none" />
    </Svg>
  );
}

export function ThreadCloseIcon(p: ThreadIconProps) {
  return <Svg {...p} name="close"><path d="M4 4l8 8M12 4l-8 8" /></Svg>;
}

export function ThreadSearchIcon(p: ThreadIconProps) {
  return <Svg {...p} name="search"><circle cx="7" cy="7" r="4.2" /><path d="M10.2 10.2l3.3 3.3" /></Svg>;
}
