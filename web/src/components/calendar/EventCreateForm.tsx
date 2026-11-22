/**
 * EventCreateForm — the Event side of the new-item popover, laid out the way a
 * desktop calendar's new-event popover is: grouped cards, a big title field,
 * the target calendar as a colour-dot row, and the date and times on ONE
 * readable line whose parts are edited in place (the date opens a month
 * flyout, the times are typed straight into the line).
 *
 * It reports what it would create (`onPreview`) so the popover can draw the
 * placeholder block in the grid as the user edits.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { listCalendarSources, type CalendarInfo } from '@/api/calendar';
import { useDraft } from '@/hooks/useDraft';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { draftKey } from '@/utils/drafts';
import { MicField, type BoxMicHandle } from '@/components/common/BoxMic';
import { useSendAfterDictation, dictationWaitProps } from '@/hooks/useSendAfterDictation';
import { Checkbox } from '@/components/controls';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { DatePicker } from '@/components/common/DatePicker';
import { clockLabel, longDayLabel } from '@/utils/calendar-date';
import type { CreateSeed } from './QuickCreatePopover';
import { getCalendarSourcesEntry } from '@/stores/calendar-events-store';
import { newEventCalendars } from './item-tint';

export interface EventPreview {
  title: string;
  day: string;
  allDay: boolean;
  /** Minutes of the day; null for an all-day event. */
  startMin: number | null;
  endMin: number | null;
  color?: string;
}

