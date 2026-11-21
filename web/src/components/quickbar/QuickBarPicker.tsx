/**
 * The quick bar's Tab list, Raycast style: first what else the bar does (search notes, search
 * tasks, ask a quick question; 2026-11-20, the user: "after tab ... you can search note, can search
 * task ... the user does not know, this is all black magic"), then who to talk to: CEO, the VPs, the
 * tasks talked to lately, then open tasks. Typing filters both; past two letters the task search
 * adds matches the list did not hold. Up/Down move, Enter picks, Cmd-1..9 picks the numbered
 * person from anywhere in the bar.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { searchQuickTasks } from '@/api/quick';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { filterPeople, personLine, type PeopleSection, type QuickPerson } from './quickbar-people';
import { PersonAvatar } from './PersonAvatar';
import { MicInput } from '@/components/common/BoxMic';
import type { ModeSpec, QuickMode } from './quickbar-modes';
import { ModeGlyph } from './quickbar-glyphs';

/**
 * A mode's row stays while the words start one of its own names, its keywords or its chip ("no"
 * keeps Notes, "?" keeps Ask), from two letters on: a name typed to find a person ("quick", "s")
 * never puts a mode ahead of that person.
 */
function modeMatches(m: ModeSpec, q: string): boolean {
  const w = q.toLowerCase();
  if (w.length < 2 && w !== '?') return false;
  return [m.chip, ...m.keywords].some((k) => k.toLowerCase().startsWith(w));
}

/** The rows in the order they are numbered (Cmd-1 is the first). */
export function flatPicks(sections: readonly PeopleSection[]): QuickPerson[] {
  return sections.flatMap((s) => s.people);
}

interface PickerProps {
  sections: PeopleSection[];
  current: QuickPerson | null;
  onPick: (p: QuickPerson) => void;
  onClose: () => void;
  /** What else the bar does, listed first. */
  modes: readonly ModeSpec[];
  onMode: (id: Exclude<QuickMode, 'send'>) => void;
  /** Opened during a take: the highlight starts on the first person, so Enter keeps the words a message. */
  startOnPeople: boolean;
  /** In a focus space: a line under the people saying the tasks outside it are left out. */
  focusNote?: string;
}

type Row = { kind: 'mode'; mode: ModeSpec } | { kind: 'person'; person: QuickPerson };

export function QuickBarPicker({ sections, current, onPick, onClose, modes: modesNow, onMode, startOnPeople: onPeopleNow, focusNote }: PickerProps) {
  // Fixed while the list is open: a take that ends under it never moves the rows or the highlight.
  const [modes] = useState(modesNow);
  const [startOnPeople] = useState(onPeopleNow);
  const start = startOnPeople ? modes.length : 0;
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<QuickPerson[]>([]);
  const [index, setIndex] = useState(start);
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
  const shownModes = useMemo(() => (query.trim() ? modes.filter((m) => modeMatches(m, query.trim())) : modes), [modes, query]);
  const rows: Row[] = useMemo(() => [
    ...shownModes.map((mode): Row => ({ kind: 'mode', mode })),
    ...shown.flatMap((s) => s.people.map((person): Row => ({ kind: 'person', person }))),
  ], [shownModes, shown]);
  const rowId = (r: Row) => (r.kind === 'mode' ? `qb-row-mode-${r.mode.id}` : `qb-row-${r.person.id}`);
  const choose = useLeanCallback((r: Row | undefined) => {
    if (!r) return;
    if (r.kind === 'mode') onMode(r.mode.id);
    else onPick(r.person);
  }, [onMode, onPick]);

  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    setIndex(query.trim() ? 0 : start);
  }, [query, start]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const onKeyDown = useLeanCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(rows.length - 1, i + 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); return; }
    if (e.key === 'Enter') { e.preventDefault(); choose(rows[index]); return; }
    if (e.key === 'Tab') { e.preventDefault(); onClose(); }
  }, [rows, index, choose, onClose]);

  // Rows are numbered for the arrows across both parts; Cmd-number counts only the people.
  let n = 0;
  let person = 0;
  return (
    <div className="qb-picker" onKeyDown={onKeyDown}>
      {/* A filter: the words narrow the list, Enter picks the highlighted row (the list's keys). */}
      <MicInput
        ref={inputRef}
        className="qb-picker-search"
        fieldClassName="qb-picker-search-field"
        data-testid="qb-picker-search"
        data-no-draft="search"
        value={query}
        setText={setQuery}
        compact
        placeholder="Search notes or tasks, or who to talk to"
        aria-label="Find what to do or who to talk to"
        aria-controls="qb-picker-list"
        aria-activedescendant={rows[index] ? rowId(rows[index]) : undefined}
        spellCheck={false}
      />
      <div className="qb-picker-list" id="qb-picker-list" ref={listRef} role="listbox">
        {rows.length === 0 && <div className="qb-picker-empty">{query.trim() ? 'Nothing by that name' : 'Loading…'}</div>}
        {shownModes.length > 0 && (
          <div className="qb-section qb-section-modes">
            <div className="qb-section-label">Search and ask</div>
            {shownModes.map((m) => {
              const at = n++;
              return (
                <div
                  key={m.id}
                  id={`qb-row-mode-${m.id}`}
                  data-row={at}
                  data-mode-row={m.id}
                  role="option"
                  aria-selected={at === index}
                  className={`qb-mode-row qb-mode-${m.id}${at === index ? ' qb-person-on' : ''}`}
                  onMouseMove={() => { if (at !== index) setIndex(at); }}
                  onMouseDown={(e) => { e.preventDefault(); onMode(m.id); }}
                >
                  <span className="qb-mode-row-icon"><ModeGlyph mode={m.id} size={16} /></span>
                  <span className="qb-mode-row-main">
                    <span className="qb-mode-row-name">{m.action}</span>
                    <span className="qb-mode-row-about">{m.about}</span>
                  </span>
                  <span className="qb-mode-row-hint">or type <kbd className="qb-key">{m.keywords[0]}</kbd> then <kbd className="qb-key">tab</kbd></span>
                </div>
              );
            })}
          </div>
        )}
        {shown.map((section) => (
          <div key={section.label} className="qb-section">
            <div className="qb-section-label">{section.label}</div>
            {section.people.map((p) => {
              const at = n++;
              const num = person++;
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
                  {!query.trim() && num < 9 && <kbd className="qb-key qb-person-key">⌘{num + 1}</kbd>}
                </div>
              );
            })}
          </div>
        ))}
        {focusNote && !query.trim() && <div className="qb-picker-empty qb-picker-focus" data-testid="qb-picker-focus">{focusNote}</div>}
      </div>
    </div>
  );
}
