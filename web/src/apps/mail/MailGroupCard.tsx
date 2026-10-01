/**
 * The three small cards a group's ⋯ menu opens, anchored on the group line:
 *
 * - `These are important…`: one sentence saying what will change, an optional `Why?`, Save. Save writes
 *   ONE learned rule, `when: { group: <name> }, then: Important`, with the note verbatim; the note also
 *   rides every later labeling prompt, which is how the correction teaches the model. Undo is in the
 *   status strip, as for every learned save.
 * - `Rename group`: the name, Save. The person's name wins over the model's from then on, and the model
 *   is told the new name so it keeps to it.
 * - `Keep out of Inbox…`: what will happen (new mail in the group is moved to Archive as it arrives,
 *   unread), `Also move the N unread in it now` (on by default), the one caveat that matters (Walnut
 *   does it while running), and the accounts it cannot move for. Save writes a `skipInbox` rule
 *   (mail-group-filter.ts).
 *
 * Nothing is written before Save. Placed by `useMenuPlacement` (never past the viewport), portalled,
 * `onPointerDown` stopped at the root, Esc closes and hands focus back to the group line.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getMailRules, putMailRules, renameMailGroup } from '@/api/mail-groups';
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement';
import { log } from '@/utils/log';
import {
  closeMailLearnRequest, pushMailListStatus, requestGroupsRefresh, type MailGroupCardRequest,
} from './mail-groups-bus';
import {
  FILTER_NOTE, FILTER_SAVE, RENAME_ARIA, RENAME_TITLE, WHY_LABEL, filterCannotMoveText, filterCardBody, filterCardTitle,
  filterMoveNowLabel, importantCardBody, importantCardTitle, importantSavedText, renamedText,
} from './mail-groups-copy';
import { saveGroupFilter } from './mail-group-filter';
import {
  MAX_NOTE, docOf, newRuleId, saveRefusalOf, todayIso, withLearnedRule,
} from './mail-correct-model';
import { pushLearnedUndo } from './MailCorrectPopover';
import './mail-learn.css';

/** The server's limit (sort-engine.ts `renameGroup`: the model's 32 plus a little room). */
export const MAX_RENAME = 40;

function messageOf(error: unknown): string {
  const body = (error as { body?: { message?: unknown } })?.body;
  if (body && typeof body.message === 'string') return body.message;
  return error instanceof Error ? error.message : String(error);
}

/** Save `These are important…`: the rule first in the file, re-read and retried once if the file moved. */
async function saveImportantRule(request: MailGroupCardRequest, note: string): Promise<void> {
  const id = newRuleId();
  const rule = { when: { group: request.label }, then: 'Important' };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await getMailRules();
    const doc = withLearnedRule(docOf(current), { rule, note, id, created: todayIso() });
    try {
      const saved = await putMailRules({ ...doc, baseRev: current.fileRev });
      pushLearnedUndo({
        statusId: `rule-saved:${id}`, viewKey: request.viewKey, text: importantSavedText(request.label),
        doc, fileRev: saved.fileRev, ruleIds: [id],
      });
      return;
    } catch (error) {
      if (attempt === 0 && saveRefusalOf(error).kind === 'changed') continue;
      throw error;
    }
  }
}

