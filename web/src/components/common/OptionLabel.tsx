import './option-label.css';
import { shownOptionLabel } from './option-label';

/**
 * An option's label as a question row shows it: its words, and "Recommended" at the right end
 * (a CSS mark on data-recommended, as the Threads card's AskOptions) when the label carried it
 * or the caller names it the recommended one.
 */
export function OptionLabel({ label, recommended, className }: {
  label: string;
  /** The caller knows it is the recommended one (its own field, not the words). */
  recommended?: boolean;
  className?: string;
}) {
  const shown = shownOptionLabel(label);
  const marked = recommended || shown.recommended;
  return (
    <span className={`option-label${className ? ` ${className}` : ''}`} {...(marked ? { 'data-recommended': 'true' } : {})}>
      {shown.text}
    </span>
  );
}
