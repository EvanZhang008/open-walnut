/**
 * The answer on a thread that holds a decision letter (experiment letters_as_threads,
 * src/core/org/letter-thread-model.ts): the letter's own buttons and its reply box, the same
 * OrgInlineAnswer every Action needed item answers a letter with. So an answer here is the
 * letter's answer (its route, its delivery to the task that asked), and the inbox reads it
 * answered; the thread then reads answered from the server. It goes the moment it is sent and
 * comes back with the reason when the server says no. A letter that no longer waits (answered in
 * the inbox a moment ago, its thread not settled yet) says so instead of offering a box.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { OrgThread } from '@/api/org-threads';
import { getLetterSnapshot, loadLetters, subscribeLetters } from '@/components/inbox/letter-store';
import { OrgInlineAnswer, type AnswerFailure } from './OrgInlineAnswer';
import { openLetterFor } from './org-answer-shape';
import type { OrgAlertView } from './org-channels-model';
import { EmptyState, LoadingState } from '@/components/common/EmptyState';

/** The thread waits on him for its letter: its card answers the letter (core: letter-thread-model.ts holdsLetter). */
export const answersLetter = (t: Pick<OrgThread, 'letter' | 'closed' | 'state'>): boolean =>
  !!t.letter && !t.letter.done && !t.letter.off && !t.closed && t.state === 'needs';

export function ThreadLetterAnswer({ t }: { t: OrgThread }) {
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<AnswerFailure | undefined>(undefined);
  const letter = t.letter!;
  const snap = useSyncExternalStore(subscribeLetters, getLetterSnapshot, getLetterSnapshot);
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    let alive = true;
    void loadLetters().finally(() => { if (alive) setFresh(true); });
    return () => { alive = false; };
  }, []);
  const open = useMemo(() => !!openLetterFor(snap.letters, letter.task, Date.now(), letter.id), [snap.letters, letter.task, letter.id]);
  if (sent) return <p className="org-thread-stand-in-note" data-testid="org-thread-letter-sent">Answer sent.</p>;
  if (!open) {
    return (
      fresh
        ? <EmptyState size="row" title="This letter no longer waits for an answer" hint="It was answered or closed in the inbox. The thread updates in a moment." testId="org-thread-letter-gone" />
        : <LoadingState size="row" title="Loading the letter…" testId="org-thread-letter-gone" />
    );
  }
  const ask = t.ask?.trim() || t.title;
  const alert: OrgAlertView = { taskId: letter.task, title: t.title, kind: 'needs', source: 'letter', ask, itemId: letter.id };
  return (
    <div className="org-thread-letter" data-testid="org-thread-letter" data-letter-id={letter.id}>
      <OrgInlineAnswer
        alert={alert}
        task={undefined}
        summary={ask}
        failure={failure}
        onAnswer={() => {
          setSent(true);
          setFailure(undefined);
          return (f) => { if (f) { setSent(false); setFailure(f); } };
        }}
      />
    </div>
  );
}
