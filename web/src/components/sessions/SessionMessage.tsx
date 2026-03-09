import { useState, useCallback, useMemo, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { SessionHistoryMessage, SessionHistoryTool } from '@/types/session';
import {
  renderMarkdownWithRefs, extractMarkdownFields, injectJsonIdLinks,
  extractContentBlockImages, findImagePaths, isImageFilePath, resolveImagePath,
} from '@/utils/markdown';
import { useLivePlanContent } from '@/contexts/PlanContentContext';

/** Hide the image's parent container on load error (broken remote images, etc.).
 *  Hides .tool-result-image-item if present (caption + img), else hides parent element. */
const hideOnImgError = (e: React.SyntheticEvent<HTMLImageElement>) => {
  const img = e.target as HTMLImageElement;
  const container = img.closest('.tool-result-image-item') ?? img.parentElement;
  if (container instanceof HTMLElement) container.style.display = 'none';
};

interface SessionMessageProps {
  message: SessionHistoryMessage;
  sessionCwd?: string;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function SessionThinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="chat-thinking">
      <button className="chat-thinking-toggle" onClick={() => setOpen((p) => !p)}>
        <span className="chat-thinking-icon">{open ? '\u25BC' : '\u25B6'}</span>
        <span className="chat-thinking-label">Thinking</span>
      </button>
      {open && <div className="chat-thinking-content">{text}</div>}
    </div>
  );
}

/** Checks if a tool is a Write to ~/.claude/plans/ */
function isPlanWrite(tool: { name: string; input: Record<string, unknown> }): boolean {
  return tool.name === 'Write'
    && typeof tool.input?.file_path === 'string'
    && tool.input.file_path.includes('.claude/plans/');
}

/** Collapsed single-line row for Write to plans/ */
export function CollapsedPlanWrite({ filePath }: { filePath: string }) {
  const filename = filePath.split('/').pop() ?? filePath;
  return (
    <div className="session-plan-write-muted">
      <span className="chat-tool-block-icon">{'\u2713'}</span>
      <span>Wrote plan to <code>{filename}</code></span>
    </div>
  );
}

/** Accent-bordered card rendering the plan markdown, collapsible.
 *  Consumes PlanContentContext to show live plan content (bypasses memo).
 *  Falls back to the snapshot `content` prop when context is null (initial load, non-plan session). */
export function PlanCard({ content }: { content: string }) {
  const livePlan = useLivePlanContent();
  const displayContent = livePlan ?? content;
  const [open, setOpen] = useState(true);
  const html = useMemo(() => renderMarkdownWithRefs(displayContent), [displayContent]);
  return (
    <div className="session-plan-card">
      <button className="session-plan-card-header" onClick={() => setOpen((p) => !p)}>
        <span className="session-plan-card-icon">{open ? '\u25BC' : '\u25B6'}</span>
        <span className="session-plan-card-title">Plan</span>
      </button>
      {open && (
        <div className="session-plan-card-body">
          <div
            className="markdown-body"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      )}
    </div>
  );
}

/** HTML-escape a string for safe insertion into innerHTML */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface GenericToolCallProps {
  tool: { name: string; input: Record<string, unknown> };
  /** Tool execution status. Defaults to 'done' (preserves history behavior). */
  status?: 'calling' | 'done' | 'error';
  /** Tool result text (streaming path provides this separately from tool.result). */
  result?: string;
  /** Session working directory — used to resolve relative image paths */
  sessionCwd?: string;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
}

