import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchUsageCosts, type CostReport, type CostView } from '@/api/usage';
import type { TimeSelection } from './useUsageOverview';
import { keepLastGood, readLastGood } from '@/utils/last-good';

const isReport = (v: unknown): v is CostReport => !!v && typeof v === 'object'
  && typeof (v as CostReport).view === 'string' && !!(v as CostReport).range && !!(v as CostReport).totals;

/**
 * One slot per view, engine and period kind ('7d', never its dates, and one for every custom
 * range), so the kept reports stay a handful whatever days the pane is opened on; the report's
 * own range is checked on read, so a slot from yesterday's "7 days" is not shown as today's.
 */
export function usageKeepKey(view: CostView, preset: TimeSelection['preset'], engine: string): string {
  return `walnut:last-good:usage-costs:v2:${JSON.stringify([view, preset, engine])}`;
}

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
      // A report still being summed is not kept: the next open would show partial totals as final.
      if (data.ready) keepLastGood(usageKeepKey(view, time.preset, wanted), data);
    } catch (err) {
      if (mine === seq.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [view, range, wanted]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void refresh(); }, [refresh]);

  const busy = !!report && (!report.ready || !!report.collection?.running);
  useEffect(() => {
    if (!busy) return;
    const timer = setTimeout(() => { void refresh(); }, report?.ready ? 5_000 : 3_000);
    return () => clearTimeout(timer);
  }, [busy, report, refresh]);

  // The last report this browser kept for exactly this view, period and engine, until the server's comes
  // (2026-11-04, the user: "cache should cache for long tie until the real data come").
  const kept = useMemo(() => readLastGood(usageKeepKey(view, time.preset, wanted), isReport), [view, time.preset, range, wanted]); // eslint-disable-line react-hooks/exhaustive-deps
  const fits = (r: CostReport | null) => !!r && r.view === view && (r.range.start ?? undefined) === range.start
    && (r.range.end ?? undefined) === range.end && (r.engine ?? 'all') === wanted;
  // A report for another view, period or engine is not this one's: show it only while the new one loads.
  const fromKept = !fits(report) && !!kept && fits(kept.value);
  const current = fits(report) ? report : fromKept ? kept!.value : null;
  // When the report shown is the kept one, when it was read (the pane says so while it reads again).
  return { report: current ?? report, current, keptAt: fromKept ? kept!.at : null, loading, error, refresh, range };
}
