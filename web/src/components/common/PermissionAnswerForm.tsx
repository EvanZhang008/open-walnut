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
import { useEffect, useRef, useState, type RefObject } from 'react';
import { AnswerBox } from '@/components/common/AnswerBox';
import { useImageAttachments, type ImageAttachments } from '@/components/common/image-attachments';
import type { ImageAttachment } from '@/api/chat';
import type { BoxMicHandle } from '@/components/common/BoxMic';
import { useSendAfterDictation, dictationWaitProps, useDictationGroup } from '@/hooks/useSendAfterDictation';
import { useDraftValue } from '@/hooks/useDraft';
import { askAnswerDraftKey } from '@/utils/drafts';
import '@/styles/prompt-mic.css';
import {
  buildAskUserAnswers, allAskUserQuestionsAnswered, toggleAskUserSelection,
  type AskQuestion,
} from '@/components/sessions/ask-user-question';

/** One question's own-words answer, with the composer's mic inside its right edge.
 *  The form's Submit waits for this mic's words (`answerMic`), then settles the ask. */
function OtherAnswerInput({ placeholder, value, disabled, onChange, draftKey, answerMic, pictures }: {
  placeholder: string; value: string; disabled: boolean; onChange: (v: string) => void; draftKey: string | null;
  answerMic: RefObject<BoxMicHandle | null>;
  /** The form's pictures (one set per ask, shown under its last question). */
  pictures?: ImageAttachments;
}) {
  return (
    <AnswerBox
      className="nfc-answer-field"
      inputClassName="nfc-answer-input"
      draftKey={draftKey}
      placeholder={placeholder}
      value={value}
      disabled={disabled}
      onChange={onChange}
      maxRows={4}
      micRef={answerMic}
      pictures={pictures}
    />
  );
}

interface PermissionAnswerFormProps {
  questions: AskQuestion[];
  /** Buttons + inputs inert (request in flight, or nothing to answer with). */
  disabled: boolean;
  /** Already settled — render nothing at all (the settled chip speaks instead). */
  resolved: boolean;
  /** The answer is still on the wire: settled only optimistically, so the words and pictures are
   *  kept until it lands (a failure rolls back to pending with both still there). */
  inFlight?: boolean;
  /** The answers, and the pictures that go with them (sent in the same request: RespondOptions.images). */
  onSubmit: (answers: Record<string, string>, images?: ImageAttachment[]) => void;
  /** Refuse the ask outright ("the user dismissed the questions"), i.e. a deny. */
  onDismissQuestions: () => void;
  /** The refuse button's word and tooltip (default `Dismiss`; a kanban card says `Skip question`). */
  dismissLabel?: string;
  dismissTitle?: string;
  /**
   * Toast placement: cap the height and scroll internally. The toaster column is
   * 380px wide and top-anchored, so a six-question ask would otherwise run off
   * the bottom of the viewport with its Submit button below the fold.
   */
  scrollable?: boolean;
}

export function PermissionAnswerForm({
  questions, disabled, resolved, inFlight = false, onSubmit, onDismissQuestions, scrollable, dismissLabel = 'Dismiss', dismissTitle,
}: PermissionAnswerFormProps) {
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  // The own-words answers are a draft of this ask (the toast, the panel and the card share it).
  const otherDraft = useDraftValue<Record<string, string>>(askAnswerDraftKey(questions), {});
  const { value: otherText, setValue: setOtherText } = otherDraft;
  // Settled (answered or dismissed, here or on another surface) and landed: the words are spent.
  const spent = resolved && !inFlight;
  const clearOther = otherDraft.clear;
  useEffect(() => { if (spent) clearOther(); }, [spent, clearOther]);
  // Pictures with the answers, sent in the same request (RespondOptions.images); spent with the words.
  const pictures = useImageAttachments();
  const { clear: clearPictures } = pictures;
  useEffect(() => { if (spent) clearPictures(); }, [spent, clearPictures]);
  const complete = allAskUserQuestionsAnswered(questions, selections, otherText);

  // Each question's own-words mic, and all of them as the one control Submit waits on.
  const { micOf, group: answerMic } = useDictationGroup<BoxMicHandle>();
  const submitNow = () => {
    if (disabled || !complete) return;
    onSubmit(buildAskUserAnswers(questions, selections, otherText), pictures.images.length ? pictures.images : undefined);
  };
  const gate = useSendAfterDictation([answerMic], submitNow);

  if (resolved) return null;

  return (
    <div className={`nfc-answer${scrollable ? ' nfc-answer--scroll' : ''}`}>
      {questions.map((q, qi) => {
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
            <OtherAnswerInput
              placeholder={q.options.length > 0 ? 'Other…' : 'Type your answer…'}
              value={otherText[q.question] ?? ''}
              disabled={disabled}
              onChange={(v) => setOtherText(prev => ({ ...prev, [q.question]: v }))}
              draftKey={otherDraft.key}
              answerMic={micOf(q.question)}
              {...(qi === questions.length - 1 ? { pictures } : {})}
            />
          </div>
        );
      })}
      {/* Why Submit waits: shown on a phone only (phone-fixes-r2.css, N2-12). */}
      {!complete && !disabled && (
        <div className="nfc-answer-hint" data-testid="nfc-answer-hint">
          {questions.length > 1 ? 'Answer every question to submit.' : 'Pick an answer or type one to submit.'}
        </div>
      )}
      <div className="notification-feed-item-actions">
        <button
          className="notification-perm-btn approve"
          disabled={disabled || (!complete && !gate.micBusy && !gate.waiting)}
          onClick={gate.send}
          {...dictationWaitProps(gate)}
        >
          Submit
        </button>
        <button className="notification-perm-btn" disabled={disabled} onClick={onDismissQuestions} title={dismissTitle}>
          {dismissLabel}
        </button>
      </div>
    </div>
  );
}
