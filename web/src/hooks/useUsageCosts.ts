import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchUsageCosts, type CostReport, type CostView } from '@/api/usage';
import type { TimeSelection } from './useUsageOverview';

function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDay(d);
}

/** The period as YYYY-MM-DD bounds; "7 days" is today and the six days before it. */
export function costRange(time: TimeSelection): { start?: string; end?: string } {
  switch (time.preset) {
    case 'today': return { start: localDay(new Date()), end: localDay(new Date()) };
    case '7d': return { start: daysAgo(6), end: localDay(new Date()) };
    case '30d': return { start: daysAgo(29), end: localDay(new Date()) };
    case 'all': return {};
    case 'custom': return { start: time.start, end: time.end };
  }
}

/**
 * One view's cost report for one period (and, in the agents view, one engine or
 * 'all'). A reply that arrives after the view, period or engine changed is
 * dropped. While past usage is still being summed, or a collection is running,
 * it reads again a few seconds later.
 */
export function useUsageCosts(view: CostView, time: TimeSelection, engine = 'all') {
  const [report, setReport] = useState<CostReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  // Today's date is part of the key, so "Today" left open past midnight moves on with the clock.
  const today = localDay(new Date());
  const range = useMemo(() => costRange(time), [time, today]); // eslint-disable-line react-hooks/exhaustive-deps
  // The Walnut view has no engines: its key stays 'all' whatever the agents view picked.
  const wanted = view === 'agents' ? engine : 'all';

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchUsageCosts(view, range, wanted);
      if (mine === seq.current) setReport(data);
    } catch (err) {
      if (mine === seq.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [view, range, wanted]);

  useEffect(() => { void refresh(); }, [refresh]);

  const busy = !!report && (!report.ready || !!report.collection?.running);
  useEffect(() => {
    if (!busy) return;
    const timer = setTimeout(() => { void refresh(); }, report?.ready ? 5_000 : 3_000);
    return () => clearTimeout(timer);
  }, [busy, report, refresh]);

  // A report for another view, period or engine is not this one's: show it only while the new one loads.
  const current = report && report.view === view && (report.range.start ?? undefined) === range.start
    && (report.range.end ?? undefined) === range.end && (report.engine ?? 'all') === wanted ? report : null;
  return { report, current, loading, error, refresh, range };
}
