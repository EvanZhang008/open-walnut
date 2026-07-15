/**
 * GhostTextInput — text input with fish-shell-style inline ghost completion.
 *
 * Measured-overlay approach: a div behind the (transparent-background) input
 * renders <transparent>typed</transparent><grey>suffix</grey> with the exact
 * same font/padding, so the grey suffix appears to continue from the caret.
 * The wrapper carries the visual background; scrollLeft is synced for paths
 * wider than the input.
 */
import { forwardRef, useRef, useCallback } from 'react';

interface Props {
  value: string;
  /** Ghost suffix to render after the typed value (null = no ghost). */
  ghost: string | null;
  editing: boolean;
  placeholder: string;
  onChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

export const GhostTextInput = forwardRef<HTMLInputElement, Props>(function GhostTextInput(
  { value, ghost, editing, placeholder, onChange, onKeyDown }, ref,
) {
  const overlayRef = useRef<HTMLDivElement>(null);

  // Keep overlay horizontally aligned with input content when long paths scroll.
  const syncScroll = useCallback((e: React.SyntheticEvent<HTMLInputElement>) => {
    if (overlayRef.current) overlayRef.current.scrollLeft = e.currentTarget.scrollLeft;
  }, []);

  return (
    <div className={`sps-ghost-wrap${editing ? ' editing' : ''}`}>
      {editing && ghost && (
        <div className="sps-ghost-overlay" ref={overlayRef} aria-hidden="true">
          <span className="sps-ghost-typed">{value}</span>
          <span className="sps-ghost-text">{ghost}</span>
        </div>
      )}
      <input
        ref={ref}
        className={`sps-search-input${editing ? ' editing' : ''}${ghost ? ' has-ghost' : ''}`}
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onScroll={syncScroll}
        onInput={syncScroll}
        autoFocus
      />
    </div>
  );
});
