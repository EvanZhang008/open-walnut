import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchSlashCommands, type SlashCommandItem } from '@/api/slash-commands';

/**
 * Fetches all available slash commands for a session (skills + commands + Claude commands).
 * Caches by cwd to avoid redundant fetches.
 */
export function useSlashCommands(cwd?: string) {
  const [items, setItems] = useState<SlashCommandItem[]>([]);
  const [loading, setLoading] = useState(false);
  const cacheRef = useRef<Map<string, SlashCommandItem[]>>(new Map());

  useEffect(() => {
    const key = cwd ?? '__no_cwd__';
    const cached = cacheRef.current.get(key);
    if (cached) {
      setItems(cached);
      return;
    }

    let cancelled = false;
    setLoading(true);
    fetchSlashCommands(cwd).then((result) => {
      if (cancelled) return;
      cacheRef.current.set(key, result);
      setItems(result);
      setLoading(false);
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
