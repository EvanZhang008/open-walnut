import { GRID_ZOOM_LEVELS, setCalendarGridSettings, useCalendarGridSettings } from './calendar-grid-settings';
import { usePhoneLayout } from '@/hooks/usePhoneLayout';
import './grid-controls.css';

export function CalendarGridControls() {
  const { zoom, fullDay } = useCalendarGridSettings();
  // A phone names the toggle, not the hour range it shows today (N2-18: "7-1"
  // read as a cryptic number); its pressed state says when all 24 hours show.
  const phone = usePhoneLayout();
  const hoursLabel = phone ? '24h' : fullDay ? '24h' : '7\u20131';
  const index = GRID_ZOOM_LEVELS.indexOf(zoom as typeof GRID_ZOOM_LEVELS[number]);
  return (
    <div className="cal-grid-controls" aria-label="Calendar time scale">
      <button type="button" aria-label="Zoom out calendar" title="Zoom out" disabled={index === 0}
        onClick={() => setCalendarGridSettings({ zoom: GRID_ZOOM_LEVELS[index - 1] })}>−</button>
      <button type="button" className="cal-zoom-value" aria-label="Reset calendar zoom" title="Reset zoom to 100%"
        onClick={() => setCalendarGridSettings({ zoom: 1 })}>{Math.round(zoom * 100)}%</button>
      <button type="button" aria-label="Zoom in calendar" title="Zoom in" disabled={index === GRID_ZOOM_LEVELS.length - 1}
        onClick={() => setCalendarGridSettings({ zoom: GRID_ZOOM_LEVELS[index + 1] })}>+</button>
      <button type="button" className="cal-hours-toggle" aria-label={fullDay ? 'Show 7 AM to 1 AM' : 'Show full day'}
        title={fullDay ? 'Show 7 AM to 1 AM' : 'Show all 24 hours'} aria-pressed={fullDay}
        onClick={() => setCalendarGridSettings({ fullDay: !fullDay })}>{hoursLabel}</button>
    </div>
  );
}
