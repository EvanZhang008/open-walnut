/**
 * "Memory & instructions" for Main, a lead or a VP, opened from the session header's ⋮
 * (2026-10-26: the user sees and edits what each org agent remembers and is told).
 *
 *  - Instructions: the user's own standing words (Task.org_instructions), edited here as on the
 *    org chart. They ride the agent's session prompt, so it reads an edit with its next message
 *    (src/core/sessions/instruction-notice.ts); nothing is woken for it.
 *  - Its own MEMORY.md: the working memory the agent writes for itself (Task.agent_memory). Folded
 *    and read-only: the agent owns it.
 *  - Main also reads Walnut's memory (MEMORY.md / USER.md), edited on the Memory page, which keeps
 *    the one editor with its write lock.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type { Task } from '@open-walnut/core';
import { ORG_INSTRUCTIONS_MAX, orgDisplayTitle } from '@open-walnut/org-tree';
import { editOrgNode } from '@/api/org';
import { fetchTask } from '@/api/tasks';
import { fetchAgentMemory, type AgentMemory } from '@/api/agent-memory';
import { fetchGlobalMemory, fetchUserMemory } from '@/api/memory';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import { log } from '@/utils/log';
import '@/styles/agent-memory.css';

/** Org agents have instructions and a memory of their own; other tasks have neither. */
export function hasMemoryAndInstructions(task: Pick<Task, 'org_role'> | null | undefined): boolean {
  return task?.org_role === 'main' || task?.org_role === 'lead';
}

const kChars = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n));

type Load<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string };
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function Fold({ summary, testId, children }: { summary: ReactNode; testId: string; children: ReactNode }) {
  return (
    <details className="am-fold" data-testid={testId}>
      <summary>{summary}</summary>
      <div className="am-fold-body">{children}</div>
    </details>
  );
}

function OwnMemory({ load }: { load: Load<AgentMemory> }) {
  if (load.state === 'loading') return <p className="am-hint">Reading…</p>;
  if (load.state === 'error') return <p className="am-hint am-error" role="alert">Could not read it. {load.message}</p>;
  const { memory, chars, soft_limit: soft } = load.value;
  return (
    <Fold testId="am-own-memory" summary={<>Its own MEMORY.md <span className="am-count">· {kChars(chars)} of {kChars(soft)}</span></>}>
      {memory?.refused && (
        <p className="am-hint am-error">Its last write was refused: {kChars(memory.refused.chars)} characters is over the limit.</p>
      )}
      {memory?.text.trim()
        ? <pre className="am-text" data-testid="am-own-memory-text">{memory.text}</pre>
        : <p className="am-hint">Empty: it has written nothing yet.</p>}
      <p className="am-hint">It writes this itself; read-only here.</p>
    </Fold>
  );
}

const WALNUT_DOCS = [
  { path: 'MEMORY.md', id: 'memory', read: fetchGlobalMemory },
  { path: 'USER.md', id: 'user', read: fetchUserMemory },
] as const;

/** `held`: words typed and not saved, which leaving for the Memory page would drop. */
function WalnutMemory({ onOpen, held }: { onOpen: (path: string) => void; held: boolean }) {
  const [docs, setDocs] = useState<Record<string, Load<string>>>({});
  useEffect(() => {
    let live = true;
    for (const doc of WALNUT_DOCS) {
      doc.read()
        .then((d) => { if (live) setDocs((prev) => ({ ...prev, [doc.path]: { state: 'ready', value: d.content } })); })
        .catch((err) => { if (live) setDocs((prev) => ({ ...prev, [doc.path]: { state: 'error', message: errText(err) } })); });
    }
    return () => { live = false; };
  }, []);
  return (
    <Fold testId="am-walnut-memory" summary="Walnut memory (MEMORY.md / USER.md)">
      {WALNUT_DOCS.map((doc) => {
        const load = docs[doc.path] ?? { state: 'loading' };
        return (
          <div key={doc.path} className="am-doc">
            <div className="am-doc-head">
              <span>{doc.path}</span>
              <button
                type="button"
                className="am-link"
                onClick={() => onOpen(doc.path)}
                disabled={held}
                title={held ? 'Save or cancel the instructions first' : undefined}
                data-testid={`am-edit-${doc.id}`}
              >Edit in Memory</button>
            </div>
            {load.state === 'loading' && <p className="am-hint">Reading…</p>}
            {load.state === 'error' && <p className="am-hint am-error" role="alert">Could not read it. {load.message}</p>}
            {load.state === 'ready' && (load.value.trim() ? <pre className="am-text">{load.value}</pre> : <p className="am-hint">Empty.</p>)}
          </div>
        );
      })}
    </Fold>
  );
}

