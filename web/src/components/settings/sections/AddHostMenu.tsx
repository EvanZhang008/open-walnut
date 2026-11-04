/**
 * Remote Hosts' Add host: the pane's one way to add a host, a menu of the two ways in, each
 * with a line saying what it needs. The menu hangs under the button with their right edges
 * aligned at every width (ContextMenu `anchorRef`), and it is opaque (remote-hosts.css): Linux
 * WebKit drew the menus' backdrop blur as nothing, so the page behind read through the words.
 * Escape gives focus back to the button.
 */
import { useRef, useState } from 'react';
import { ContextMenu } from '@/components/common/ContextMenu';
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
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const button = () => anchor.current?.querySelector<HTMLButtonElement>('button') ?? null;
  return (
    <span ref={anchor} className="rh-add-anchor">
      <SettingsButton
        variant="primary"
        aria-haspopup="menu"
        aria-expanded={!!menu}
        data-testid="remote-hosts-add"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu(menu ? null : { x: r.left, y: r.bottom + 4 });
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
          onClose={() => setMenu(null)}
          items={[
            { key: 'join', label: <Item title="Join a machine with a link" sub="Run one command on it. No SSH needed." />, onSelect: onJoin },
            { key: 'ssh', label: <Item title="Add an SSH host" sub="A machine this Mac already reaches with ssh." />, onSelect: onSsh },
          ]}
        />
      )}
    </span>
  );
}
