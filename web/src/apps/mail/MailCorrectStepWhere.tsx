/**
 * Step 1 of the correction card: where should this mail go, and (optionally) why.
 *
 * Real radios, never a native `<select>` (web/src/AGENTS.md, menus): the list is short and bounded
 * (Important plus the groups), so it stays inline. `Next` is disabled until a destination is chosen,
 * and a new group's name must not collide with one that exists.
 */
import { useId, type RefObject } from 'react';
import {
  COPY,
  MAX_GROUP_NAME,
  MAX_NOTE,
  NEW_GROUP_VALUE,
  NOTE_COUNTER_FROM,
  whereSentence,
  type CorrectChoice,
} from './mail-correct-model';

export interface StepWhereProps {
  currentLabel: string;
  choices: CorrectChoice[];
  focusIndex: number;
  firstRef: RefObject<HTMLInputElement | null>;
  value: string | null;
  onValue: (value: string) => void;
  newName: string;
  onNewName: (name: string) => void;
  /** '' = nothing to say yet, null = the name is fine. */
  newNameProblem: string | null;
  note: string;
  onNote: (note: string) => void;
  onCancel: () => void;
  onNext: () => void;
}

export function canGoNext(value: string | null, newNameProblem: string | null): boolean {
  if (!value) return false;
  if (value === NEW_GROUP_VALUE) return newNameProblem === null;
  return true;
}

export function MailCorrectStepWhere(props: StepWhereProps) {
  const { choices, value, newName, newNameProblem, note } = props;
  const titleId = useId();
  const whyId = useId();
  const name = useId();
  const next = canGoNext(value, newNameProblem);
  return (
    <div className="mail-correct-step" data-step="where">
      <p className="mail-correct-title" id={titleId}>{whereSentence(props.currentLabel)}</p>
      <div className="mail-correct-choices" role="radiogroup" aria-labelledby={titleId}>
        {choices.map((choice, index) => (
          <label className="mail-correct-choice" key={choice.value}>
            <input
              type="radio"
              name={name}
              value={choice.value}
              checked={value === choice.value}
              onChange={() => props.onValue(choice.value)}
              ref={index === props.focusIndex ? props.firstRef : undefined}
              data-testid="mail-correct-choice"
              data-group-id={choice.value}
              data-keep={choice.keep ? 'true' : undefined}
            />
            <span className="mail-correct-choice-label">{choice.label}</span>
          </label>
        ))}
        <label className="mail-correct-choice">
          <input
            type="radio"
            name={name}
            value={NEW_GROUP_VALUE}
            checked={value === NEW_GROUP_VALUE}
            onChange={() => props.onValue(NEW_GROUP_VALUE)}
            data-testid="mail-correct-choice"
            data-group-id="new"
          />
          <span className="mail-correct-choice-label">{COPY.newGroupLabel}</span>
        </label>
        {value === NEW_GROUP_VALUE && (
          <div className="mail-correct-new-group">
            <input
              type="text"
              className="mail-correct-input"
              aria-label={COPY.newGroupAria}
              data-testid="mail-correct-new-group"
              maxLength={MAX_GROUP_NAME}
              value={newName}
              autoFocus
              onChange={(event) => props.onNewName(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && next) { event.preventDefault(); props.onNext(); } }}
            />
            {newNameProblem ? (
              <p className="mail-correct-field-error" role="alert" data-testid="mail-correct-new-group-error">{newNameProblem}</p>
            ) : null}
          </div>
        )}
      </div>
      <label className="mail-correct-why-label" htmlFor={whyId}>{COPY.whyLabel}</label>
      <textarea
        id={whyId}
        className="mail-correct-why"
        data-testid="mail-correct-why"
        rows={2}
        maxLength={MAX_NOTE}
        placeholder={COPY.whyPlaceholder}
        value={note}
        onChange={(event) => props.onNote(event.target.value.slice(0, MAX_NOTE))}
      />
      {note.length > NOTE_COUNTER_FROM && (
        <span className="mail-correct-counter" data-testid="mail-correct-counter" aria-live="polite">
          {note.length} / {MAX_NOTE}
        </span>
      )}
      <div className="mail-correct-actions">
        <button type="button" className="btn btn-sm" onClick={props.onCancel} data-testid="mail-correct-cancel">Cancel</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={!next} onClick={props.onNext} data-testid="mail-correct-next">
          Next
        </button>
      </div>
    </div>
  );
}
