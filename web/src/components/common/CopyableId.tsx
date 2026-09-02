/**
 * CopyableId — a task/session id rendered as a reference, not a headline.
 *
 * Why it exists: an agent, a log line or a session message names a task by id
 * ("mtjpcnzl-d230"), and until the detail view showed one there was no way to
 * tell which card that was. Two ways to get the id out, because both are used:
 * a click copies it (and, via `user-select: all`, visibly selects it as the
 * confirmation that something happened), and the text stays real selectable
 * text so Cmd+C and drag-select still work for pasting into a terminal.
 *
 * Colors come from theme vars only — no pinned background/foreground pair.
 */

import { useEffect, useRef, useState } from 'react';
import { copyTextRobust } from '@/utils/clipboard';
import { log } from '@/utils/log';

const CONFIRM_MS = 1400;

export function CopyableId({
  id, label = 'ID', title,
}: {
  id: string;
  /** Short prefix shown before the id, e.g. "ID". */
  label?: string;
  /** Tooltip; defaults to a copy hint carrying the full id. */
  title?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const copy = () => {
    void copyTextRobust(id).then((result) => {
      if (result === 'failed') {
        // Not a dead end: the text is selectable, so say so instead of lying.
        log.warn('tasks', 'copy id failed — falling back to manual selection', { id });
        setState('failed');
      } else {
        setState('copied');
      }
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setState('idle'), CONFIRM_MS);
    });
  };

  return (
    <span className="copyable-id" data-testid="copyable-id">
      {label && <span className="copyable-id-label">{label}</span>}
      <span
        className="copyable-id-value"
        role="button"
        tabIndex={0}
        title={title ?? `Click to copy ${id}`}
        onClick={copy}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copy(); }
        }}
      >
        {id}
      </span>
      <span className="copyable-id-status" aria-live="polite">
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select to copy' : ''}
      </span>
    </span>
  );
}
