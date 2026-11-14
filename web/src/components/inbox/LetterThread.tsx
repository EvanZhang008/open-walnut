import { formatRelative } from '@/contexts/notifications';
import { LinkifiedText } from '@/components/common/LinkifiedText';
import { AgentText } from '@/components/common/AgentText';
import { answeredByName, type LetterThreadEntry } from '@/api/human-inbox';
import { LetterBody } from './LetterBody';
import { EmailItems } from './EmailItems';
import { openAgentRef, type AgentRef } from '@/utils/agent-ref-open';
import { useCallback } from 'react';
import { useAgentFileOpener } from '@/hooks/useAgentFileOpener';
import { useEntityClickHandler } from '@/hooks/useEntityClickHandler';
import { taskPath } from '@/utils/task-path';

type Sender = { host?: string; sessionId?: string; unknownSource?: boolean };

/**
 * Where an agent turn's paths open: its own recorded writer, never the letter's sender, because
 * another session (or Walnut, or a plugin) may have written it. An older turn has none: unknown.
 */
export function agentTurnSource(entry: LetterThreadEntry): Sender {
  const s = entry.sender;
  if (!s?.sessionId) return { unknownSource: true };
  return { sessionId: s.sessionId, ...(s.host !== undefined ? { host: s.host } : {}) };
}

function TurnBody({ entry, sender, subject, onBodyClick, onRefOpen, onNavigate }: {
  entry: LetterThreadEntry;
  sender?: Sender;
  subject: string;
  onBodyClick?: (e: React.MouseEvent) => void;
  onRefOpen?: (ref: AgentRef) => void;
  onNavigate: (to: string) => void;
}) {
  const by = entry.by?.sessionId?.trim();
  const person = entry.from === 'human' && !by;
  const peer = !!by && by !== sender?.sessionId;
  const agent = entry.from === 'agent';
  const source = agent ? agentTurnSource(entry) : peer ? { sessionId: by } : person ? { host: '__local__' } : sender;
  const file = useAgentFileOpener(source);
  const peerClick = useEntityClickHandler(
    (taskId) => onNavigate(taskPath(taskId)),
    (sid) => onNavigate(`/sessions?id=${sid}`),
    file.onFileOpen, file.fileHost, file.fileSessionId, file.refusesAll,
  );
  const peerRef = useCallback((ref: AgentRef) => {
    if (ref.kind === 'file' && file.onFileOpen) file.onFileOpen(ref.path, ref.line, undefined, ref.endLine);
    else openAgentRef(ref, onNavigate);
  }, [file.onFileOpen, onNavigate]);
  // Only a human turn of the letter's own sender may use the letter's handlers; every other turn has its own source.
  const own = !(agent || peer || person);
  const onClick = own ? onBodyClick : peerClick;
  return <>
    {entry.text && (person
      ? <div className="hib-turn-text"><LinkifiedText text={entry.text} /></div>
      : <AgentText text={entry.text} className="hib-turn-text" host={source?.host} sessionId={source?.sessionId} unknownSource={source?.unknownSource} onClick={onClick} />)}
    {(entry.body || (entry.bodyDeferred && entry.bodyUrl)) && entry.bodyFormat && (
      <div className="hib-turn-body">
        <LetterBody body={entry.body ?? ''} format={entry.bodyFormat} subject={subject}
          onClick={onClick} onRefOpen={own ? onRefOpen : peerRef} source={source}
          {...(entry.bodyDeferred && entry.bodyUrl ? { bodyUrl: entry.bodyUrl } : {})} />
      </div>
    )}
  </>;
}

export function LetterThread({ entries, subject, onBodyClick, onRefOpen, letterId, onNavigate, sender }: {
  entries: LetterThreadEntry[];
  /** The envelope's source; agent turns carry their own saved source. */
  sender?: Sender;
  letterId: string;
  onNavigate: (to: string) => void;
  subject: string;
  onBodyClick?: (e: React.MouseEvent) => void;
  onRefOpen?: (ref: AgentRef) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="hib-thread">
      {entries.map((entry, i) => (
        <div
          key={`${entry.at}-${i}`}
          className={`hib-turn hib-turn--${entry.from === 'human' ? 'human' : 'agent'}`}
        >
          <div className="hib-turn-head">
            <span className="hib-turn-who">{entry.from === 'human' ? (entry.by ? answeredByName(entry.by, 'A task') : 'You') : 'Agent'}</span>
            <span className="hib-turn-time">{formatRelative(entry.at)}</span>
          </div>
          <TurnBody entry={entry} sender={sender} subject={subject} onBodyClick={onBodyClick}
            onRefOpen={onRefOpen} onNavigate={onNavigate} />
          {entry.images && entry.images.length > 0 && (
            <div className="chat-message-images hib-turn-images" data-testid="letter-turn-images">
              {entry.images.map((name) => (
                <a key={name} href={`/api/images/${encodeURIComponent(name)}`} target="_blank" rel="noreferrer">
                  <img
                    className="chat-message-image"
                    src={`/api/images/${encodeURIComponent(name)}`}
                    alt="Attached picture (no longer on disk)"
                    loading="lazy"
                    // Pictures live in the images folder, which a reboot may clear: say so, never a broken icon.
                    onError={(e) => { e.currentTarget.replaceWith(Object.assign(document.createElement('span'), { className: 'hib-note', textContent: 'A picture (no longer on disk)' })); }}
                  />
                </a>
              ))}
            </div>
          )}
          {entry.by?.userWords && (
            <div className="hib-turn-text hib-turn-quote" data-testid="letter-turn-user-words">On your words: “{entry.by.userWords}”</div>
          )}
          {entry.from === 'agent' && <EmailItems letterId={letterId} items={entry.items} onNavigate={onNavigate} sender={agentTurnSource(entry)} />}
          {!entry.body && !entry.bodyDeferred && entry.bodyFile && (
            <div className="hib-note">The rich body of this reply is no longer on disk.</div>
          )}
        </div>
      ))}
    </div>
  );
}