export function GenericToolCall({ tool, status = 'done', result: resultProp, sessionCwd, onTaskClick, onSessionClick }: GenericToolCallProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  // Merge result from explicit prop (streaming path) and tool.result (persisted history path)
  const result = resultProp ?? (tool as { result?: string }).result;
  const safeInput = (tool.input && typeof tool.input === 'object') ? tool.input : {};
  const inputSummary = Object.entries(safeInput)
    .map(([k, v]) => {
      const val = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k}: ${val.length > 60 ? val.slice(0, 60) + '...' : val}`;
    })
    .join(', ');

  // Dynamic icon and class based on status
  const statusIcon = status === 'error' ? '\u2717' : status === 'done' ? '\u2713' : '\u25B6';
  const statusClass = status === 'error' ? 'chat-tool-block-error'
    : status === 'done' ? 'chat-tool-block-done' : 'chat-tool-block-calling';

  // Detect long multiline string values in input and render as markdown.
  // Only computed when expanded (open) to avoid eager parsing cost.
  // Dependency is tool.input (stable ref) — safeInput creates a new {} each render when falsy.
  const markdownFields = useMemo(() => {
    if (!open || !tool.input) return [];
    const input = (typeof tool.input === 'object') ? tool.input : {};
    return extractMarkdownFields(input);
  }, [tool.input, open]);

  // Expanded JSON with pill links injected
  const expandedJsonHtml = useMemo(() => {
    if (!open) return '';
    const jsonStr = JSON.stringify(safeInput, null, 2);
    return injectJsonIdLinks(escapeHtml(jsonStr));
  }, [safeInput, open]);

  // Result rendering with image detection (base64 content blocks + file paths)
  const { resultImages, resultTextHtml } = useMemo(() => {
    if (!open || !result) return { resultImages: null as null | { src: string; key: string; caption?: string }[], resultTextHtml: '' };

    // 1. Check for Anthropic content blocks with base64 images
    const extracted = extractContentBlockImages(result);
    if (extracted) {
      const images = extracted.imageSrcs.map((src, i) => ({ src, key: `b64-${i}` }));
      const text = extracted.textParts.length > 0
        ? renderMarkdownWithRefs(extracted.textParts.join('\n').slice(0, 3000))
        : '';
      return { resultImages: images, resultTextHtml: text };
    }

    // 2. Check for image file paths in result text (skip unresolvable relative paths)
    const paths = findImagePaths(result);
    const resolved = paths
      .map((p, i) => {
        const abs = resolveImagePath(p, sessionCwd);
        return abs ? { src: `/api/local-image?path=${encodeURIComponent(abs)}`, key: `path-${i}`, caption: p } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const images = resolved.length > 0 ? resolved : null;

    // 3. Render remaining text as markdown (with truncation)
    const text = renderMarkdownWithRefs(result.length > 3000 ? result.slice(0, 3000) : result);
    return { resultImages: images, resultTextHtml: text };
  }, [result, open, sessionCwd]);

  // Input image preview: if file_path/path/filename points to an image file, show thumbnail
  const inputImageSrc = useMemo(() => {
    if (!open) return null;
    const fp = safeInput.file_path ?? safeInput.path ?? safeInput.filename;
    if (typeof fp !== 'string' || !isImageFilePath(fp)) return null;
    // Skip if result already has images (avoids showing same image twice for Read tool)
    if (resultImages && resultImages.length > 0) return null;
    const resolved = resolveImagePath(fp, sessionCwd);
    return resolved ? `/api/local-image?path=${encodeURIComponent(resolved)}` : null;
  }, [safeInput, open, resultImages, sessionCwd]);

  // Click handler for pill links inside <pre> (event delegation)
  const handlePreClick = useCallback((e: React.MouseEvent<HTMLPreElement>) => {
    const target = e.target as HTMLElement;
    const taskAnchor = target.closest('a.task-link') as HTMLAnchorElement | null;
    if (taskAnchor) {
      const taskId = taskAnchor.dataset.taskId;
      if (taskId) {
        e.preventDefault();
        onTaskClick ? onTaskClick(taskId) : navigate(`/tasks/${taskId}`);
      }
      return;
    }
    const sessionAnchor = target.closest('a.session-link') as HTMLAnchorElement | null;
    if (sessionAnchor) {
      const sessionId = sessionAnchor.dataset.sessionId;
      if (sessionId) {
        e.preventDefault();
        onSessionClick ? onSessionClick(sessionId) : navigate(`/sessions?id=${sessionId}`);
      }
    }
  }, [navigate, onTaskClick, onSessionClick]);

  return (
    <div className={`chat-tool-block ${statusClass}`}>
      <button className="chat-tool-block-header" onClick={() => setOpen((p) => !p)}>
        <span className="chat-tool-block-icon">{statusIcon}</span>
        <span className="chat-tool-block-name">{tool.name}</span>
        {!open && inputSummary && (
          <span className="chat-tool-block-summary">{inputSummary}</span>
        )}
        {status === 'calling' && <span className="chat-tool-block-calling-dot" />}
        <span className="chat-tool-block-arrow">{open ? '\u25BC' : '\u25B6'}</span>
      </button>
      {open && (
        <div className="chat-tool-block-body">
          <div className="chat-tool-block-section">
            <div className="chat-tool-block-section-label">Input</div>
            <pre className="chat-tool-block-pre" onClick={handlePreClick} dangerouslySetInnerHTML={{ __html: expandedJsonHtml }} />
            {markdownFields.map(f => (
              <div key={f.key} className="chat-tool-block-field-markdown">
                <div className="chat-tool-block-field-label">{f.key}</div>
                <div className="chat-tool-block-result markdown-body"
                     dangerouslySetInnerHTML={{ __html: f.html }} />
              </div>
            ))}
            {inputImageSrc && (
              <div className="tool-result-images">
                <img src={inputImageSrc} className="inline-image" data-lightbox-src={inputImageSrc} loading="lazy" onError={hideOnImgError} />
              </div>
            )}
          </div>
          {status !== 'calling' && (resultImages || resultTextHtml) && (
            <div className="chat-tool-block-section">
              <div className="chat-tool-block-section-label">Result</div>
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
              {resultTextHtml && (
                <div className="chat-tool-block-result markdown-body"
                     dangerouslySetInnerHTML={{ __html: resultTextHtml }} />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Extract plan content from an ExitPlanMode tool — checks planContent field, then input.plan */
function getExitPlanContent(tool: { input: Record<string, unknown>; planContent?: string }): string | null {
  if (tool.planContent) return tool.planContent;
  if (typeof tool.input?.plan === 'string' && tool.input.plan) return tool.input.plan;
  return null;
}

interface SessionToolCallProps {
  tool: SessionHistoryTool;
  sessionCwd?: string;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
}

/** Tool names that should render as collapsible groups with child messages. */
const GROUPABLE_HISTORY_TOOLS = new Set(['Task', 'Agent']);

/** Collapsible group for a Task/Agent tool call with child messages */
function TaskGroup({ tool, sessionCwd, onTaskClick, onSessionClick }: SessionToolCallProps) {
  const [open, setOpen] = useState(false);
  const description = typeof tool.input?.description === 'string'
    ? tool.input.description
    : typeof tool.input?.prompt === 'string'
      ? (tool.input.prompt as string).slice(0, 80) + ((tool.input.prompt as string).length > 80 ? '...' : '')
      : tool.name;
  const subagentType = typeof tool.input?.subagent_type === 'string' ? tool.input.subagent_type : '';
  const childCount = tool.childMessages?.length ?? 0;
  const toolCount = tool.childMessages?.reduce((n, m) => n + (m.tools?.length ?? 0), 0) ?? 0;
  const hasResult = !!tool.result;

  return (
    <div className={`task-group ${open ? 'task-group--open' : ''}`}>
      <button className="task-group-header" onClick={() => setOpen(p => !p)}>
        <span className="task-group-chevron">{open ? '\u25BC' : '\u25B6'}</span>
        <span className="task-group-icon">
          {hasResult ? '\u2713' : '\u25B6'}
        </span>
        <span className="task-group-label">{tool.name}</span>
        {subagentType && <span className="task-group-agent-type">{subagentType}</span>}
        <span className="task-group-description">{description}</span>
        {!open && toolCount > 0 && (
          <span className="task-group-badge">{toolCount} tool{toolCount !== 1 ? 's' : ''}</span>
        )}
      </button>
      {open && (
        <div className="task-group-body">
          {tool.childMessages && tool.childMessages.length > 0 ? (
            tool.childMessages.map((child, ci) => (
              <SessionMessage key={ci} message={child} sessionCwd={sessionCwd} onTaskClick={onTaskClick} onSessionClick={onSessionClick} />
            ))
          ) : tool.result ? (
            <div className="task-group-result">
              <div className="task-group-result-label">Result</div>
              <div className="markdown-body" dangerouslySetInnerHTML={{
                __html: renderMarkdownWithRefs(tool.result.slice(0, 3000))
              }} />
            </div>
          ) : (
            <div className="task-group-empty">No subagent data available</div>
          )}
        </div>
      )}
    </div>
  );
}

function SessionToolCall({ tool, sessionCwd, onTaskClick, onSessionClick }: SessionToolCallProps) {
  // Task/Agent tool with childMessages or agentId → render as collapsible group
  if (GROUPABLE_HISTORY_TOOLS.has(tool.name) && (tool.childMessages || tool.agentId || tool.result)) {
    return <TaskGroup tool={tool} sessionCwd={sessionCwd} onTaskClick={onTaskClick} onSessionClick={onSessionClick} />;
  }

  // ExitPlanMode with plan content → render PlanCard
  const exitPlanContent = tool.name === 'ExitPlanMode' ? getExitPlanContent(tool) : null;
  if (exitPlanContent) {
    return <PlanCard content={exitPlanContent} />;
  }

  // Write to plans → collapsed row
  if (isPlanWrite(tool)) {
    return <CollapsedPlanWrite filePath={tool.input.file_path as string} />;
  }

  return <GenericToolCall tool={tool} sessionCwd={sessionCwd} onTaskClick={onTaskClick} onSessionClick={onSessionClick} />;
}

export const SessionMessage = memo(function SessionMessage({ message, sessionCwd, onTaskClick, onSessionClick }: SessionMessageProps) {
  const { role, text, timestamp, tools, thinking, model, usage } = message;
  const navigate = useNavigate();
  const time = formatTime(timestamp);
  const isUser = role === 'user';

  // Detect image paths in assistant text and render inline previews
  const textImagePaths = useMemo(() => {
    if (!text || isUser) return [];
    return findImagePaths(text);
  }, [text, isUser]);

  // Intercept clicks on entity ref links for SPA navigation
  const handleContentClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const taskAnchor = target.closest('a.task-link') as HTMLAnchorElement | null;
    if (taskAnchor) {
      const taskId = taskAnchor.dataset.taskId;
      if (taskId) {
        e.preventDefault();
        onTaskClick ? onTaskClick(taskId) : navigate(`/tasks/${taskId}`);
      }
      return;
    }
    const sessionAnchor = target.closest('a.session-link') as HTMLAnchorElement | null;
    if (sessionAnchor) {
      const sessionId = sessionAnchor.dataset.sessionId;
      if (sessionId) {
        e.preventDefault();
        onSessionClick ? onSessionClick(sessionId) : navigate(`/sessions?id=${sessionId}`);
      }
    }
  }, [navigate, onTaskClick, onSessionClick]);

  return (
    <div className={`session-msg ${isUser ? 'session-msg-user' : 'session-msg-assistant'}`}>
      <div className="session-msg-header">
        <span className="session-msg-role">{isUser ? 'You' : 'Walnut'}</span>
        {time && <span className="session-msg-time">{time}</span>}
        {!isUser && model && <span className="session-msg-model">{model}</span>}
      </div>
      <div className="session-msg-content" onClick={handleContentClick}>
        {thinking && <SessionThinking text={thinking} />}
        {tools && tools.length > 0 && tools.map((t, i) => (
          <SessionToolCall key={i} tool={t} sessionCwd={sessionCwd} onTaskClick={onTaskClick} onSessionClick={onSessionClick} />
        ))}
        {text && (
          <div
            className="markdown-body"
            dangerouslySetInnerHTML={{ __html: renderMarkdownWithRefs(text) }}
          />
        )}
        {textImagePaths.length > 0 && (() => {
          const resolved = textImagePaths
            .map((p) => ({ p, abs: resolveImagePath(p, sessionCwd) }))
            .filter((x): x is { p: string; abs: string } => x.abs !== null);
          if (resolved.length === 0) return null;
          return (
            <div className="tool-result-images">
              {resolved.map(({ p, abs }, i) => {
                const src = `/api/local-image?path=${encodeURIComponent(abs)}`;
                return (
                  <div key={i} className="tool-result-image-item">
                    <img src={src} className="inline-image" data-lightbox-src={src} loading="lazy" onError={hideOnImgError} />
                    <span className="inline-image-path">{p}</span>
                  </div>
                );
              })}
            </div>
          );
        })()}
      </div>
      {!isUser && usage && (
        <div className="session-msg-meta">
          {usage.input_tokens.toLocaleString()} in / {usage.output_tokens.toLocaleString()} out
        </div>
      )}
    </div>
  );
});
