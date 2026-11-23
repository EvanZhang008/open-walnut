/**
 * "Email from": the mailbox a topic's people are emailed from, the user's own choice (mail goes
 * out in his name). A button that opens Walnut's own menu (never a native select: web/src/AGENTS.md,
 * Menus & overlays) of the mail accounts that can send, and "No mailbox". Shown by the side panel
 * and the New topic dialog only while a person is in the topic or being added.
 */
import { useRef } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { ContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu';
import { useMenuButton } from '@/components/settings/sections/useMenuButton';
import { mailboxWords, useMailAccounts } from './useMailAccounts';
import { MenuCaret } from '@/components/controls';

export function TopicMailFrom({ value, onPick, disabled }: {
  value: string | null;
  onPick: (accountId: string | null) => void;
  disabled?: boolean;
}) {
  const { accounts, available } = useMailAccounts(true);
  const anchor = useRef<HTMLSpanElement>(null);
  const button = useLeanCallback(() => anchor.current?.querySelector<HTMLButtonElement>('button') ?? null, []);
  const { menu, buttonProps, close } = useMenuButton(button);
  const words = mailboxWords(accounts, value);

  const items: ContextMenuItem[] = [
    ...(accounts ?? []).map((a) => ({ key: a.accountId, label: a.address, checked: a.accountId === value, onSelect: () => { if (a.accountId !== value) onPick(a.accountId); } })),
    ...(accounts && !accounts.length ? [{ key: 'none-can-send', info: true, label: available ? 'No mail account can send. Add one in Settings, Mail.' : 'Mail is off or did not answer.' }] : []), // empty-state-ok: a menu info item (ContextMenu items take a string label)
    ...(accounts === null ? [{ key: 'loading', info: true, label: 'Reading the mail accounts…' }] : []),
    { key: 'divider', divider: true },
    { key: 'no-mailbox', label: 'No mailbox (nothing is emailed)', checked: !value, onSelect: () => { if (value) onPick(null); } },
  ];

  return (
    <div className="topic-mail-from" data-testid="topic-mail-from">
      <span className="topic-field-label">Email from</span>
      <span ref={anchor} className="topic-mail-from-anchor">
        <button type="button" className="btn btn-sm topic-mail-from-btn" data-testid="topic-mail-from-button" data-account-id={value ?? ''} disabled={disabled} {...buttonProps}>
          {words ?? 'Choose a mailbox'} <MenuCaret />
        </button>
        {menu && (
          <ContextMenu
            point={menu}
            anchorRef={anchor}
            ariaLabel="Email from"
            testId="topic-mail-from-menu"
            returnFocus={button()}
            highlightFirst={menu.keys}
            onClose={close}
            items={items}
          />
        )}
      </span>
      {!value && <span className="topic-muted" data-testid="topic-mail-from-none">Nothing is emailed until you choose one.</span>}{/* empty-state-ok: a help line under the field */}
    </div>
  );
}
