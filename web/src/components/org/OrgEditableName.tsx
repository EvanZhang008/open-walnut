/**
 * A name the user renames in place (the org's name, the user's role on the chart): it reads as
 * text, a click turns it into a field, Enter or leaving the field saves, Escape keeps the old
 * name. A blank name goes back to the default (the server's rule, org-settings.ts).
 */
import { useEffect, useRef, useState } from 'react';
import { MicInput } from '@/components/common/BoxMic';

interface Props {
  value: string;
  /** What it names, for its labels ("the org's name"). */
  label: string;
  onSave: (next: string) => Promise<void>;
  className?: string;
  testId: string;
  maxLength?: number;
  /** Always the field (a settings row): Enter or leaving it saves, Escape puts the saved name back. */
  asField?: boolean;
}

export function OrgEditableName({ value, label, onSave, className = '', testId, maxLength = 60, asField = false }: Props) {
  const [editingNow, setEditing] = useState(false);
  const editing = asField || editingNow;
  const [draft, setDraft] = useState(value);
  const [failed, setFailed] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Once per edit: Escape, or an Enter whose field then blurs as it goes away, is not a second save.
  const cancelled = useRef(false);
  useEffect(() => { if (editingNow) input.current?.select(); }, [editingNow]);
  // A field shows the saved name while it is not being changed (a rename elsewhere, a save's answer).
  const focused = useRef(false);
  useEffect(() => { if (asField && !focused.current && !failed) setDraft(value); }, [asField, value, failed]);

  if (!editing) {
    return (
      <button
        type="button"
        className={`org-name-edit ${className}${failed ? ' is-failed' : ''}`}
        data-testid={testId}
        title={failed ? `Not saved. Click to rename ${label} again.` : `${value}. Click to rename.`}
        onClick={(e) => { e.stopPropagation(); setDraft(value); setFailed(false); cancelled.current = false; setEditing(true); }}
      >{value}</button>
    );
  }
  const commit = () => {
    focused.current = false;
    setEditing(false);
    if (cancelled.current) { cancelled.current = asField ? false : cancelled.current; return; }
    cancelled.current = !asField;
    const next = draft.replace(/\s+/g, ' ').trim();
    if (next === value) return;
    setFailed(false);
    onSave(next).catch(() => setFailed(true));
  };
  const field = (
    <MicInput data-no-draft="rename"
      ref={input}
      className={`${asField ? 'org-name-field' : 'org-name-input'} ${className}`}
      fieldClassName={asField ? 'mic-field-grow' : 'mic-field-compact mic-field-grow'}
      data-testid={`${testId}-input`}
      aria-label={`Rename ${label}`}
      value={draft}
      maxLength={maxLength}
      onClick={(e) => e.stopPropagation()}
      setText={setDraft}
      // Enter saves once a name still being dictated is in (the box's send gate).
      onEnter={commit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation(); cancelled.current = true; setEditing(false);
          if (asField) { setDraft(value); setFailed(false); input.current?.blur(); }
        }
      }}
      onFocus={() => { focused.current = true; }}
      onBlur={commit}
    />
  );
  if (!asField) return field;
  // A field has no button to wear the failure: it says it under the field, and the words stay to try again.
  return (
    <>
      {field}
      {failed && <span className="org-thread-error org-name-failed" role="alert" data-testid={`${testId}-failed`}>Not saved. Press Enter to try again.</span>}
    </>
  );
}
