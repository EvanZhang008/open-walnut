/**
 * The answer on a thread that holds a Board choice (experiment brief_off,
 * src/core/org/choice-thread-model.ts): the choice's own options and its words box, the same
 * OrgInlineAnswer a Board choice is answered with on the Org page. So an answer here is the
 * Board's answer (its route, its delivery to the Board's task), and the Board reads it answered;
 * the thread then reads closed from the server. It goes the moment it is sent and comes back with
 * the reason when the server says no.
 */
import { useState } from 'react';
import type { OrgThread } from '@/api/org-threads';
import { OrgInlineAnswer, type AnswerFailure } from './OrgInlineAnswer';
import type { OrgAlertView } from './org-channels-model';

/** The thread waits on him for its Board choice: its card answers the choice (core: choice-thread-model.ts holdsChoice). */
export const answersChoice = (t: Pick<OrgThread, 'choice' | 'closed' | 'state'>): boolean =>
  !!t.choice && !t.choice.done && !t.choice.off && !t.closed && t.state === 'needs';

export function ThreadChoiceAnswer({ t }: { t: OrgThread }) {
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<AnswerFailure | undefined>(undefined);
  const c = t.choice!;
  if (sent) return <p className="org-thread-stand-in-note" data-testid="org-thread-choice-sent">Answer sent.</p>;
  const ask = t.ask?.trim() || t.title;
  const alert: OrgAlertView = { taskId: c.task ?? c.board, title: t.title, kind: 'needs', source: 'choice', ask };
  return (
    <div className="org-thread-choice" data-testid="org-thread-choice" data-choice-id={c.id} data-board={c.board}>
      <OrgInlineAnswer
        alert={alert}
        task={undefined}
        summary={ask}
        failure={failure}
        choice={{ owner: c.board, id: c.id, title: t.title, options: c.options, ...(c.recommended ? { recommended: c.recommended } : {}) }}
        onAnswer={() => {
          setSent(true);
          setFailure(undefined);
          return (f) => { if (f) { setSent(false); setFailure(f); } };
        }}
      />
    </div>
  );
}
