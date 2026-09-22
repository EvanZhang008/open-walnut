import { useState } from 'react';
import { ContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu';
import type { CustomTierDef } from '@/api/focus';
import { TASK_SHORTCUTS_KEY, useNavigationPreference } from '@/hooks/useNavigationPreference';

export function TaskViewMenu({ active, onChange, customTiers = [], actions = [] }: {
  active: string; onChange: (id: string) => void; customTiers?: CustomTierDef[]; actions?: ContextMenuItem[];
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; origin: HTMLElement } | null>(null);
  const [shortcuts, setShortcuts] = useNavigationPreference(TASK_SHORTCUTS_KEY);
  const views = [
    { id: 'all', label: 'All tasks' },
    { id: 'focus', label: 'Focus' }, { id: 'satellite', label: 'Satellite' },
    { id: 'backlog', label: 'Backlog' }, { id: 'wait', label: 'Wait' }, ...customTiers,
    { id: 'recent', label: 'Recent' }, { id: 'tasks', label: 'Projects' }, { id: 'notes', label: 'Scratchpad' },
  ];
  return <>
    <button type="button" className="task-view-menu-trigger" aria-label="Task view" aria-haspopup="menu" aria-expanded={!!menu}
      onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ x: rect.left, y: rect.bottom, origin: event.currentTarget }); }}>
      {views.find(view => view.id === active)?.label ?? 'All tasks'} <span aria-hidden="true">⌄</span>
    </button>
    {menu && <ContextMenu point={menu} returnFocus={menu.origin} ariaLabel="Task views" onClose={() => setMenu(null)} items={[
      ...views.map(view => ({ key: view.id, label: view.label, onSelect: () => onChange(view.id) })),
      { divider: true }, ...actions,
      { key: 'quick-views', label: `${shortcuts ? 'Hide' : 'Show'} task quick views`, onSelect: () => setShortcuts(!shortcuts) },
    ]} />}
  </>;
}
