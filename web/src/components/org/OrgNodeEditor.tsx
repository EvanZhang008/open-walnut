/**
 * Make a VP or a project, or set a VP's name and the CEO's or a VP's own instructions, inside the
 * org chart (2026-10-26, the user: "in org chart should be able to create VP or Project ... during
 * regular or creation, I can define VP name, some Instruction").
 *
 * The server owns the rules (src/core/org/org-node-edit.ts): a new project has its own VP, a new
 * VP has no project until one is dragged under it, and the instructions ride the node's session
 * prompt, so a running session is told an edit with its next message (the instruction notice).
 * Its own words are shown when the server refuses, and nothing typed is lost.
 */
import { useState, type FormEvent, type KeyboardEvent } from 'react';
import type { Task } from '@open-walnut/core';
import { createOrgNode, editOrgNode, editProjectVp } from '@/api/org';
import { log } from '@/utils/log';
import { ORG_INSTRUCTIONS_MAX as INSTRUCTIONS_MAX } from '@open-walnut/org-tree';
import { theVp } from './org-chart-model';

const NAME_MAX = 60;

export type OrgNodeEditorMode =
  | { kind: 'new-vp' }
  | { kind: 'new-project' }
  /**
   * The CEO (`task` is Main), or a VP: `name` as the chart shows it, `project` its own project, and
   * `task` its lead when it has one (one is made on save when the project has none yet).
   */
  | { kind: 'edit'; task?: Task; project?: string; name?: string };

interface Props {
  mode: OrgNodeEditorMode;
  onClose: () => void;
  /** A save is in flight: the sheet's Escape must not close the form under it. */
  onBusy?: (busy: boolean) => void;
  /** Done: one line for the chart to say. */
  onDone: (message: string) => void;
}

export function OrgNodeEditor({ mode, onClose, onBusy, onDone }: Props) {
  const editing = mode.kind === 'edit' ? mode : null;
  const isCeo = editing?.task?.org_role === 'main';
  const [name, setName] = useState(editing?.name ?? '');
  const [vpName, setVpName] = useState('');
  const before = editing?.task?.org_instructions?.text ?? '';
  const [instructions, setInstructions] = useState(before);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const title = mode.kind === 'new-vp' ? 'New VP'
    : mode.kind === 'new-project' ? 'New project'
      : isCeo ? 'The CEO\'s instructions' : `${theVp(editing!.name ?? '').replace(/^the /, 'The ')}`;
  const needsName = !isCeo;
  const canSave = !busy && (!needsName || name.trim().length > 0);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!canSave) return;
    setBusy(true);
    onBusy?.(true);
    setError('');
    const words = instructions.trim();
    try {
      if (mode.kind === 'edit') {
        // Only what changed is sent: an untouched name never renames, an untouched text never re-dates.
        const renamed = !isCeo && name.trim() !== (mode.name ?? '').trim();
        const changed = words !== before.trim();
        if (!renamed && !changed) { onClose(); return; }
        const edit = { ...(renamed ? { name: name.trim() } : {}), ...(changed ? { instructions: words } : {}) };
        const t = mode.task ? await editOrgNode(mode.task.id, edit) : await editProjectVp(mode.project ?? '', edit);
        log.info('org-chart', 'org node edited', { taskId: t.id, role: t.org_role, renamed, instructions: changed ? words.length : undefined });
        const who = isCeo ? 'The CEO' : theVp(t.org_name ?? t.project).replace(/^the /, 'The ');
        onDone(changed ? `Saved. ${who} reads the new instructions with its next message.` : `Saved. It is ${theVp(t.org_name ?? t.project)} now.`);
      } else {
        const t = await createOrgNode(mode.kind === 'new-vp' ? 'vp' : 'project', {
          name: name.trim(),
          ...(mode.kind === 'new-project' && vpName.trim() ? { vpName: vpName.trim() } : {}),
          ...(words ? { instructions: words } : {}),
        });
        log.info('org-chart', 'org node made', { taskId: t.id, kind: mode.kind, project: t.project });
        onDone(mode.kind === 'new-vp'
          ? `Made ${theVp(t.org_name ?? t.project)}. Drag projects onto it to put them under it.`
          : `Made the project ${t.project} with its own VP.`);
      }
    } catch (err) {
      const answered = typeof (err as { status?: unknown }).status === 'number';
      const detail = err instanceof Error ? err.message : String(err);
      log.warn('org-chart', 'org node change failed', { kind: mode.kind, error: detail });
      setError(answered ? detail : 'Try again.');
    } finally {
      setBusy(false);
      onBusy?.(false);
    }
  };

  // Escape mid-save or mid-IME-composition is not a cancel: the sheet's own Escape never sees it
  // (the sheet also holds Escape while a save is in flight, for a key that lands outside the form).
  const onFormKey = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key === 'Escape' && (busy || e.nativeEvent.isComposing)) e.stopPropagation();
  };

  // Cmd/Ctrl+Enter saves from the instructions; Enter there starts a new line.
  const onAreaKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
  };

  return (
    <div className="oc-confirm-layer">
      <form className="oc-confirm oc-form" role="dialog" aria-modal="true" aria-label={title} data-testid="org-node-editor" onKeyDown={onFormKey} onSubmit={(e) => { void submit(e); }}>
        <h3 className="oc-confirm-title">{title}</h3>
        {mode.kind === 'new-vp' && <p className="oc-form-hint">A VP with no project yet: drag projects onto it once it is made.</p>}
        {mode.kind === 'new-project' && <p className="oc-form-hint">A project comes with its own VP. Drag it under another VP whenever you like.</p>}
        {needsName && (
          <label className="oc-field">
            <span>{mode.kind === 'new-project' ? 'Project' : 'Name'}</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={NAME_MAX}
              placeholder={mode.kind === 'new-project' ? 'Garden' : 'Growth'}
              data-testid="org-node-name"
              autoFocus
              readOnly={busy}
            />
          </label>
        )}
        {mode.kind === 'new-project' && (
          <label className="oc-field">
            <span>VP name <em>optional</em></span>
            <input
              value={vpName}
              onChange={(e) => setVpName(e.target.value)}
              maxLength={NAME_MAX}
              placeholder={name.trim() || 'Same as the project'}
              data-testid="org-node-vp-name"
              readOnly={busy}
            />
          </label>
        )}
        <label className="oc-field">
          <span>Instructions <em>optional</em></span>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            onKeyDown={onAreaKey}
            maxLength={INSTRUCTIONS_MAX}
            rows={6}
            placeholder={isCeo ? 'How the CEO should run the org for you.' : 'What this VP owns, how it works, what to watch for.'}
            data-testid="org-node-instructions"
            autoFocus={isCeo}
            readOnly={busy}
          />
          <span className="oc-field-count" aria-hidden="true">{instructions.length} / {INSTRUCTIONS_MAX}</span>
        </label>
        {error && <p className="oc-confirm-error" role="alert" data-testid="org-node-error">Not saved. {error}</p>}
        <div className="oc-confirm-actions">
          <button type="button" className="btn btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-sm btn-primary" data-testid="org-node-save" disabled={!canSave}>
            {busy ? 'Working…' : mode.kind === 'edit' ? 'Save' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
