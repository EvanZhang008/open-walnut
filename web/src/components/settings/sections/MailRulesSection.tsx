/**
 * Settings > Mail rules: the rules file, the person's rules and the built-in ones, all editable here
 * and all written to the same `sort-rules.yaml` a person can edit. The groups themselves are the
 * model's (it names them from the unread mail), so there is no group list to order here.
 *
 * Every write goes through ONE save queue (`mail-rules-save-queue.ts`), chained on the file revision,
 * so this panel never gets a 409 from its own earlier write. A change made on disk while the panel is
 * open (`plugin:mail:rules-changed`) refreshes it when nothing is being edited, and otherwise says so
 * and lets the person choose between the file and their unsaved edit.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getMailGroups,
  getMailRules,
  initMailRules,
  putMailRules,
  restoreMailRules,
  type MailRule,
  type MailRuleValidationError,
  type MailRuleView,
  type MailRulesResponse,
} from '@/api/mail-groups';
import { listMailAccounts, type MailAccountDto } from '@/api/mail';
import { wsClient } from '@/api/ws';
import { useWebPluginRuntime } from '@/plugins/runtime-store';
import { log } from '@/utils/log';
import { SettingsGroup, SettingsLoadingRow, SettingsNotice, SettingsSection } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { createRulesSaveQueue, RulesQueueCancelled, type RulesDoc } from './mail-rules-save-queue';
import { COPY, moveItem, newRuleId, storedRule } from './mail-rules-model';
import { MailRulesFileRow } from './MailRulesFileRow';
import { MailRulesBuiltinList, MailRulesRulesList, type MoveFocus } from './MailRulesList';
import { MailRuleEditor } from './MailRuleEditor';
import './mail-rules.css';

const MOVED_MS = 1_500;
const FLASH_MS = 300;
const NEW_RULE = '__new-rule__';

function reasonOf(error: unknown): string {
  const body = (error as { body?: { message?: unknown } })?.body;
  if (body && typeof body.message === 'string') return body.message.replace(/\.$/, '');
  return error instanceof Error ? error.message.replace(/\.$/, '') : String(error);
}

function todayIso(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** The section behind the registry entry: answers the plugin-off case before touching any route. */
export function MailRulesSection() {
  const runtime = useWebPluginRuntime();
  const active = runtime.plugins.some((plugin) => plugin.id === 'mail' && plugin.state === 'active');
  if (runtime.ready && !active) {
    return (
      <SettingsSection id="mail-rules" title="Mail rules">
        <SettingsNotice kind="info">{COPY.pluginOff}</SettingsNotice>
      </SettingsSection>
    );
  }
  if (!runtime.ready) {
    return (
      <SettingsSection id="mail-rules" title="Mail rules">
        <SettingsLoadingRow />
      </SettingsSection>
    );
  }
  return <MailRulesPanel />;
}

