import type { CSSProperties } from 'react';

/**
 * The inline style of an `.app-content-area` that holds a full-bleed app (Mail, Passwords, a
 * plugin's app): no padding, no scroll of its own, and no scrollbar gutter kept, because such an
 * app scrolls in its own boxes (a kept gutter is a blank strip of about 15px down the right edge
 * where scrollbars take room). One definition for the main window (AppShell) and an app's own
 * window (PopoutAppView), so the two never drift.
 */
const FULL_BLEED: CSSProperties = { padding: 0, overflow: 'hidden', scrollbarGutter: 'auto' };

export function contentAreaStyle(fullBleed: boolean): CSSProperties | undefined {
  return fullBleed ? FULL_BLEED : undefined;
}