export type CreateEventInput = { calendarId: string; title: string; start: string; end: string; allDay?: boolean };

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (mins: number) => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
const DAY_MIN = 24 * 60;
/** Whole days from `a` to `b` (both "YYYY-MM-DD"); noon keeps a DST day whole. */
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00`) - Date.parse(`${a}T12:00:00`)) / 86_400_000);
function dayAfter(d: string, n: number): string {
  const [y, m, dd] = d.split('-').map(Number);
  const e = new Date(y, m - 1, dd + n);
  return `${e.getFullYear()}-${pad(e.getMonth() + 1)}-${pad(e.getDate())}`;
}

export function EventCreateForm({
  seed,
  onClose,
  onCreateEvent,
  onPreview,
  onNoCalendar,
  active = true,
}: {
  seed: CreateSeed;
  onClose: () => void;
  onCreateEvent: (input: CreateEventInput) => Promise<unknown>;
  onPreview?: (p: EventPreview) => void;
  /** Called once the calendars are read and none can take a new event. */
  onNoCalendar?: () => void;
  /** The side on show: its title takes the focus each time it comes back. */
  active?: boolean;
}) {
  // The new event's title is a draft until it is created or Cancel is pressed;
  // Esc or a click outside keeps it for the next slot the popover opens on.
  const titleDraft = useDraft(draftKey('calendar-event', 'new'));
  const { text: title, setText: setTitle } = titleDraft;
  // The calendars Walnut already read start the form, so its block shows in the new event's
  // own colour from the first frame (item-tint.ts); a fresh read then follows.
  const [initial] = useState(() => {
    const cached = getCalendarSourcesEntry();
    return cached.calendarsLoaded && cached.calendars.length ? newEventCalendars(cached.calendars, cached.defaultCalendar) : null;
  });
  const [calendars, setCalendars] = useState<CalendarInfo[] | null>(initial?.writable ?? null);
  const [calendarId, setCalendarId] = useState(initial?.preselect?.id ?? '');
  const [defaultWarning, setDefaultWarning] = useState<string | null>(initial?.warning ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listCalendarSources()
      .then((res) => {
        if (!alive) return;
        const picked = newEventCalendars(res.calendars, res.defaultCalendar);
        setCalendars(picked.writable);
        setDefaultWarning(picked.warning);
        // A calendar the person already picked in this form stays theirs.
        setCalendarId((cur) => (cur && picked.writable.some((c) => c.id === cur) && cur !== initial?.preselect?.id ? cur : picked.preselect?.id ?? ''));
      })
      .catch(() => alive && setCalendars((cur) => cur ?? []));
    return () => {
      alive = false;
    };
  }, [initial]);

  const seedAllDay = !seed.start.includes('T');
  const [allDay, setAllDay] = useState(seedAllDay);
  const [day, setDay] = useState(seed.start.slice(0, 10));
  // A timed seed's end: the drag's end (it can be past midnight, the grid runs on
  // into the next morning), else an hour on. An all-day seed's end is its last day.
  const seedEnd = seedAllDay ? null : (seed.end ?? addHourLocal(seed.start));
  const [endDay, setEndDay] = useState(seedEnd ? seedEnd.slice(0, 10) : (seed.end ?? seed.start).slice(0, 10));
  // Editable times: a meeting is rarely exactly the clicked slot + 1h. An all-day
  // seed still gets a working hour, for when the user turns all-day off.
  const [startTime, setStartTime] = useState(() => (seedEnd ? seed.start.slice(11, 16) : '09:00'));
  const [endTime, setEndTime] = useState(() => (seedEnd ? seedEnd.slice(11, 16) : '10:00'));
  /** A timed end in minutes from the start day's midnight (past 24 h when it ends the next day). */
  const endAbs = (eDay: string, eTime: string) => daysBetween(day, eDay) * DAY_MIN + toMin(eTime);
  // Editing Start keeps the duration (macOS Calendar behaviour, same as the item
  // popover): holding End fixed dead-ended "the meeting is 3h later" edits in
  // "End must be after start." Duration = intent: only explicit End edits set it,
  // and Start edits don't shift a misordered End (the user is mid-correction).
  const [durMin, setDurMin] = useState(() => (seedEnd ? Math.max(0, endAbs(endDay, endTime) - toMin(startTime)) : 60));
  const changeStart = (newStart: string) => {
    // Skip the shift only on a REAL misorder (both fields filled, end<=start).
    // A transiently blank field (Chromium emits '' between keystrokes;
    // Backspace-retype) must NOT disarm the shift.
    const misorderedNow = !!startTime && !!endTime && endAbs(endDay, endTime) <= toMin(startTime);
    if (newStart && durMin > 0 && !misorderedNow) {
      const e = Math.min(toMin(newStart) + durMin, 2 * DAY_MIN - 1);
      setEndDay(dayAfter(day, Math.floor(e / DAY_MIN)));
      setEndTime(hhmm(e % DAY_MIN));
    }
    setStartTime(newStart);
  };
  const changeEnd = (newEnd: string) => {
    if (newEnd && startTime) {
      const d = endAbs(endDay, newEnd) - toMin(startTime);
      if (d > 0) setDurMin(d);
    }
    setEndTime(newEnd);
  };
  // An explicit end-date edit is an end edit too (typing End 01:00 on a 23:00
  // event means tomorrow: without this row there was no way to say so).
  const changeEndDay = (next: string) => {
    if (!allDay && startTime && endTime) {
      const d = endAbs(next, endTime) - toMin(startTime);
      if (d > 0) setDurMin(d);
    }
    setEndDay(next);
  };
  // Moving the day moves the end with it, keeping a range's span.
  const changeDay = (next: string) => {
    setEndDay(dayAfter(next, Math.max(0, daysBetween(day, endDay))));
    setDay(next);
  };
  // A cleared time input (Backspace mid-retype) must gate Create too:
  // submitting a blank composes '<day>T:00' and surfaces a raw server 400.
  const incomplete = !allDay && (!startTime || !endTime);
  const misordered = allDay ? endDay < day : !!startTime && !!endTime && endAbs(endDay, endTime) <= toMin(startTime);
  const invalid = incomplete || misordered;

  const calendar = calendars?.find((c) => c.id === calendarId);
  // The block follows the form; a time field cleared mid-retype keeps it where
  // it was instead of dropping it (and the popover with it) to the column top.
  const lastTimes = useRef<{ start: number; end: number } | null>(null);
  useEffect(() => {
    let startMin: number | null = null;
    let endMin: number | null = null;
    if (!allDay) {
      startMin = startTime ? toMin(startTime) : (lastTimes.current?.start ?? null);
      endMin = endTime ? endAbs(endDay, endTime) : (lastTimes.current?.end ?? null);
      if (startMin !== null && endMin !== null) lastTimes.current = { start: startMin, end: endMin };
    }
    onPreview?.({ title: title.trim(), day, allDay, startMin, endMin, color: calendar?.color });
    // endAbs reads only `day`, which is a dependency.
  }, [onPreview, title, day, endDay, allDay, startTime, endTime, calendar?.color]);

  // No writable calendar at all: say so to the popover, which then opens on Task.
  useEffect(() => {
    if (calendars && calendars.length === 0) onNoCalendar?.();
  }, [calendars, onNoCalendar]);

  const titleBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (active) titleBox.current?.focus();
  }, [active]);
  const titleMic = useRef<BoxMicHandle | null>(null);
  // Enter pressed while the calendars are still being read: create once they are.
  const submitWhenReady = useRef(false);
  const submitNow = async () => {
    if (!calendarId && calendars === null && title.trim()) {
      submitWhenReady.current = true;
      return;
    }
    if (!title.trim() || !calendarId || submitting || invalid) return;
    titleMic.current?.clear();
    setSubmitting(true);
    setError(null);
    try {
      const start = allDay ? day : `${day}T${startTime}:00`;
      const end = allDay ? endDay : `${endDay}T${endTime}:00`;
      const sentKey = titleDraft.key;
      await onCreateEvent({ calendarId, title: title.trim(), start, end, allDay });
      titleDraft.clear(sentKey);
      onClose();
    } catch (err) {
      // 400, not 200: a refused write names its fix at the end of a ~170-character message.
      setError(String((err as Error).message ?? err).slice(0, 400));
      setSubmitting(false);
    }
  };
  // Enter and Create wait for a title still being dictated, then create the event.
  const gate = useSendAfterDictation([titleMic], () => void submitNow());
  useEffect(() => {
    if (calendars === null || !submitWhenReady.current) return;
    submitWhenReady.current = false;
    // Through the gate like every press: it runs once, when the calendars arrive,
    // and still waits for a title being dictated.
    if (calendarId) gate.send();
  }, [calendars, calendarId]);
  const onFieldKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); gate.send(); }
  };

  return (
    <div className="cal-event-form" role="dialog" aria-label="New event">
      <div className="cal-form-card">
        <MicField inline boxRef={titleBox} text={title} setText={setTitle} handleRef={titleMic} disabled={submitting}>
          <input
            ref={titleBox}
            data-draft-key={titleDraft.key ?? undefined}
            className="cal-event-form-title"
            placeholder="New Event"
            aria-label="Event title"
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              onFieldKey(e);
              if (e.key === 'Escape' && !e.nativeEvent.isComposing) onClose();
            }}
          />
        </MicField>
        <CalendarPicker calendars={calendars} value={calendarId} onChange={setCalendarId} />
        {defaultWarning && !calendarId && (
          <div className="cal-event-form-error" data-testid="cal-event-form-default-warning">{defaultWarning}</div>
        )}
      </div>

      <div className="cal-form-card">
        <div className="cal-event-form-when" data-testid="cal-event-form-when">
          <DayButton day={day} onChange={changeDay} label="Date" />
          {allDay ? (
            endDay !== day && (
              <>
                <span className="cal-when-dash">–</span>
                <DayButton day={endDay} onChange={changeEndDay} label="End date" />
              </>
            )
          ) : (
            <span className="cal-when-times">
              <TimeField value={startTime} onChange={changeStart} onKeyDown={onFieldKey} label="Start time" />
              <span className="cal-when-dash">–</span>
              {(endDay !== day || misordered) && <DayButton day={endDay} onChange={changeEndDay} label="End date" />}
              <TimeField value={endTime} onChange={changeEnd} onKeyDown={onFieldKey} label="End time" />
            </span>
          )}
        </div>
        <Checkbox rowClassName="cal-when-allday" label="All-day" checked={allDay} onChange={setAllDay} />
        {misordered && <div className="cal-event-form-error">End must be after start.</div>}
      </div>

      {error && <div className="cal-event-form-error cal-event-form-error-box">{error}</div>}
      <div className="cal-event-form-footer">
        <button className="cal-form-btn" onClick={() => { titleDraft.clear(); onClose(); }}>Cancel</button>
        <button
          className="cal-form-btn cal-event-form-create"
          disabled={(!title.trim() && !gate.micBusy && !gate.waiting) || !calendarId || submitting || invalid}
          onClick={gate.send}
          {...dictationWaitProps(gate)}
        >
          {submitting ? 'Adding…' : 'Add Event'}
        </button>
      </div>
    </div>
  );
}

/**
 * Under a flyout: a click outside closes the flyout alone. It closes on the CLICK,
 * which it swallows: closing on mousedown removed it before the mouseup, and the
 * click then fell through to the popover's backdrop and closed the popover too.
 */
function FlyoutBackdrop({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="cal-flyout-backdrop"
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onClose(); }}
    />
  );
}

/** Escape closes an open flyout alone: stopped in the capture phase, the popover's window listener never sees it. */
function useFlyoutEscape(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, close]);
}

/** Target calendar: a colour dot and its name; the list is its own flyout (no native select in a popover). */
function CalendarPicker({ calendars, value, onChange }: { calendars: CalendarInfo[] | null; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const placement = useMenuPlacement(open, btnRef, listRef, { align: 'start', minHeight: 120 });
  useFlyoutEscape(open, useLeanCallback(() => setOpen(false), []));
  const current = calendars?.find((c) => c.id === value);
  const label = calendars === null
    ? 'Loading calendars…'
    : calendars.length === 0
      ? 'No writable calendar'
      : current
        ? `${current.title} (${current.account})${current.default ? ' · default' : ''}`
        : 'Pick a calendar';
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="cal-form-row cal-cal-picker"
        data-testid="cal-event-form-calendar"
        data-value={value}
        aria-label="Calendar"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={!calendars?.length}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="cal-cal-dot" style={{ background: current?.color ?? 'var(--fg-muted)' }} />
        <span className="cal-cal-name">{label}</span>
        <svg className="cal-cal-chevrons" viewBox="0 0 10 14" aria-hidden="true">
          <path d="M2 5l3-3 3 3M2 9l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && createPortal(
        <>
          <FlyoutBackdrop onClose={() => setOpen(false)} />
          <div
            ref={listRef}
            className="cal-cal-list wn-glass"
            role="listbox"
            aria-label="Calendars"
            style={menuPlacementStyle(placement)}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {calendars?.map((c) => (
              <button
                key={c.id}
                type="button"
                role="option"
                aria-selected={c.id === value}
                className="cal-cal-option"
                data-calendar-id={c.id}
                onClick={() => { onChange(c.id); setOpen(false); }}
              >
                <span className="cal-cal-dot" style={{ background: c.color }} />
                <span className="cal-cal-name">{c.title}</span>
                <span className="cal-cal-account">{c.account}{c.default ? ' · default' : ''}</span>
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}

/**
 * One time of the when-line: reads as text ("5:00 PM") and is typed straight
 * into. The time field lies under the text and takes over while focused, so a
 * click lands in the field the browser already knows how to edit.
 */
function TimeField({ value, onChange, onKeyDown, label }: {
  value: string;
  onChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  label: string;
}) {
  return (
    <span className="cal-when-time-wrap">
      <input type="time" className="cal-when-time" value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} aria-label={label} />
      <span className="cal-when-time-text" aria-hidden="true">{value ? clockLabel(toMin(value), true) : '--:--'}</span>
    </span>
  );
}

/** One day of the when-line: reads as text ("Mon, Nov 16, 2026"), opens a month flyout. */
function DayButton({ day, onChange, label }: { day: string; onChange: (day: string) => void; label: string }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const flyRef = useRef<HTMLDivElement>(null);
  const placement = useMenuPlacement(open, btnRef, flyRef, { align: 'start' });
  useFlyoutEscape(open, useLeanCallback(() => setOpen(false), []));
  return (
    <>
      <button ref={btnRef} type="button" className="cal-when-part cal-when-day" aria-label={label} data-day={day} onClick={() => setOpen((v) => !v)}>
        {longDayLabel(day)}
      </button>
      {open && createPortal(
        <>
          <FlyoutBackdrop onClose={() => setOpen(false)} />
          <div
            ref={flyRef}
            className="dp-popover cal-day-flyout wn-glass"
            style={menuPlacementStyle(placement)}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <DatePicker
              inline
              date={day}
              onChange={(v) => {
                if (v) onChange(v.slice(0, 10));
                setOpen(false);
              }}
            />
          </div>
        </>,
        document.body,
      )}
    </>
  );
}

function addHourLocal(iso: string): string {
  const [d, time] = iso.split('T');
  const [h, m] = time.split(':').map(Number);
  // Clamp to 23:59, not "hour 23 same minute": the latter seeded a ZERO-length
  // 23:00–23:00 range for 22:30+ slots, so the form opened pre-broken with
  // 'End must be after start.' before the user touched anything.
  const mins = Math.min(h * 60 + m + 60, 23 * 60 + 59);
  return `${d}T${hhmm(mins)}:00`;
}
