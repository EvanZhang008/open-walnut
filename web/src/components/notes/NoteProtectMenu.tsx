/**
 * The Lock control in a note's header on the Notes page (docs/reference/locked-notes.md): one lock
 * button that drops a short menu of what the note can become. A plain note: Hide from AI (plain on
 * disk, no agent tool reads it, covered on this page until Show, no password) or Encrypt (the
 * lock: a confirm, then the master password). A hidden note: Encrypt or Unhide. A locked note has
 * no menu: its panel's Remove lock gives back what it was. Shown only with the Locked notes
 * experiment on (NotesEditorPanel); a note already hidden or locked opens covered whatever it says.
 *
 * The menu is the shared ContextMenu hung under its button (`anchorRef`, placed by
 * useMenuPlacement, portalled), its open state owned by useMenuButton like Remote Hosts' Add host.
 */
import { useRef } from 'react';
import { ContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu';
import { useMenuButton } from '@/components/settings/sections/useMenuButton';
import { ICON_EYE, ICON_EYE_OFF, ICON_LOCK } from '@/components/common/Icons';
import { useLeanCallback } from '@/hooks/useLeanCallback';

export type NoteProtectAction = 'hide' | 'lock' | 'unhide';

/** The menu's rows for a plain or a hidden note, in the order they show. */
export function protectMenuItems(hidden: boolean, run: (action: NoteProtectAction) => void): ContextMenuItem[] {
  const encrypt: ContextMenuItem = { key: 'lock', label: 'Encrypt', icon: ICON_LOCK, title: 'Encrypt it with your Passwords master password', onSelect: () => run('lock') };
  return hidden
    ? [encrypt, { key: 'unhide', label: 'Unhide', icon: ICON_EYE, title: 'Let agents read it again', onSelect: () => run('unhide') }]
    : [{ key: 'hide', label: 'Hide from AI', icon: ICON_EYE_OFF, title: 'Agents cannot read it. Its text stays unencrypted.', onSelect: () => run('hide') }, encrypt];
}

export function NoteProtectMenu({ hidden, onAction }: { hidden: boolean; onAction: (action: NoteProtectAction) => void }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const button = useLeanCallback(() => anchor.current?.querySelector<HTMLButtonElement>('button') ?? null, []);
  const { menu, buttonProps, close } = useMenuButton(button);
  return (
    <span ref={anchor} className="notes-protect-anchor">
      <button type="button" className="btn btn-icon notes-lock-btn" aria-label="Hide or encrypt this note" title="Hide or encrypt" data-testid="note-lock" {...buttonProps}>
        {ICON_LOCK}
      </button>
      {menu && (
        <ContextMenu
          point={menu}
          anchorRef={anchor}
          ariaLabel="Hide or encrypt this note"
          testId="note-protect-menu"
          returnFocus={button()}
          highlightFirst={menu.keys}
          onClose={close}
          items={protectMenuItems(hidden, onAction)}
        />
      )}
    </span>
  );
}
