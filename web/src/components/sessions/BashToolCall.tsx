import { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import { findImagePaths, resolveImagePath } from '@/utils/markdown';

// ── Bash tool call — terminal-style rendering ──
// Bash commands/output are shell text, not JSON: the command renders with real
// newlines under a `$` prompt and the output as a plain terminal pre (markdown
// would mangle kubectl/ls column output). An expand button opens a large popup
// with the untruncated command + output.

const INLINE_RESULT_LIMIT = 4000;

interface BashToolCallProps {
  tool: { name: string; input: Record<string, unknown> };
  status?: 'calling' | 'done' | 'error';
  result?: string;
  sessionCwd?: string;
}

/** Large-popup view of the full command + output (PlanPopup shell, terminal body). */
function BashPopup({ command, description, output, onClose }: {
  command: string;
  description?: string;
  output?: string;
  onClose: () => void;
}) {
  useModalOverlay(onClose);
  return createPortal(
    <div className="plan-popup-overlay" role="dialog" aria-modal="true" aria-label="Bash command detail" onClick={onClose}>
      <div className="plan-popup-container" onClick={(e) => e.stopPropagation()}>
        <div className="plan-popup-header">
          <span className="plan-popup-title">
            Bash{description ? ` · ${description}` : ''}
          </span>
          <button className="plan-popup-close" onClick={onClose} aria-label="Close bash popup">&times;</button>
        </div>
        <div className="bash-popup-body">
          <div className="chat-tool-block-section-label">Command</div>
          <pre className="bash-tool-pre bash-popup-pre"><span className="bash-tool-prompt">$ </span>{command}</pre>
          {output !== undefined && (
            <>
              <div className="chat-tool-block-section-label">Output</div>
              <pre className="bash-tool-pre bash-popup-pre">{output || '(no output)'}</pre>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

const hideOnImgError = (e: React.SyntheticEvent<HTMLImageElement>) => {
  (e.target as HTMLImageElement).style.display = 'none';
};

export function BashToolCall({ tool, status: statusProp = 'done', result: resultProp, sessionCwd }: BashToolCallProps) {
  const [open, setOpen] = useState(false);
  const [popupOpen, setPopupOpen] = useState(false);

  const result = resultProp ?? (tool as { result?: string }).result;
  const status = (tool as { isError?: boolean }).isError ? 'error' : statusProp;
  const input = (tool.input && typeof tool.input === 'object') ? tool.input : {};
  const command = typeof input.command === 'string' ? input.command : '';
  const rawDesc = typeof input.description === 'string' ? input.description.trim() : '';
  const description = rawDesc ? (rawDesc.length > 120 ? rawDesc.slice(0, 120) + '...' : rawDesc) : null;

  // Collapsed summary: first line of the command (terminal one-liner, not JSON)
  const commandSummary = useMemo(() => {
    const firstLine = command.split('\n')[0];
    return firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine;
  }, [command]);

  // Screenshot-style image paths in output still get inline previews
  const resultImages = useMemo(() => {
    if (!open || !result) return null;
    const resolved = findImagePaths(result)
      .map((p, i) => {
        const abs = resolveImagePath(p, sessionCwd);
        return abs ? { src: `/api/local-image?path=${encodeURIComponent(abs)}`, key: `path-${i}`, caption: p } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return resolved.length > 0 ? resolved : null;
  }, [result, open, sessionCwd]);

  const inlineResult = result && result.length > INLINE_RESULT_LIMIT
    ? result.slice(0, INLINE_RESULT_LIMIT) + `\n… (${result.length - INLINE_RESULT_LIMIT} more chars — expand ⤢ for full output)`
    : result;

  const statusIcon = status === 'error' ? '✗' : status === 'done' ? '✓' : '▶';
  const statusClass = status === 'error' ? 'chat-tool-block-error'
    : status === 'done' ? 'chat-tool-block-done' : 'chat-tool-block-calling';

  return (
    <div className={`chat-tool-block ${statusClass}`}>
      <button className="chat-tool-block-header" onClick={() => setOpen((p) => !p)}>
        <span className="chat-tool-block-icon">{statusIcon}</span>
        <span className="chat-tool-block-name">Bash</span>
        {description && <span className="chat-tool-block-desc">· {description}</span>}
        {!open && !description && commandSummary && (
          <span className="chat-tool-block-summary">{commandSummary}</span>
        )}
        {status === 'calling' && <span className="chat-tool-block-calling-dot" />}
        <span className="chat-tool-block-arrow">{open ? '▼' : '▶'}</span>
        <span
          className="bash-tool-expand-btn"
          role="button"
          tabIndex={0}
          title="Expand command & output"
          aria-label="Expand command and output to popup"
          onClick={(e) => { e.stopPropagation(); setPopupOpen(true); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setPopupOpen(true); } }}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="10 2 14 2 14 6" />
            <polyline points="6 14 2 14 2 10" />
            <line x1="14" y1="2" x2="9" y2="7" />
            <line x1="2" y1="14" x2="7" y2="9" />
          </svg>
        </span>
      </button>
      {open && (
        <div className="chat-tool-block-body">
          <div className="chat-tool-block-section">
            <div className="chat-tool-block-section-label">Command</div>
            <pre className="bash-tool-pre"><span className="bash-tool-prompt">$ </span>{command}</pre>
          </div>
          {status !== 'calling' && result !== undefined && (
            <div className="chat-tool-block-section">
              <div className="chat-tool-block-section-label">Output</div>
              {resultImages && (
                <div className="tool-result-images">
                  {resultImages.map(img => (
                    <div key={img.key} className="tool-result-image-item">
                      <img src={img.src} className="inline-image" data-lightbox-src={img.src} loading="lazy" onError={hideOnImgError} />
                      {img.caption && <span className="inline-image-path">{img.caption}</span>}
                    </div>
                  ))}
                </div>
              )}
              <pre className="bash-tool-pre">{inlineResult || '(no output)'}</pre>
            </div>
          )}
        </div>
      )}
      {popupOpen && (
        <BashPopup
          command={command}
          description={rawDesc || undefined}
          output={status !== 'calling' ? (result ?? undefined) : undefined}
          onClose={() => setPopupOpen(false)}
        />
      )}
    </div>
  );
}
