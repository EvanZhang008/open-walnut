import { useState, useCallback, useMemo, memo } from 'react';
import type { SessionHistoryMessage, SessionHistoryTool } from '@/types/session';
import {
  renderMarkdownWithRefs, extractMarkdownFields, injectJsonIdLinks,
  extractContentBlockImages, findImagePaths, isImageFilePath, resolveImagePath,
} from '@/utils/markdown';
import { useEntityClickHandler } from '@/hooks/useEntityClickHandler';
import { useLivePlanContent } from '@/contexts/PlanContentContext';
import { fetchSubagentHistory } from '@/api/sessions';
import { getSubagentCache, setSubagentCache } from '@/cache/session-cache';
import { CopyMessageButtons } from '@/components/common/CopyMessageButtons';
import { log } from '@/utils/log';

// ── Edit Diff View ──

/** Simple line diff: finds common prefix and suffix lines, marks the middle as changed. */
function computeLineDiff(oldStr: string, newStr: string): { type: 'context' | 'removed' | 'added'; text: string }[] {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const result: { type: 'context' | 'removed' | 'added'; text: string }[] = [];

  // Find common prefix
  let prefixLen = 0;
  while (prefixLen < oldLines.length && prefixLen < newLines.length
    && oldLines[prefixLen] === newLines[prefixLen]) {
    prefixLen++;
  }

  // Find common suffix (from the end, not overlapping with prefix)
  let suffixLen = 0;
  while (suffixLen < oldLines.length - prefixLen && suffixLen < newLines.length - prefixLen
    && oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]) {
    suffixLen++;
  }

  // Prefix lines = context
  for (let i = 0; i < prefixLen; i++) {
    result.push({ type: 'context', text: oldLines[i] });
  }

  // Middle: removed from old, added from new
  const oldMiddleEnd = oldLines.length - suffixLen;
  const newMiddleEnd = newLines.length - suffixLen;

  for (let i = prefixLen; i < oldMiddleEnd; i++) {
    result.push({ type: 'removed', text: oldLines[i] });
  }
  for (let i = prefixLen; i < newMiddleEnd; i++) {
    result.push({ type: 'added', text: newLines[i] });
  }

  // Suffix lines = context
  for (let i = oldLines.length - suffixLen; i < oldLines.length; i++) {
    result.push({ type: 'context', text: oldLines[i] });
  }

  return result;
}

interface EditDiffViewProps {
  filePath: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
  status: 'calling' | 'done' | 'error';
  result?: string;
  onViewFile?: (path: string) => void;
}

function EditDiffView({ filePath, oldString, newString, replaceAll, status, result, onViewFile }: EditDiffViewProps) {
  const [collapsed, setCollapsed] = useState(false);
  const totalLines = oldString.split('\n').length + newString.split('\n').length;
  const isLarge = totalLines > 100;
  const [expanded, setExpanded] = useState(!isLarge);

  const diffLines = useMemo(
    () => computeLineDiff(oldString, newString),
    [oldString, newString],
  );

  const statusIcon = status === 'error' ? '\u2717' : status === 'done' ? '\u2713' : '\u25B6';
  const statusClass = status === 'error' ? 'chat-tool-block-error'
    : status === 'done' ? 'chat-tool-block-done' : 'chat-tool-block-calling';

  const filename = filePath.split('/').pop() ?? filePath;

  return (
    <div className={`chat-tool-block ${statusClass}`}>
      <button className="chat-tool-block-header" onClick={() => setCollapsed(p => !p)}>
        <span className="chat-tool-block-icon">{statusIcon}</span>
        <span className="chat-tool-block-name">Edit</span>
        <span className="edit-diff-filename" title={filePath}>{filename}</span>
        {replaceAll && <span className="edit-diff-replace-all">(replace all)</span>}
        {status === 'calling' && <span className="chat-tool-block-calling-dot" />}
        <span className="chat-tool-block-arrow">{collapsed ? '\u25B6' : '\u25BC'}</span>
        {onViewFile && (
          <span
            className="edit-diff-view-file"
            role="button"
            tabIndex={0}
            title="View full file"
            onClick={(e) => { e.stopPropagation(); onViewFile(filePath); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onViewFile(filePath); } }}
          >
            &#x1F4C4;
          </span>
        )}
      </button>
      {!collapsed && (
        <div className="edit-diff-body">
          {!expanded ? (
            <button className="edit-diff-expand" onClick={() => setExpanded(true)}>
              Show diff ({totalLines} lines)
            </button>
          ) : (
            <pre className="edit-diff-pre">
              {diffLines.map((dl, i) => (
                <div key={i} className={`edit-diff-line edit-diff-line--${dl.type}`}>
                  <span className="edit-diff-prefix">
                    {dl.type === 'removed' ? '-' : dl.type === 'added' ? '+' : ' '}
                  </span>
                  <span className="edit-diff-text">{dl.text || '\u00A0'}</span>
                </div>
              ))}
            </pre>
          )}
          {status === 'error' && result && (
            <div className="edit-diff-error">{result}</div>
          )}
        </div>
      )}
    </div>
  );
}

