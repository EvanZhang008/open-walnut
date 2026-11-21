/**
 * The one Copy button: a key of the button family (styles/buttons.css) that says "Copied" for a
 * moment. Settings, the password vault, notices and the terminal each had their own (four copies
 * of one idea, each its own look); they all render this one now.
 *
 * Its width never changes when the label flips: both labels sit in one grid cell (`.btn-reserve`).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { log } from '@/utils/log';
import { copyTextRobust } from '@/utils/clipboard';
import { ICON_CHECK, ICON_COPY } from './Icons';

export const COPIED_MS = 1500;

export type CopyButtonKind = 'default' | 'primary' | 'link' | 'ghost' | 'icon';

const KIND_CLASS: Record<CopyButtonKind, string> = {
  default: '',
  primary: ' btn-primary',
  link: ' btn-link',
  ghost: ' btn-ghost',
  icon: ' btn-icon',
};

export interface CopyButtonProps {
  text: string;
  /** The label at rest; "Copied" replaces it for a moment. Not shown for kind "icon". */
  label?: string;
  kind?: CopyButtonKind;
  /** The small size (28 px; 24 px for an icon). */
  small?: boolean;
  /** The copy and check glyphs before the label. Always on for kind "icon". */
  icon?: boolean;
  /** With `icon`: the label never changes, only the glyph turns into a check (a dense row such as a
   *  message's MD / Rich, where a reserved "Copied" width would push the label away from its glyph). */
  keepLabel?: boolean;
  /** How the text reaches the clipboard (the vault's own, which clears it later). Resolves when copied. */
  write?: (text: string) => Promise<unknown>;
  /** A press does not reach the row or card under the button (a notice that opens on click). */
  isolate?: boolean;
  /** The copy did not happen: the label says "Copy failed" until the next press. */
  onFailed?: () => void;
  className?: string;
  title?: string;
  'aria-label'?: string;
  'data-testid'?: string;
}

async function writeDefault(text: string): Promise<void> {
  if (await copyTextRobust(text) === 'failed') throw new Error('copy failed');
}

export function CopyButton({
  text, label = 'Copy', kind = 'default', small = true, icon = false, keepLabel = false, write = writeDefault, isolate = false, onFailed,
  className, title, 'aria-label': ariaLabel, 'data-testid': testId,
}: CopyButtonProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copied = state === 'copied';
  const shown = copied ? 'Copied' : state === 'failed' ? 'Copy failed' : label;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onlyIcon = kind === 'icon';
  const glyph: ReactNode = (icon || onlyIcon) ? (copied ? ICON_CHECK : ICON_COPY) : null;
  return (
    <button
      type="button"
      // WebKit only tabs to buttons with an explicit tabindex (the Mac app).
      tabIndex={0}
      className={`btn${small ? ' btn-sm' : ''}${KIND_CLASS[kind]}${state === 'failed' ? ' btn-danger' : ''}${className ? ` ${className}` : ''}`}
      data-testid={testId}
      data-copied={copied || undefined}
      title={title}
      aria-label={onlyIcon || state !== 'idle' ? (state === 'idle' ? ariaLabel ?? label : shown) : ariaLabel}
      onPointerDown={isolate ? (e) => e.stopPropagation() : undefined}
      onClick={(e) => {
        if (isolate) e.stopPropagation();
        write(text).then(
          () => {
            setState('copied');
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setState('idle'), COPIED_MS);
          },
          (err: unknown) => {
            log.warn('clipboard', 'copy failed', { message: String(err), length: text.length });
            if (onFailed) { setState('failed'); onFailed(); }
          },
        );
      }}
    >
      {glyph}
      {!onlyIcon && keepLabel && glyph && <span className="btn-label">{state === 'failed' ? 'Copy failed' : label}</span>}
      {!onlyIcon && !(keepLabel && glyph) && (
        <span className="btn-reserve" data-r1={onFailed && label.length < 11 ? 'Copy failed' : label} data-r2="Copied">
          <span className="btn-label">{shown}</span>
        </span>
      )}
    </button>
  );
}
