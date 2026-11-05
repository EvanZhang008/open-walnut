import { useState, useMemo } from 'react';
import { disclosureIds, useRowDisclosure } from './row-disclosure';
import { ChevronRightIcon, PlayGlyphIcon } from '@/components/common/PhoneIcons';
import { createPortal } from 'react-dom';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import { findImagePaths, resolveImagePath } from '@/utils/markdown';
import { isUserDenied } from './tool-run-phrase';
import { AnswerText } from './RuleDetail';
import { answeredCallState, callAnswerText, callDecisionLabel, useDeniedNow, useSoleCall, useToolDecisions, useWaitingTools } from './waiting-tools';
import { bashCommandSummary, toolDescription } from '@open-walnut/tool-header-text';

// ── Bash tool call — terminal-style rendering ──
// Bash commands/output are shell text, not JSON: the command renders with real
// newlines under a `$` prompt and the output as a plain terminal pre (markdown
// would mangle kubectl/ls column output). An expand button opens a large popup
// with the untruncated command + output.

const INLINE_RESULT_LIMIT = 4000;

interface BashToolCallProps {
  tool: { name: string; input: Record<string, unknown>; toolUseId?: string };
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
  const [open, setOpen] = useRowDisclosure(disclosureIds.tool(tool.toolUseId), useSoleCall());
  const [popupOpen, setPopupOpen] = useState(false);

  const result = resultProp ?? (tool as { result?: string }).result;
  const failed = (tool as { isError?: boolean }).isError || statusProp === 'error';
  // The person said no: not a failure. Held by an open prompt: not running yet (waiting-tools.ts).
  const waitingTools = useWaitingTools();
  const decision = useToolDecisions().get(tool.toolUseId ?? '');
  const answered = answeredCallState(tool.toolUseId, decision, useDeniedNow());
  const denied = (failed && isUserDenied(result)) || (result === undefined && answered === 'denied');
  const waiting = !denied && result === undefined && !!tool.toolUseId && waitingTools.has(tool.toolUseId);
  // Sent beside a call whose prompt is open: the CLI runs nothing until it is answered.
  const queued = !waiting && !denied && !failed && !answered && result === undefined && waitingTools.size > 0;
  const status = waiting || queued ? 'waiting' : denied ? 'denied' : failed ? 'error' : statusProp;
  const input = (tool.input && typeof tool.input === 'object') ? tool.input : {};
  const command = typeof input.command === 'string' ? input.command : '';
  const rawDesc = typeof input.description === 'string' ? input.description.trim() : '';
  const description = toolDescription(input);

  // Collapsed summary: first line of the command (terminal one-liner, not JSON)
  const commandSummary = useMemo(() => bashCommandSummary(command), [command]);

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

  const statusIcon = status === 'waiting' ? '\u23F8\uFE0E' : status === 'denied' ? '\u2298' : status === 'error' ? '✗' : status === 'done' ? '✓' : <PlayGlyphIcon size={10} />;
  const statusClass = status === 'waiting' ? 'chat-tool-block-waiting' : status === 'denied' ? 'chat-tool-block-denied'
    : status === 'error' ? 'chat-tool-block-error'
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
        {status === 'waiting' && <span className="chat-tool-block-waiting-label">{queued ? 'Queued' : 'Waiting for approval'}</span>}
        {status !== 'waiting' && decision && <span className="chat-tool-block-decision" title={decision}><AnswerText text={callDecisionLabel(decision)} /></span>}
        <span className="chat-tool-block-arrow">{open ? '▼' : <ChevronRightIcon size={10} />}</span>
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
          {/* The whole answer, which the header line cuts to fit. */}
          {status !== 'waiting' && decision && (
            <div className="chat-tool-block-section">
              <div className="chat-tool-block-section-label">Answer</div>
              <div className="chat-tool-block-answer"><AnswerText text={callAnswerText(decision, command)} /></div>
            </div>
          )}
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
