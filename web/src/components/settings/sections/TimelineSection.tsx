import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  fetchTimeline,
  fetchTimelineDates,
  toggleTracking,
  type TimelineResponse,
  type TimelineEntry,
} from '@/api/timeline';
import { SettingsSection, SettingsNotice, SettingsGroup, SettingsRow, SettingsLoadingRow } from '../SettingsSection';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { SettingsButton } from '../inputs/SettingsButton';
import { couldntSave } from '../inputs/useOptimisticSetting';
import { saveErrorMessage } from '../settings-pane-context';
import { ChevronGlyph } from '../settings-glyphs';
import '@/styles/settings-sections-addons.css';
import { usageDay } from './UsageTables';

// Category colors (data colours of the activity chart, not UI chrome).

const CATEGORY_COLORS: Record<string, string> = {
  coding: '#007AFF',
  browsing: '#FF9500',
  communication: '#34C759',
  reading: '#5856D6',
  writing: '#AF52DE',
  meeting: '#FF2D55',
  media: '#FF3B30',
  idle: '#8E8E93',
  other: '#636366',
};

function getCategoryColor(cat: string): string {
  return CATEGORY_COLORS[cat] || CATEGORY_COLORS.other;
}

// Time helpers

function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// Sub-components

function CategoryBar({ entries }: { entries: TimelineEntry[] }) {
  const totalMinutes = entries.reduce(
    (sum, e) => sum + Math.max(1, timeToMinutes(e.endTime) - timeToMinutes(e.startTime)),
    0,
  );
  if (totalMinutes === 0) return null;

  const byCategory: Record<string, number> = {};
  for (const e of entries) {
    const dur = Math.max(1, timeToMinutes(e.endTime) - timeToMinutes(e.startTime));
    byCategory[e.category] = (byCategory[e.category] ?? 0) + dur;
  }

  const segments = Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, mins]) => ({
      category: cat,
      minutes: mins,
      pct: (mins / totalMinutes) * 100,
    }));

  return (
    <div className="settings-addons-catbar">
      {segments.map((seg) => (
        <div
          key={seg.category}
          title={`${seg.category}: ${formatDuration(seg.minutes)} (${seg.pct.toFixed(1)}%)`}
          style={{
            width: `${seg.pct}%`,
            backgroundColor: getCategoryColor(seg.category),
            minWidth: seg.pct > 2 ? undefined : 3,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontSize: 11,
            fontWeight: 600,
            overflow: 'hidden',
            whiteSpace: 'nowrap',
          }}
        >
          {seg.pct > 8 ? seg.category : ''}
        </div>
      ))}
    </div>
  );
}

function ActivityRow({ entry }: { entry: TimelineEntry }) {
  const duration = Math.max(1, timeToMinutes(entry.endTime) - timeToMinutes(entry.startTime));
  return (
    <SettingsRow
      className="timeline-activity-row"
      label={
        <span className="settings-addons-inline">
          <span className="settings-addons-dot" style={{ background: getCategoryColor(entry.category) }} aria-hidden="true" />
          <span className="settings-addons-muted">{`${entry.startTime} to ${entry.endTime}`}</span>
          <span className="settings-addons-ellipsis" title={entry.application}>{entry.application}</span>
        </span>
      }
      help={`${entry.category}: ${entry.description}`}
      control={<span className="settings-addons-muted">{formatDuration(duration)}</span>}
    />
  );
}

