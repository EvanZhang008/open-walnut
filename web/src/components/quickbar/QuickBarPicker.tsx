/**
 * The quick bar's people list (Tab): CEO, the VPs, the tasks talked to lately, then open tasks.
 * Typing filters it; past two letters the task search adds matches the list did not hold.
 * Up/Down move, Enter picks, Cmd-1..9 picks the numbered row from anywhere in the bar.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { searchQuickTasks } from '@/api/quick';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { filterPeople, personLine, type PeopleSection, type QuickPerson } from './quickbar-people';
import { PersonAvatar } from './PersonAvatar';

/** The rows in the order they are numbered (Cmd-1 is the first). */
export function flatPicks(sections: readonly PeopleSection[]): QuickPerson[] {
  return sections.flatMap((s) => s.people);
}

interface PickerProps {
  sections: PeopleSection[];
  current: QuickPerson | null;
  onPick: (p: QuickPerson) => void;
  onClose: () => void;
}

export function QuickBarPicker({ sections, current, onPick, onClose }: PickerProps) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<QuickPerson[]>([]);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { inputRef.current?.focus({ preventScroll: true }); }, []);

  // Tasks the list does not hold, from the search, once two letters are typed.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setFound([]); return; }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      searchQuickTasks(q, ctl.signal).then(({ tasks }) => setFound(tasks.map((r) => ({
        id: r.id, title: r.title, kind: 'task' as const, project: r.project, state: r.state, stateLabel: r.stateLabel, line: '', needs: r.state === 'needs' ? 1 : 0,
      })))).catch(() => { /* the list alone still answers */ });
    }, 120);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [query]);

  const shown: PeopleSection[] = useMemo(() => {
    const q = query.trim();
    if (!q) return sections;
    const listed = filterPeople(sections.flatMap((s) => s.people), q);
    const ids = new Set(listed.map((p) => p.id));
    const more = found.filter((p) => !ids.has(p.id));
    return [{ label: 'Matches', people: listed }, { label: 'Other tasks', people: more }].filter((s) => s.people.length > 0);
  }, [sections, query, found]);
  const rows = useMemo(() => shown.flatMap((s) => s.people), [shown]);

  useEffect(() => { setIndex(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const onKeyDown = useLeanCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(rows.length - 1, i + 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); return; }
    if (e.key === 'Enter') { e.preventDefault(); const p = rows[index]; if (p) onPick(p); return; }
    if (e.key === 'Tab') { e.preventDefault(); onClose(); }
  }, [rows, index, onPick, onClose]);

  let n = 0;
  return (
    <div className="qb-picker" onKeyDown={onKeyDown}>
      <input
        ref={inputRef}
        className="qb-picker-search"
        data-no-draft="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Who? Type a name or a task"
        aria-label="Find who to talk to"
        aria-controls="qb-picker-list"
        aria-activedescendant={rows[index] ? `qb-row-${rows[index].id}` : undefined}
        spellCheck={false}
      />
      <div className="qb-picker-list" id="qb-picker-list" ref={listRef} role="listbox">
        {rows.length === 0 && <div className="qb-picker-empty">{query.trim() ? 'No one by that name' : 'Loading…'}</div>}
        {shown.map((section) => (
          <div key={section.label} className="qb-section">
            <div className="qb-section-label">{section.label}</div>
            {section.people.map((p) => {
              const at = n++;
              return (
                <div
                  key={p.id}
                  id={`qb-row-${p.id}`}
                  data-row={at}
                  role="option"
                  aria-selected={at === index}
                  className={`qb-person${at === index ? ' qb-person-on' : ''}${current?.id === p.id ? ' qb-person-current' : ''}`}
                  onMouseMove={() => { if (at !== index) setIndex(at); }}
                  onMouseDown={(e) => { e.preventDefault(); onPick(p); }}
                >
                  <PersonAvatar person={p} size={26} />
                  <span className="qb-person-main">
                    <span className="qb-person-name">{p.title}</span>
                    {p.kind === 'task' && p.project && <span className="qb-person-project">{p.project}</span>}
                  </span>
                  <span className={`qb-person-line${p.needs > 0 || p.state === 'needs' ? ' qb-person-needs' : ''}`}>
                    {personLine(p)}
                  </span>
                  {!query.trim() && at < 9 && <kbd className="qb-key qb-person-key">⌘{at + 1}</kbd>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
