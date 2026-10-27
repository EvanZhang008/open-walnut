/**
 * A name the user renames in place (the org's name, the user's role on the chart): it reads as
 * text, a click turns it into a field, Enter or leaving the field saves, Escape keeps the old
 * name. A blank name goes back to the default (the server's rule, org-settings.ts).
 */
import { useEffect, useRef, useState } from 'react';

interface Props {
  value: string;
  /** What it names, for its labels ("the org's name"). */
  label: string;
  onSave: (next: string) => Promise<void>;
  className?: string;
  testId: string;
  maxLength?: number;
}

export function OrgEditableName({ value, label, onSave, className = '', testId, maxLength = 60 }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [failed, setFailed] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Once per edit: Escape, or an Enter whose field then blurs as it goes away, is not a second save.
  const cancelled = useRef(false);
  useEffect(() => { if (editing) input.current?.select(); }, [editing]);

  if (!editing) {
    return (
      <button
        type="button"
        className={`org-name-edit ${className}${failed ? ' is-failed' : ''}`}
        data-testid={testId}
        title={failed ? `Not saved. Click to rename ${label} again.` : `Rename ${label}`}
        onClick={(e) => { e.stopPropagation(); setDraft(value); setFailed(false); cancelled.current = false; setEditing(true); }}
      >{value}</button>
    );
  }
  const commit = () => {
    setEditing(false);
    if (cancelled.current) return;
    cancelled.current = true;
    const next = draft.replace(/\s+/g, ' ').trim();
    if (next === value) return;
    onSave(next).catch(() => setFailed(true));
  };
  return (
    <input data-no-draft="rename"
      ref={input}
      className={`org-name-input ${className}`}
      data-testid={`${testId}-input`}
      aria-label={`Rename ${label}`}
      value={draft}
      maxLength={maxLength}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelled.current = true; setEditing(false); }
      }}
      onBlur={commit}
    />
  );
}