/** Hide the image's parent container on load error (broken remote images, etc.).
 *  Hides .tool-result-image-item if present (caption + img), else hides parent element. */
const hideOnImgError = (e: React.SyntheticEvent<HTMLImageElement>) => {
  const img = e.target as HTMLImageElement;
  const container = img.closest('.tool-result-image-item') ?? img.parentElement;
  if (container instanceof HTMLElement) container.style.display = 'none';
};

interface SessionMessageProps {
  message: SessionHistoryMessage;
  assistantLabel?: string;
  sessionId?: string;
  sessionCwd?: string;
  sessionHost?: string;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  onFileOpen?: (path: string, line?: number) => void;
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

  const handleExpandClick = useCallback(() => {
    // Open the unified plan modal (listened by SessionPanel / SessionDetailPanel)
    window.dispatchEvent(new CustomEvent('open-plan-modal'));
  }, []);

  return (
    <div className="session-plan-card">
      <div className="session-plan-card-header">
        <button className="session-plan-card-toggle" onClick={() => setOpen((p) => !p)}>
          <span className="session-plan-card-icon">{open ? '\u25BC' : '\u25B6'}</span>
          <span className="session-plan-card-title">Plan</span>
        </button>
        <button
          className="plan-card-expand-btn"
          onClick={handleExpandClick}
          title="Expand plan"
          aria-label="Expand plan to popup"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="10 2 14 2 14 6" />
            <polyline points="6 14 2 14 2 10" />
            <line x1="14" y1="2" x2="9" y2="7" />
            <line x1="2" y1="14" x2="7" y2="9" />
          </svg>
        </button>
      </div>
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
  /** Session host — used to resolve relative file paths on click (remote sessions) */
  sessionHost?: string;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  onFileOpen?: (path: string) => void;
}

export function GenericToolCall({ tool, status: statusProp = 'done', result: resultProp, sessionCwd, sessionHost, onTaskClick, onSessionClick, onFileOpen }: GenericToolCallProps) {
  const [open, setOpen] = useState(false);
  // Merge result from explicit prop (streaming path) and tool.result (persisted history path)
  const result = resultProp ?? (tool as { result?: string }).result;
  // Persisted history carries isError (tool_result.is_error) — a failed tool must
  // render ✗ after reload, matching what the streaming view showed live.
  const status = (tool as { isError?: boolean }).isError ? 'error' : statusProp;
  const safeInput = (tool.input && typeof tool.input === 'object') ? tool.input : {};
  const rawDesc = typeof safeInput.description === 'string' ? safeInput.description.trim() : '';
  const description = rawDesc ? (rawDesc.length > 120 ? rawDesc.slice(0, 120) + '...' : rawDesc) : null;
  const inputSummary = Object.entries(safeInput)
    .filter(([k]) => k !== 'description')
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
  const { resultImages, resultTextHtml } = useMemo<{
    resultImages: { src: string; key: string; caption?: string }[] | null;
    resultTextHtml: string;
  }>(() => {
    if (!open || !result) return { resultImages: null, resultTextHtml: '' };

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

  // Unified click handler for entity ref links (.task-link, .session-link, .file-link) inside tool blocks
  const handlePreClick = useEntityClickHandler(onTaskClick, onSessionClick, onFileOpen ? (p) => onFileOpen(p) : undefined, sessionHost);

  // [View File] button for tools that operate on files
  const toolFilePath = typeof safeInput.file_path === 'string' ? safeInput.file_path : null;
  const showViewFile = onFileOpen && toolFilePath && ['Edit', 'Read', 'Write', 'NotebookEdit'].includes(tool.name);

  return (
    <div className={`chat-tool-block ${statusClass}`}>
      <button className="chat-tool-block-header" onClick={() => setOpen((p) => !p)}>
        <span className="chat-tool-block-icon">{statusIcon}</span>
        <span className="chat-tool-block-name">{tool.name}</span>
        {description && (
          <span className="chat-tool-block-desc">· {description}</span>
        )}
        {!open && inputSummary && (
          <span className="chat-tool-block-summary">{inputSummary}</span>
        )}
        {status === 'calling' && <span className="chat-tool-block-calling-dot" />}
        <span className="chat-tool-block-arrow">{open ? '\u25BC' : '\u25B6'}</span>
        {showViewFile && (
          <span
            className="edit-diff-view-file"
            role="button"
            tabIndex={0}
            title="View full file"
            onClick={(e) => { e.stopPropagation(); onFileOpen!(toolFilePath!); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onFileOpen!(toolFilePath!); } }}
          >
            &#x1F4C4;
          </span>
        )}
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
  assistantLabel: string;
  sessionId?: string;
  sessionCwd?: string;
  sessionHost?: string;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  onFileOpen?: (path: string, line?: number) => void;
}

/** Tool names that should render as collapsible groups with child messages. */
const GROUPABLE_HISTORY_TOOLS = new Set(['Task', 'Agent']);

/** Short model label for the task-group header chip (full Bedrock IDs → "opus-4-8"). */
export function agentModelLabel(input?: Record<string, unknown>): string {
  const model = input?.model;
  if (typeof model !== 'string' || !model) return '';
  const last = model.split('.').pop() ?? model;
  return last.replace(/^claude-/, '').replace(/-v\d+.*$/, '').replace(/\[[^\]]*\]$/, '');
}

/** Collapsed-by-default row inside a task-group body exposing the subagent's
 *  full input: prompt text + remaining settings (model, effort, isolation…).
 *  Opt-in visibility — header stays uncluttered. */
export function TaskGroupPrompt({ input }: { input?: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const prompt = typeof input?.prompt === 'string' ? input.prompt : '';
  const settings = Object.entries(input ?? {})
    .filter(([k, v]) => k !== 'prompt' && k !== 'description' && v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  if (!prompt && settings.length === 0) return null;
  return (
    <div className="task-group-prompt">
      <button className="task-group-prompt-toggle" onClick={() => setOpen(p => !p)}>
        <span className="task-group-chevron">{open ? '▼' : '▶'}</span>
        <span className="task-group-prompt-title">Prompt &amp; settings</span>
        {!open && prompt && (
          <span className="task-group-prompt-preview">{prompt.slice(0, 120)}</span>
        )}
      </button>
      {open && (
        <div className="task-group-prompt-body">
          {settings.length > 0 && (
            <div className="task-group-prompt-settings">{settings.join(' · ')}</div>
          )}
          {prompt && <pre className="task-group-prompt-pre">{prompt}</pre>}
        </div>
      )}
    </div>
  );
}

/** Collapsible group for a Task/Agent tool call with child messages.
 *  Lazy-loads subagent content on first expand via API when childMessages is undefined. */
const TASK_GROUP_INITIAL = 10;
const TASK_GROUP_LOAD_MORE = 20;

function TaskGroup({ tool, assistantLabel, sessionId, sessionCwd, sessionHost, onTaskClick, onSessionClick, onFileOpen }: SessionToolCallProps) {
  const [open, setOpen] = useState(false);
  const [lazyChildren, setLazyChildren] = useState<SessionHistoryMessage[] | null>(null);
  const [loadingChildren, setLoadingChildren] = useState(false);
  const [innerOffset, setInnerOffset] = useState(0);

  const description = typeof tool.input?.description === 'string'
    ? tool.input.description
    : typeof tool.input?.prompt === 'string'
      ? (tool.input.prompt as string).slice(0, 80) + ((tool.input.prompt as string).length > 80 ? '...' : '')
      : tool.name;
  const subagentType = typeof tool.input?.subagent_type === 'string' ? tool.input.subagent_type : '';
  const modelChip = agentModelLabel(tool.input);
  const hasResult = !!tool.result;

  // Resolved children: inline (already attached) or lazy-loaded
  const children = tool.childMessages ?? lazyChildren;
  const toolCount = children?.reduce((n, m) => n + (m.tools?.length ?? 0), 0) ?? 0;

  const handleToggle = useCallback(async () => {
    if (!open && !children && !loadingChildren && tool.agentId && sessionId) {
      // Check frontend cache first
      const cached = getSubagentCache(sessionId, tool.agentId);
      if (cached) {
        setLazyChildren(cached);
      } else {
        // Lazy-load from backend
        setLoadingChildren(true);
        try {
          const result = await fetchSubagentHistory(sessionId, tool.agentId);
          setLazyChildren(result.messages);
          setSubagentCache(sessionId, tool.agentId, result.messages);
          log.info('session', `lazy-loaded subagent ${tool.agentId}: ${result.messages.length} msgs`);
        } catch (err) {
          log.warn('session', 'failed to lazy-load subagent', { agentId: tool.agentId, error: String(err) });
        } finally {
          setLoadingChildren(false);
        }
      }
    }
    setOpen(p => !p);
  }, [open, children, loadingChildren, tool.agentId, sessionId]);

  // Tail truncation: show most recent tool calls first (most relevant activity)
  // Inner truncation: only show last TASK_GROUP_INITIAL + innerOffset children
  const allChildren = children ?? [];
  const innerLimit = TASK_GROUP_INITIAL + innerOffset;
  const innerStart = Math.max(0, allChildren.length - innerLimit);
  const visibleChildren = allChildren.slice(innerStart);
  const hiddenCount = innerStart;

  return (
    <div className={`task-group ${open ? 'task-group--open' : ''}`}>
      <button className="task-group-header" onClick={handleToggle}>
        <span className="task-group-chevron">{open ? '\u25BC' : '\u25B6'}</span>
        <span className="task-group-icon">
          {loadingChildren ? '\u23F3' : hasResult ? '\u2713' : '\u25B6'}
        </span>
        <span className="task-group-label">{tool.name}</span>
        {subagentType && <span className="task-group-agent-type">{subagentType}</span>}
        {modelChip && <span className="task-group-model">{modelChip}</span>}
        <span className="task-group-description">{description}</span>
        {!open && toolCount > 0 && (
          <span className="task-group-badge">{toolCount} tool{toolCount !== 1 ? 's' : ''}</span>
        )}
      </button>
      {open && (
        <div className="task-group-body">
          <TaskGroupPrompt input={tool.input} />
          {loadingChildren ? (
            <div className="task-group-loading">Loading subagent history...</div>
          ) : allChildren.length > 0 ? (
            <>
              {hiddenCount > 0 && (
                <button
                  className="session-show-earlier-btn"
                  onClick={() => setInnerOffset(p => p + TASK_GROUP_LOAD_MORE)}
                >
                  Show {Math.min(hiddenCount, TASK_GROUP_LOAD_MORE)} earlier tool calls
                  <span className="session-show-earlier-count">({hiddenCount} hidden)</span>
                </button>
              )}
              {visibleChildren.map((child, ci) => (
                <SessionMessage key={innerStart + ci} message={child} assistantLabel={assistantLabel} sessionId={sessionId} sessionCwd={sessionCwd} sessionHost={sessionHost} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen} />
              ))}
            </>
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

function SessionToolCall({ tool, assistantLabel, sessionId, sessionCwd, sessionHost, onTaskClick, onSessionClick, onFileOpen }: SessionToolCallProps) {
  // Task/Agent tool with childMessages or agentId → render as collapsible group
  if (GROUPABLE_HISTORY_TOOLS.has(tool.name) && (tool.childMessages || tool.agentId || tool.result)) {
    return <TaskGroup tool={tool} assistantLabel={assistantLabel} sessionId={sessionId} sessionCwd={sessionCwd} sessionHost={sessionHost} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen} />;
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

  // Edit tool with old_string/new_string → render as diff view
  if (tool.name === 'Edit'
    && typeof tool.input?.file_path === 'string'
    && typeof tool.input?.old_string === 'string'
    && typeof tool.input?.new_string === 'string') {
    return (
      <EditDiffView
        filePath={tool.input.file_path}
        oldString={tool.input.old_string}
        newString={tool.input.new_string}
        replaceAll={tool.input.replace_all === true}
        status={((tool as { status?: string }).status === 'error' || (tool as { isError?: boolean }).isError) ? 'error' : 'done'}
        result={(tool as { result?: string }).result}
        onViewFile={onFileOpen ? (p) => onFileOpen(p) : undefined}
      />
    );
  }

  return <GenericToolCall tool={tool} sessionCwd={sessionCwd} sessionHost={sessionHost} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen ? (p) => onFileOpen(p) : undefined} />;
}

export const SessionMessage = memo(function SessionMessage({ message, assistantLabel = 'Claude Code', sessionId, sessionCwd, sessionHost, onTaskClick, onSessionClick, onFileOpen }: SessionMessageProps) {
  const { role, text, timestamp, tools, thinking, model, usage } = message;
  const time = formatTime(timestamp);
  const isUser = role === 'user';

  // System lines from persisted history (compact boundary, API errors, model
  // substitution notices) — same visual language as the streaming system blocks
  // (session-system-line), never a chat bubble.
  if (role === 'system') {
    const variant = message.systemVariant ?? 'info';
    const icon = variant === 'error' ? '⚠️' : variant === 'compact' ? '⚙️' : 'ℹ️';
    return (
      <div className={`session-system-line session-system-line--${variant}`}>
        <span className="session-system-icon">{icon}</span>
        <span className="session-system-text">{text}</span>
        {time && <span className="session-system-detail">{time}</span>}
      </div>
    );
  }

  // Interrupt marker — render as muted system banner, not a "You" bubble.
  // Claude CLI writes `[Request interrupted by user]` whenever its
  // AbortController fires without a reason — walnut's health-monitor idle
  // reap triggers it via SIGINT, but it's indistinguishable from a real
  // user-clicked Interrupt. Showing it as a blue "You" bubble is misleading.
  // Both CLI variants: "[Request interrupted by user]" and
  // "[Request interrupted by user for tool use]" (62 of the latter in corpus).
  if (isUser && text && /^\[Request interrupted by user( for tool use)?\]$/.test(text.trim())) {
    return (
      <div className="chat-interrupt-banner">
        <span className="chat-interrupt-icon">{'⏹'}</span>
        <span className="chat-interrupt-text">Turn interrupted</span>
        {time && <span className="chat-interrupt-time">{time}</span>}
      </div>
    );
  }

  // Detect image paths in assistant text and render inline previews
  const textImagePaths = useMemo(() => {
    if (!text || isUser) return [];
    return findImagePaths(text);
  }, [text, isUser]);

  // Unified click handler for entity ref links + file links in message content
  const handleContentClick = useEntityClickHandler(onTaskClick, onSessionClick, onFileOpen, sessionHost);

  return (
    <div className={`session-msg ${isUser ? 'session-msg-user' : 'session-msg-assistant'}`}>
      <div className="session-msg-header">
        <span className="session-msg-role">{isUser ? 'You' : assistantLabel}</span>
        {time && <span className="session-msg-time">{time}</span>}
        {!isUser && model && <span className="session-msg-model">{model}</span>}
      </div>
      <div className="session-msg-content" onClick={handleContentClick}>
        {thinking && <SessionThinking text={thinking} />}
        {tools && tools.length > 0 && tools.map((t, i) => (
          <SessionToolCall key={i} tool={t} assistantLabel={assistantLabel} sessionId={sessionId} sessionCwd={sessionCwd} sessionHost={sessionHost} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen} />
        ))}
        {text && (
          <div
            className="markdown-body"
            dangerouslySetInnerHTML={{ __html: renderMarkdownWithRefs(text, sessionCwd) }}
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
        {text && text.trim() && (
          <div className="session-msg-actions">
            <CopyMessageButtons markdown={text} />
          </div>
        )}
      </div>
      {!isUser && usage && (
        <div className="session-msg-meta">
          {usage.input_tokens.toLocaleString()} in / {usage.output_tokens.toLocaleString()} out
        </div>
      )}
    </div>
  );
});
