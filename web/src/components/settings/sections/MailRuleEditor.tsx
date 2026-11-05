/**
 * The inline rule editor of Settings > Mail rules (spec 12): condition rows (field, value, remove),
 * where the mail goes, an optional note, and a live preview over every inbox.
 *
 * Pickers are custom portalled lists placed by `useMenuPlacement`, never a native `<select>` (web/src/
 * AGENTS.md, menus): the portal stops pointerdown, and the outside closer ignores its own list.
 *
 * A condition being typed is judged once typing pauses (SETTLE_MS) or its field loses focus: an
 * unfinished pattern (`(?`, `[a`, `\`) is not shown as an error on every keystroke. Until then no
 * preview is sent and Save is off, as it is while a problem shows. The preview then goes out
 * (at least 400 ms after the last change), never while the rows have a problem Walnut can already
 * see (a subject pattern the server would refuse is refused here, in its words). From the moment a
 * condition changes, the old count is gone: "Checking…" holds its place while the input waits to be
 * judged (Save off), "Counting mails…" once it passed and its count is on its way (Save on), and an
 * answer for an older input never shows. A rule that is off because
 * its own stored pattern is too big keeps that pattern through an edit of anything else: the
 * editor says once, calmly, that it stays off until the pattern is made smaller (the row's own
 * line is hidden meanwhile), and nothing is previewed for it; a changed pattern is judged as new,
 * and once it passes the editor says that saving turns the rule on. A rule the user switched off
 * stays off through a save, and its preview says so. Under a pattern that runs, a hint says when
 * the rule would not do what it seems to (in the warning colour), with a button that rewrites the
 * pattern where one fix is plain; the preview lists up to five of the mails it matches on request.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  previewMailRule,
  type MailCatalogItem,
  type MailPreviewResponse,
  type MailRule,
  type MailRuleValidationError,
  type MailSample,
} from '@/api/mail-groups';
import type { MailAccountDto } from '@/api/mail';
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement';
import { useDraftValue } from '@/hooks/useDraft';
import { draftHash, draftKey } from '@/utils/drafts';
import { SettingsButton } from '../inputs/SettingsButton';
import { MicField, type BoxMicHandle } from '@/components/common/BoxMic';
import { useSendAfterDictation, dictationWaitProps } from '@/hooks/useSendAfterDictation';
import '@/styles/settings-mic.css';
import {
  FIELD_LABELS,
  FIELD_ORDER,
  SENDER_KINDS,
  defaultValueOf,
  existingGroupLine,
  fieldOfError,
  heldPatternOf,
  previewSentence,
  rowsOfWhen,
  TEXT_FIELDS,
  whenOfRows,
  type ConditionField,
  type ConditionRow,
} from './mail-rules-model';

export const PREVIEW_DEBOUNCE_MS = 400;
const PLACEHOLDERS: Partial<Record<ConditionField, string>> = {
  from: 'issues@*, Survey Desk',
  subject: 'invoice',
  subjectRe: 'invoice #\\d+',
  group: 'Ticket updates',
};
/** Under an empty or fine subject pattern: what the field takes, in one line. */
export const PATTERN_HELP = 'A regular expression; case is ignored.';
/** Under a text condition that holds only spaces. */
export const SPACES_ONLY = 'Spaces alone count as empty.';
/** Under a rule's own pattern Walnut kept off, once it was replaced by one Walnut runs. */
export const TURNS_ON = 'Saving turns this rule on.';
/** How long typing in a condition pauses before it is judged. */
export const SETTLE_MS = 600;
const NEW_GROUP = '__new-group__';

export interface PickerOption { value: string; label: string; hint?: string }

