/**
 * Remote Hosts' Add host: the pane's one way to add a host, a menu of the two ways in, each
 * with a line saying what it needs. The menu hangs under the button with their right edges
 * aligned at every width (ContextMenu `anchorRef`), and it is opaque (remote-hosts.css): Linux
 * WebKit drew the menus' backdrop blur as nothing, so the page behind read through the words.
 * Opened from the keyboard (Enter, Space, or ArrowDown on the closed button) its first item is
 * highlighted. Escape gives focus back to the button, and so does a scroll that closes it (also
 * when the scroll moved the button into the sticky bar), and a press on blank page. A press on the
 * button while the menu is open closes it. The open state has one owner (useMenuButton.ts).
 */
import { useCallback, useRef } from 'react';
import { ContextMenu } from '@/components/common/ContextMenu';
import { useMenuButton } from './useMenuButton';
import { useFocusAcrossRemount } from '@/utils/focus-across-remount';
import { SettingsButton } from '../inputs/SettingsButton';

function Item({ title, sub }: { title: string; sub: string }) {
  return (
    <span className="rh-add-item">
      <span className="rh-add-item-title">{title}</span>{' '}
      <span className="rh-add-item-sub">{sub}</span>
    </span>
  );
}

export function AddHostButton({ onJoin, onSsh }: { onJoin: () => void; onSsh: () => void }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const button = useCallback(() => anchor.current?.querySelector<HTMLButtonElement>('button') ?? null, []);
  const { menu, buttonProps, close } = useMenuButton(button);
  // The pane's header moves into the sticky bar on a scroll, as a new button: one that held the
  // focus, or whose menu did (a scroll closes it), takes it back there.
  const menuOpen = useRef(false);
  menuOpen.current = !!menu;
  useFocusAcrossRemount('remote-hosts-add', anchor, () => menuOpen.current);
  return (
    <span ref={anchor} className="rh-add-anchor">
      <SettingsButton variant="primary" data-testid="remote-hosts-add" {...buttonProps}>
        Add host
      </SettingsButton>
      {menu && (
        <ContextMenu
          point={menu}
          anchorRef={anchor}
          ariaLabel="Add a host"
          testId="remote-hosts-add-menu"
          className="rh-add-menu"
          returnFocus={button()}
          highlightFirst={menu.keys}
          onClose={close}
          items={[
            { key: 'join', label: <Item title="Join a machine with a link" sub="Run one command on it. No SSH needed." />, onSelect: onJoin },
            { key: 'ssh', label: <Item title="Add an SSH host" sub="A machine this Mac already reaches with ssh." />, onSelect: onSsh },
          ]}
        />
      )}
    </span>
  );
}
