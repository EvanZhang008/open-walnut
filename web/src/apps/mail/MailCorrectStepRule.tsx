/**
 * Steps 2 and 3 of the correction card: which rule to save, with its live match counts.
 *
 * The model's draft has a RESERVED two-line cell at the top from the moment a note was written, so the
 * radios under it never move when the model answers or gives up (C81). Every sentence and number comes
 * from the server through `mail-correct-model.ts`; this file only lays them out.
 */
import { useId } from 'react';
import {
  COPY,
  matchesLine,
  shadowSentence,
  type RuleOption,
  type SaveRefusal,
} from './mail-correct-model';

export type ModelState = 'none' | 'pending' | 'done';

export interface StepRuleProps {
  loading: boolean;
  loadError: string | null;
  options: RuleOption[];
  modelState: ModelState;
  modelSentence: string | null;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  allInboxes: boolean;
  expanded: ReadonlySet<string>;
  onToggleSamples: (key: string) => void;
  kept: ReadonlySet<string>;
  onKeepEarlier: (key: string) => void;
  recipientsLine: string | null;
  groupLabel: (groupId: string) => string;
  saving: boolean;
  error: SaveRefusal | null;
  onBack: () => void;
  onSave: () => void;
  onReload: () => void;
  onRetryLoad: () => void;
}

function shortDate(at: number): string {
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function OptionRow(props: StepRuleProps & { option: RuleOption; name: string }) {
  const { option } = props;
  const line = matchesLine(option, props.allInboxes);
  const open = props.expanded.has(option.key);
  const kept = props.kept.has(option.key);
  const shadow = option.shadows[0];
  return (
    <div className="mail-correct-option" data-testid="mail-correct-option" data-kind={option.kind}>
      <label className="mail-correct-choice">
        <input
          type="radio"
          name={props.name}
          value={option.key}
          checked={props.selectedKey === option.key}
          onChange={() => props.onSelect(option.key)}
          data-testid="mail-correct-rule"
          data-kind={option.kind}
        />
        <span className="mail-correct-summary">
          {option.summary}
          {option.fromNote && <span className="mail-correct-tag" data-testid="mail-correct-from-note">{COPY.fromNote}</span>}
        </span>
      </label>
      <div className="mail-correct-matches" data-testid="mail-correct-matches">
        <span>{line.head}</span>
        {line.moves && (
          <>
            <span aria-hidden="true"> · </span>
            <span className={line.bold ? 'mail-correct-moves-bold' : undefined} data-testid="mail-correct-moves">{line.moves}</span>
          </>
        )}
        {option.samples.length > 0 && (
          <>
            <span aria-hidden="true"> · </span>
            <button
              type="button"
              className="mail-correct-link"
              aria-expanded={open}
              data-testid="mail-correct-samples"
              onClick={() => props.onToggleSamples(option.key)}
            >
              {open ? 'Hide' : `Show ${Math.min(option.samples.length, 5)}`}
            </button>
          </>
        )}
      </div>
      {open && (
        <ul className="mail-correct-sample-list" data-testid="mail-correct-sample-list">
          {option.samples.slice(0, 5).map((sample) => (
            <li key={`${sample.accountId}/${sample.messageId}`} className="mail-correct-sample" data-testid="mail-correct-sample">
              <span className="mail-correct-sample-sender">{sample.sender}</span>
              <span className="mail-correct-sample-subject">{sample.subject || '(no subject)'}</span>
              <span className="mail-correct-sample-meta">{shortDate(sample.at)} · {props.groupLabel(sample.currentGroup)}</span>
            </li>
          ))}
        </ul>
      )}
      {kept ? (
        <p className="mail-correct-shadow" data-testid="mail-correct-shadow">{COPY.earlierStays}</p>
      ) : shadow ? (
        <p className="mail-correct-shadow" data-testid="mail-correct-shadow">
          <span>{shadowSentence(shadow)}</span>{' '}
          <button type="button" className="mail-correct-link" data-testid="mail-correct-keep-earlier" onClick={() => props.onKeepEarlier(option.key)}>
            {COPY.keepEarlier}
          </button>
        </p>
      ) : null}
    </div>
  );
}

export function MailCorrectStepRule(props: StepRuleProps) {
  const name = useId();
  const titleId = useId();
  const modelOption = props.options.find((one) => one.kind === 'model') ?? null;
  const local = props.options.filter((one) => one.kind !== 'model');
  const error = props.error;
  return (
    <div className="mail-correct-step" data-step="rule">
      <p className="mail-correct-title" id={titleId}>{COPY.step2Title}</p>
      {props.loading ? (
        <p className="mail-correct-loading" data-testid="mail-correct-loading">Loading…</p>
      ) : props.loadError ? (
        <p className="mail-correct-field-error" role="alert" data-testid="mail-correct-load-error">
          {props.loadError}{' '}
          <button type="button" className="mail-correct-link" onClick={props.onRetryLoad}>Try again</button>
        </p>
      ) : (
        <div className="mail-correct-choices" role="radiogroup" aria-labelledby={titleId}>
          {props.modelState !== 'none' && (
            <div className="mail-correct-model-cell" data-testid="mail-correct-model-cell" data-state={modelOption ? 'ok' : props.modelState}>
              {modelOption ? (
                <OptionRow {...props} option={modelOption} name={name} />
              ) : props.modelState === 'pending' ? (
                <p className="mail-correct-model-wait" data-testid="mail-correct-model-wait" aria-live="polite">
                  <span className="mail-correct-spinner" aria-hidden="true" />
                  {COPY.reading}
                </p>
              ) : props.modelSentence ? (
                <p className="mail-correct-model-failed" data-testid="mail-correct-model-failed">{props.modelSentence}</p>
              ) : null}
            </div>
          )}
          {local.map((option) => <OptionRow key={option.key} {...props} option={option} name={name} />)}
        </div>
      )}
      {props.recipientsLine && !props.loading && (
        <p className="mail-correct-recipients" data-testid="mail-correct-recipients">{props.recipientsLine}</p>
      )}
      {error && (
        <p className="mail-correct-field-error" role="alert" data-testid="mail-correct-save-error" data-kind={error.kind}>
          {error.message}
          {error.kind === 'changed' && (
            <>{' '}<button type="button" className="mail-correct-link" data-testid="mail-correct-reload" onClick={props.onReload}>Reload</button></>
          )}
          {error.kind === 'network' && (
            <>{' '}<button type="button" className="mail-correct-link" data-testid="mail-correct-try-again" onClick={props.onSave}>Try again</button></>
          )}
        </p>
      )}
      <div className="mail-correct-actions">
        <button type="button" className="btn btn-sm" onClick={props.onBack} disabled={props.saving} data-testid="mail-correct-back">Back</button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={props.saving || props.loading || !props.selectedKey || error?.kind === 'changed'}
          onClick={props.onSave}
          data-testid="mail-correct-save"
        >
          {props.saving ? 'Saving…' : 'Save rule'}
        </button>
      </div>
    </div>
  );
}
