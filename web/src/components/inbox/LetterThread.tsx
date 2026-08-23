/**
 * The letter's conversation: agent turns and human turns, oldest first.
 *
 * A turn is normally plain text (what the delivery wrapper carried), so it
 * renders verbatim with URLs linkified — markdown semantics would turn a typed
 * `#` into a heading. A turn that carried a RICH body (the agent replied with
 * html/markdown) renders that body through the same sandbox/renderer the letter
 * body uses, so a report replied into the thread reads like a report.
 */
import { formatRelative } from '@/contexts/notifications';
import { LinkifiedText } from '@/components/common/LinkifiedText';
import type { LetterThreadEntry } from '@/api/human-inbox';
import { LetterBody } from './LetterBody';

export function LetterThread({ entries, subject, onBodyClick }: {
  entries: LetterThreadEntry[];
  subject: string;
  onBodyClick?: (e: React.MouseEvent) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="hib-thread">
      <div className="hib-thread-head">Thread · {entries.length}</div>
      {entries.map((entry, i) => (
        <div
          key={`${entry.at}-${i}`}
          className={`hib-turn hib-turn--${entry.from === 'human' ? 'human' : 'agent'}`}
        >
          <div className="hib-turn-head">
            <span className="hib-turn-who">{entry.from === 'human' ? 'You' : 'Agent'}</span>
            <span className="hib-turn-time">{formatRelative(entry.at)}</span>
          </div>
          {entry.text && (
            <div className="hib-turn-text"><LinkifiedText text={entry.text} /></div>
          )}
          {entry.body && entry.bodyFormat && (
            <div className="hib-turn-body">
              <LetterBody
                body={entry.body}
                format={entry.bodyFormat}
                subject={subject}
                onClick={onBodyClick}
              />
            </div>
          )}
          {!entry.body && entry.bodyFile && (
            <div className="hib-note">The rich body of this reply is no longer on disk.</div>
          )}
        </div>
      ))}
    </div>
  );
}
