/**
 * "Filter mails like these…": a small card anchored on the group line (or the letter's row) that
 * files mail into a folder of the account. Three fields start filled in (mail-filter-defaults.ts):
 * From contains, Subject contains, Move to folder. Under them, how many mails in the Inbox match now
 * (the rule preview, debounced), and "Also move the N in the Inbox now" (on). Save writes the
 * person's own rule (mail-filter-save.ts); the status strip says what happened, with Undo.
 *
 * Nothing is written before Save. Placed by `useMenuPlacement` (never past the viewport), portalled,
 * `onPointerDown` stopped at the root, Esc closes and hands focus back to the anchor.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { previewMailRule } from '@/api/mail-groups';
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement';
import { log } from '@/utils/log';
import { useDraft } from '@/hooks/useDraft';
import { draftKey } from '@/utils/drafts';
import { getMailSnapshot } from './mail-store';
import { closeMailLearnRequest, requestGroupsRefresh, type MailFilterRequest } from './mail-groups-bus';
import {
  FOLDER_FILTER_FOLDER, FOLDER_FILTER_FROM, FOLDER_FILTER_NOTE, FOLDER_FILTER_SAVE, FOLDER_FILTER_SUBJECT,
  FOLDER_FILTER_MOVE_NOW, FOLDER_FILTER_TITLE, folderFilterCountText,
} from './mail-groups-copy';
import { folderFilterRule, saveFolderFilter } from './mail-filter-save';
import { saveRefusalOf } from './mail-correct-model';
import './mail-learn.css';
import './mail-groups.css';

export const COUNT_DEBOUNCE_MS = 400;

function messageOf(error: unknown): string {
  const body = (error as { body?: { message?: unknown } })?.body;
  if (body && typeof body.message === 'string') return body.message;
  return error instanceof Error ? error.message : String(error);
}

export function MailFilterCard({ request }: { request: MailFilterRequest }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLElement | null>(request.anchor);
  anchorRef.current = request.anchor;
  const firstRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const ids = { from: useId(), subject: useId(), folder: useId() };
  // Each field is a draft of this card until Save or Cancel; Esc or a click outside keeps it for the
  // next time the card opens on the same group or letter. It starts from the mail's own values.
  const keyOf = (field: string) => draftKey('mail-filter-card', field, request.origin, request.draftId);
  const fromDraft = useDraft(keyOf('from'), { baseline: request.fromContains });
  const subjectDraft = useDraft(keyOf('subject'), { baseline: request.subject });
  const folderDraft = useDraft(keyOf('folder'), { baseline: request.folder });
  const drafts = [fromDraft, subjectDraft, folderDraft];
  const clearDrafts = () => { for (const one of drafts) one.clear(); };
  const [fromContains, setFrom] = [fromDraft.text, fromDraft.setText];
  const [subject, setSubject] = [subjectDraft.text, subjectDraft.setText];
  const [folder, setFolder] = [folderDraft.text, folderDraft.setText];
  const [moveNow, setMoveNow] = useState(true);
  const [count, setCount] = useState<{ key: string; matches: number; partial: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = useCallback((restoreFocus: boolean) => {
    closeMailLearnRequest();
    if (restoreFocus && request.anchor.isConnected) request.anchor.focus({ preventScroll: true });
  }, [request]);

  const placement = useMenuPlacement(true, anchorRef, cardRef, {
    align: 'start', edgeOverflow: 'clamp', gap: 4, minHeight: 280, onAnchorLost: () => close(false),
  });

  useEffect(() => { firstRef.current?.focus({ preventScroll: true }); }, []);

  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const node = event.target as Element | null;
      if (saving || (node && typeof node.closest === 'function' && node.closest('.mail-filter-card'))) return;
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

  const rule = folderFilterRule({ fromContains, subject, folder, ...(request.accountId ? { accountId: request.accountId } : {}) });
  // Which account's mail it takes, said plainly: a letter's own account, a group seen in one account, else every account.
  const account = request.accountId ? getMailSnapshot().accounts.find((one) => one.accountId === request.accountId) : undefined;
  const reach = request.accountId
    ? `Only mail in ${account?.address || account?.displayName || 'this account'}.`
    : 'Mail in every account that can file it.';
  const problem = 'problem' in rule ? rule.problem : null;
  // The count answers the condition alone; the folder's name does not change it.
  const countKey = 'problem' in rule ? '' : JSON.stringify(rule.when);
  useEffect(() => {
    if ('problem' in rule) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      previewMailRule({ scope: { role: 'inbox' }, when: rule.when, then: rule.then }, controller.signal)
        .then((answer) => setCount({ key: countKey, matches: answer.matches, partial: !!answer.partial }))
        .catch((failure) => {
          if ((failure as { name?: string })?.name === 'AbortError') return;
          log.warn('mail', 'filter count failed', { error: messageOf(failure) });
        });
    }, COUNT_DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
    // `rule` is rebuilt every render; the count only follows its condition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countKey]);
  const shown = count && count.key === countKey ? count : null;

  const saveNow = async () => {
    if (saving || problem) return;
    setSaving(true);
    setError(null);
    try {
      // Only what the person saw offered: the box shows once the count is in and above zero.
      const offered = !!shown && shown.matches > 0;
      await saveFolderFilter({
        fromContains, subject, folder, moveNow: moveNow && offered, viewKey: request.viewKey,
        ...(request.accountId ? { accountId: request.accountId } : {}),
      });
      clearDrafts();
      requestGroupsRefresh();
      close(true);
    } catch (failure) {
      const refusal = saveRefusalOf(failure);
      const message = refusal.kind === 'network' ? messageOf(failure) : refusal.message;
      log.warn('mail', 'filter card save failed', { origin: request.origin, error: message });
      setError(`Couldn't save: ${message.replace(/[.\s]+$/, '')}.`);
      setSaving(false);
    }
  };

  const field = (id: string, label: string, value: string, set: (next: string) => void, testId: string, draft: string | null, ref?: typeof firstRef) => (
    <label className="mail-filter-field" htmlFor={id}>
      <span className="mail-filter-label">{label}</span>
      <input
        id={id}
        ref={ref}
        type="text"
        className="mail-correct-input"
        data-testid={testId}
        data-draft-key={draft ?? undefined}
        value={value}
        maxLength={320}
        disabled={saving}
        onChange={(event) => set(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void saveNow(); } }}
      />
    </label>
  );

  return createPortal(
    <div
      ref={cardRef}
      className="mail-correct mail-group-card mail-filter-card"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-testid="mail-filter-card"
      style={menuPlacementStyle(placement)}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="mail-correct-step">
        <p className="mail-correct-title" id={titleId}>{FOLDER_FILTER_TITLE}</p>
        {field(ids.from, FOLDER_FILTER_FROM, fromContains, setFrom, 'mail-filter-from', fromDraft.key, firstRef)}
        {field(ids.subject, FOLDER_FILTER_SUBJECT, subject, setSubject, 'mail-filter-subject', subjectDraft.key)}
        {field(ids.folder, FOLDER_FILTER_FOLDER, folder, setFolder, 'mail-filter-folder', folderDraft.key)}
        {!problem && (
          <p className="mail-group-card-body" data-testid="mail-filter-count" role="status">
            {folderFilterCountText(shown ? shown.matches : null, shown?.partial)}
          </p>
        )}
        {!problem && (shown?.matches ?? 0) > 0 && (
          <label className="mail-group-card-check">
            <input
              type="checkbox"
              data-testid="mail-filter-move-now"
              checked={moveNow}
              disabled={saving}
              onChange={(event) => setMoveNow(event.target.checked)}
            />
            <span>{FOLDER_FILTER_MOVE_NOW}</span>
          </label>
        )}
        <p className="mail-group-card-note" data-testid="mail-filter-reach">{reach}</p>
        <p className="mail-group-card-note">{FOLDER_FILTER_NOTE}</p>
        {(error || problem) && (
          <p className="mail-correct-field-error" role="alert" data-testid="mail-filter-error">{error ?? problem}</p>
        )}
        <div className="mail-correct-actions">
          <button type="button" className="btn btn-sm" disabled={saving} onClick={() => { clearDrafts(); close(true); }} data-testid="mail-filter-cancel">
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={saving || !!problem}
            onClick={() => { void saveNow(); }}
            data-testid="mail-filter-save"
          >
            {saving ? 'Saving…' : FOLDER_FILTER_SAVE}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
