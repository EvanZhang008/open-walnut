import { useState, useRef, useEffect, useCallback } from 'react';

/**
 * NotesChatSwitcher — dropdown selector for the /notes chat column.
 *
 * The trigger shows the CURRENT selection's title (a Walnut Agent chat, or the
 * Claude Code session named after the note/folder it was started from) plus a
 * badge naming its KIND — "Walnut Agent" or "Claude Code" — no icon-decoding
 * required. The menu has two labeled groups mirroring those kinds; every
 * non-main row has its own close/delete ×.
 */

export interface SwitcherSession {
  key: string;
  label: string;
  /** Vault-relative folder the session was started from — rendered as a muted
   *  sublabel so same-named notes in different folders stay tellable apart. */
  folder?: string;
  error?: boolean;
  /** Still linking (no sessionId yet) — shown with a subtle "starting" hint. */
  pending?: boolean;
}

/** A named Walnut Agent (note-agent) side chat — key = its conversation id. */
export interface SwitcherAgentChat {
  key: string;
  label: string;
}

interface NotesChatSwitcherProps {
  sessions: SwitcherSession[];
  /** Side conversations of the built-in agent (main is always shown separately). */
  agentChats?: SwitcherAgentChat[];
  /** 'assistant' (main agent chat), an agent-chat key, or a session key. */
  active: string;
  onSelect: (key: string) => void;
  /** Close a CC session tab OR delete an agent side chat (dispatch by key). */
  onCloseSession: (key: string) => void;
}

export function NotesChatSwitcher({ sessions, agentChats = [], active, onSelect, onCloseSession }: NotesChatSwitcherProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Light-dismiss: click anywhere outside, or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const select = useCallback((key: string) => {
    onSelect(key);
    setOpen(false);
  }, [onSelect]);

  const currentSession = sessions.find((s) => s.key === active);
  const currentAgentChat = agentChats.find((c) => c.key === active);
  const title = currentSession?.label ?? currentAgentChat?.label ?? 'Note Agent';
  // Folder context in the trigger: "Areas/Records / vialto" reads as
  // "session in Areas/Records, started from vialto". Skip when it would just
  // repeat the label (folder target: label === last folder segment).
  const currentFolder = currentSession?.folder && !currentSession.folder.endsWith(currentSession.label)
    ? currentSession.folder : undefined;

  return (
    <div className="notes-chat-switcher" ref={rootRef}>
      <button
        className="notes-chat-switcher-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={currentSession
          ? `Claude Code — ${currentSession.folder ?? ''}${currentSession.folder ? '/' : ''}${currentSession.label}`
          : `Walnut Agent — ${title}`}
        onClick={() => setOpen((v) => !v)}
      >
        {currentFolder && (
          <>
            {/* Separator lives OUTSIDE the RTL-ellipsis span, else it renders first. */}
            <span className="notes-chat-switcher-folder">{currentFolder}</span>
            <span className="notes-chat-switcher-sep" aria-hidden>/</span>
          </>
        )}
        <span className="notes-chat-switcher-title">{title}</span>
        {/* Group badge — says which KIND of chat this pane is. */}
        <span className="notes-chat-switcher-badge">{currentSession ? 'Claude Code' : 'Walnut Agent'}</span>
        {currentSession?.pending && <span className="notes-chat-switcher-hint">starting…</span>}
        <span className={`notes-chat-switcher-caret${open ? ' open' : ''}`} aria-hidden>▾</span>
      </button>

      {open && (
        <div className="notes-chat-switcher-menu" role="listbox">
          {/* Two labeled groups — the kind of chat is stated, never implied. */}
          <div className="notes-chat-switcher-group notes-chat-switcher-group-first">Walnut Agent</div>
          <button
            role="option"
            aria-selected={active === 'assistant'}
            className={`notes-chat-switcher-item${active === 'assistant' ? ' active' : ''}`}
            onClick={() => select('assistant')}
          >
            <span className="notes-chat-switcher-item-label">Note Agent</span>
          </button>
          {agentChats.map((c) => (
            <div
              key={c.key}
              role="option"
              aria-selected={active === c.key}
              className={`notes-chat-switcher-item notes-chat-switcher-agent-chat${active === c.key ? ' active' : ''}`}
              onClick={() => select(c.key)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') select(c.key); }}
              tabIndex={0}
            >
              <span className="notes-chat-switcher-item-text" title={c.label}>
                <span className="notes-chat-switcher-item-label">{c.label}</span>
              </span>
              <button
                className="notes-chat-switcher-close"
                title="Delete chat"
                aria-label={`Delete chat ${c.label}`}
                onClick={(e) => { e.stopPropagation(); onCloseSession(c.key); }}
              >
                ×
              </button>
            </div>
          ))}

          {sessions.length > 0 && (
            <div className="notes-chat-switcher-group">Claude Code</div>
          )}
          {sessions.map((s) => (
            <div
              key={s.key}
              role="option"
              aria-selected={active === s.key}
              className={`notes-chat-switcher-item notes-chat-switcher-session${active === s.key ? ' active' : ''}${s.error ? ' error' : ''}`}
              onClick={() => select(s.key)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') select(s.key); }}
              tabIndex={0}
            >
              <span className="notes-chat-switcher-item-text" title={`${s.folder ? s.folder + '/' : ''}${s.label}`}>
                <span className="notes-chat-switcher-item-label">{s.label}</span>
                {s.folder && !s.folder.endsWith(s.label) && (
                  <span className="notes-chat-switcher-item-folder">{s.folder}</span>
                )}
              </span>
              {s.pending && <span className="notes-chat-switcher-hint">starting…</span>}
              {s.error && <span className="notes-chat-switcher-hint">failed</span>}
              <button
                className="notes-chat-switcher-close"
                title="Close session"
                aria-label={`Close session ${s.label}`}
                onClick={(e) => { e.stopPropagation(); onCloseSession(s.key); }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
