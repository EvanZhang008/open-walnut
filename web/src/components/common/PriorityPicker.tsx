import { useState, useEffect, useRef } from 'react';
import type { TaskPriority } from '@walnut/core';

const PRIORITY_ORDER: TaskPriority[] = ['immediate', 'important', 'backlog', 'none'];

const PRIORITY_ICON: Record<string, string> = {
  immediate: '!!',
  important: '!',
  backlog: '~',
  none: '--',
};

const PRIORITY_LABEL: Record<string, string> = {
  immediate: 'Immediate',
  important: 'Important',
  backlog: 'Backlog',
  none: 'None',
};

interface PriorityPickerProps {
  priority: TaskPriority;
  onChange: (priority: TaskPriority) => void;
  /** Use fixed positioning for the dropdown (escapes overflow:hidden parents). */
  fixed?: boolean;
}

export function PriorityPicker({ priority, onChange, fixed }: PriorityPickerProps) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Normalize legacy values for display
  const displayPriority = (['high', 'medium', 'low'].includes(priority) ? 'none' : priority) as TaskPriority;
  const cssClass = displayPriority === 'immediate' ? 'immediate'
    : displayPriority === 'important' ? 'important'
    : displayPriority === 'backlog' ? 'backlog' : 'none';

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wrapperRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleScroll = () => setOpen(false);
    document.addEventListener('mousedown', handleClick);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [open]);

  const handleSelect = (p: TaskPriority) => {
    if (p !== priority) onChange(p);
    setOpen(false);
  };

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!open && fixed && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 2, left: rect.right });
    }
    setOpen(!open);
  };

  const menuStyle = fixed && menuPos
    ? { position: 'fixed' as const, top: menuPos.top, right: window.innerWidth - menuPos.left, zIndex: 9999 } as React.CSSProperties
    : undefined;

  return (
    <div className="priority-picker-wrapper" ref={wrapperRef}>
      <button
        ref={btnRef}
        type="button"
        className={`badge badge-${cssClass} badge-clickable`}
        title={PRIORITY_LABEL[displayPriority] ?? priority}
        onClick={handleToggle}
      >
        {PRIORITY_ICON[displayPriority] ?? priority}
      </button>
      {open && (
        <div className="priority-picker-menu" ref={menuRef} style={menuStyle}>
          {PRIORITY_ORDER.map((p) => (
            <button
              key={p}
              className={`priority-picker-item${displayPriority === p ? ' active' : ''}`}
              onClick={(e) => { e.stopPropagation(); handleSelect(p); }}
            >
              <span className={`priority-picker-icon badge-${p}`}>
                {PRIORITY_ICON[p]}
              </span>
              <span>{PRIORITY_LABEL[p]}</span>
              {displayPriority === p && <span className="priority-picker-check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
