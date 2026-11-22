/**
 * Settings > Inbox Triage > Routing rules: the standing "messages about X go to task Y" table every
 * triage batch reads (src/core/triage/routing-rules.ts). The user, Main and the VPs write the same
 * rules (ops triage_rule_set / triage_rule_delete); each row says who wrote it and what it routed.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { MicField, type BoxMicHandle, MicInput } from '@/components/common/BoxMic';
import { useSendAfterDictation, dictationWaitProps } from '@/hooks/useSendAfterDictation';
import { SettingsGroup, SettingsNotice } from '../SettingsSection';
import { EmptyState, LoadingState } from '../../common/EmptyState';
import { SettingsButton } from '../inputs/SettingsButton';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { ControlGroup } from '@/components/controls';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { useDraft } from '@/hooks/useDraft';
import { discardDraft, draftKey } from '@/utils/drafts';
import { taskPath } from '@/utils/task-path';
import {
  createTriageRule, deleteTriageRule, listTriageRules, updateTriageRule, type TriageRoutingRuleView,
} from '@/api/triage-rules';
import {
  ROUTING_COPY, pickTasks, provenanceLine, routedLine, senderNeedle, shadowingRule, taskLine, type PickableTask,
} from './triage-rules-model';
import './triage-rules.css';

const NEW = 'new';
const EDITOR_FIELDS = ['from', 'subject', 'note', 'task-query'] as const;

/** An editor's drafts, dropped: its Cancel, its Save, and opening another editor in its place. */
function discardEditorDrafts(id: string): void {
  // discardDraft, not clearDraft: a box's unmount flush would write its words back right after
  // (the next Edit then showed them over a newer value another writer saved).
  for (const field of EDITOR_FIELDS) discardDraft(draftKey('triage-rule', id, field));
}

function reasonOf(error: unknown): string {
  const e = error as { body?: { message?: string; error?: { message?: string } }; message?: string };
  return e?.body?.error?.message ?? e?.body?.message ?? e?.message ?? 'The rule was not saved';
}

/** After an editor closes, focus goes back to what opened it (the row's Edit, or Add rule). */
function focusOpener(id: string): void {
  requestAnimationFrame(() => {
    const sel = id === NEW ? '[data-testid="triage-rule-add"]' : `[data-rule-id="${CSS.escape(id)}"] [data-testid="triage-rule-edit"]`;
    (document.querySelector(sel) as HTMLElement | null)?.focus();
  });
}

