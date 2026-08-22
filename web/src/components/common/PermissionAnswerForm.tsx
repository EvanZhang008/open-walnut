/**
 * The AskUserQuestion answer form — ONE implementation, used by both the
 * notification panel's permission card and the permission toast.
 *
 * Why it is shared rather than duplicated: answering an AskUserQuestion IS the
 * response (a bare allow carries no `answers` map, which tells the model the user
 * answered nothing), so the two surfaces must agree exactly on what goes on the
 * wire. The toast used to render a reduced version of this — pills only when there
 * was ONE question, single-select, with at most four options, and an "Answer…"
 * button that just opened the panel otherwise. That made the popup a dead end for
 * every richer ask: the user had to open the center to answer a question that was
 * already on screen. Now the toast renders the full ask, and this file is the only
 * place the answer payload is built.
 *
 * The pure helpers stay in `@/components/sessions/ask-user-question` (parsing,
 * `answers` construction, the completeness gate, pill toggling) — this component
 * owns only the selection state and the markup.
 */
import { useState } from 'react';
import {
  buildAskUserAnswers, allAskUserQuestionsAnswered, toggleAskUserSelection,
  type AskQuestion,
} from '@/components/sessions/ask-user-question';

interface PermissionAnswerFormProps {
  questions: AskQuestion[];
  /** Buttons + inputs inert (request in flight, or nothing to answer with). */
  disabled: boolean;
  /** Already settled — render nothing at all (the settled chip speaks instead). */
  resolved: boolean;
  onSubmit: (answers: Record<string, string>) => void;
  /** Refuse the ask outright ("the user dismissed the questions"), i.e. a deny. */
  onDismissQuestions: () => void;
  /**
   * Toast placement: cap the height and scroll internally. The toaster column is
   * 380px wide and top-anchored, so a six-question ask would otherwise run off
   * the bottom of the viewport with its Submit button below the fold.
   */
  scrollable?: boolean;
}

export function PermissionAnswerForm({
  questions, disabled, resolved, onSubmit, onDismissQuestions, scrollable,
}: PermissionAnswerFormProps) {
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  const complete = allAskUserQuestionsAnswered(questions, selections, otherText);

  if (resolved) return null;

  return (
    <div className={`nfc-answer${scrollable ? ' nfc-answer--scroll' : ''}`}>
      {questions.map((q) => {
        const picked = selections[q.question] ?? [];
        return (
          <div key={q.question} className="nfc-answer-q">
            {q.header && <div className="nfc-chip">{q.header}</div>}
            <div className="nfc-answer-text">{q.question}</div>
            {q.options.length > 0 && (
              /* Every option, no cap: a truncated option list is a wrong answer
                 waiting to happen — the pills wrap instead. */
              <div className="nfc-answer-opts">
                {q.options.map((opt) => (
                  <button
                    key={opt.label}
                    className={`nfc-answer-opt${picked.includes(opt.label) ? ' nfc-picked' : ''}`}
                    title={opt.description}
                    disabled={disabled}
                    onClick={() => setSelections(prev => ({
                      ...prev,
                      // multiSelect toggles membership; single-select replaces
                      // (and re-clicking the picked pill clears it).
                      [q.question]: toggleAskUserSelection(prev[q.question], opt.label, q.multiSelect),
                    }))}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
            {/* Free text per question. buildAskUserAnswers lets it BEAT the pills —
                an "Other" answer is a deliberate override, not an addition. */}
            <input
              className="nfc-answer-input"
              placeholder={q.options.length > 0 ? 'Other…' : 'Type your answer…'}
              value={otherText[q.question] ?? ''}
              disabled={disabled}
              onChange={(e) => setOtherText(prev => ({ ...prev, [q.question]: e.target.value }))}
            />
          </div>
        );
      })}
      <div className="notification-feed-item-actions">
        <button
          className="notification-perm-btn approve"
          disabled={disabled || !complete}
          onClick={() => onSubmit(buildAskUserAnswers(questions, selections, otherText))}
        >
          Submit
        </button>
        <button className="notification-perm-btn" disabled={disabled} onClick={onDismissQuestions}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
