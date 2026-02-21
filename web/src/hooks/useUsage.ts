import { useState, useEffect, useCallback } from 'react';
import type { UsageSummary, DailyCost, UsageByGroup, UsageRecord, Period } from '@/api/usage';
import * as usageApi from '@/api/usage';

interface UseUsageReturn {
  summary: Record<string, UsageSummary> | null;
  daily: DailyCost[];
  bySource: UsageByGroup[];
  byModel: UsageByGroup[];
  recent: UsageRecord[];
  loading: boolean;
  error: string | null;
  period: Period;
  setPeriod: (p: Period) => void;
  refresh: () => void;
}

export function useUsage(): UseUsageReturn {
  const [summary, setSummary] = useState<Record<string, UsageSummary> | null>(null);
  const [daily, setDaily] = useState<DailyCost[]>([]);
  const [bySource, setBySource] = useState<UsageByGroup[]>([]);
  const [byModel, setByModel] = useState<UsageByGroup[]>([]);
  const [recent, setRecent] = useState<UsageRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>('30d');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [summaryData, dailyData, sourceData, modelData, recentData] = await Promise.all([
        usageApi.fetchUsageSummary(),
        usageApi.fetchDailyCosts(period === 'today' ? 1 : period === '7d' ? 7 : period === 'all' ? 365 : 30),
        usageApi.fetchBySource(period),
        usageApi.fetchByModel(period),
        usageApi.fetchRecentRecords(50),
      ]);
      setSummary(summaryData);
      setDaily(dailyData);
      setBySource(sourceData);
      setByModel(modelData);
      setRecent(recentData);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { refresh(); }, [refresh]);

  return { summary, daily, bySource, byModel, recent, loading, error, period, setPeriod, refresh };
}
