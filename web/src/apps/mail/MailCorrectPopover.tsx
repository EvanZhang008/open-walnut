/**
 * The correction card: the row menu's `Not important…` / `Important…` and the reader head's
 * `Not right?`.
 *
 * A portalled popover placed by `useMenuPlacement` next to the row (never past the viewport, flipped
 * above when there is no room below), `onPointerDown` stopped at the root so no row drag or outside
 * closer sees its clicks, Esc closes it and hands focus back to where it was opened from.
 *
 * NOTHING IS LEARNED WITHOUT `Save rule`. Step 2 asks the server for drafts (`POST /rules/propose`
 * never writes). With a note, two proposals run side by side: the instant one (`model: false`), which
 * answers in well under a second with the local drafts, and one with the note, whose only new part is
 * the model's draft; the model can take up to 12 s and the local drafts must be clickable long before
 * that (C28).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  getMailRules,
  previewMailRule,
  proposeMailRule,
  putMailRules,
  type MailProposeResponse,
  type MailRulesResponse,
} from '@/api/mail-groups';
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement';
import { log } from '@/utils/log';
import {
  closeMailLearnRequest,
  markMailMovedOut,
  pushMailListStatus,
  requestGroupsRefresh,
  updateMailListStatus,
  type MailCorrectRequest,
} from './mail-groups-bus';
import {
  NEW_GROUP_VALUE,
  correctChoices,
  defaultOptionKey,
  docOf,
  groupLabelOf,
  idForTarget,
  initialFocusIndex,
  localOptions,
  modelCellSentence,
  modelOption,
  newGroupProblem,
  newRuleId,
  recipientsSentence,
  saveRefusalOf,
  savedSentence,
  todayIso,
  undoLearnedRules,
  undoneSentence,
  withLearnedRule,
  type RuleOption,
  type RulesDoc,
  type SaveRefusal,
} from './mail-correct-model';
import { MailCorrectStepWhere } from './MailCorrectStepWhere';
import { MailCorrectStepRule, type ModelState } from './MailCorrectStepRule';
import './mail-learn.css';

/** How long the `Saved. … · Undo` note stays (hovering it pauses the clock, in the status strip). */
export const SAVED_NOTE_MS = 12_000;

function reasonOf(error: unknown): string {
  const body = (error as { body?: { message?: unknown } })?.body;
  if (body && typeof body.message === 'string') return body.message.replace(/\.$/, '');
  return error instanceof Error ? error.message.replace(/\.$/, '') : String(error);
}

/** Undo for any learned save, drawn in the list status strip of the view it was made from. */
export function pushLearnedUndo(input: {
  statusId: string;
  viewKey: string;
  text: string;
  doc: RulesDoc;
  fileRev: string;
  ruleIds: string[];
  createdGroup?: string;
}): void {
  const run = async () => {
    updateMailListStatus(input.statusId, { text: 'Undoing…', actions: [], sticky: true });
    const outcome = await undoLearnedRules({ get: getMailRules, put: putMailRules }, input);
    if (outcome.ok) {
      updateMailListStatus(input.statusId, { text: undoneSentence(input.ruleIds.length), tone: 'info', sticky: false, ttlMs: 4_000 });
      requestGroupsRefresh();
    } else {
      updateMailListStatus(input.statusId, { text: outcome.message, tone: 'error', sticky: false, ttlMs: 8_000 });
    }
  };
  pushMailListStatus({
    id: input.statusId,
    viewKey: input.viewKey,
    text: input.text,
    tone: 'success',
    ttlMs: SAVED_NOTE_MS,
    actions: [{ label: 'Undo', testId: 'mail-rule-undo', run: () => { void run(); } }],
  });
}

type Step = 'where' | 'rule';

