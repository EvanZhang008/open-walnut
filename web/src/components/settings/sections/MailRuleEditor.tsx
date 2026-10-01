/**
 * The inline rule editor of Settings > Mail rules (spec 12): condition rows (field, value, remove),
 * where the mail goes, an optional note, and a live preview over every inbox.
 *
 * Pickers are custom portalled lists placed by `useMenuPlacement`, never a native `<select>` (web/src/
 * AGENTS.md, menus): the portal stops pointerdown, and the outside closer ignores its own list. The
 * preview waits 400 ms after the last keystroke and is not sent at all while the rows have a problem
 * Walnut can already see (a pattern that could run for ever never reaches the server's matcher).
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  previewMailRule,
  type MailCatalogItem,
  type MailPreviewResponse,
  type MailRule,
  type MailRuleValidationError,
} from '@/api/mail-groups';
import type { MailAccountDto } from '@/api/mail';
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement';
import { SettingsButton } from '../inputs/SettingsButton';
import {
  FIELD_LABELS,
  FIELD_ORDER,
  SENDER_KINDS,
  defaultValueOf,
  fieldOfError,
  rowsOfWhen,
  whenOfRows,
  type ConditionField,
  type ConditionRow,
} from './mail-rules-model';

export const PREVIEW_DEBOUNCE_MS = 400;
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

function previewSentence(answer: MailPreviewResponse): string {
  const n = answer.matches;
  const head = `Matches ${answer.partial ? 'at least ' : ''}${n.toLocaleString('en-US')} ${n === 1 ? 'mail' : 'mails'}`;
  return answer.moves < answer.matches ? `${head} · moves ${answer.moves.toLocaleString('en-US')}` : head;
}

export function MailRuleEditor(props: MailRuleEditorProps) {
  const keySeq = useRef(0);
  const nextKey = () => { keySeq.current += 1; return keySeq.current; };
  const [rows, setRows] = useState<ConditionRow[]>(() => (props.initial ? rowsOfWhen(props.initial.when, nextKey) : [{ key: nextKey(), field: 'from', value: '' }]));
  const [then, setThen] = useState(props.initial?.then ?? 'Important');
  const [newGroup, setNewGroup] = useState('');
  const [note, setNote] = useState(props.initial?.note ?? '');
  const [skipInbox, setSkipInbox] = useState(props.initial?.skipInbox === true);
  const [preview, setPreview] = useState<{ text: string; error?: string } | null>(null);
  const noteId = useId();
  const dirtyRef = useRef(false);
  const markDirty = () => { if (!dirtyRef.current) { dirtyRef.current = true; props.onDirty(true); } };

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
  const { when, problems } = whenOfRows(rows);

  // The live preview: 400 ms after the last change, over every inbox, never with a local problem.
  const whenKey = JSON.stringify(when);
  useEffect(() => {
    if (problems.size > 0 || !target) { setPreview(null); return; }
    const control = new AbortController();
    const timer = setTimeout(() => {
      previewMailRule({ scope: { role: 'inbox' }, when, then: target }, control.signal).then(
        (answer) => setPreview({ text: previewSentence(answer) }),
        (error: unknown) => {
          if (control.signal.aborted) return;
          const body = (error as { body?: { message?: unknown; errors?: Array<{ message?: unknown }> } })?.body;
          const said = body?.errors?.[0]?.message ?? body?.message;
          setPreview({ text: '', error: typeof said === 'string' ? said : 'Walnut could not count the matching mail.' });
        },
      );
    }, PREVIEW_DEBOUNCE_MS);
    return () => { clearTimeout(timer); control.abort(); };
    // `when` is compared by its JSON, so an unchanged rule does not preview twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whenKey, target, problems.size]);

  const errorFor = (field: ConditionField | 'then' | 'note'): string | undefined =>
    props.serverErrors.find((one) => fieldOfError(one.field) === field)?.message;
  const otherErrors = props.serverErrors.filter((one) => fieldOfError(one.field) === null);
  const setRow = (key: number, patch: Partial<ConditionRow>) => {
    markDirty();
    setRows((prev) => prev.map((one) => (one.key === key ? { ...one, ...patch } : one)));
  };
  const canSave = problems.size === 0 && !!target && !props.saving;
  const [attempted, setAttempted] = useState(false);
  const rowProblem = (row: ConditionRow): string | undefined => {
    const local = problems.get(row.key);
    if (local && (attempted || row.value.trim() !== '')) return local;
    return errorFor(row.field);
  };

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
      <input type="text" className="settings-input mail-rule-value-input" aria-label={label} data-testid="mail-rule-value"
        value={row.value} placeholder={row.field === 'from' ? 'issues@*, Survey Desk' : row.field === 'group' ? 'Ticket updates' : ''}
        onChange={(event) => setRow(row.key, { value: event.target.value })} />
    );
  };

  const save = () => {
    setAttempted(true);
    if (!canSave) return;
    const trimmed = note.trim();
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

  return (
    <div className="mail-rule-editor" data-testid="mail-rule-editor">
      <div className="mail-rule-editor-head">When</div>
      <ul className="mail-rule-conditions">
        {rows.map((row) => {
          const problem = rowProblem(row);
          return (
            <li key={row.key} className="mail-rule-condition" data-testid="mail-rule-condition" data-field={row.field}>
              <MailRulesPicker ariaLabel="Condition" value={row.field} options={fieldOptions} testId="mail-rule-field"
                onChange={(field) => setRow(row.key, { field: field as ConditionField, value: defaultValueOf(field as ConditionField) })} />
              {valueControl(row)}
              <button type="button" className="mail-rules-icon-btn" aria-label={`Remove condition ${FIELD_LABELS[row.field]}`}
                data-testid="mail-rule-remove-condition" onClick={() => { markDirty(); setRows((prev) => prev.filter((one) => one.key !== row.key)); }}>
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" /></svg>
              </button>
              {problem && <p className="mail-rule-field-error" role="alert" data-testid="mail-rule-field-error">{problem}</p>}
            </li>
          );
        })}
      </ul>
      {attempted && problems.get(-1) && <p className="mail-rule-field-error" role="alert">{problems.get(-1)}</p>}
      <SettingsButton variant="text" data-testid="mail-rule-add-condition"
        onClick={() => { markDirty(); setRows((prev) => [...prev, { key: nextKey(), field: 'subject', value: '' }]); }}>
        + Add condition
      </SettingsButton>
      <div className="mail-rule-editor-head">Then</div>
      <div className="mail-rule-then">
        <MailRulesPicker ariaLabel="Goes to" value={then} options={targets} testId="mail-rule-then"
          onChange={(value) => { markDirty(); setThen(value); }} />
        {then === NEW_GROUP && (
          <input type="text" className="settings-input" aria-label="New group name" maxLength={40} value={newGroup}
            data-testid="mail-rule-new-group" onChange={(event) => { markDirty(); setNewGroup(event.target.value); }} />
        )}
      </div>
      {errorFor('then') && <p className="mail-rule-field-error" role="alert">{errorFor('then')}</p>}
      <label className="mail-rule-skip-inbox" data-testid="mail-rule-skip-inbox">
        <input type="checkbox" checked={skipInbox && !reservedTarget} disabled={reservedTarget}
          onChange={(event) => { markDirty(); setSkipInbox(event.target.checked); }} />
        <span>Keep out of the Inbox: Walnut moves this mail to Archive as it arrives</span>
      </label>
      <label className="mail-rule-editor-head" htmlFor={noteId}>Note</label>
      <input id={noteId} type="text" className="settings-input" maxLength={300} value={note} data-testid="mail-rule-note"
        placeholder="Optional: why this rule exists" onChange={(event) => { markDirty(); setNote(event.target.value); }} />
      {otherErrors.map((one, index) => <p key={index} className="mail-rule-field-error" role="alert">{one.message}</p>)}
      <p className="mail-rule-preview" data-testid="mail-rule-preview" aria-live="polite">
        {preview?.error ? <span className="mail-rule-field-error">{preview.error}</span> : preview?.text ?? ''}
      </p>
      <div className="mail-rule-editor-actions">
        <SettingsButton onClick={props.onCancel} data-testid="mail-rule-cancel" disabled={props.saving}>Cancel</SettingsButton>
        <SettingsButton variant="primary" onClick={save} busy={props.saving} busyLabel="Saving…" data-testid="mail-rule-save"
          disabled={props.saving || (attempted && !canSave)}>
          Save
        </SettingsButton>
      </div>
    </div>
  );
}
