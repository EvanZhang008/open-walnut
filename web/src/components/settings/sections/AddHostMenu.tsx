/**
 * Remote Hosts' Add host: the pane's one way to add a host, a menu of the two ways in, each
 * with a line saying what it needs. The menu hangs under the button with their right edges
 * aligned at every width (ContextMenu `anchorRef`), and it is opaque (remote-hosts.css): Linux
 * WebKit drew the menus' backdrop blur as nothing, so the page behind read through the words.
 * Opened from the keyboard (Enter, Space, or ArrowDown on the closed button) its first item is
 * highlighted. Escape gives focus back to the button, and so does a scroll that closes it (also
 * when the scroll moved the button into the sticky bar).
 */
import { useRef, useState } from 'react';
import { ContextMenu } from '@/components/common/ContextMenu';
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
  const [menu, setMenu] = useState<{ x: number; y: number; keys: boolean } | null>(null);
  const button = () => anchor.current?.querySelector<HTMLButtonElement>('button') ?? null;
  // The pane's header moves into the sticky bar on a scroll, as a new button: one that held the
  // focus, or whose menu did (a scroll closes it), takes it back there.
  const menuOpen = useRef(false);
  menuOpen.current = !!menu;
  useFocusAcrossRemount('remote-hosts-add', anchor, () => menuOpen.current);
  const open = (el: HTMLElement, keys: boolean) => {
    const r = el.getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 4, keys });
  };
  // A close that leaves the focus nowhere (a scroll, an outside press on blank space): back on the
  // button, at once while the menu still holds it (a frame later, WebKit under load had already
  // moved the button into the sticky bar, and the focus was left on the page), and again a frame
  // later for a focus that fell meanwhile.
  const close = () => {
    const lostFocus = () => {
      const a = document.activeElement;
      return !a || a === document.body || !a.isConnected || !!a.closest('[data-testid="remote-hosts-add-menu"]');
    };
    if (lostFocus()) button()?.focus({ preventScroll: true });
    setMenu(null);
    requestAnimationFrame(() => { if (lostFocus()) button()?.focus({ preventScroll: true }); });
  };
  return (
    <span ref={anchor} className="rh-add-anchor">
      <SettingsButton
        variant="primary"
        aria-haspopup="menu"
        aria-expanded={!!menu}
        data-testid="remote-hosts-add"
        // A click the keyboard made (a screen reader's) has no pointer: `detail` is 0.
        onClick={(e) => { if (menu) setMenu(null); else open(e.currentTarget, e.detail === 0); }}
        // Enter, Space and ArrowDown open it on the key going down, not through the click the
        // browser makes of Enter or Space: WebKit makes Space's click as the key comes up, and its
        // menu, already holding the focus, sometimes lost it to the button there and closed.
        onKeyDown={(e) => {
          if (menu || !(e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) return;
          e.preventDefault();
          open(e.currentTarget, true);
        }}
      >
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
