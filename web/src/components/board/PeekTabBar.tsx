/**
 * The chat column's tab bar (usePeekTabs): "Chat", the panel's own, then one tab
 * per task opened beside it, like a browser's tabs. A click switches, × closes,
 * the arrow keys walk the tabs (Enter or Space switches), Delete closes the
 * focused one. Right-click (or the list button at the end) lists every tab, with
 * Close, Close other tabs and Close all tabs, the same menu for both gestures.
 *
 * It sits where the "Chat" bar was, at the same height, with the bar's own right
 * corner (the hide-chat toggle) passed in as `rightSlot`.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { ContextMenu, type ContextMenuItem, type ContextMenuPoint } from '@/components/common/ContextMenu';
import { ICON_CHEVRON_DOWN, ICON_CLOSE } from '@/components/common/Icons';
import { useStoreTask, useTasksContextSafe } from '@/contexts/TasksContext';
import { boardPhaseLabel } from './board-peek-model';
import type { PeekTabsState } from './usePeekTabs';
import '@/styles/task-board.css';

export interface PeekTabBarProps {
  peek: PeekTabsState;
  rightSlot?: ReactNode;
}

const OWN = '';

function tabTitle(task: { title?: string } | null, id: string): string {
  return task?.title || id;
}

function PeekTab({ id, selected, onSelect, onClose, onMenu }: {
  id: string; selected: boolean;
  onSelect: (id: string) => void; onClose: (id: string) => void; onMenu: (e: MouseEvent, id: string) => void;
}) {
  const task = useStoreTask(id);
  const title = tabTitle(task, id);
  const phase = boardPhaseLabel(task?.phase);
  return (
    <div
      className={`peek-tab${selected ? ' is-active' : ''}`}
      data-testid="peek-tab"
      data-task-id={id}
      onContextMenu={(e) => onMenu(e, id)}
      // A middle click closes, as in a browser.
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(id); } }}
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        tabIndex={selected ? 0 : -1}
        className="peek-tab-main"
        data-tab-id={id}
        title={phase ? `${title} · ${phase}` : title}
        onClick={() => onSelect(id)}
      >
        <span className="peek-tab-dot" data-phase={task?.phase ?? ''} aria-hidden="true" />
        <span className="peek-tab-title" data-testid="peek-tab-title">{title}</span>
      </button>
      <button
        type="button"
        className="peek-tab-close"
        tabIndex={-1}
        aria-label={`Close ${title}`}
        title="Close tab"
        data-testid="peek-tab-close"
        onClick={(e) => { e.stopPropagation(); onClose(id); }}
      >{ICON_CLOSE}</button>
    </div>
  );
}

export function PeekTabBar({ peek, rightSlot }: PeekTabBarProps) {
  const { tabs, active } = peek;
  const listRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ point: ContextMenuPoint; subject: string | null; origin: HTMLElement | null } | null>(null);
  const tasks = useTasksContextSafe()?.tasks;

  // The active tab stays in view when the strip scrolls.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[role="tab"][aria-selected="true"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, tabs.length]);

  const select = useCallback((id: string | null) => peek.activate(id, 'tab'), [peek]);
  const closeTab = useCallback((id: string) => peek.close(id, 'close'), [peek]);

  const openMenuAt = useCallback((e: MouseEvent, subject: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ point: { x: e.clientX, y: e.clientY }, subject, origin: e.currentTarget as HTMLElement });
  }, []);
  const openListMenu = useCallback((e: MouseEvent<HTMLButtonElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    setMenu({ point: { x: box.right, y: box.bottom + 4 }, subject: active, origin: e.currentTarget });
  }, [active]);

  const focusTab = (id: string | null) => {
    const el = listRef.current?.querySelector<HTMLElement>(`[role="tab"][data-tab-id="${CSS.escape(id ?? OWN)}"]`);
    el?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const tab = (e.target as HTMLElement).closest<HTMLElement>('[role="tab"]');
    if (!tab) return;
    const order: Array<string | null> = [null, ...tabs];
    const at = Math.max(0, order.indexOf(tab.dataset.tabId || null));
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (at + 1) % order.length;
    else if (e.key === 'ArrowLeft') next = (at - 1 + order.length) % order.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = order.length - 1;
    else if ((e.key === 'Delete' || e.key === 'Backspace') && tab.dataset.tabId) {
      e.preventDefault();
      const gone = tab.dataset.tabId;
      const neighbour = order[at + 1] !== undefined ? order[at + 1] : order[at - 1] ?? null;
      peek.close(gone, 'key');
      requestAnimationFrame(() => focusTab(neighbour ?? null));
      return;
    }
    if (next === null) return;
    e.preventDefault();
    focusTab(order[next] ?? null);
  };

  const subject = menu?.subject ?? null;
  const items: ContextMenuItem[] = menu ? [
    { key: 'own', label: 'Chat', checked: active === null, onSelect: () => peek.activate(null, 'menu') },
    ...tabs.map((id): ContextMenuItem => {
      const task = tasks?.find((t) => t.id === id) ?? null;
      const title = tabTitle(task, id);
      const phase = boardPhaseLabel(task?.phase);
      return {
        key: `tab:${id}`,
        label: title,
        title: phase ? `${title} · ${phase}` : undefined,
        checked: active === id,
        onSelect: () => peek.activate(id, 'menu'),
      };
    }),
    { key: 'd1', divider: true },
    { key: 'close', label: 'Close tab', when: !!subject, onSelect: () => subject && peek.close(subject, 'menu') },
    { key: 'others', label: 'Close other tabs', when: !!subject && tabs.length > 1, onSelect: () => subject && peek.closeOthers(subject) },
    { key: 'all', label: 'Close all tabs', when: tabs.length > 0, onSelect: () => peek.closeAll() },
  ] : [];

  return (
    <div className="session-chat-bar peek-tab-bar" data-testid="peek-tab-bar" onContextMenu={(e) => openMenuAt(e, null)}>
      <div className="peek-tabs" role="tablist" aria-label="Chats in this column" ref={listRef} onKeyDown={onKeyDown}>
        <div
          className={`peek-tab peek-tab-own${active === null ? ' is-active' : ''}`}
          data-testid="peek-tab"
          data-task-id=""
          onContextMenu={(e) => openMenuAt(e, null)}
        >
          <button
            type="button"
            role="tab"
            aria-selected={active === null}
            tabIndex={active === null ? 0 : -1}
            className="peek-tab-main"
            data-tab-id={OWN}
            title="This panel's own chat"
            onClick={() => select(null)}
          ><span className="peek-tab-title" data-testid="peek-tab-title">Chat</span></button>
        </div>
        {tabs.map((id) => (
          <PeekTab key={id} id={id} selected={active === id} onSelect={select} onClose={closeTab} onMenu={openMenuAt} />
        ))}
      </div>
      <button
        type="button"
        className="sfe-btn peek-tab-list"
        aria-label="All tabs in this column"
        aria-haspopup="menu"
        aria-expanded={!!menu}
        title="All tabs (or right-click a tab)"
        data-testid="peek-tab-list"
        onClick={openListMenu}
      >{ICON_CHEVRON_DOWN}</button>
      {rightSlot}
      {menu && (
        <ContextMenu
          point={menu.point}
          items={items}
          onClose={() => setMenu(null)}
          ariaLabel="Tabs in this column"
          testId="peek-tab-menu"
          returnFocus={menu.origin}
        />
      )}
    </div>
  );
}
