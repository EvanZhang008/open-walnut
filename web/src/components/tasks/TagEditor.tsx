import React, { useState, useRef, useEffect, useCallback } from 'react';
import { TagChip } from './TagChip';
import { fetchTags } from '../../api/tasks';

interface TagEditorProps {
  tags: string[];
  onAdd: (tag: string) => void;
  onRemove: (tag: string) => void;
}

/**
 * Inline tag editor with autocomplete from existing tags.
 * Enter or comma to confirm, dropdown with suggestions.
 */
export function TagEditor({ tags, onAdd, onRemove }: TagEditorProps) {
  const [input, setInput] = useState('');
  const [suggestions, setSuggestions] = useState<{ tag: string; count: number }[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const allTagsRef = useRef<{ tag: string; count: number }[]>([]);

  // Load all tags on mount
  useEffect(() => {
    fetchTags().then(t => { allTagsRef.current = t; }).catch(() => {});
  }, []);

  const updateSuggestions = useCallback((val: string) => {
    if (!val.trim()) {
      setSuggestions([]);
      setShowDropdown(false);
      return;
    }
    const lower = val.toLowerCase();
    const tagSet = new Set(tags);
    const filtered = allTagsRef.current
      .filter(t => t.tag.toLowerCase().includes(lower) && !tagSet.has(t.tag))
      .slice(0, 6);
    setSuggestions(filtered);
    setShowDropdown(filtered.length > 0);
    setSelectedIdx(-1);
  }, [tags]);

  const confirm = useCallback((value: string) => {
    const trimmed = value.trim();
    if (trimmed && !tags.includes(trimmed)) {
      onAdd(trimmed);
    }
    setInput('');
    setShowDropdown(false);
    setSelectedIdx(-1);
  }, [tags, onAdd]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (selectedIdx >= 0 && selectedIdx < suggestions.length) {
        confirm(suggestions[selectedIdx].tag);
      } else {
        confirm(input);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx(i => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx(i => Math.max(i - 1, -1));
    } else if (e.key === 'Escape') {
      setShowDropdown(false);
      setSelectedIdx(-1);
    } else if (e.key === 'Backspace' && !input && tags.length > 0) {
      // Remove last tag on backspace when input is empty
      onRemove(tags[tags.length - 1]);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    // If user types comma, confirm immediately
    if (val.includes(',')) {
      const parts = val.split(',');
      for (const part of parts.slice(0, -1)) {
        confirm(part);
      }
      setInput(parts[parts.length - 1]);
      updateSuggestions(parts[parts.length - 1]);
    } else {
      setInput(val);
      updateSuggestions(val);
    }
  };

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
          inputRef.current && !inputRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div className="tag-editor">
      <div className="tag-editor-chips">
        {tags.map(tag => (
          <TagChip key={tag} tag={tag} onRemove={() => onRemove(tag)} />
        ))}
        <div className="tag-editor-input-wrapper">
          <input
            ref={inputRef}
            className="tag-editor-input"
            type="text"
            value={input}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onFocus={() => { if (input.trim()) updateSuggestions(input); }}
            placeholder={tags.length === 0 ? 'Add tags...' : '+'}
            size={Math.max(input.length + 1, tags.length === 0 ? 12 : 2)}
          />
          {showDropdown && (
            <div className="tag-autocomplete" ref={dropdownRef}>
              {suggestions.map((s, i) => (
                <button
                  key={s.tag}
                  className={`tag-autocomplete-item${i === selectedIdx ? ' selected' : ''}`}
                  onMouseDown={(e) => { e.preventDefault(); confirm(s.tag); }}
                >
                  <span>{s.tag}</span>
                  <span className="tag-autocomplete-count">{s.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