export function AgentMemoryPanel({ task, onClose }: { task: Task; onClose: () => void }) {
  const navigate = useNavigate();
  const [saved, setSaved] = useState(task.org_instructions?.text ?? '');
  const [text, setText] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [own, setOwn] = useState<Load<AgentMemory>>({ state: 'loading' });
  const isMain = task.org_role === 'main';
  const name = orgDisplayTitle(task);
  const dirty = text.trim() !== saved.trim();
  // Escape mid-save waits for the answer, and never drops typed words (Cancel does that).
  useModalOverlay(() => { if (!busy && !dirty) onClose(); });

  // The row it was opened from may be a list copy: read the stored words before any typing, and
  // never offer the box over words it could not read (a save would replace them unseen).
  const [fresh, setFresh] = useState(false);
  const [readError, setReadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    let live = true;
    setReadError('');
    fetchTask(task.id).then((t) => {
      if (!live) return;
      const stored = t.org_instructions?.text ?? '';
      setSaved(stored);
      setText(stored);
      setFresh(true);
    }).catch((err) => {
      if (!live) return;
      log.warn('agent-memory', 'stored instructions not read', { taskId: task.id, error: errText(err) });
      setReadError(errText(err));
    });
    return () => { live = false; };
  }, [task.id, attempt]);
  // The box opens read-only until the stored words are in; then it takes the focus.
  useEffect(() => { if (fresh) area.current?.focus(); }, [fresh]);

  useEffect(() => {
    let live = true;
    fetchAgentMemory(task.id)
      .then((value) => { if (live) setOwn({ state: 'ready', value }); })
      .catch((err) => { if (live) setOwn({ state: 'error', message: errText(err) }); });
    return () => { live = false; };
  }, [task.id]);

  const save = async () => {
    if (!dirty || busy || !fresh) return;
    setBusy(true);
    setNote(null);
    try {
      const t = await editOrgNode(task.id, { instructions: text.trim() });
      log.info('agent-memory', 'org instructions saved', { taskId: t.id, role: task.org_role, chars: text.trim().length });
      setSaved(text.trim());
      setNote({ ok: true, text: 'Saved. It reads them with its next message.' });
    } catch (err) {
      log.warn('agent-memory', 'org instructions not saved', { taskId: task.id, error: errText(err) });
      setNote({ ok: false, text: `Not saved. ${typeof (err as { status?: unknown }).status === 'number' ? errText(err) : 'Try again.'}` });
    } finally {
      setBusy(false);
    }
  };
  const openMemory = (path: string) => {
    onClose();
    navigate(`/memory?path=${encodeURIComponent(path)}`);
  };

  return createPortal(
    <div
      className="app-modal-overlay"
      // A click outside closes it, unless that would drop unsaved words.
      onMouseDown={() => { if (!busy && !dirty) onClose(); }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      // Typing here must not reach the panel's shortcuts; Escape still reaches useModalOverlay.
      onKeyDown={(e) => { if (e.key !== 'Escape') e.stopPropagation(); }}
    >
      <div
        className="app-modal am-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Memory and instructions: ${name}`}
        data-testid="agent-memory-panel"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="am-head">
          <div className="app-modal-title">Memory &amp; instructions</div>
          <button type="button" className="am-close" onClick={onClose} disabled={busy} aria-label="Close">×</button>
        </div>
        <div className="am-sub">{name}</div>

        <label className="am-field">
          <span className="am-label">Instructions</span>
          <span className="am-hint">Your own standing words for {isMain ? 'the CEO' : 'this VP'}: what it owns, how it works, what to watch for. It reads them with its next message.</span>
          <textarea
            className="app-modal-input am-instructions"
            value={text}
            onChange={(e) => { setText(e.target.value); setNote(null); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); void save(); }
            }}
            maxLength={ORG_INSTRUCTIONS_MAX}
            rows={6}
            // Read only, never disabled, while saving: WebKit blurs a disabled focused box.
            readOnly={busy || !fresh}
            ref={area}
            data-testid="am-instructions"
          />
          <span className="am-count am-right" aria-hidden="true">{text.length} / {ORG_INSTRUCTIONS_MAX}</span>
        </label>
        {readError && (
          <p className="am-note am-error" role="alert" data-testid="am-read-error">
            Could not read the stored instructions. {readError}{' '}
            <button type="button" className="am-link" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
          </p>
        )}
        {note && <p className={`am-note${note.ok ? '' : ' am-error'}`} role={note.ok ? 'status' : 'alert'} data-testid="am-note">{note.text}</p>}

        <OwnMemory load={own} />
        {isMain && <WalnutMemory onOpen={openMemory} held={dirty} />}

        <div className="app-modal-actions">
          <button type="button" className="app-modal-btn" onClick={onClose} disabled={busy}>{dirty ? 'Cancel' : 'Close'}</button>
          <button type="button" className="app-modal-btn primary" onClick={() => { void save(); }} disabled={!dirty || busy || !fresh} data-testid="am-save">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
