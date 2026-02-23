import { useState, useEffect, useRef } from 'react';

interface SearchBarProps {
  onSearch: (query: string) => void;
  debounceMs?: number;
}

export function SearchBar({ onSearch, debounceMs = 300 }: SearchBarProps) {
  const [value, setValue] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      onSearch(value.trim());
    }, debounceMs);
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [value, debounceMs, onSearch]);

  return (
    <div className="search-bar">
      <span className="search-bar-icon">&#128269;</span>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search tasks and memory..."
        className="search-bar-input"
        autoFocus
      />
      {value && (
        <button className="search-bar-clear" onClick={() => setValue('')} aria-label="Clear search">
          &times;
        </button>
      )}
    </div>
  );
}