function RuleEditor({ rule, tasks, onSaved, onCancel }: {
  rule: TriageRoutingRuleView | null;
  tasks: readonly PickableTask[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const id = rule?.id ?? NEW;
  const keys = useMemo(() => ({
    from: draftKey('triage-rule', id, 'from'),
    subject: draftKey('triage-rule', id, 'subject'),
    note: draftKey('triage-rule', id, 'note'),
    query: draftKey('triage-rule', id, 'task-query'),
  }), [id]);
  const from = useDraft(keys.from, { baseline: rule?.match.from ?? '' });
  const subject = useDraft(keys.subject, { baseline: rule?.match.subject ?? '' });
  const note = useDraft(keys.note, { baseline: rule?.note ?? '' });
  const noteBox = useRef<HTMLTextAreaElement>(null);
  const noteMic = useRef<BoxMicHandle | null>(null);
  const query = useDraft(keys.query);
  // The picked task is a choice, not typed text: plain state, so it never outlives this editor
  // (as a draft it came back in the next new rule, and "Change" could not clear it).
  const [taskId, setTaskId] = useState(rule?.taskId ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [active, setActive] = useState(0);
  // "Change" remembers the task it let go of: Escape in the picker puts it back.
  const [changedFrom, setChangedFrom] = useState('');
  const chosen = tasks.find((t) => t.id === taskId)
    ?? (rule && rule.taskId === taskId ? { id: rule.taskId, title: rule.task?.title ?? rule.taskTitle ?? rule.taskId, phase: rule.task?.phase ?? '' } : null);
  const matches = chosen ? [] : pickTasks(tasks, query.text);
  const pick = (t: PickableTask) => { setTaskId(t.id); setChangedFrom(''); query.setText(''); setPicking(false); setActive(0); setError(null); };
  const listOpen = picking;
  // Enter saves from a text field, Escape cancels (the picker's own keys come first).
  const onFieldKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); gate.send(); }
    else if (e.key === 'Escape') { e.preventDefault(); clearAll(); onCancel(); }
  };
  const onPickerKey = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setPicking(true);
      if (matches.length) setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
    } else if (e.key === 'Enter' && listOpen && matches[active]) {
      // Only a choice the user can see: a closed list picks nothing.
      e.preventDefault();
      pick(matches[active]!);
    } else if (e.key === 'Escape' && (listOpen || changedFrom)) {
      e.preventDefault();
      setPicking(false);
      query.setText('');
      if (changedFrom) {
        setTaskId(changedFrom);
        setChangedFrom('');
        // The search goes away with the restored task: focus its Change button, never the page.
        requestAnimationFrame(() => (document.querySelector(`[data-editor-id="${CSS.escape(id)}"] [data-testid="triage-rule-task-change"]`) as HTMLElement | null)?.focus());
      }
    } else {
      onFieldKey(e);
    }
  };

  const clearAll = () => discardEditorDrafts(id);
  const saveNow = async () => {
    if (!from.text.trim() && !subject.text.trim()) { setError(ROUTING_COPY.matchRequired); return; }
    if (!taskId) { setError(ROUTING_COPY.taskRequired); return; }
    setSaving(true);
    setError(null);
    try {
      // task_id only when it moved: a rule whose task completed keeps its note editable.
      const fields = { from: from.text.trim(), subject: subject.text.trim(), ...(taskId !== rule?.taskId ? { task_id: taskId } : {}), note: note.text.trim() };
      if (rule) await updateTriageRule(rule.id, fields);
      else await createTriageRule(fields);
      clearAll();
      onSaved();
    } catch (e) {
      setError(reasonOf(e));
    } finally {
      setSaving(false);
    }
  };

  // Save (the button, or Enter in a field) waits for a note still being dictated, then saves it too.
  const gate = useSendAfterDictation([noteMic], () => void saveNow(), keys.note);

  return (
    <div className="trr-editor" data-testid="triage-rule-editor" data-editor-id={id}>
      <label className="trr-field">
        <span>{ROUTING_COPY.from}</span>
        <input className="settings-input" autoFocus data-testid="triage-rule-from" onKeyDown={onFieldKey} data-draft-key={keys.from} value={from.text}
          placeholder="e.g. kitchenpros.example" onChange={(e) => { from.setText(e.target.value); setError(null); }} />
        {from.text.trim() && senderNeedle(from.text) !== from.text.trim() && (
          <span className="trr-hint" data-testid="triage-rule-from-hint">Saved as {senderNeedle(from.text)}: the address, not the name.</span>
        )}
      </label>
      <label className="trr-field">
        <span>{ROUTING_COPY.subject}</span>
        <input className="settings-input" data-testid="triage-rule-subject" onKeyDown={onFieldKey} data-draft-key={keys.subject} value={subject.text}
          placeholder="e.g. kitchen remodel" onChange={(e) => { subject.setText(e.target.value); setError(null); }} />
      </label>
      <div className="trr-field">
        <span>{ROUTING_COPY.task}</span>
        {chosen ? (
          <span className="trr-chosen" data-testid="triage-rule-task-chosen">
            <a className="task-link" data-task-id={chosen.id} href={taskPath(chosen.id)}>{chosen.title}</a>
            <SettingsButton data-testid="triage-rule-task-change"
              onClick={() => { setChangedFrom(taskId); setTaskId(''); setPicking(true); }}>Change</SettingsButton>
          </span>
        ) : null}
        {chosen && rule && taskId === rule.taskId && taskLine(rule).warn ? (
          <div className="trr-warn" data-testid="triage-rule-editor-warn">{taskLine(rule).warn}</div>
        ) : null}
        {chosen ? null : (
          <div className="trr-picker" onBlur={(e) => {
            // Focus left the search and its list (an option click keeps it inside): close the list.
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPicking(false);
          }}>
            <MicInput fieldClassName="settings-mic-field trr-task-search-field" className="settings-input" data-testid="triage-rule-task-search" data-draft-key={keys.query} value={query.text}
              placeholder="Search your open tasks" autoFocus={!!changedFrom} onFocus={() => setPicking(true)} onKeyDown={onPickerKey}
              role="combobox" aria-label={ROUTING_COPY.task} aria-expanded={listOpen} aria-controls={`trr-picks-${id}`}
              aria-activedescendant={matches[active] ? `trr-pick-${id}-${matches[active]!.id}` : undefined}
              setText={(text) => { query.setText(text); setPicking(true); setActive(0); setError(null); }} />
            {listOpen && (
              <div className="trr-picks" role="listbox" aria-label="Tasks" id={`trr-picks-${id}`}>
                {matches.length === 0 && (query.text.trim()
                  ? <EmptyState size="row" role="presentation" title={`No open task matches “${query.text.trim()}”`} />
                  : <EmptyState size="row" role="presentation" title="No open tasks" />)}
                {matches.map((t, i) => (
                  <button data-peek-row="" key={t.id} type="button" tabIndex={-1} role="option" aria-selected={i === active} id={`trr-pick-${id}-${t.id}`}
                    className={`trr-pick${i === active ? ' trr-pick-active' : ''}`} data-testid="triage-rule-task-option"
                    title={t.title} onMouseEnter={() => setActive(i)}
                    // Focus stays in the search (WebKit focuses no button on click), so its blur
                    // never closes the list under the pointer.
                    onMouseDown={(e) => e.preventDefault()} onClick={() => pick(t)}>
                    <span className="trr-pick-title wn-title">{t.title}</span>
                    {t.project && <span className="trr-pick-project wn-meta">{t.project}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <label className="trr-field">
        <span>{ROUTING_COPY.note}</span>
        <MicField fieldClassName="settings-mic-field trr-note-field" boxRef={noteBox} text={note.text} setText={(t) => { note.setText(t); setError(null); }} handleRef={noteMic} target={keys.note} disabled={saving}>
          <textarea ref={noteBox} className="settings-input trr-note-input" rows={3} data-testid="triage-rule-note" onKeyDown={onFieldKey}
            data-draft-key={keys.note} value={note.text} maxLength={500}
            placeholder="optional, e.g. the contractor for the kitchen job" onChange={(e) => { note.setText(e.target.value); setError(null); }} />
        </MicField>
      </label>
      {error && <p className="settings-row-error trr-error" role="alert" data-testid="triage-rule-error">{error}</p>}
      <div className="trr-editor-actions">
        {/* mousedown keeps focus where it is: closing the task list on blur moved these buttons
            under the pointer, and the first click landed nowhere. */}
        <SettingsButton variant="primary" data-testid="triage-rule-save" onMouseDown={(e) => e.preventDefault()} busy={saving} busyLabel="Saving…" onClick={gate.send} {...dictationWaitProps(gate)}>Save rule</SettingsButton>
        <SettingsButton variant="ghost" onMouseDown={(e) => e.preventDefault()} onClick={() => { clearAll(); onCancel(); }}>Cancel</SettingsButton>
      </div>
    </div>
  );
}

/** The id of one rule's ControlGroup (its on/off switch), named by the Inbox triage master. */
const ruleGroupId = (ruleId: string) => `triage-rule-on-group-${ruleId}`;

/** `onGroupIds`: the rules' ControlGroup ids, for the master switch's aria-controls. */
export function TriageRoutingRules({ off = false, onGroupIds }: { off?: boolean; onGroupIds?: (ids: readonly string[]) => void }) {
  const [rules, setRules] = useState<TriageRoutingRuleView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const tasks = useTasksContextSafe()?.tasks;
  const pickable = useMemo<PickableTask[]>(
    () => (tasks ?? []).map((t) => ({ id: t.id, title: t.title, project: t.project, phase: t.phase })),
    [tasks],
  );

  const load = useCallback(async () => {
    try {
      setRules(await listTriageRules());
      setLoadError(null);
    } catch (e) {
      setLoadError(`Couldn't load the routing rules: ${reasonOf(e)}.`);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const groupKey = (rules ?? []).map((r) => r.id).join(' ');
  useEffect(() => { onGroupIds?.(groupKey ? groupKey.split(' ').map(ruleGroupId) : []); }, [groupKey, onGroupIds]);
  // Main or a VP may add a rule while this is open: read again when the window comes back.
  useEffect(() => {
    const onFocus = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);
    return () => { document.removeEventListener('visibilitychange', onFocus); window.removeEventListener('focus', onFocus); };
  }, [load]);

  // Opening an editor closes the one open now as its Cancel would: its unsaved words go, never
  // kept out of sight to come back over a value someone saved since.
  const openEditor = (id: string) => {
    if (editing && editing !== id) discardEditorDrafts(editing);
    setRemoving(null);
    setEditing(id);
  };

  const act = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try { await fn(); } catch (e) { setActionError(reasonOf(e)); }
    await load();
  };

  return (
    <SettingsGroup
      heading={ROUTING_COPY.heading}
      data-testid="triage-routing-rules"
      headingTrailing={
        <SettingsButton data-testid="triage-rule-add" disabled={!rules}
          onClick={() => openEditor(NEW)}>{ROUTING_COPY.add}</SettingsButton>
      }
      footer={ROUTING_COPY.help}
    >
      {loadError && (
        <SettingsNotice kind="error" action={<SettingsButton onClick={() => { void load(); }}>Try again</SettingsButton>}>{loadError}</SettingsNotice>
      )}
      {actionError && <SettingsNotice kind="error">{actionError}</SettingsNotice>}
      {off && rules && rules.length > 0 && <p className="trr-off" data-testid="triage-rules-off">{ROUTING_COPY.off}</p>}
      {!rules && !loadError && <LoadingState title="Loading routing rules…" />}
      {editing === NEW && (
        <RuleEditor rule={null} tasks={pickable} onCancel={() => { setEditing(null); focusOpener(NEW); }}
          onSaved={() => { setEditing(null); focusOpener(NEW); void load(); }} />
      )}
      {rules && rules.length === 0 && editing !== NEW && (
        <EmptyState title={ROUTING_COPY.emptyTitle} hint={ROUTING_COPY.emptyHint} testId="triage-rules-empty" />
      )}
      {rules?.map((rule, index) => editing === rule.id ? (
        <RuleEditor key={rule.id} rule={rule} tasks={pickable} onCancel={() => { setEditing(null); focusOpener(rule.id); }}
          onSaved={() => { setEditing(null); focusOpener(rule.id); void load(); }} />
      ) : (
        <div key={rule.id} className={`trr-rule${rule.enabled ? '' : ' trr-rule-off'}${removing === rule.id ? ' trr-rule-removing' : ''}`} data-testid="triage-rule" data-rule-id={rule.id}>
          <div className="trr-rule-main" title={`Rule ${rule.id}`}>
            <div className="trr-rule-line">
              <span className="trr-match">{rule.matchText}</span>
              <span className="trr-to">
                <span className="trr-arrow" aria-hidden="true">→</span>
                <a className="task-link trr-task" data-task-id={rule.taskId} href={taskPath(rule.taskId)}>{taskLine(rule).text}</a>
              </span>
            </div>
            {taskLine(rule).warn && <div className="trr-warn" data-testid="triage-rule-warn">{taskLine(rule).warn}</div>}
            {(() => {
              const by = shadowingRule(rules, index);
              return by ? (
                <div className="trr-warn" data-testid="triage-rule-shadowed">
                  {by.matchText === rule.matchText
                    ? <>Never used: a rule above has the same match ({by.matchText}) and goes first. Remove one of them, or </>
                    : <>Never used: the rule above ({by.matchText}) matches all of these first.{' '}</>}
                  <button type="button" className="btn btn-link trr-inline-btn" data-testid="triage-rule-move-up"
                    onClick={() => { void act(() => updateTriageRule(rule.id, { before: by.id })); }}>
                    Move this rule above it
                  </button>
                </div>
              ) : null;
            })()}
            {rule.note && <div className="trr-note">{rule.note}</div>}
            <div className="trr-meta">
              {/* One line of text: the no-break space ties the dot to the words before it, so a wrap
                  never starts a line with a dot nor leaves one alone. */}
              <span data-testid="triage-rule-provenance">{provenanceLine(rule)}</span>
              {'\u00a0· '}
              <span data-testid="triage-rule-routed">{routedLine(rule)}</span>
            </div>
          </div>
          <div className="trr-rule-actions" onKeyDown={(e) => { if (e.key === 'Escape' && removing === rule.id) { e.preventDefault(); setRemoving(null); } }}>
            {removing === rule.id ? (
              <>
                <span className="trr-confirm-q">Remove this rule?</span>
                <SettingsButton variant="danger-confirm" autoFocus aria-label={`Remove rule: ${rule.matchText}`} data-testid="triage-rule-delete-confirm"
                  onClick={() => { setRemoving(null); void act(() => deleteTriageRule(rule.id)); }}>Remove</SettingsButton>
                <SettingsButton variant="ghost" onClick={() => setRemoving(null)}>Keep</SettingsButton>
              </>
            ) : (
              <span className="trr-rule-keys">
                <SettingsButton aria-label={`Edit rule: ${rule.matchText}`} data-testid="triage-rule-edit"
                  onClick={() => openEditor(rule.id)}>Edit</SettingsButton>
                <SettingsButton variant="danger" aria-label={`Remove rule: ${rule.matchText}`} data-testid="triage-rule-delete"
                  onClick={() => setRemoving(rule.id)}>Remove</SettingsButton>
              </span>
            )}
            {/* Hidden while a removal is asked, so the red Remove has no switch beside it. While Inbox
                triage is off a rule routes nothing: its switch reads disabled and grey (its saved
                state kept), and the line above the list says why. The rule itself stays editable. */}
            {removing !== rule.id && (
              <ControlGroup id={ruleGroupId(rule.id)} off={off}>
                <ToggleSwitch id={`triage-rule-on-${rule.id}`} checked={rule.enabled}
                  aria-label={`Rule ${rule.enabled ? 'on' : 'off'}: ${rule.matchText}`} data-testid="triage-rule-toggle"
                  onChange={(on) => { void act(() => updateTriageRule(rule.id, { enabled: on })); }} />
              </ControlGroup>
            )}
          </div>
        </div>
      ))}
    </SettingsGroup>
  );
}