export function MailRulesPicker({ value, options, onChange, ariaLabel, testId, disabled }: {
  value: string;
  options: PickerOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  testId?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const placement = useMenuPlacement(open, trigger, list, { align: 'start', minHeight: 120, onAnchorLost: () => setOpen(false) });
  const current = options.find((one) => one.value === value);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const node = event.target as Node | null;
      if (node && (list.current?.contains(node) || trigger.current?.contains(node))) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    list.current?.querySelector<HTMLElement>('[aria-selected="true"], [role="option"]')?.focus();
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  const pick = (next: string) => { onChange(next); setOpen(false); trigger.current?.focus(); };
  const onListKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...(list.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[Math.max(0, Math.min(items.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  };
  return (
    <>
      <button ref={trigger} type="button" className="mail-rules-picker" aria-haspopup="listbox" aria-expanded={open}
        aria-controls={open ? listId : undefined} aria-label={`${ariaLabel}: ${current?.label ?? value}`}
        data-testid={testId} data-value={value} disabled={disabled} onClick={() => setOpen((was) => !was)}>
        <span className="mail-rules-picker-label">{current?.label ?? value}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
      </button>
      {open && createPortal(
        <div ref={list} id={listId} role="listbox" aria-label={ariaLabel} className="mail-rules-picker-list"
          data-testid={testId ? `${testId}-list` : undefined} style={menuPlacementStyle(placement)}
          onPointerDown={(event) => event.stopPropagation()} onKeyDown={onListKey}>
          {options.map((one) => (
            <button key={one.value} type="button" role="option" aria-selected={one.value === value}
              className="mail-rules-picker-option" data-value={one.value} onClick={() => pick(one.value)}>
              <span>{one.label}</span>
              {one.hint && <span className="mail-rules-picker-hint">{one.hint}</span>}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

export interface MailRuleEditorProps {
  initial: MailRule | null;
  catalog: MailCatalogItem[];
  accounts: MailAccountDto[];
  serverErrors: MailRuleValidationError[];
  saving: boolean;
  onSave: (rule: Omit<MailRule, 'id' | 'source' | 'created'> & { newGroup?: string }) => void;
  onCancel: () => void;
  onDirty: (dirty: boolean) => void;
}

interface RuleForm { rows: ConditionRow[]; then: string; newGroup: string; note: string; skipInbox: boolean }

/** The form for a rule as stored (or a new one). Row keys count from 1, so the same rule gives the same form. */
function formOf(initial: MailRule | null): RuleForm {
  let seq = 0;
  const next = () => { seq += 1; return seq; };
  return {
    rows: initial ? rowsOfWhen(initial.when, next) : [{ key: next(), field: 'from', value: '' }],
    then: initial?.then ?? 'Important',
    newGroup: '',
    note: initial?.note ?? '',
    skipInbox: initial?.skipInbox === true,
  };
}

/** The draft of the editor for `rule` (null: a new rule). A rule with no id is
 *  told apart by its stored content, so two id-less rules never share a draft. */
export function mailRuleDraftKey(rule: MailRule | null | undefined): string {
  if (!rule) return draftKey('mail-rule', 'new');
  return rule.id ? draftKey('mail-rule', rule.id) : draftKey('mail-rule', 'stored', draftHash(JSON.stringify(rule)));
}

export function MailRuleEditor(props: MailRuleEditorProps) {
  // The rule being edited and not saved is kept in the draft store: closing the editor by
  // leaving the pane or reloading keeps it; Save (once it landed) and Cancel end it.
  const form = useDraftValue<RuleForm>(mailRuleDraftKey(props.initial), formOf(props.initial));
  const { rows, then, newGroup, note, skipInbox } = form.value;
  const nextKeyOf = (prev: ConditionRow[]) => prev.reduce((max, one) => Math.max(max, one.key), 0) + 1;
  const setRows = (next: (prev: ConditionRow[]) => ConditionRow[]) => form.setValue((f) => ({ ...f, rows: next(f.rows) }));
  const setThen = (value: string) => form.setValue((f) => ({ ...f, then: value }));
  const setNewGroup = (value: string) => form.setValue((f) => ({ ...f, newGroup: value }));
  const setNote = (value: string) => form.setValue((f) => ({ ...f, note: value }));
  const setSkipInbox = (value: boolean) => form.setValue((f) => ({ ...f, skipInbox: value }));
  // The last answer, with the input it answers: it shows only while that is still the input.
  const [preview, setPreview] = useState<{ key: string; text: string; samples?: MailSample[]; error?: string } | null>(null);
  // The matching mails under the preview line, once asked for; they stay listed while the rule changes.
  const [samplesOn, setSamplesOn] = useState(false);
  const userOff = props.initial?.enabled === false;
  const noteId = useId();
  const noteRef = useRef<HTMLInputElement | null>(null);
  const noteMic = useRef<BoxMicHandle | null>(null);
  const dirtyRef = useRef(false);
  const lastEditAt = useRef(0);
  const markDirty = () => {
    lastEditAt.current = Date.now();
    if (!dirtyRef.current) { dirtyRef.current = true; props.onDirty(true); }
  };
  // A kept draft is an edit in progress from the first render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (form.dirty) markDirty(); }, []);
  // A save that went through ends the draft in the section (MailRulesSection.saveEdited).

  // Important and Not important first (the catalog lists them first), then every group; a rule's own
  // target stays offered even when no unread mail is in that group today.
  const targets: PickerOption[] = useMemo(() => {
    const out: PickerOption[] = props.catalog.map((one) => ({ value: one.label, label: one.label }));
    const then = props.initial?.then;
    if (then && !out.some((one) => one.value.toLowerCase() === then.toLowerCase())) out.push({ value: then, label: then });
    out.push({ value: NEW_GROUP, label: 'New group…' });
    return out;
  }, [props.catalog, props.initial]);
  const accountOptions: PickerOption[] = props.accounts.map((one) => ({
    value: one.accountId, label: one.displayName || one.address, ...(one.displayName ? { hint: one.address } : {}),
  }));
  const fieldOptions: PickerOption[] = FIELD_ORDER.map((field) => ({ value: field, label: FIELD_LABELS[field] }));
  const target = then === NEW_GROUP ? newGroup.trim() : then;
  // Keep out of the Inbox needs a group to show the mail in when a move fails (the server refuses it otherwise).
  const reservedTarget = /^(important|not important)$/i.test(target);
  // Compiling a subject pattern is not free: once per change of the rows, never per render.
  const held = useMemo(() => heldPatternOf(props.initial), [props.initial]);
  const { when, problems, off, hints, turnsOn } = useMemo(() => whenOfRows(rows, held), [rows, held]);
  // A blank text condition: nothing to judge or count until something is typed.
  const blank = rows.some((row) => TEXT_FIELDS.has(row.field) && !row.value.trim());

  // Typed rows are judged once typing pauses or the field is left; a picker's change at once.
  const rowsKey = JSON.stringify(rows);
  const [settledKey, setSettledKey] = useState(rowsKey);
  const typedRef = useRef(false);
  const pending = rowsKey !== settledKey;
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setSettledKey(rowsKey), typedRef.current ? SETTLE_MS : 0);
    return () => clearTimeout(timer);
  }, [rowsKey, pending]);
  const settleNow = () => setSettledKey(rowsKey);

  // The live preview, over every inbox: never while typing, with a local problem, or for a rule off.
  // `when` is compared by its JSON, so an unchanged rule does not preview twice.
  const previewKey = `${JSON.stringify(when)}\n${target}`;
  const previewWanted = problems.size === 0 && off.size === 0 && !!target;
  useEffect(() => {
    if (pending || !previewWanted) return;
    const control = new AbortController();
    const key = previewKey;
    const wait = Math.max(0, PREVIEW_DEBOUNCE_MS - (Date.now() - lastEditAt.current));
    const timer = setTimeout(() => {
      previewMailRule({ scope: { role: 'inbox' }, when, then: target }, control.signal).then(
        (answer) => { if (!control.signal.aborted) setPreview({ key, text: previewSentence(answer, userOff), samples: answer.samples }); },
        (error: unknown) => {
          if (control.signal.aborted) return;
          const body = (error as { body?: { message?: unknown; errors?: Array<{ message?: unknown }> } })?.body;
          const said = body?.errors?.[0]?.message ?? body?.message;
          setPreview({ key, text: '', error: typeof said === 'string' ? said : 'Walnut could not count the matching mail.' });
        },
      );
    }, wait);
    return () => { clearTimeout(timer); control.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, pending, previewWanted]);
  // An answer shows only for the input it was asked for (a late one for an older input never does);
  // from the moment a condition changes until its answer comes, a neutral line holds the place.
  const answer = !pending && preview?.key === previewKey ? preview : null;
  const checking = !answer && (pending || previewWanted);
  const samples = !answer?.error ? (answer?.samples ?? []).slice(0, 5) : [];
  const typedGroup = then === NEW_GROUP ? newGroup.trim() : '';
  const existingGroup = typedGroup && !reservedTarget
    ? targets.find((one) => one.value !== NEW_GROUP && one.value.toLowerCase() === typedGroup.toLowerCase())?.label
    : undefined;

  const errorFor = (field: ConditionField | 'then' | 'note'): string | undefined =>
    props.serverErrors.find((one) => fieldOfError(one.field) === field)?.message;
  const otherErrors = props.serverErrors.filter((one) => fieldOfError(one.field) === null);
  const setRow = (key: number, patch: Partial<ConditionRow>, typed = false) => {
    markDirty();
    typedRef.current = typed;
    setRows((prev) => prev.map((one) => (one.key === key ? { ...one, ...patch } : one)));
  };
  const canSave = problems.size === 0 && !!target && !props.saving;
  const [attempted, setAttempted] = useState(false);
  const shown = (row: ConditionRow): boolean => !pending && (attempted || row.value.trim() !== '');
  const rowProblem = (row: ConditionRow): string | undefined => {
    const local = problems.get(row.key);
    if (local) return shown(row) ? local : undefined;
    return errorFor(row.field);
  };
  // Save is off while a typed condition waits to be judged and from the moment a problem shows.
  const problemShown = rows.some((row) => problems.has(row.key) && shown(row)) || (attempted && problems.has(-1));
  // A blank text condition holds Save too: there is nothing to save yet, and the placeholder shows what goes there.
  const saveOff = props.saving || pending || problemShown || blank || (attempted && !canSave);

  const valueControl = (row: ConditionRow) => {
    const label = `${FIELD_LABELS[row.field]} value`;
    if (row.field === 'addressedToMe') {
      return <MailRulesPicker ariaLabel={label} value={row.value} testId="mail-rule-value"
        options={[{ value: 'true', label: 'Yes, to me directly' }, { value: 'false', label: 'No, to a group or list' }]}
        onChange={(value) => setRow(row.key, { value })} />;
    }
    if (row.field === 'sender') {
      return <MailRulesPicker ariaLabel={label} value={row.value} testId="mail-rule-value"
        options={SENDER_KINDS.map((kind) => ({ value: kind, label: kind[0]!.toUpperCase() + kind.slice(1) }))}
        onChange={(value) => setRow(row.key, { value })} />;
    }
    if (row.field === 'account') {
      return <MailRulesPicker ariaLabel={label} value={row.value} testId="mail-rule-value" options={accountOptions}
        onChange={(value) => setRow(row.key, { value })} />;
    }
    if (row.field === 'cc') return <span className="mail-rules-help">Not available for Outlook accounts</span>;
    return (
      <input type="text" className="settings-input mail-rule-value-input" aria-label={label} data-testid="mail-rule-value" data-draft-key={form.key ?? undefined}
        value={row.value} placeholder={PLACEHOLDERS[row.field] ?? ''} spellCheck={row.field === 'subjectRe' ? false : undefined}
        onChange={(event) => setRow(row.key, { value: event.target.value }, true)} onBlur={settleNow} />
    );
  };

  const save = () => {
    setAttempted(true);
    if (!canSave) return;
    const trimmed = note.trim();
    noteMic.current?.clear();
    props.onSave({
      when,
      then: target,
      ...(trimmed ? { note } : {}),
      ...(props.initial?.enabled === false ? { enabled: false } : {}),
      ...(props.initial?.label ? { label: props.initial.label } : {}),
      ...(skipInbox && !reservedTarget ? { skipInbox: true } : {}),
      ...(then === NEW_GROUP ? { newGroup: target } : {}),
    });
  };
  // Save while the note's mic records waits for the final words, then saves.
  const saveGate = useSendAfterDictation([noteMic], save);
  // Enter in any text box of the editor saves, as the Save button would: what was typed is judged
  // at once (no wait for the pause), and nothing is saved while it has a problem.
  const onEditorKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const box = event.target;
    if (!(box instanceof HTMLInputElement) || box.type !== 'text') return;
    event.preventDefault();
    settleNow();
    if (canSave) saveGate.send();
  };

  return (
    <div className="mail-rule-editor" data-testid="mail-rule-editor" onKeyDown={onEditorKey}>
      <div className="mail-rule-editor-head">When</div>
      <ul className="mail-rule-conditions">
        {rows.map((row) => {
          const problem = rowProblem(row);
          // One line under a row at most: its problem, else why it stays off, else a hint, else that
          // saving turns the rule on, else help. Spaces alone say so at once.
          const offLine = problem ? undefined : off.get(row.key);
          const hint = problem || offLine || pending ? undefined : hints.get(row.key);
          const spacesOnly = !problem && TEXT_FIELDS.has(row.field) && row.value !== '' && !row.value.trim();
          const turnOn = !problem && !offLine && !hint && !pending && !userOff && turnsOn.has(row.key);
          const help = !problem && !offLine && !hint && !turnOn && row.field === 'subjectRe' ? PATTERN_HELP : undefined;
          return (
            <li key={row.key} className="mail-rule-condition" data-testid="mail-rule-condition" data-field={row.field}>
              <MailRulesPicker ariaLabel="Condition" value={row.field} options={fieldOptions} testId="mail-rule-field"
                onChange={(picked) => {
                  const field = picked as ConditionField;
                  // From one text box to another (Subject contains to Subject pattern, say), what was typed stays.
                  const keep = TEXT_FIELDS.has(row.field) && TEXT_FIELDS.has(field);
                  setRow(row.key, { field, value: keep ? row.value : defaultValueOf(field) });
                }} />
              {valueControl(row)}
              <button type="button" className="mail-rules-icon-btn" aria-label={`Remove condition ${FIELD_LABELS[row.field]}`}
                data-testid="mail-rule-remove-condition" onClick={() => { markDirty(); typedRef.current = false; setRows((prev) => prev.filter((one) => one.key !== row.key)); }}>
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" /></svg>
              </button>
              {problem && <p className="mail-rule-field-error" role="alert" data-testid="mail-rule-field-error">{problem}</p>}
              {offLine && <p className="mail-rule-off" data-testid="mail-rule-field-off">{offLine}</p>}
              {hint && (
                <p className="mail-rule-hint" data-warn={hint.warn ? 'true' : undefined} data-testid="mail-rule-field-hint">
                  {hint.text}
                  {hint.fix && (
                    <button type="button" className="mail-rule-hint-fix" data-testid="mail-rule-hint-fix"
                      onClick={() => setRow(row.key, { value: hint.fix!.pattern })}>{hint.fix.label}</button>
                  )}
                </p>
              )}
              {spacesOnly && <p className="mail-rule-help" data-testid="mail-rule-field-spaces">{SPACES_ONLY}</p>}
              {!spacesOnly && turnOn && <p className="mail-rule-help" data-testid="mail-rule-field-turns-on">{TURNS_ON}</p>}
              {!spacesOnly && help && <p className="mail-rule-help" data-testid="mail-rule-field-help">{help}</p>}
            </li>
          );
        })}
      </ul>
      {attempted && problems.get(-1) && <p className="mail-rule-field-error" role="alert">{problems.get(-1)}</p>}
      <SettingsButton variant="text" className="mail-rule-add-condition" data-testid="mail-rule-add-condition"
        onClick={() => { markDirty(); typedRef.current = false; setRows((prev) => [...prev, { key: nextKeyOf(prev), field: 'subject', value: '' }]); }}>
        + Add condition
      </SettingsButton>
      <div className="mail-rule-editor-head">Then</div>
      <div className="mail-rule-then">
        <MailRulesPicker ariaLabel="Goes to" value={then} options={targets} testId="mail-rule-then"
          onChange={(value) => { markDirty(); setThen(value); }} />
        {then === NEW_GROUP && (
          <input type="text" className="settings-input" aria-label="New group name" maxLength={40} value={newGroup} data-draft-key={form.key ?? undefined}
            data-testid="mail-rule-new-group" onChange={(event) => { markDirty(); setNewGroup(event.target.value); }} />
        )}
      </div>
      {errorFor('then') && <p className="mail-rule-field-error" role="alert">{errorFor('then')}</p>}
      {existingGroup && <p className="mail-rule-help" data-testid="mail-rule-group-exists">{existingGroupLine(existingGroup)}</p>}
      <label className="mail-rule-skip-inbox" data-testid="mail-rule-skip-inbox">
        <input type="checkbox" checked={skipInbox && !reservedTarget} disabled={reservedTarget}
          onChange={(event) => { markDirty(); setSkipInbox(event.target.checked); }} />
        <span>Keep out of the Inbox: Walnut moves this mail to Archive as it arrives</span>
      </label>
      <label className="mail-rule-editor-head" htmlFor={noteId}>Note</label>
      <MicField inline fieldClassName="settings-mic-field" boxRef={noteRef} text={note} handleRef={noteMic} disabled={props.saving}
        setText={(t) => { markDirty(); setNote(t.slice(0, 300)); }}>
        <input ref={noteRef} id={noteId} type="text" className="settings-input" maxLength={300} value={note} data-testid="mail-rule-note" data-draft-key={form.key ?? undefined}
          placeholder="Optional: why this rule exists" onChange={(event) => { markDirty(); setNote(event.target.value); }} />
      </MicField>
      {otherErrors.map((one, index) => <p key={index} className="mail-rule-field-error" role="alert">{one.message}</p>)}
      <p className="mail-rule-preview" data-testid="mail-rule-preview" aria-live="polite" data-state={answer ? 'answer' : checking && !blank ? 'checking' : 'none'}>
        {answer?.error ? <span className="mail-rule-field-error">{answer.error}</span> : answer ? answer.text : blank ? '' : pending ? 'Checking…' : checking ? 'Counting mails…' : ''}
        {samples.length > 0 && (
          <>
            <span aria-hidden="true">{' \u00b7 '}</span>
            <button type="button" className="mail-rule-hint-fix mail-rule-samples-toggle" aria-expanded={samplesOn} data-testid="mail-rule-samples"
              onClick={() => setSamplesOn((on) => !on)}>
              {samplesOn ? 'Hide them' : `Show ${samples.length === 1 ? 'it' : samples.length}`}
            </button>
          </>
        )}
      </p>
      {samplesOn && samples.length > 0 && (
        <ul className="mail-rule-samples" data-testid="mail-rule-sample-list">
          {samples.map((one) => (
            <li key={`${one.accountId}/${one.messageId}`} className="mail-rule-sample" data-testid="mail-rule-sample">
              <span className="mail-rule-sample-sender">{one.sender}</span>
              <span className="mail-rule-sample-subject">{one.subject || '(no subject)'}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mail-rule-editor-actions">
        <SettingsButton onClick={() => { form.clear(); props.onCancel(); }} data-testid="mail-rule-cancel" disabled={props.saving}>Cancel</SettingsButton>
        <SettingsButton variant="primary" onClick={saveGate.send} busy={props.saving} busyLabel="Saving…" data-testid="mail-rule-save"
          disabled={saveOff} {...dictationWaitProps(saveGate)}>
          Save
        </SettingsButton>
      </div>
    </div>
  );
}