export function MailCorrectPopover({ request }: { request: MailCorrectRequest }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLElement | null>(request.anchor);
  anchorRef.current = request.anchor;
  const firstRef = useRef<HTMLInputElement | null>(null);
  const runRef = useRef(0);
  const allInboxes = 'role' in request.scope;

  const [rules, setRules] = useState<MailRulesResponse | null>(null);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('where');
  // The destination the menu item named is picked when the card opens: that was the request.
  const [choice, setChoice] = useState<string | null>(request.preset ?? null);
  const [newName, setNewName] = useState('');
  const [note, setNote] = useState('');
  const [local, setLocal] = useState<MailProposeResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [model, setModel] = useState<MailProposeResponse['model'] | null>(null);
  const [modelState, setModelState] = useState<ModelState>('none');
  const [overrides, setOverrides] = useState<Record<string, Partial<RuleOption>>>({});
  const [kept, setKept] = useState<Map<string, number>>(() => new Map());
  const [picked, setPicked] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<SaveRefusal | null>(null);

  const close = useCallback((restoreFocus: boolean) => {
    runRef.current += 1;
    closeMailLearnRequest();
    if (!restoreFocus) return;
    const back = request.returnFocus ?? request.anchor;
    if (back && back.isConnected) back.focus({ preventScroll: true });
  }, [request]);

  const loadRules = useCallback(async (): Promise<MailRulesResponse | null> => {
    setRulesError(null);
    try {
      const next = await getMailRules();
      setRules(next);
      return next;
    } catch (error) {
      setRulesError(`Couldn't load your groups: ${reasonOf(error)}.`);
      log.warn('mail', 'correction card could not read the rules', { error: String(error) });
      return null;
    }
  }, []);

  useEffect(() => { void loadRules(); }, [loadRules]);

  const catalog = useMemo(() => rules?.catalog ?? [], [rules]);
  const choices = useMemo(
    () => correctChoices(catalog, request.groupId, request.groupLabel),
    [catalog, request.groupId, request.groupLabel],
  );
  const focusIndex = initialFocusIndex(choices, request.preset);
  const currentLabel = groupLabelOf(catalog, request.groupId, request.groupLabel);
  const problem = choice === NEW_GROUP_VALUE ? newGroupProblem(newName, catalog) : null;
  const target = choice === NEW_GROUP_VALUE ? newName.trim() : choices.find((one) => one.value === choice)?.target ?? '';

  useEffect(() => {
    if (step === 'where' && rules) firstRef.current?.focus({ preventScroll: true });
  }, [step, rules]);

  const propose = useCallback(async () => {
    const run = ++runRef.current;
    setLocal(null); setLoadError(null); setModel(null); setOverrides({}); setKept(new Map());
    setExpanded(new Set()); setSaveError(null);
    const withNote = note.trim().length > 0;
    setModelState(withNote ? 'pending' : 'none');
    // `scope` counts the drafts over the view the person is in; `model: false` is the instant call.
    // Passed as variables: the P1 client type predates both fields, the server reads them.
    const base = { accountId: request.accountId, messageId: request.messageId, target, scope: request.scope };
    const withModel = { ...base, note };
    const instant = { ...base, model: false };
    if (withNote) {
      proposeMailRule(withModel).then(
        (answer) => { if (run === runRef.current) { setModel(answer.model); setModelState('done'); } },
        (error: unknown) => {
          if (run !== runRef.current) return;
          log.warn('mail', 'rule proposal with a note failed', { error: String(error) });
          setModel({ status: 'unavailable' });
          setModelState('done');
        },
      );
    }
    try {
      const answer = await proposeMailRule(instant);
      if (run === runRef.current) setLocal(answer);
    } catch (error) {
      if (run === runRef.current) setLoadError(`Couldn't load the rule drafts: ${reasonOf(error)}.`);
    }
  }, [note, request.accountId, request.messageId, target]);

  const options = useMemo(() => {
    const fromModel = modelOption(model);
    const list = [...(fromModel ? [fromModel] : []), ...(local ? localOptions(local) : [])];
    return list.map((one) => (overrides[one.key] ? { ...one, ...overrides[one.key] } : one));
  }, [model, local, overrides]);
  // Until the person touches the radios the default follows the drafts (the model's included);
  // after that, nothing but the person moves the pick.
  const selectedKey = touched && picked && options.some((one) => one.key === picked) ? picked : defaultOptionKey(options);

  // The model's draft arrives with counts only; its samples and shadows come from one preview.
  const modelDraft = model?.status === 'ok' ? model.draft : undefined;
  useEffect(() => {
    if (!modelDraft) return;
    let live = true;
    previewMailRule({ scope: request.scope, when: modelDraft.when, then: modelDraft.then }).then(
      (answer) => {
        if (!live) return;
        setOverrides((prev) => ({
          ...prev,
          model: { matches: answer.matches, moves: answer.moves, samples: answer.samples, shadows: answer.shadows, partial: answer.partial },
        }));
      },
      (error: unknown) => log.warn('mail', 'preview of the model draft failed', { error: String(error) }),
    );
    return () => { live = false; };
  }, [modelDraft, request.scope]);

  const keepEarlier = async (key: string) => {
    const option = options.find((one) => one.key === key);
    if (!option || !rules) return;
    const at = option.shadows.map((one) => rules.rules.findIndex((rule) => rule.id === one.ruleId)).filter((i) => i >= 0);
    const insertAt = at.length > 0 ? Math.max(...at) + 1 : 0;
    try {
      const answer = await previewMailRule({ scope: request.scope, when: option.when, then: option.then, insertAt });
      setOverrides((prev) => ({
        ...prev,
        [key]: { matches: answer.matches, moves: answer.moves, samples: answer.samples, shadows: answer.shadows, partial: answer.partial },
      }));
      setKept((prev) => new Map(prev).set(key, insertAt));
    } catch (error) {
      setSaveError({ kind: 'network', message: `Couldn't check your earlier rule: ${reasonOf(error)}.` });
    }
  };

  const save = async () => {
    const option = options.find((one) => one.key === selectedKey);
    if (!option || !rules || saving) return;
    setSaving(true);
    setSaveError(null);
    const id = newRuleId();
    const createdGroup = choice === NEW_GROUP_VALUE ? target : undefined;
    const doc = withLearnedRule(docOf(rules), {
      rule: option, note, id, created: todayIso(), newGroup: createdGroup, insertAt: kept.get(option.key),
    });
    try {
      const saved = await putMailRules({ ...doc, baseRev: rules.fileRev, touch: { accountId: request.accountId, messageId: request.messageId } });
      pushLearnedUndo({
        statusId: `rule-saved:${id}`,
        viewKey: request.viewKey,
        text: savedSentence(option.moves, option.then),
        doc, fileRev: saved.fileRev, ruleIds: [id], createdGroup,
      });
      if (idForTarget(catalog, option.then) !== request.groupId) {
        markMailMovedOut([{ accountId: request.accountId, messageId: request.messageId }]);
      }
      requestGroupsRefresh();
      close(true);
    } catch (error) {
      setSaveError(saveRefusalOf(error));
      setSaving(false);
    }
  };

  const reload = async () => {
    const fresh = await loadRules();
    if (fresh) await propose();
  };

  const placement = useMenuPlacement(true, anchorRef, cardRef, {
    align: 'start', edgeOverflow: 'clamp', gap: 4, minHeight: 240, onAnchorLost: () => close(false),
  });

  // Outside pointer closes; the card's own portal content never counts as outside.
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const node = event.target as Element | null;
      if (node && typeof node.closest === 'function' && node.closest('.mail-correct')) return;
      if (saving) return;
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

  const groupLabel = (groupId: string) => groupLabelOf(catalog, groupId);

  const body = !rules ? (
    <div className="mail-correct-step" data-step="loading">
      {rulesError ? (
        <p className="mail-correct-field-error" role="alert" data-testid="mail-correct-load-error">
          {rulesError}{' '}
          <button type="button" className="mail-correct-link" onClick={() => { void loadRules(); }}>Try again</button>
        </p>
      ) : (
        <p className="mail-correct-loading" data-testid="mail-correct-loading">Loading…</p>
      )}
      <div className="mail-correct-actions">
        <button type="button" className="btn btn-sm" onClick={() => close(true)}>Cancel</button>
      </div>
    </div>
  ) : step === 'where' ? (
    <MailCorrectStepWhere
      currentLabel={currentLabel}
      choices={choices}
      focusIndex={focusIndex}
      firstRef={firstRef}
      value={choice}
      onValue={setChoice}
      newName={newName}
      onNewName={setNewName}
      newNameProblem={problem}
      note={note}
      onNote={setNote}
      onCancel={() => close(true)}
      onNext={() => { setStep('rule'); void propose(); }}
    />
  ) : (
    <MailCorrectStepRule
      loading={!local && !loadError}
      loadError={loadError}
      options={options}
      modelState={modelState}
      modelSentence={modelState === 'done' ? modelCellSentence(model) : null}
      selectedKey={selectedKey}
      onSelect={(key) => { setTouched(true); setPicked(key); }}
      allInboxes={allInboxes}
      expanded={expanded}
      onToggleSamples={(key) => setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
      })}
      kept={new Set(kept.keys())}
      onKeepEarlier={(key) => { void keepEarlier(key); }}
      recipientsLine={local ? recipientsSentence(local.recipients) : null}
      groupLabel={groupLabel}
      saving={saving}
      error={saveError}
      onBack={() => { runRef.current += 1; setSaveError(null); setStep('where'); }}
      onSave={() => { void save(); }}
      onReload={() => { void reload(); }}
      onRetryLoad={() => { void propose(); }}
    />
  );

  return createPortal(
    <div
      ref={cardRef}
      className="mail-correct"
      role="dialog"
      aria-modal="false"
      aria-label="Where should this mail go?"
      data-testid="mail-correct"
      data-step={step}
      style={menuPlacementStyle(placement)}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {body}
    </div>,
    document.body,
  );
}