export function MailGroupCard({ request }: { request: MailGroupCardRequest }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLElement | null>(request.anchor);
  anchorRef.current = request.anchor;
  const fieldRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const titleId = useId();
  const fieldId = useId();
  const important = request.kind === 'group-important';
  const filter = request.kind === 'group-filter';
  const [text, setText] = useState(important || filter ? '' : request.label);
  const [moveNow, setMoveNow] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = useCallback((restoreFocus: boolean) => {
    closeMailLearnRequest();
    if (restoreFocus && request.anchor.isConnected) request.anchor.focus({ preventScroll: true });
  }, [request]);

  const placement = useMenuPlacement(true, anchorRef, cardRef, {
    align: 'start', edgeOverflow: 'clamp', gap: 4, minHeight: 160, onAnchorLost: () => close(false),
  });

  useEffect(() => {
    const field = fieldRef.current;
    field?.focus({ preventScroll: true });
    if (field instanceof HTMLInputElement) field.select();
  }, []);

  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const node = event.target as Element | null;
      if (saving || (node && typeof node.closest === 'function' && node.closest('.mail-group-card'))) return;
      close(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || saving) return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [close, saving]);

  const name = text.replace(/\s+/g, ' ').trim();
  const renameProblem = important || filter ? null
    : !name ? '' : name.length > MAX_RENAME ? `A group name is at most ${MAX_RENAME} characters.` : null;
  const unchanged = request.kind === 'rename' && name === request.label;

  const save = async () => {
    if (saving || renameProblem !== null || unchanged) return;
    setSaving(true);
    setError(null);
    try {
      if (important) {
        await saveImportantRule(request, text);
      } else if (filter) {
        await saveGroupFilter(request, moveNow);
      } else {
        const done = await renameMailGroup(request.groupId, name);
        pushMailListStatus({ id: `rename:${request.groupId}`, viewKey: request.viewKey, text: renamedText(done.label), tone: 'success', ttlMs: 6_000 });
      }
      requestGroupsRefresh();
      close(true);
    } catch (failure) {
      const refusal = saveRefusalOf(failure);
      const message = refusal.kind === 'network' ? messageOf(failure) : refusal.message;
      log.warn('mail', 'group card save failed', { kind: request.kind, groupId: request.groupId, error: message });
      setError(important || filter ? `Couldn't save: ${message.replace(/[.\s]+$/, '')}.` : message);
      setSaving(false);
    }
  };

  return createPortal(
    <div
      ref={cardRef}
      className="mail-correct mail-group-card"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-testid={important ? 'mail-group-important-card' : filter ? 'mail-group-filter-card' : 'mail-group-rename-card'}
      style={menuPlacementStyle(placement)}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="mail-correct-step">
        <p className="mail-correct-title" id={titleId}>
          {important ? importantCardTitle(request.label) : filter ? filterCardTitle(request.label) : RENAME_TITLE}
        </p>
        {filter ? (
          <>
            <p className="mail-group-card-body">{filterCardBody(request.label)}</p>
            {request.unread > 0 && (
              <label className="mail-group-card-check">
                <input
                  ref={(el) => { fieldRef.current = el; }}
                  type="checkbox"
                  data-testid="mail-group-filter-move-now"
                  checked={moveNow}
                  onChange={(event) => setMoveNow(event.target.checked)}
                />
                <span>{filterMoveNowLabel(request.unread)}</span>
              </label>
            )}
            {(request.cannotArchive?.length ?? 0) > 0 && (
              <p className="mail-group-card-note" data-testid="mail-group-filter-cannot">{filterCannotMoveText(request.cannotArchive!)}</p>
            )}
            <p className="mail-group-card-note">{FILTER_NOTE}</p>
          </>
        ) : important ? (
          <>
            <p className="mail-group-card-body">{importantCardBody(request.label)}</p>
            <label className="mail-correct-why-label" htmlFor={fieldId}>{WHY_LABEL}</label>
            <textarea
              id={fieldId}
              ref={(el) => { fieldRef.current = el; }}
              className="mail-correct-why"
              data-testid="mail-group-card-why"
              rows={2}
              maxLength={MAX_NOTE}
              placeholder="For example: tickets that name me need me"
              value={text}
              onChange={(event) => setText(event.target.value.slice(0, MAX_NOTE))}
            />
          </>
        ) : (
          <input
            id={fieldId}
            ref={(el) => { fieldRef.current = el; }}
            type="text"
            className="mail-correct-input"
            aria-label={RENAME_ARIA}
            data-testid="mail-group-card-name"
            maxLength={MAX_RENAME + 10}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void save(); } }}
          />
        )}
        {(error || renameProblem) && (
          <p className="mail-correct-field-error" role="alert" data-testid="mail-group-card-error">{error ?? renameProblem}</p>
        )}
        <div className="mail-correct-actions">
          <button type="button" className="btn btn-sm" disabled={saving} onClick={() => close(true)} data-testid="mail-group-card-cancel">
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={saving || renameProblem !== null || unchanged}
            onClick={() => { void save(); }}
            data-testid="mail-group-card-save"
          >
            {saving ? 'Saving…' : filter ? FILTER_SAVE : 'Save'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
