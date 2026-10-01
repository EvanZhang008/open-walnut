/**
 * The two lists of Settings > Mail rules: the person's rules (first match wins), and the read-only
 * built-in rules under them.
 *
 * Moves re-order on screen at once (the save queue folds a burst into one write) and focus FOLLOWS the
 * moved row: the same button on the row that moved, not the button now sitting where it was, and a
 * short `Moved` is announced beside it (C63).
 */
import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import type { MailRuleView } from '@/api/mail-groups';
import { SettingsButton } from '../inputs/SettingsButton';
import { InlineConfirmButton } from '../inputs/InlineConfirmButton';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { COPY, provenanceLine } from './mail-rules-model';

export interface MoveFocus { list: 'rule'; key: string; dir: 'up' | 'down'; at: number }

function ArrowIcon({ dir }: { dir: 'up' | 'down' }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false" data-icon={`arrow-${dir}`}>
      <path d={dir === 'up' ? 'M6 2.5 2.5 6.5h7z' : 'M6 9.5 2.5 5.5h7z'} fill="currentColor" />
    </svg>
  );
}

function MoveButtons({ name, index, count, disabled, onMove }: {
  name: string; index: number; count: number; disabled: boolean; onMove: (delta: -1 | 1) => void;
}) {
  return (
    <span className="mail-rules-move">
      <button type="button" className="mail-rules-icon-btn" data-move="up" aria-label={`Move up ${name}`}
        disabled={disabled || index === 0} onClick={() => onMove(-1)}>
        <ArrowIcon dir="up" />
      </button>
      <button type="button" className="mail-rules-icon-btn" data-move="down" aria-label={`Move down ${name}`}
        disabled={disabled || index === count - 1} onClick={() => onMove(1)}>
        <ArrowIcon dir="down" />
      </button>
    </span>
  );
}

function MovedNote({ show }: { show: boolean }) {
  return <span className="mail-rules-moved" aria-live="polite" data-testid="mail-rules-moved">{show ? 'Moved' : ''}</span>;
}

/** After a move, focus the moved row's same button (or its other one at an end of the list). */
function useFollowFocus(root: RefObject<HTMLElement | null>, focus: MoveFocus | null): void {
  useLayoutEffect(() => {
    if (!focus || !root.current) return;
    const attr = 'data-rule-id';
    const row = [...root.current.querySelectorAll<HTMLElement>(`[${attr}]`)].find((one) => one.getAttribute(attr) === focus.key);
    if (!row) return;
    const same = row.querySelector<HTMLButtonElement>(`button[data-move="${focus.dir}"]`);
    const other = row.querySelector<HTMLButtonElement>(`button[data-move="${focus.dir === 'up' ? 'down' : 'up'}"]`);
    const target = same && !same.disabled ? same : other;
    target?.focus({ preventScroll: false });
  }, [root, focus]);
}

export interface RulesListProps {
  rules: MailRuleView[];
  disabled: boolean;
  disabledTitle?: string;
  focus: MoveFocus | null;
  movedKey: string | null;
  flashKey: string | null;
  editingId: string | null;
  onMove: (index: number, delta: -1 | 1) => void;
  onToggle: (index: number, enabled: boolean) => void;
  onEdit: (index: number) => void;
  onDelete: (index: number) => void;
  renderEditor: (index: number) => ReactNode;
}

export function MailRulesRulesList(props: RulesListProps) {
  const root = useRef<HTMLOListElement>(null);
  useFollowFocus(root, props.focus?.list === 'rule' ? props.focus : null);
  if (props.rules.length === 0 && !props.editingId) {
    return <p className="mail-rules-empty" data-testid="mail-rules-empty">{COPY.empty}</p>;
  }
  return (
    <ol className="mail-rules-rules" ref={root}>
      {props.rules.map((rule, index) => {
        const editing = props.editingId === rule.id;
        const on = rule.enabled !== false;
        return (
          <li key={rule.id} className="mail-rule-row" data-testid="mail-rule-row" data-rule-id={rule.id}
            data-enabled={on ? 'true' : 'false'} data-flash={props.flashKey === rule.id ? 'true' : undefined}>
            <div className="mail-rule-line">
              <MoveButtons name={rule.summary} index={index} count={props.rules.length} disabled={props.disabled || editing}
                onMove={(delta) => props.onMove(index, delta)} />
              <div className="mail-rule-copy">
                <span className="mail-rule-summary" data-testid="mail-rule-summary">
                  {rule.summary}
                  {rule.skipInbox && <span className="mail-rule-skip-badge" data-testid="mail-rule-skip-badge">· Skips the Inbox</span>}
                </span>
                <span className="mail-rule-provenance" data-testid="mail-rule-provenance">{provenanceLine(rule)}</span>
              </div>
              <MovedNote show={props.movedKey === rule.id} />
              <span className="mail-rule-actions" title={props.disabled ? props.disabledTitle : undefined}>
                <ToggleSwitch checked={on} disabled={props.disabled || editing} aria-label={`Use rule ${rule.summary}`}
                  data-testid="mail-rule-toggle" onChange={(value) => props.onToggle(index, value)} />
                <SettingsButton variant="text" disabled={props.disabled || editing} data-testid="mail-rule-edit" onClick={() => props.onEdit(index)}>
                  Edit
                </SettingsButton>
                <InlineConfirmButton label="Delete" confirmLabel="Delete rule?" aria-label={`Delete rule ${rule.summary}`}
                  disabled={props.disabled || editing} data-testid="mail-rule-delete" onConfirm={() => props.onDelete(index)} />
              </span>
            </div>
            {editing && props.renderEditor(index)}
          </li>
        );
      })}
    </ol>
  );
}

export function MailRulesBuiltinList({ builtins }: { builtins: Array<{ id: string; summary: string; then: string }> }) {
  return (
    <ol className="mail-rules-builtins" data-testid="mail-rules-builtins">
      {builtins.map((one) => (
        <li key={one.id} className="mail-rules-builtin" data-testid="mail-rules-builtin" data-builtin-id={one.id}>
          <span className="mail-rule-summary">{one.summary}</span>
          <span className="mail-rule-provenance">{COPY.builtinNote}</span>
        </li>
      ))}
    </ol>
  );
}
