import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { CalendarSidePanel } from '@/components/calendar/CalendarSidePanel';
import { NotesPage } from '@/pages/NotesPage';

export type CompanionKind = 'notes' | 'calendar';

interface Props {
  active: CompanionKind | null;
  onClose: () => void;
}

export function HomeCompanionPanel({ active: selected, onClose }: Props) {
  const active = useLocation().pathname === '/' ? selected : null;
  const shellRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const selector = active === 'notes' ? '.home-companion-close' : '.cal-side-header [title="Close calendar panel"]';
    if (active) shellRef.current?.querySelector<HTMLButtonElement>(selector)?.focus({ preventScroll: true });
  }, [active]);
  // Keep visited editors mounted so pending saves and failed-save buffers survive switching.
  const visited = useRef({ notes: false, calendar: false });
  if (active) visited.current[active] = true;
  if (!active && !visited.current.notes && !visited.current.calendar) return null;

  return (
    <aside
      ref={shellRef}
      aria-label={active === 'calendar' ? 'Calendar side panel' : 'Notes side panel'}
      onKeyDown={event => {
        if (event.key !== 'Escape' || event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return;
        if (document.querySelector('.cal-popover-backdrop')) return;
        event.stopPropagation();
        onClose();
      }}
      className={`home-companion${active ? ` home-companion-${active}` : ''}`}
      data-testid="home-companion"
      data-active={active ?? 'none'}
      style={active ? undefined : { display: 'none' }}
      inert={!active}
    >
      {active === 'notes' && (
        <div className="home-companion-header">
          <span className="home-companion-title">Notes</span>
          <button type="button" className="btn btn-sm home-companion-close"
            onClick={onClose} aria-label="Close side panel" title="Close side panel" data-testid="home-companion-close">
            ✕
          </button>
        </div>
      )}
      {visited.current.notes && (
        <div className="home-companion-body home-companion-body-notes"
          data-testid="home-companion-notes"
          style={active === 'notes' ? undefined : { display: 'none' }} inert={active !== 'notes'}>
          <NotesPage embedded />
        </div>
      )}
      {visited.current.calendar && (
        <div className="home-companion-body home-companion-body-calendar"
          data-testid="home-companion-calendar"
          style={active === 'calendar' ? undefined : { display: 'none' }} inert={active !== 'calendar'}>
          <CalendarSidePanel onClose={onClose} active={active === 'calendar'} width="100%" />
        </div>
      )}
    </aside>
  );
}
