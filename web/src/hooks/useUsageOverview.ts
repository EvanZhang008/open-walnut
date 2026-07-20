import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { UsageOverview, UsageFilter, Period } from '@/api/usage';
import * as usageApi from '@/api/usage';

/**
 * Time selection is either a named preset window OR an explicit custom date
 * range. Drill-in dimensions (source/model/agent) are separate and AND with
 * whatever time range is active.
 */
export interface TimeSelection {
  preset: Period | 'custom';
  start?: string;   // used when preset === 'custom'
  end?: string;
}

export interface DrillFilters {
  source?: string;
  model?: string;
  agentId?: string;
}

interface UseUsageOverviewReturn {
  overview: UsageOverview | null;
  loading: boolean;
  error: string | null;
  time: TimeSelection;
  setTime: (t: TimeSelection) => void;
  drill: DrillFilters;
  setDrill: (d: DrillFilters | ((prev: DrillFilters) => DrillFilters)) => void;
  clearDrill: () => void;
  refresh: () => void;
  /** The effective date range being queried (resolved from preset/custom). */
  effectiveRange: { start?: string; end?: string };
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Resolve a time selection into concrete YYYY-MM-DD bounds (undefined = open). */
function resolveRange(time: TimeSelection): { start?: string; end?: string } {
  switch (time.preset) {
    case 'today': return { start: todayStr(), end: todayStr() };
    case '7d': return { start: daysAgoStr(7) };
    case '30d': return { start: daysAgoStr(30) };
    case 'all': return {};
    case 'custom': return { start: time.start, end: time.end };
  }
}

export function useUsageOverview(): UseUsageOverviewReturn {
  const [overview, setOverview] = useState<UsageOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [time, setTime] = useState<TimeSelection>({ preset: '7d' });
  const [drill, setDrill] = useState<DrillFilters>({});
  const reqSeq = useRef(0);

  const effectiveRange = useMemo(() => resolveRange(time), [time]);

  const filter: UsageFilter = useMemo(() => ({
    startDate: effectiveRange.start,
    endDate: effectiveRange.end,
    source: drill.source,
    model: drill.model,
    agentId: drill.agentId,
  }), [effectiveRange.start, effectiveRange.end, drill.source, drill.model, drill.agentId]);

  const refresh = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    setError(null);
    try {
      const data = await usageApi.fetchUsageOverview(filter);
      if (seq === reqSeq.current) setOverview(data);
    } catch (err) {
      if (seq === reqSeq.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [filter]);

  useEffect(() => { refresh(); }, [refresh]);

  const clearDrill = useCallback(() => setDrill({}), []);

  return { overview, loading, error, time, setTime, drill, setDrill, clearDrill, refresh, effectiveRange };
}
