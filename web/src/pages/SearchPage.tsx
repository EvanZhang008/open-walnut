import { useState, useCallback } from 'react';
import { searchAll, type SearchResult } from '@/api/search';
import { SearchBar } from '@/components/search/SearchBar';
import { SearchResults } from '@/components/search/SearchResults';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';

export function SearchPage() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSearch = useCallback(async (q: string) => {
    setQuery(q);
    if (!q) {
      setResults(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await searchAll(q);
      setResults(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Search</h1>
        <p className="page-subtitle">Search across tasks and memory</p>
      </div>

      <SearchBar onSearch={handleSearch} />

      {loading && <LoadingSpinner />}
      {error && <div className="empty-state"><p>Error: {error}</p></div>}
      {results && !loading && (
        <SearchResults
          tasks={results.tasks}
          memories={results.memories}
          query={query}
        />
      )}
    </div>
  );
}
