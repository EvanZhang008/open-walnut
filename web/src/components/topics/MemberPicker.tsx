/**
 * Picking a topic's members: the ones picked as chips (★ makes one the host, × takes it off), a
 * search over the CEO, the VPs and the open tasks (member-candidates.ts), and "Add a person by
 * email" for someone outside Walnut, or their bot. Used by the New topic dialog and by Add in a
 * topic's side panel.
 */
import { useMemo, useState } from 'react';
import { MicInput } from '@/components/common/BoxMic';
import type { PickedMember } from './topic-dialogs';
import { useMemberCandidates } from './member-candidates';
import { isEmail, rankByName, refKey } from './topic-model';
import { MemberAvatar } from './TopicAvatars';

const LIMIT = 8;

export function MemberPicker({ picked, onChange, host, onHost, exclude, autoFocus }: {
  picked: PickedMember[];
  onChange: (next: PickedMember[]) => void;
  /** The index in `picked` of the host; with `onHost` each chip has a ★. */
  host?: number;
  onHost?: (index: number) => void;
  /** Refs already in the topic (refKey): not offered again. */
  exclude?: ReadonlySet<string>;
  autoFocus?: boolean;
}) {
  const all = useMemberCandidates();
  const [query, setQuery] = useState('');
  const [person, setPerson] = useState<{ name: string; email: string; bot: boolean } | null>(null);
  const taken = useMemo(() => new Set([...(exclude ?? []), ...picked.map((p) => refKey(p.ref))]), [exclude, picked]);
  const rows = useMemo(() => {
    const free = all.filter((c) => !taken.has(refKey(c.ref)));
    return (query.trim() ? rankByName(free, (c) => c.name, query) : free.filter((c) => c.ref.kind === 'org')).slice(0, LIMIT);
  }, [all, taken, query]);

  const add = (m: PickedMember) => { onChange([...picked, m]); setQuery(''); };
  const remove = (i: number) => onChange(picked.filter((_, j) => j !== i));
  const personOk = !!person && !!person.name.trim() && isEmail(person.email) && !taken.has(`person:${person.email.trim().toLowerCase()}`);
  const addPerson = () => {
    if (!person || !personOk) return;
    add({ ref: { kind: 'person', name: person.name.trim(), email: person.email.trim(), ...(person.bot ? { bot: true } : {}) }, name: person.name.trim() });
    setPerson(null);
  };

  return (
    <div className="topic-picker" data-testid="topic-member-picker">
      {picked.length > 0 && (
        <ul className="topic-picked" data-testid="topic-picked">
          {picked.map((p, i) => (
            <li key={refKey(p.ref)} className={`topic-chip${host === i ? ' is-host' : ''}`} data-testid="topic-picked-member" data-ref={refKey(p.ref)}>
              <MemberAvatar who={{ name: p.name, ref: p.ref }} size={18} />
              <span className="topic-chip-name">{p.name}</span>
              {onHost && (
                <button type="button" className="topic-chip-host" data-testid="topic-make-host" aria-pressed={host === i}
                  title={host === i ? 'Hosts this topic' : 'Make this member the host'} onClick={() => onHost(i)}>★</button>
              )}
              <button type="button" className="topic-chip-x" data-testid="topic-unpick" aria-label={`Remove ${p.name}`} onClick={() => remove(i)}>×</button>
            </li>
          ))}
        </ul>
      )}
      <MicInput
        data-no-draft="search"
        className="app-modal-input topic-picker-search"
        type="search"
        value={query}
        setText={setQuery}
        placeholder="Search tasks, VPs and the CEO…"
        aria-label="Search members to add"
        data-testid="topic-member-search"
        autoFocus={autoFocus}
        onEnter={() => { if (rows[0]) add(rows[0]); }}
      />
      {rows.length > 0 && (
        <ul className="topic-candidates" role="listbox" aria-label="Members to add" data-testid="topic-candidates">
          {rows.map((c) => (
            <li key={refKey(c.ref)}>
              <button type="button" role="option" aria-selected={false} className="topic-candidate" data-testid="topic-candidate" data-ref={refKey(c.ref)} onClick={() => add(c)}>
                <MemberAvatar who={{ name: c.name, ref: c.ref }} size={20} />
                <span className="topic-candidate-name">{c.name}</span>
                <span className="topic-candidate-hint">{c.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {query.trim() && rows.length === 0 && <p className="topic-muted">No task or VP matches “{query.trim()}”.</p>}
      {person ? (
        <div className="topic-person" data-testid="topic-person-form">
          <MicInput data-no-draft="picker" className="app-modal-input" placeholder="Name" aria-label="Their name" data-testid="topic-person-name" value={person.name} setText={(name) => setPerson((p) => (p ? { ...p, name } : p))} />
          <input data-no-draft="picker" className="app-modal-input" type="email" placeholder="name@example.com" aria-label="Their email" data-testid="topic-person-email" value={person.email}
            onChange={(e) => setPerson({ ...person, email: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPerson(); } }} />
          <label className="topic-person-bot">
            <input type="checkbox" data-testid="topic-person-bot" checked={person.bot} onChange={(e) => setPerson({ ...person, bot: e.target.checked })} />
            It is a bot
          </label>
          <span className="topic-person-actions">
            <button type="button" className="app-modal-btn" onClick={() => setPerson(null)}>Cancel</button>
            <button type="button" className="app-modal-btn primary" data-testid="topic-person-add" disabled={!personOk} onClick={addPerson}>Add</button>
          </span>
          <p className="topic-muted">They get the topic by email and can reply to it. Nothing is mailed until you send a message.</p>
        </div>
      ) : (
        <button type="button" className="topic-link-btn" data-testid="topic-add-person" onClick={() => setPerson({ name: '', email: query.trim() && isEmail(query) ? query.trim() : '', bot: false })}>
          + Add a person by email
        </button>
      )}
    </div>
  );
}
