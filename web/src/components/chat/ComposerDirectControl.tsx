import { useEffect, useRef, useState, type RefObject } from 'react';
import type { ComposerControlsBarHandle } from './ComposerControlsBar';

interface Mirrored { present: boolean; open: boolean; disabled: boolean; title: string; count: string }
const CLOSED: Mirrored = { present: false, open: false, disabled: false, title: '', count: '' };
const same = (a: Mirrored, b: Mirrored) =>
  a.present === b.present && a.open === b.open && a.disabled === b.disabled && a.title === b.title && a.count === b.count;

/** Mirror the mounted control's live state, never a second copy of its logic. The
 *  mounted control may render after this button, or be replaced by a re-render, so
 *  the button watches its whole composer and looks the control up again on each change. */
export function ComposerDirectControl({ id, handleRef, disabled }: {
  id: string;
  handleRef: RefObject<ComposerControlsBarHandle | null>;
  disabled?: boolean;
}) {
  const selfRef = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<Mirrored>(CLOSED);
  useEffect(() => {
    const root = selfRef.current?.closest('.chat-input-box') ?? selfRef.current?.parentElement;
    const read = () => {
      const source = handleRef.current?.button(id);
      const next = source ? {
        present: true, open: source.classList.contains('is-open'), disabled: source.disabled,
        title: source.title, count: source.querySelector('.side-question-count')?.textContent ?? '',
      } : CLOSED;
      setState((prev) => (same(prev, next) ? prev : next));
    };
    read();
    if (!root) return;
    const observer = new MutationObserver(read);
    observer.observe(root, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['class', 'disabled', 'title'],
    });
    return () => observer.disconnect();
  }, [id, handleRef]);
  return <button ref={selfRef} type="button"
    className={`side-question-pill composer-direct-control${state.open ? ' is-open' : ''}`}
    // Hidden until the control it mirrors is mounted (the session record may load later).
    style={state.present ? undefined : { display: 'none' }}
    data-add-control={id} disabled={disabled || state.disabled} aria-expanded={state.open}
    title={state.title || (id === 'btw' ? 'Open side threads' : 'Add a session note')}
    // Keep focus where it is until the toggle runs (no blur first), while other
    // popups still see the press and close. Note's editor would read the press as
    // outside and collapse before its own toggle, so only Note keeps it.
    onMouseDown={(event) => event.preventDefault()}
    onPointerDown={id === 'note' ? (event) => event.stopPropagation() : undefined}
    onClick={() => handleRef.current?.activate(id)}>
    {id === 'btw' ? 'btw' : 'Note'}
    {state.count && <span className="side-question-count">{state.count}</span>}
  </button>;
}
