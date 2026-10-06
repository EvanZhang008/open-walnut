/**
 * A lane's `+ Add task` (spec 7.6): an input; Enter adds a subtask of the
 * board's owner in this lane (a pending `Adding...` card shows at once, the
 * input clears and keeps focus for the next); a failure gives the title back
 * with `Couldn't add: <reason>`. `key:value` tokens in the title become tags
 * (G15): their chips show live under the input and × drops one (and its
 * token). No session starts.
 */
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ICON_PLUS } from '@/components/common/Icons';
import { TagChip } from '@/components/tasks/TagChip';
import { READ_ONLY_TITLE, type KanbanWriteApi } from './kanban-contract';

const TOKEN_RE = /(^|\s)([A-Za-z][A-Za-z0-9_-]*):(\S+)/g;
const NOT_TAGS = new Set(['http', 'https', 'file', 'mailto']);

/** The title without its `key:value` tokens, and the tags they make. */
export function splitTagTokens(text: string): { title: string; tags: string[] } {
  const tags: string[] = [];
  const title = text.replace(TOKEN_RE, (all, lead: string, key: string, value: string) => {
    if (NOT_TAGS.has(key.toLowerCase())) return all;
    const tag = `${key.toLowerCase()}:${value}`;
    if (!tags.includes(tag)) tags.push(tag);
    return lead;
  }).replace(/\s+/g, ' ').trim();
  return { title, tags };
}

/** `text` without the token that makes `tag`. */
function dropToken(text: string, tag: string): string {
  return text.replace(TOKEN_RE, (all, lead: string, key: string, value: string) =>
    (`${key.toLowerCase()}:${value}` === tag ? lead : all)).replace(/\s+/g, ' ').replace(/^\s+/, '');
}

export interface KanbanAddTaskProps {
  laneId: string;
  laneName: string;
  api: KanbanWriteApi;
  autoFocus?: boolean;
}

function KanbanAddTaskInner({ laneId, laneName, api, autoFocus }: KanbanAddTaskProps) {
  const [open, setOpen] = useState(!!autoFocus);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => { if (autoFocus) { setOpen(true); } }, [autoFocus]);
  useEffect(() => {
    if (open) inputRef.current?.focus();
    // N2: Escape out of the form leaves focus on its button, inside the board.
    else if (refocus.current) { refocus.current = false; btnRef.current?.focus(); }
  }, [open]);
  const { title, tags } = splitTagTokens(text);
  // R3-14: while the user adds, the form (input, tag preview, error) stays in view as the lane
  // grows above it (the pending card, then the real one), so adding the next one needs no scroll.
  const formRef = useRef<HTMLDivElement>(null);
  const keepInView = () => {
    const form = formRef.current;
    if (form && document.activeElement === inputRef.current) form.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  useLayoutEffect(keepInView, [tags.length, error]);
  useEffect(() => {
    const body = open ? formRef.current?.parentElement : null;
    if (!body) return;
    // A size change (ResizeObserver) and a card put in or taken out (MutationObserver) each check
    // again once the frame is laid out: one missed signal must not leave the form below the lane.
    let raf = 0;
    const soon = () => { keepInView(); cancelAnimationFrame(raf); raf = requestAnimationFrame(keepInView); };
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(soon);
    ro?.observe(body);
    const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(soon);
    mo?.observe(body, { childList: true });
    return () => { ro?.disconnect(); mo?.disconnect(); cancelAnimationFrame(raf); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (!title || api.readOnly) return;
    const typed = text;
    setText('');
    setError('');
    inputRef.current?.focus();
    const r = await api.addTask(laneId, title, tags);
    if (!r.ok) {
      setText((cur) => cur || typed);
      setError(`Couldn't add: ${r.error}`);
    }
  };

  if (!open) {
    return (
      <button
        ref={btnRef} type="button" className="kanban-add-task" data-testid="kanban-add-task" data-lane-id={laneId}
        aria-disabled={api.readOnly || undefined} title={api.readOnly ? READ_ONLY_TITLE : `Add a task to ${laneName}`}
        onClick={() => { if (!api.readOnly) setOpen(true); }}
      ><span className="kanban-add-icon" aria-hidden="true">{ICON_PLUS}</span>Add task</button>
    );
  }
  return (
    <div ref={formRef} className="kanban-add-task-form" data-testid="kanban-add-task-form" onPointerDown={(e) => e.stopPropagation()}>
      <input
        ref={inputRef} className="kanban-add-task-input" data-testid="kanban-add-task-input" placeholder="Task title"
        aria-label={`New task in ${laneName}`} value={text} maxLength={500}
        onChange={(e) => { setText(e.target.value); if (error) setError(''); }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
          if (e.key === 'Escape') { e.preventDefault(); setText(''); setError(''); refocus.current = true; setOpen(false); }
        }}
        onBlur={() => { if (!text.trim() && !error) setOpen(false); }}
      />
      {tags.length > 0 && (
        <div className="kanban-add-task-tags" data-testid="kanban-add-task-tags">
          {tags.map((t) => (
            <TagChip key={t} tag={t} inline whole onRemove={() => { setText((cur) => dropToken(cur, t)); inputRef.current?.focus(); }} />
          ))}
        </div>
      )}
      {error && <div className="kanban-error-text" role="alert" data-testid="kanban-add-task-error">{error}</div>}
    </div>
  );
}

// Its lane re-renders at every drag start and lane crossing (dnd-kit); this row's props do not change then.
export const KanbanAddTask = memo(KanbanAddTaskInner);