function MailRulesPanel() {
  const [rules, setRules] = useState<MailRulesResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<MailAccountDto[]>([]);
  const [viewRules, setViewRules] = useState<MailRuleView[]>([]);
  const [docGroups, setDocGroups] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [editorSaving, setEditorSaving] = useState(false);
  const [serverErrors, setServerErrors] = useState<MailRuleValidationError[]>([]);
  const [focus, setFocus] = useState<MoveFocus | null>(null);
  const [moved, setMoved] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [changedOnDisk, setChangedOnDisk] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const dirty = useRef(false);
  const movedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const apply = useCallback((next: MailRulesResponse) => {
    setRules(next);
    setViewRules(next.rules);
    setDocGroups(next.groups);
    setChangedOnDisk(false);
    setSaveError(null);
  }, []);

  const queue = useMemo(() => createRulesSaveQueue({
    put: putMailRules,
    onError: (error) => {
      if (error instanceof RulesQueueCancelled) return;
      const status = (error as { status?: number }).status;
      const code = (error as { body?: { error?: string } }).body?.error;
      if (status === 409 && code === 'changed') setSaveError(COPY.changedOnSave);
      else if (status !== 400) setSaveError(`Couldn't save the rules: ${reasonOf(error)}.`);
    },
  }), []);

  const load = useCallback(async (): Promise<MailRulesResponse | null> => {
    setLoadError(null);
    try {
      const next = await getMailRules();
      queue.setBase(next.fileRev);
      apply(next);
      dirty.current = false;
      return next;
    } catch (error) {
      setLoadError(`Couldn't read the mail rules: ${reasonOf(error)}.`);
      return null;
    }
  }, [apply, queue]);

  const loadCounts = useCallback(async () => {
    try {
      const groups = await getMailGroups({ role: 'inbox' });
      setProgress(groups.recomputing ?? null);
    } catch (error) {
      log.warn('settings', 'mail rules could not read the group counts', { error: String(error) });
    }
  }, []);

  useEffect(() => {
    void load();
    void loadCounts();
    listMailAccounts().then((answer) => setAccounts(answer.accounts), () => setAccounts([]));
  }, [load, loadCounts]);

  // The plugin's own events: a file change on disk, and the recompute's progress.
  useEffect(() => wsClient.subscribeAll((name, data) => {
    if (name === 'plugin:mail:sort-progress') {
      const value = data as { done?: number; total?: number };
      if (typeof value.done === 'number' && typeof value.total === 'number') setProgress({ done: value.done, total: value.total });
    } else if (name === 'plugin:mail:sorted') {
      setProgress(null);
      void loadCounts();
    } else if (name === 'plugin:mail:rules-changed') {
      if (queue.busy()) return;
      void getMailRules().then((fresh) => {
        if (fresh.fileRev === queue.base()) { if (!dirty.current) apply(fresh); else setRules(fresh); return; }
        if (dirty.current) { setChangedOnDisk(true); return; }
        queue.setBase(fresh.fileRev);
        apply(fresh);
      }, (error: unknown) => log.warn('settings', 'mail rules refresh failed', { error: String(error) }));
    }
  }), [apply, loadCounts, queue]);

  const docOf = (nextRules: ReadonlyArray<MailRuleView | MailRule>, groups: string[] = docGroups): RulesDoc => ({
    groups: [...groups],
    rules: nextRules.map(storedRule),
  });

  const showMoved = (key: string) => {
    clearTimeout(movedTimer.current);
    setMoved(key);
    movedTimer.current = setTimeout(() => setMoved(null), MOVED_MS);
  };
  useEffect(() => () => clearTimeout(movedTimer.current), []);

  const refreshAfterSave = useCallback(async () => {
    if (queue.busy()) return;
    try {
      const fresh = await getMailRules();
      if (queue.busy()) return;
      queue.setBase(fresh.fileRev);
      if (!dirty.current) apply(fresh); else setRules(fresh);
    } catch (error) {
      log.warn('settings', 'mail rules reread after save failed', { error: String(error) });
    }
  }, [apply, queue]);

  const write = (doc: RulesDoc, coalesce = false) =>
    queue.save(doc, { coalesce }).then(() => { void refreshAfterSave(); void loadCounts(); });

  const moveRule = (index: number, delta: -1 | 1) => {
    const rule = viewRules[index];
    if (!rule) return;
    const next = moveItem(viewRules, index, delta);
    setViewRules(next);
    setFocus({ list: 'rule', key: rule.id, dir: delta < 0 ? 'up' : 'down', at: Date.now() });
    showMoved(rule.id);
    write(docOf(next), true).catch(() => undefined);
  };

  const toggleRule = (index: number, enabled: boolean) => {
    const next = viewRules.map((one, at) => (at === index ? { ...one, enabled } : one));
    setViewRules(next);
    write(docOf(next)).catch(() => undefined);
  };

  const deleteRule = (index: number) => {
    const next = viewRules.filter((_, at) => at !== index);
    setViewRules(next);
    write(docOf(next)).catch(() => undefined);
  };

  const saveEdited = (input: Omit<MailRule, 'id' | 'source' | 'created'> & { newGroup?: string }) => {
    const { newGroup, ...fields } = input;
    const index = editing === NEW_RULE ? -1 : viewRules.findIndex((one) => one.id === editing);
    const base = index >= 0 ? viewRules[index]! : null;
    const id = base?.id && /^r-[0-9a-f]{6}$/.test(base.id) ? base.id : newRuleId();
    const rule: MailRule = {
      id,
      source: base?.source ?? 'user',
      ...(base?.created ? { created: base.created } : { created: todayIso() }),
      ...fields,
    };
    const stored = viewRules.map(storedRule);
    const nextRules = index >= 0 ? stored.map((one, at) => (at === index ? rule : one)) : [rule, ...stored];
    const groups = newGroup && !docGroups.some((one) => one.toLowerCase() === newGroup.toLowerCase()) ? [...docGroups, newGroup] : docGroups;
    const at = index >= 0 ? index : 0;
    setEditorSaving(true);
    setServerErrors([]);
    queue.save({ groups, rules: nextRules }).then(
      async () => {
        setEditorSaving(false);
        setEditing(null);
        dirty.current = false;
        await refreshAfterSave();
        void loadCounts();
        if (!reducedMotion()) { setFlash(id); setTimeout(() => setFlash(null), FLASH_MS); }
      },
      (error: unknown) => {
        setEditorSaving(false);
        const body = (error as { status?: number; body?: { errors?: MailRuleValidationError[]; message?: string } });
        if (body.status === 400) {
          const errors = body.body?.errors ?? [];
          const mine = errors.filter((one) => one.index === at);
          setServerErrors(mine.length > 0 ? mine : errors.length > 0 ? errors : [{ index: at, field: '', message: body.body?.message ?? 'The rule was not accepted.' }]);
        }
      },
    );
  };

  const fileAction = async (kind: 'create' | 'restore' | 'reload' | 'builtin') => {
    setBusy(kind);
    try {
      if (kind === 'create') await initMailRules();
      else if (kind === 'restore') await restoreMailRules();
      else if (kind === 'builtin') await queue.save({ groups: [], rules: [] });
      await load();
      void loadCounts();
    } catch (error) {
      if (!(error instanceof RulesQueueCancelled)) setSaveError(`Couldn't change the rules file: ${reasonOf(error)}.`);
    } finally {
      setBusy(null);
    }
  };

  if (!rules) {
    return (
      <SettingsSection id="mail-rules" title="Mail rules">
        {loadError ? (
          <SettingsNotice kind="error" action={<SettingsButton onClick={() => { void load(); }}>Try again</SettingsButton>}>{loadError}</SettingsNotice>
        ) : <SettingsLoadingRow />}
      </SettingsSection>
    );
  }

  const fileBroken = !!rules.error;
  const catalog = rules.catalog;
  const editorFor = (id: string) => {
    const base = id === NEW_RULE ? null : viewRules.find((one) => one.id === id) ?? null;
    return (
      <MailRuleEditor
        key={id}
        initial={base ? storedRule(base) : null}
        catalog={catalog}
        accounts={accounts}
        serverErrors={serverErrors}
        saving={editorSaving}
        onSave={saveEdited}
        onCancel={() => { setEditing(null); setServerErrors([]); dirty.current = false; }}
        onDirty={(value) => { dirty.current = value; }}
      />
    );
  };

  return (
    <SettingsSection id="mail-rules" title="Mail rules" data-testid="mail-rules-section">
      <p className="mail-rules-crosslink" data-testid="mail-rules-triage-link">
        {COPY.crossLink} <Link to="/settings#triage">{COPY.openTriage}</Link>
      </p>
      <p className="mail-rules-help">{COPY.triageUndo}</p>
      {progress && (
        <p className="mail-rules-progress" data-testid="mail-rules-progress" aria-live="polite">
          Updating groups… {progress.done.toLocaleString('en-US')} of {progress.total.toLocaleString('en-US')}
        </p>
      )}
      {changedOnDisk && (
        <SettingsNotice kind="warn" action={
          <span className="mail-rules-inline-actions">
            <SettingsButton data-testid="mail-rules-changed-reload" onClick={() => { setEditing(null); void load(); }}>Reload</SettingsButton>
            <SettingsButton variant="text" data-testid="mail-rules-keep-editing" onClick={() => setChangedOnDisk(false)}>Keep editing</SettingsButton>
          </span>
        }>
          <span data-testid="mail-rules-changed">{COPY.changedOnDisk}</span>
        </SettingsNotice>
      )}
      {saveError && (
        <SettingsNotice kind="error" action={<SettingsButton data-testid="mail-rules-error-reload" onClick={() => { setEditing(null); void load(); }}>Reload</SettingsButton>}>
          <span data-testid="mail-rules-save-error">{saveError}</span>
        </SettingsNotice>
      )}
      <MailRulesFileRow
        rules={rules}
        busy={busy}
        onCreate={() => { void fileAction('create'); }}
        onReload={() => { void fileAction('reload'); }}
        onRestore={() => { void fileAction('restore'); }}
        onBuiltinOnly={() => { void fileAction('builtin'); }}
      />
      <SettingsGroup heading="Your rules" headingTrailing={
        <SettingsButton variant="text" data-testid="mail-rules-add" disabled={fileBroken || editing !== null}
          onClick={() => { setServerErrors([]); setEditing(NEW_RULE); }}>
          Add rule
        </SettingsButton>
      } footer="The first rule that matches a mail decides where it goes. A rule's note is also shown to Walnut's model when it sorts new mail.">
        {editing === NEW_RULE && <div className="mail-rule-row mail-rule-row-new">{editorFor(NEW_RULE)}</div>}
        <MailRulesRulesList
          rules={viewRules}
          disabled={fileBroken}
          disabledTitle={COPY.fixFirst}
          focus={focus}
          movedKey={moved}
          flashKey={flash}
          editingId={editing}
          onMove={moveRule}
          onToggle={toggleRule}
          onEdit={(index) => { setServerErrors([]); setEditing(viewRules[index]?.id ?? null); }}
          onDelete={deleteRule}
          renderEditor={(index) => editorFor(viewRules[index]!.id)}
        />
      </SettingsGroup>
      <SettingsGroup heading="Built-in">
        <MailRulesBuiltinList builtins={rules.builtins} />
      </SettingsGroup>
    </SettingsSection>
  );
}
