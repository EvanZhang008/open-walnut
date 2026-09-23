import { Children, createContext, isValidElement, useContext, useEffect, useMemo, useState, type ReactNode, type MouseEvent } from 'react';
import { ContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu';
import { useNotifications } from '@/contexts/notifications';
import { TASK_SHORTCUTS_KEY, useNavigationPreference } from '@/hooks/useNavigationPreference';

import { orderedNavigationIds, moveNavigationId } from './navigation-order';

interface OrderContext {
  ids: string[];
  move: (from: string, to: string) => void;
  storageKey: string;
}
const NavigationOrder = createContext<OrderContext | null>(null);

export function NavigationSections({ storageKey, children }: { storageKey: string; children: ReactNode }) {
  const nodes = Children.toArray(children).filter(isValidElement<{ navId: string }>);
  const { notify } = useNotifications();
  const [saved, setSaved] = useState<unknown>(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) ?? 'null'); } catch { return null; }
  });
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key !== storageKey && event.key !== null) return;
      try { setSaved(JSON.parse(localStorage.getItem(storageKey) ?? 'null')); } catch { setSaved(null); }
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [storageKey]);
  const ids = orderedNavigationIds(saved, nodes.map(node => node.props.navId));
  const value = useMemo(() => ({ ids, storageKey, move: (from: string, to: string) => {
    const next = moveNavigationId(ids, from, to);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      setSaved(next);
      notify({ kind: 'sort', severity: 'info', title: 'Navigation reordered', persistent: false, dedupKey: `navigation-order:${storageKey}`,
        action: { label: 'Undo', kind: 'callback' }, onAction: () => {
          try {
            const current = localStorage.getItem(storageKey);
            if (current !== JSON.stringify(next)) return;
            localStorage.setItem(storageKey, JSON.stringify(ids));
            setSaved(ids);
          } catch {
            notify({ kind: 'operation-error', severity: 'error', title: 'Could not restore navigation order', persistent: false, dedupKey: `navigation-order-error:${storageKey}` });
          }
        } });
    } catch {
      notify({ kind: 'operation-error', severity: 'error', title: 'Could not save navigation order', persistent: false, dedupKey: `navigation-order-error:${storageKey}` });
    }
  } }), [ids.join('\0'), storageKey, notify]);
  const byId = new Map(nodes.map(node => [node.props.navId, node]));
  return <NavigationOrder.Provider value={value}>{ids.map(id => byId.get(id))}</NavigationOrder.Provider>;
}

export function NavigationSection({ children }: { navId: string; children: ReactNode }) {
  return <>{children}</>;
}

interface HeadingProps {
  id: string;
  label: string;
  className?: string;
  collapsed?: boolean;
  /** A group's glyph (a tier's), drawn before the name. Section headings have none. */
  icon?: ReactNode;
  onClick: () => void;
  actions?: ContextMenuItem[];
}

export function NavigationHeading({ id, label, className = '', collapsed, icon, onClick, actions = [] }: HeadingProps) {
  const order = useContext(NavigationOrder);
  const [tabBar, setTabBar] = useNavigationPreference(TASK_SHORTCUTS_KEY);
  const [menu, setMenu] = useState<{ x: number; y: number; origin: HTMLElement } | null>(null);
  const [over, setOver] = useState(false);
  const openMenu = (event: MouseEvent<HTMLElement>, atCursor = false) => {
    event.preventDefault(); event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ x: atCursor ? event.clientX : rect.right, y: atCursor ? event.clientY : rect.bottom, origin: event.currentTarget });
  };
  const index = order?.ids.indexOf(id) ?? -1;
  const items: ContextMenuItem[] = [
    ...actions,
    ...(actions.length ? [{ divider: true }] : []),
    { key: 'up', label: 'Move up', disabled: !order || index <= 0, onSelect: () => order?.move(id, order.ids[index - 1]) },
    { key: 'down', label: 'Move down', disabled: !order || index < 0 || index >= order.ids.length - 1, onSelect: () => order?.move(id, order.ids[index + 1]) },
    // A panel-wide setting, so every heading offers it, the same switch as the filter menu's.
    { divider: true },
    { key: 'tab-bar', label: 'Show tab bar', toggle: true, checked: tabBar, onSelect: () => setTabBar(!tabBar) },
  ];
  return <>
    <div className={`navigation-heading ${className}${over ? ' navigation-drop-target' : ''}`} data-navigation-id={id}
      onContextMenu={event => openMenu(event, true)}
      onDragOver={event => { if (event.dataTransfer.types.includes(`text/${order?.storageKey}`)) { event.preventDefault(); event.stopPropagation(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={event => { const from = event.dataTransfer.getData(`text/${order?.storageKey}`); setOver(false); if (from) { event.preventDefault(); event.stopPropagation(); order?.move(from, id); } }}>
      <button type="button" className="navigation-heading-open" draggable={!!order}
        aria-expanded={collapsed === undefined ? undefined : !collapsed}
        onClick={onClick}
        onKeyDown={event => { if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && order) { event.preventDefault(); const target = order.ids[index + (event.key === 'ArrowUp' ? -1 : 1)]; if (target !== undefined) order.move(id, target); } }}
        onDragStart={event => { event.stopPropagation(); event.dataTransfer.setData(`text/${order?.storageKey}`, id); event.dataTransfer.effectAllowed = 'move'; }}>
        {icon && <span className="navigation-icon" aria-hidden="true">{icon}</span>}
        <span className="navigation-label">{label}</span>
        {collapsed !== undefined && <NavigationChevron collapsed={collapsed} />}
      </button>
      <button type="button" className="navigation-more" aria-label={`${label} menu`} aria-haspopup="menu" onClick={event => openMenu(event)} onPointerDown={event => event.stopPropagation()}>···</button>
    </div>
    {menu && <ContextMenu point={menu} items={items} onClose={() => setMenu(null)} returnFocus={menu.origin} ariaLabel={`${label} actions`} />}
  </>;
}

/** Trails the name, Claude-sidebar style: `⌄` open, `›` folded. */
export function NavigationChevron({ collapsed }: { collapsed: boolean }) {
  return <svg className={`navigation-chevron${collapsed ? '' : ' expanded'}`} width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 2 6.5 5 3.5 8" /></svg>;
}
