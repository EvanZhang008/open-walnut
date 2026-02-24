import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  fetchTimeline,
  fetchTimelineDates,
  toggleTracking,
  type TimelineResponse,
  type TimelineEntry,
} from '@/api/timeline';

// ── Category colors ──

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

// ── Time helpers ──

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

// ── Components ──

function CategoryBar({ entries }: { entries: TimelineEntry[] }) {
  const totalMinutes = entries.reduce(
    (sum, e) => sum + Math.max(1, timeToMinutes(e.endTime) - timeToMinutes(e.startTime)),
    0,
  );
  if (totalMinutes === 0) return null;

  // Group by category
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
    <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', height: 28 }}>
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

function ActivityBlock({ entry }: { entry: TimelineEntry }) {
  const duration = Math.max(1, timeToMinutes(entry.endTime) - timeToMinutes(entry.startTime));
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        padding: '10px 14px',
        borderLeft: `3px solid ${getCategoryColor(entry.category)}`,
        backgroundColor: 'var(--bg-secondary)',
        borderRadius: '0 8px 8px 0',
        marginBottom: 6,
        alignItems: 'center',
      }}
    >
      <div style={{ minWidth: 90, fontSize: 13, color: 'var(--fg-muted)', fontVariantNumeric: 'tabular-nums' }}>
        {entry.startTime} - {entry.endTime}
      </div>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          textTransform: 'uppercase',
          color: getCategoryColor(entry.category),
          minWidth: 80,
        }}
      >
        {entry.category}
      </div>
      <div style={{ flex: 1, fontSize: 13, color: 'var(--fg)' }}>
        <strong>{entry.application}</strong> &mdash; {entry.description}
      </div>
      <div style={{ fontSize: 12, color: 'var(--fg-muted)', minWidth: 40, textAlign: 'right' }}>
        {formatDuration(duration)}
      </div>
    </div>
  );
}

function SummaryCards({ summary }: { summary: Record<string, string> }) {
  const items = Object.entries(summary);
  if (items.length === 0) return null;

  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      {items.map(([cat, dur]) => (
        <div
          key={cat}
          style={{
            padding: '10px 16px',
            backgroundColor: 'var(--bg-secondary)',
            borderRadius: 10,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            minWidth: 120,
          }}
        >
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              backgroundColor: getCategoryColor(cat),
            }}
          />
          <div>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)', textTransform: 'capitalize' }}>
              {cat}
            </div>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--fg)' }}>{dur}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function DatePicker({
  value,
  availableDates,
  onChange,
}: {
  value: string;
  availableDates: string[];
  onChange: (date: string) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <button
        onClick={() => {
          const d = new Date(value);
          d.setDate(d.getDate() - 1);
          onChange(d.toISOString().slice(0, 10));
        }}
        style={{
          background: 'var(--bg-secondary)',
          border: 'none',
          borderRadius: 6,
          padding: '6px 10px',
          cursor: 'pointer',
          color: 'var(--fg)',
          fontSize: 14,
        }}
      >
        &larr;
      </button>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: '6px 12px',
          color: 'var(--fg)',
          fontSize: 14,
        }}
      />
      <button
        onClick={() => {
          const d = new Date(value);
          d.setDate(d.getDate() + 1);
          onChange(d.toISOString().slice(0, 10));
        }}
        style={{
          background: 'var(--bg-secondary)',
          border: 'none',
          borderRadius: 6,
          padding: '6px 10px',
          cursor: 'pointer',
          color: 'var(--fg)',
          fontSize: 14,
        }}
      >
        &rarr;
      </button>
      {availableDates.length > 0 && (
        <span style={{ fontSize: 12, color: 'var(--fg-muted)', marginLeft: 8 }}>
          {availableDates.length} day{availableDates.length !== 1 ? 's' : ''} recorded
        </span>
      )}
    </div>
  );
}

// ── Main Page ──

export function TimelinePage() {
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

  const handleToggle = useCallback(async () => {
    setToggling(true);
    try {
      const result = await toggleTracking();
      setData((prev) => (prev ? { ...prev, tracking: result.enabled } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setToggling(false);
    }
  }, []);

  const totalMinutes = useMemo(() => {
    if (!data?.entries.length) return 0;
    return data.entries.reduce(
      (sum, e) => sum + Math.max(1, timeToMinutes(e.endTime) - timeToMinutes(e.startTime)),
      0,
    );
  }, [data]);

  return (
    <div style={{ padding: '24px 32px', maxWidth: 960, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 className="page-title">Timeline</h1>
          <p className="page-subtitle">Activity tracker powered by screenshots + AI analysis</p>
        </div>
        <button
          onClick={handleToggle}
          disabled={toggling}
          style={{
            padding: '8px 20px',
            borderRadius: 8,
            border: 'none',
            cursor: toggling ? 'wait' : 'pointer',
            fontWeight: 600,
            fontSize: 13,
            backgroundColor: data?.tracking ? '#FF3B30' : '#34C759',
            color: '#fff',
          }}
        >
          {toggling ? '...' : data?.tracking ? 'Stop Tracking' : 'Start Tracking'}
        </button>
      </div>

      {/* Date picker */}
      <div style={{ marginBottom: 20 }}>
        <DatePicker value={date} availableDates={dates} onChange={setDate} />
      </div>

      {error && (
        <div style={{ padding: 12, background: '#FF3B3020', borderRadius: 8, color: '#FF3B30', marginBottom: 16 }}>
          {error}
        </div>
      )}

      {loading ? (
        <div className="empty-state"><p>Loading...</p></div>
      ) : !data?.entries.length ? (
        <div className="empty-state">
          <p style={{ fontSize: 32, marginBottom: 8 }}>&#128247;</p>
          <p>No activity recorded for {date}</p>
          <p style={{ fontSize: 13, marginTop: 8 }}>
            {data?.tracking
              ? 'Tracking is active — activity will appear here as screenshots are analyzed.'
              : 'Enable tracking to start recording your daily activity.'}
          </p>
        </div>
      ) : (
        <>
          {/* Category bar */}
          <div style={{ marginBottom: 20 }}>
            <CategoryBar entries={data.entries} />
          </div>

          {/* Summary cards */}
          <div style={{ marginBottom: 24 }}>
            <SummaryCards summary={data.summary} />
          </div>

          {/* Stats line */}
          <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: 16 }}>
            {data.entries.length} activities &middot; {formatDuration(totalMinutes)} tracked
          </div>

          {/* Activity timeline */}
          <div>
            {data.entries.map((entry, i) => (
              <ActivityBlock key={`${entry.startTime}-${i}`} entry={entry} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
