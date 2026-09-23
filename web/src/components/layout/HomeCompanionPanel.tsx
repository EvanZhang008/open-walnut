import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { CalendarSidePanel } from '@/components/calendar/CalendarSidePanel';

interface Props {
  open: boolean;
  onClose: () => void;
}

/** The day agenda beside the home conversation, toggled from the rail's Home group. */
export function HomeCompanionPanel({ open: requested, onClose }: Props) {
  const open = useLocation().pathname === '/' && requested;
  const shellRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) shellRef.current?.querySelector<HTMLButtonElement>('.cal-side-header [title="Close calendar panel"]')?.focus({ preventScroll: true });
  }, [open]);
  // Stays mounted once shown, so the chosen day and an open create form survive closing.
  const visited = useRef(false);
  if (open) visited.current = true;
  if (!visited.current) return null;

  return (
    <aside
      ref={shellRef}
      aria-label="Calendar side panel"
      onKeyDown={event => {
        if (event.key !== 'Escape' || event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return;
        if (document.querySelector('.cal-popover-backdrop')) return;
        event.stopPropagation();
        onClose();
      }}
      className={`home-companion${open ? ' home-companion-calendar' : ''}`}
      data-testid="home-companion"
      data-active={open ? 'calendar' : 'none'}
      style={open ? undefined : { display: 'none' }}
      inert={!open}
    >
      <div className="home-companion-body home-companion-body-calendar" data-testid="home-companion-calendar">
        <CalendarSidePanel onClose={onClose} active={open} width="100%" />
      </div>
    </aside>
  );
}
