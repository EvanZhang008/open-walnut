/**
 * The key hints at the foot of a menu, picker or palette: ONE footer and ONE key cap everywhere
 * (overlay-family.css, wn-menu-foot and wn-key; tests/web/menu-row-family.test.ts). Each hint is a key
 * and the word for what it does; `children` go after the hints (a count at the far end, say).
 */
import type { ReactNode } from 'react';

export type KeyHint = readonly [key: string, does: string];

export function KeyHints({ hints, className, children, hidden = false }: {
  hints: ReadonlyArray<KeyHint | false | null | undefined>;
  className?: string;
  children?: ReactNode;
  /** Hide the hints from a screen reader (only where the rows already say what each key does). */
  hidden?: boolean;
}) {
  return (
    <div className={`wn-menu-foot${className ? ` ${className}` : ''}`} aria-hidden={hidden || undefined}>
      {hints.filter((h): h is KeyHint => !!h).map(([key, does]) => (
        <span key={`${key} ${does}`} className="wn-key-hint"><kbd className="wn-key">{key}</kbd>{' '}{does}</span>
      ))}
      {children}
    </div>
  );
}
