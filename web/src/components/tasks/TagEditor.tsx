import React, { useState, useRef, useEffect, useCallback, useId } from 'react';
import { createPortal } from 'react-dom';
import { TagChip } from './TagChip';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { fetchTags } from '../../api/tasks';
import { useTagDisplay } from '@/stores/tag-display-store';
import { isDerivedTag, normalizeTag, tagInputProblem } from '../../../../src/core/tag-model';

interface TagEditorProps {
  tags: string[];
  onAdd: (tag: string) => void;
  onRemove: (tag: string) => void;
  /** The task's own date tags (`created:…`, `updated:…`, see src/core/tag-model.ts): listed
   *  with the hidden tags, read-only (Walnut works them out; nobody stores them). */
  derived?: readonly string[];
  /** Placeholder of the input when the task shows no tag. */
  placeholder?: string;
}

/**
 * Inline tag editor with autocomplete from existing tags. Enter or comma confirms.
 *
 * Every tag is key:value (`team:marina`, `sev:2`): text without a key is not added, and the
 * input says why. Tags read as the display rules say (a ticket as its id, a label as its word);
 * the ones the rules keep off task pills, and the task's own dates, fold behind "N hidden", so
 * a hidden tag can still be seen and removed.
 */
export function TagEditor({ tags, onAdd, onRemove, derived = [], placeholder = 'Add tags...' }: TagEditorProps) {
  const { compiled } = useTagDisplay();
  const [input, setInput] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [suggestions, setSuggestions] = useState<{ tag: string; count: number }[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const allTagsRef = useRef<{ tag: string; count: number }[]>([]);
  const problemId = useId();
  // Portalled and placed like every dropdown (web/src/AGENTS.md, menus): the detail pane
  // scrolls, and an inline list would be cut at its edge.
  const placement = useMenuPlacement(showDropdown, inputRef, dropdownRef, {
    align: 'start', minHeight: 60, onAnchorLost: () => setShowDropdown(false),
  });

  const visible = tags.filter((tag) => compiled.shown(tag));
  const hidden = [...tags.filter((tag) => !compiled.shown(tag)), ...derived.filter((tag) => !compiled.shown(tag))];
  const shownDerived = derived.filter((tag) => compiled.shown(tag));

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
      .filter(t => t.tag.toLowerCase().includes(lower) && !tagSet.has(t.tag) && !isDerivedTag(t.tag))
      .slice(0, 6);
    setSuggestions(filtered);
    setShowDropdown(filtered.length > 0);
    setSelectedIdx(-1);
  }, [tags]);

  /** Add the text as a tag; false (and the reason shown) when it is not one. */
  const confirm = useCallback((value: string): boolean => {
    const trimmed = value.trim();
    if (!trimmed) return true;
    const why = tagInputProblem(trimmed);
    if (why) {
      setProblem(why);
      return false;
    }
    const tag = normalizeTag(trimmed);
    if (tag && !tags.includes(tag)) onAdd(tag);
    setProblem(null);
    setInput('');
    setShowDropdown(false);
    setSelectedIdx(-1);
    return true;
  }, [tags, onAdd]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
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
      // Escape closes what the input opened (suggestions, a hint, typed text) before it
      // reaches the detail modal, which closes on it. preventDefault first, then stop: the
      // order useModalOverlay documents (the Escape beep guard reads it).
      if (showDropdown || problem || input) {
        e.preventDefault();
        e.stopPropagation();
        if (!showDropdown && !problem) setInput('');
      }
      setShowDropdown(false);
      setSelectedIdx(-1);
      setProblem(null);
    } else if (e.key === 'Backspace' && !input && visible.length > 0) {
      // Remove the last tag the user can SEE: a hidden one is never removed unseen.
      onRemove(visible[visible.length - 1]);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setProblem(null);
    // If user types comma, confirm immediately
    if (val.includes(',')) {
      const parts = val.split(',');
      const rejected = parts.slice(0, -1).filter((part) => !confirm(part));
      const rest = [...rejected, parts[parts.length - 1]].join(',');
      setInput(rest);
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
    <div className="tag-editor" data-testid="tag-editor">
      <div className="tag-editor-chips">
        {visible.map(tag => (
          <TagChip key={tag} tag={tag} valueOnly={compiled.valueOnly(tag)} href={compiled.linkFor(tag)} onRemove={() => onRemove(tag)} />
        ))}
        {shownDerived.map(tag => (
          <TagChip key={tag} tag={tag} valueOnly={compiled.valueOnly(tag)} href={compiled.linkFor(tag)} />
        ))}
        {showHidden && hidden.map(tag => (
          <TagChip
            key={tag}
            tag={tag}
            hiddenOnTasks
            href={compiled.linkFor(tag)}
            onRemove={derived.includes(tag) ? undefined : () => onRemove(tag)}
          />
        ))}
        {hidden.length > 0 && (
          <button
            type="button"
            className="tag-editor-hidden-toggle"
            data-testid="tag-editor-hidden-toggle"
            aria-expanded={showHidden}
            title={showHidden ? 'Fold the hidden tags' : hidden.join(', ')}
            onClick={() => setShowHidden((open) => !open)}
          >
            {showHidden ? 'Fewer' : `${hidden.length} hidden`}
          </button>
        )}
        <div className="tag-editor-input-wrapper">
          <input
            ref={inputRef}
            className={`tag-editor-input${problem ? ' tag-editor-input-invalid' : ''}`}
            type="text"
            value={input}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onFocus={() => { if (input.trim()) updateSuggestions(input); }}
            onBlur={() => { if (!input.trim()) setProblem(null); }}
            placeholder={visible.length === 0 ? placeholder : '+'}
            aria-label="Add a tag (key:value)"
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? problemId : undefined}
            size={Math.max(input.length + 1, visible.length === 0 ? Math.max(placeholder.length, 8) : 2)}
          />
          {showDropdown && createPortal(
            <div
              className="tag-autocomplete tag-autocomplete-portal"
              ref={dropdownRef}
              style={menuPlacementStyle(placement)}
              onPointerDown={(e) => e.stopPropagation()}
            >
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
            </div>,
            document.body,
          )}
        </div>
      </div>
      {problem && (
        <div className="tag-editor-problem" id={problemId} role="alert" data-testid="tag-editor-problem">{problem}</div>
      )}
    </div>
  );
}
