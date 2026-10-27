/**
 * The Transfer dialog: pick a harness, a host, the model, effort and
 * permissions the new session runs with, a directory and how the new task
 * starts. Every choice is a row of radio-style buttons (no native
 * <select>); a pair the server marks blocked stays visible, disabled, with its
 * reason. State lives in TransferDialogHost so it survives a hide; the two text
 * boxes are also kept as drafts of the task being moved, so a Cancel-less close
 * or a reload gives them back. A submit drops them (the host keeps the form while
 * it runs) and a refusal keeps them again.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { useDraft } from '@/hooks/useDraft';
import { draftKey } from '@/utils/drafts';
import { createPortal } from 'react-dom';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import { MicField, type BoxMicHandle } from '@/components/common/BoxMic';
import type { TransferOptions } from '@/api/transfer';
import {
  blockedReason, effectiveDir, hostKindLabel, hostLabel, sourceLine, submitBlocker, withEngine,
  type DirChoice, type TransferForm,
} from './transfer-model';
import { TransferLaunchRows } from './TransferLaunchRows';
import '@/styles/transfer.css';

interface Props {
  options: TransferOptions | null;
  loadError: string | null;
  form: TransferForm | null;
  busy: boolean;
  error: string | null;
  onChange: (patch: Partial<TransferForm>) => void;
  onSubmit: () => void;
  onClose: () => void;
  onRetryLoad: () => void;
}

function Choice({ checked, disabled, onPick, name, now, tag, sub, testId }: {
  checked: boolean; disabled?: boolean; onPick: () => void; name: ReactNode; now?: boolean; tag?: ReactNode; sub?: ReactNode; testId?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      className={`xfer-opt${checked ? ' is-checked' : ''}`}
      onClick={onPick}
      data-testid={testId}
    >
      <span className="xfer-opt-line">
        <span className="xfer-opt-dot" aria-hidden="true" />
        <span className="xfer-opt-name">{name}</span>
        {now && <span className="xfer-now">Now</span>}
        {tag && <span className="xfer-opt-tag">{tag}</span>}
      </span>
      {sub && <span className="xfer-opt-sub">{sub}</span>}
    </button>
  );
}

function Group({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className="xfer-group">
      <div className="xfer-label" id={`xfer-${label.toLowerCase()}`}>{label}</div>
      <div className={`xfer-opts${wide ? ' is-wide' : ''}`} role="radiogroup" aria-labelledby={`xfer-${label.toLowerCase()}`}>{children}</div>
    </div>
  );
}

export function TransferDialog({ options, loadError, form, busy, error, onChange, onSubmit, onClose, onRetryLoad }: Props) {
  useModalOverlay(onClose);
  const customRef = useRef<HTMLInputElement>(null);
  const messageBox = useRef<HTMLTextAreaElement | null>(null);
  const messageMic = useRef<BoxMicHandle | null>(null);
  const source = options?.source ?? null;
  const dir: DirChoice | null = form && source ? effectiveDir(form, source) : null;
  useEffect(() => { if (form?.dir === 'custom') customRef.current?.focus(); }, [form?.dir]);

  const taskId = options?.taskId ?? null;
  const messageDraft = useDraft(taskId ? draftKey('transfer', taskId, 'message') : null);
  const pathDraft = useDraft(taskId ? draftKey('transfer', taskId, 'path') : null);
  // A fresh form (the dialog was closed, or the page reloaded) takes the kept words back.
  const hasForm = !!form;
  useEffect(() => {
    if (!hasForm || busy) return;
    const patch: Partial<TransferForm> = {};
    if (!form!.message && messageDraft.text) patch.message = messageDraft.text;
    if (!form!.customPath && pathDraft.text) patch.customPath = pathDraft.text;
    if (Object.keys(patch).length) onChange(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasForm, taskId]);
  // A refused transfer: the words in the form are unsent again (each refusal
  // ends a busy spell, so the same message twice is caught too).
  useEffect(() => {
    if (busy || !error || !form) return;
    if (form.message) messageDraft.setText(form.message);
    if (form.customPath) pathDraft.setText(form.customPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error, busy]);
  const setMessage = (message: string) => { messageDraft.setText(message); onChange({ message }); };
  const setCustomPath = (customPath: string) => { pathDraft.setText(customPath); onChange({ customPath }); };

  const blocker = options && form ? submitBlocker(options, form) : null;
  const isNow = (engine: string, host: string) => !!source && source.engine === engine && source.host === host;

  let body: ReactNode;
  if (loadError) {
    body = (
      <div className="xfer-status xfer-status-error" role="alert">
        <span>{loadError}</span>
        <button type="button" className="app-modal-btn" onClick={onRetryLoad}>Try again</button>
      </div>
    );
  } else if (!options) {
    body = <div className="xfer-status">Reading where this task can go…</div>;
  } else if (!source || !form) {
    body = <div className="xfer-status">This task has no conversation to move.</div>;
  } else {
    body = (
      <fieldset className="xfer-fields" disabled={busy}>
        <Group label="Harness">
          {options.engines.map((e) => {
            const reason = blockedReason(options, e.id, form.host);
            return (
              <Choice
                key={e.id}
                checked={form.engine === e.id}
                disabled={!!reason}
                onPick={() => onChange(withEngine(form, source, e.id))}
                name={e.displayName}
                now={source.engine === e.id}
                sub={reason ?? undefined}
                testId={`xfer-engine-${e.id}`}
              />
            );
          })}
        </Group>
        <Group label="Host">
          {options.hosts.map((h) => {
            const reason = blockedReason(options, form.engine, h.alias);
            return (
              <Choice
                key={h.alias}
                checked={form.host === h.alias}
                disabled={!!reason}
                onPick={() => onChange({ host: h.alias })}
                name={hostLabel(h.alias, options.hosts)}
                now={source.host === h.alias}
                tag={h.kind && h.kind !== 'unknown' ? hostKindLabel(h.kind) : undefined}
                sub={reason ?? undefined}
                testId={`xfer-host-${h.alias}`}
              />
            );
          })}
        </Group>
        <TransferLaunchRows
          options={options}
          source={source}
          form={form}
          onChange={onChange}
          group={(label, children, wide) => <Group label={label} wide={wide}>{children}</Group>}
        />
        <Group label="Directory" wide>
          <Choice checked={dir === 'auto'} onPick={() => onChange({ dir: 'auto' })} name="Let Walnut choose" sub="Walnut finds or makes the repository on the target." testId="xfer-dir-auto" />
          <Choice
            checked={dir === 'same'}
            disabled={!source.cwd}
            onPick={() => onChange({ dir: 'same' })}
            name="Same directory"
            sub={source.cwd ? <span className="xfer-mono">{source.cwd}</span> : 'The session has no directory.'}
            testId="xfer-dir-same"
          />
          <Choice checked={dir === 'custom'} onPick={() => onChange({ dir: 'custom' })} name="Another directory" testId="xfer-dir-custom" />
          {dir === 'custom' && (
            <input
              ref={customRef}
              data-draft-key={pathDraft.key ?? undefined}
              className="app-modal-input xfer-path"
              value={form.customPath}
              placeholder="/absolute/path/on/the/host"
              aria-label="Directory on the target host"
              onChange={(e) => setCustomPath(e.target.value)}
              data-testid="xfer-dir-input"
            />
          )}
        </Group>
        <Group label="Start">
          <Choice checked={form.mode === 'carry'} onPick={() => onChange({ mode: 'carry' })} name="Carry the conversation" sub="The new task picks up the whole conversation." testId="xfer-mode-carry" />
          <Choice checked={form.mode === 'brief'} onPick={() => onChange({ mode: 'brief' })} name="Start from a brief" sub="Walnut writes a short handoff, and the new task starts from it." testId="xfer-mode-brief" />
        </Group>
        <label className="xfer-check">
          <input type="checkbox" checked={form.keepSource} onChange={(e) => onChange({ keepSource: e.target.checked })} data-testid="xfer-keep-source" />
          <span>Keep the original task open</span>
        </label>
        <label className="xfer-label xfer-label-field" htmlFor="xfer-message">First instruction (optional)</label>
        <MicField boxRef={messageBox} text={form.message} setText={setMessage} handleRef={messageMic} disabled={busy}>
          <textarea
            ref={messageBox}
            data-draft-key={messageDraft.key ?? undefined}
            id="xfer-message"
            className="app-modal-input xfer-message"
            rows={2}
            value={form.message}
            placeholder="What should the new task do first?"
            onChange={(e) => setMessage(e.target.value)}
            data-testid="xfer-message"
          />
        </MicField>
      </fieldset>
    );
  }

  return createPortal(
    <div
      className="app-modal-overlay"
      onMouseDown={onClose}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      // Typing here must not reach the panel's shortcuts; Escape still reaches useModalOverlay.
      onKeyDown={(e) => { if (e.key !== 'Escape') e.stopPropagation(); }}
    >
      <div
        className="app-modal xfer-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Transfer task"
        data-testid="transfer-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="xfer-head">
          <div className="app-modal-title">Transfer to another harness or host</div>
          <button type="button" className="xfer-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="xfer-intro">
          A new task takes over the work.{options?.source ? ` ${sourceLine(options)}.` : ''}
        </div>
        <div className="xfer-body">{body}</div>
        {error && <div className="xfer-error" role="alert" data-testid="xfer-error">{error}</div>}
        <div className="app-modal-actions xfer-actions">
          {blocker && options?.source && !busy && <span className="xfer-hint" data-testid="xfer-hint">{blocker}</span>}
          {busy && <span className="xfer-hint">You can close this. Walnut opens the new task when it is ready.</span>}
          <button type="button" className="app-modal-btn" onClick={() => { if (!busy) { messageDraft.clear(); pathDraft.clear(); } onClose(); }}>{busy ? 'Hide' : 'Cancel'}</button>
          <button
            type="button"
            className="app-modal-btn primary"
            disabled={busy || !!blocker || !form}
            title={blocker ?? undefined}
            onClick={() => { messageMic.current?.clear(); messageDraft.clear(); pathDraft.clear(); onSubmit(); }}
            data-testid="xfer-submit"
          >
            {busy ? 'Transferring…' : 'Transfer'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
