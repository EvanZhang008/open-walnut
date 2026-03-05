import { useState, useEffect, useCallback } from 'react';
import { fetchSlashCommands, type SlashCommandItem } from '@/api/slash-commands';
import { perf } from '@/utils/perf-logger';

// Module-level global cache: shared across all hook instances (e.g. multiple DockTaskCards).
// Each cwd key is fetched at most once — avoids 3x duplicate requests (22KB each).
const globalCache = new Map<string, SlashCommandItem[]>();
const inflightRequests = new Map<string, Promise<SlashCommandItem[]>>();

/**
 * Fetches all available slash commands for a session (skills + commands + Claude commands).
 * Uses a module-level global cache with inflight dedup to avoid redundant fetches.
 */
export function useSlashCommands(cwd?: string) {
  const [items, setItems] = useState<SlashCommandItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const key = cwd ?? '__no_cwd__';
    const cached = globalCache.get(key);
    if (cached) {
      setItems(cached);
      return;
    }

    let cancelled = false;
    setLoading(true);

    // Dedup inflight requests: if another instance is already fetching, reuse the promise
    let promise = inflightRequests.get(key);
    if (!promise) {
      const endPerf = perf.start('slash-commands:fetch');
      promise = fetchSlashCommands(cwd);
      inflightRequests.set(key, promise);
      promise.then((r) => endPerf(`${r.length} cmds`)).catch(() => endPerf('error'));
      promise.finally(() => inflightRequests.delete(key));
    }

    promise.then((result) => {
      globalCache.set(key, result);
      if (!cancelled) {
        setItems(result);
        setLoading(false);
      }
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });

    return () => { cancelled = true; };
  }, [cwd]);

  const search = useCallback((query: string): SlashCommandItem[] => {
    if (!query) return items;
    const q = query.toLowerCase();
    // Score: name prefix > name contains > description contains
    const scored: { item: SlashCommandItem; score: number }[] = [];
    for (const item of items) {
      const nameLower = item.name.toLowerCase();
      const descLower = item.description.toLowerCase();
      if (nameLower.startsWith(q)) {
        scored.push({ item, score: 3 });
      } else if (nameLower.includes(q)) {
        scored.push({ item, score: 2 });
      } else if (descLower.includes(q)) {
        scored.push({ item, score: 1 });
      }
    }
    scored.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
    return scored.map((s) => s.item);
  }, [items]);

  return { items, loading, search };
}
