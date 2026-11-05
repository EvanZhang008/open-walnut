import { useEffect, useState } from 'react';
import { AnswerBox } from '@/components/common/AnswerBox';
import { useDraftValue } from '@/hooks/useDraft';
import { permissionNoteDraftKey } from '@/utils/drafts';
import { denyNoteMessage } from './prompt-keys';

/**
 * The note a prompt's Deny carries to the agent ("tell the agent what to do
 * instead"). Words only: the agent CLI takes a deny as one text message, so no
 * picture can go with it (tests/web/answer-box-pictures-guard.test.ts).
 */
/** One wording on the card, the toast and the panel. */
const NOTE_PLACEHOLDER = 'Tell the agent what to do instead \u00b7 Enter denies with it';

export function PermissionNoteBox({ value, draftKey, disabled, denyLabel, onChange, onSubmit, autoFocus, placeholder, onEscape }: {
  value: string;
  draftKey: string | null;
  disabled: boolean;
  /** The choice the note goes with ("Deny"). */
  denyLabel: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  autoFocus?: boolean;
  placeholder?: string;
  /** After Esc has left the box (DenyWithNote closes an empty one). */
  onEscape?: () => void;
}) {
  // Words already there when the box first shows are a draft left from earlier (a
  // reload, another surface): said, with a way to drop them, until the person edits.
  const [restored, setRestored] = useState(() => value.trim().length > 0);
  const box = (
    <AnswerBox
      className="permission-note"
      inputClassName="permission-note-input"
      testId="permission-note-input"
      value={value}
      draftKey={draftKey}
      disabled={disabled}
      maxRows={4}
      placeholder={placeholder ?? NOTE_PLACEHOLDER}
      ariaLabel="Note for the agent"
      onChange={(v) => { setRestored(false); onChange(v); }}
      onSubmit={onSubmit}
      autoFocus={autoFocus}
      // Esc leaves the box for its card, so the next digit picks a choice instead of
      // typing into the note (and switching the Allow choices off). The words stay.
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.nativeEvent.isComposing) return;
        e.preventDefault();
        e.stopPropagation();
        const card = e.currentTarget.parentElement?.closest<HTMLElement>('[tabindex]');
        if (card) card.focus({ preventScroll: true }); else e.currentTarget.blur();
        onEscape?.();
      }}
    />
  );
  if (!restored || !value.trim()) return box;
  return (
    <>
      <div className="permission-note-draft">
        Note saved from earlier
        <button type="button" className="permission-note-draft-clear" data-arm-exempt disabled={disabled} onClick={() => { setRestored(false); onChange(''); }}>Clear</button>
      </div>
      {box}
    </>
  );
}

/** A prompt's one note draft (permissionNoteDraftKey): the session card, a toast and the panel share it. */
export function usePermissionNote(requestId: string | null) {
  const draft = useDraftValue<string>(requestId ? permissionNoteDraftKey(requestId) : null, '');
  return { note: draft.value, text: draft.value.trim(), setNote: draft.setValue, key: draft.key };
}

/**
 * A toast's and the panel's way to deny with a note: one quiet button that opens
 * the box. Once words are typed, the surface's own Deny sends them too (its label
 * says "Deny with note"), and Enter in the box does the same.
 */
export function DenyWithNote({ note, disabled, onDeny }: {
  note: ReturnType<typeof usePermissionNote>;
  disabled: boolean;
  /** Sends the deny with this message (denyNoteMessage of the note). */
  onDeny: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Opened at the foot of a scrolled list (the panel's last ask): the whole box comes into view.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      (document.activeElement?.closest('.permission-note') ?? document.activeElement)?.scrollIntoView?.({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);
  if (!open && !note.text) {
    return (
      <button type="button" className="perm-note-toggle" data-testid="perm-note-toggle" disabled={disabled} onClick={() => setOpen(true)}>
        {'Deny with a note\u2026'}
      </button>
    );
  }
  return (
    <PermissionNoteBox
      value={note.note}
      draftKey={note.key}
      disabled={disabled}
      denyLabel="Deny"
      placeholder={NOTE_PLACEHOLDER}
      autoFocus={open}
      onChange={note.setNote}
      onSubmit={() => { if (note.text) onDeny(denyNoteMessage(note.text)); }}
      onEscape={() => { if (!note.text) setOpen(false); }}
    />
  );
}

/** The deny message a surface's Deny sends: the note, when one is typed. */
export function denyMessageOf(note: ReturnType<typeof usePermissionNote>): string | undefined {
  return note.text ? denyNoteMessage(note.text) : undefined;
}