function shiftDay(value: string, days: number): string {
  const d = new Date(value);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function DatePicker({ value, onChange }: { value: string; onChange: (date: string) => void }) {
  return (
    <span className="settings-addons-inline">
      <SettingsButton aria-label="Previous day" onClick={() => onChange(shiftDay(value, -1))}>
        <ChevronGlyph size={12} className="settings-addons-flip" />
      </SettingsButton>
      <input
        type="date"
        className="settings-input settings-input--short"
        aria-label="Day"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <SettingsButton aria-label="Next day" onClick={() => onChange(shiftDay(value, 1))}>
        <ChevronGlyph size={12} />
      </SettingsButton>
    </span>
  );
}

// Main section

export function TimelineSection() {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [data, setData] = useState<TimelineResponse | null>(null);
  const [dates, setDates] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);

  const loadTimeline = useCallback(async (d: string) => {
    setLoading(true);
    setError(null);
    try {
      const [timeline, datesRes] = await Promise.all([fetchTimeline(d), fetchTimelineDates()]);
      setData(timeline);
      setDates(datesRes.dates);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTimeline(date);
  }, [date, loadTimeline]);

  // Optimistic switch: the thumb moves at once; a failed write puts it back
  // and leaves a row error until the next flip. A diagnostic pane: no Saved.
  const [pendingTracking, setPendingTracking] = useState<boolean | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const handleToggle = useCallback(async (next: boolean) => {
    setPendingTracking(next);
    setToggleError(null);
    try {
      const result = await toggleTracking();
      setData((prev) => (prev ? { ...prev, tracking: result.enabled } : prev));
    } catch (err) {
      setToggleError(saveErrorMessage(err));
    } finally {
      setPendingTracking(null);
    }
  }, []);
  const tracking = pendingTracking ?? data?.tracking ?? false;

  const totalMinutes = useMemo(() => {
    if (!data?.entries.length) return 0;
    return data.entries.reduce(
      (sum, e) => sum + Math.max(1, timeToMinutes(e.endTime) - timeToMinutes(e.startTime)),
      0,
    );
  }, [data]);

  return (
    <SettingsSection id="timeline" title="Screen Tracking">
      <SettingsGroup>
        <SettingsRow
          label="Screen tracking"
          htmlFor="timeline-tracking"
          help="Takes periodic screenshots and sorts them into what you were doing."
          error={toggleError ? couldntSave(toggleError) : undefined}
          control={
            <ToggleSwitch
              id="timeline-tracking"
              checked={tracking}
              busy={pendingTracking !== null}
              disabled={!data}
              onChange={(v) => void handleToggle(v)}
              data-testid="timeline-tracking-switch"
            />
          }
        />
        <SettingsRow
          label="Day"
          help={dates.length > 0 ? `${dates.length} day${dates.length !== 1 ? 's' : ''} recorded` : undefined}
          control={<DatePicker value={date} onChange={setDate} />}
        />
      </SettingsGroup>

      {error && <SettingsNotice kind="error" role="alert">{`Couldn't load activity: ${error}`}</SettingsNotice>}

      {loading ? (
        <SettingsGroup><SettingsLoadingRow /></SettingsGroup>
      ) : !data?.entries.length ? (
        <SettingsGroup>
          <SettingsRow
            label={`No activity recorded for ${usageDay(date)}.`}
            help={data?.tracking
              ? 'Tracking is on; activity appears here as screenshots are analyzed.'
              : 'Turn on screen tracking to start recording your day.'}
          />
        </SettingsGroup>
      ) : (
        <>
          <SettingsGroup
            heading="Summary"
            footer={`${data.entries.length} activities, ${formatDuration(totalMinutes)} tracked.`}
          >
            <div className="settings-row settings-row-stacked" data-wide="true">
              <CategoryBar entries={data.entries} />
            </div>
            {Object.entries(data.summary).map(([cat, dur]) => (
              <SettingsRow
                key={cat}
                label={
                  <span className="settings-addons-inline">
                    <span className="settings-addons-dot" style={{ background: getCategoryColor(cat) }} aria-hidden="true" />
                    <span>{cat.charAt(0).toUpperCase() + cat.slice(1)}</span>
                  </span>
                }
                control={<span className="settings-addons-muted">{dur}</span>}
              />
            ))}
          </SettingsGroup>

          <SettingsGroup heading="Activity">
            {data.entries.map((entry, i) => (
              <ActivityRow key={`${entry.startTime}-${i}`} entry={entry} />
            ))}
          </SettingsGroup>
        </>
      )}
    </SettingsSection>
  );
}
