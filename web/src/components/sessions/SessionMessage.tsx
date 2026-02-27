import { useState, useCallback, useMemo, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { SessionHistoryMessage, SessionHistoryTool } from '@/types/session';
import { renderMarkdownWithRefs, extractMarkdownFields, injectJsonIdLinks } from '@/utils/markdown';
import { useLivePlanContent } from '@/contexts/PlanContentContext';

interface SessionMessageProps {
  message: SessionHistoryMessage;
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

export interface GenericToolCallProps {
  tool: { name: string; input: Record<string, unknown> };
  /** Tool execution status. Defaults to 'done' (preserves history behavior). */
  status?: 'calling' | 'done' | 'error';
  /** Tool result text (streaming path provides this separately from tool.result). */
  result?: string;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
}

export function GenericToolCall({ tool, status = 'done', result, onTaskClick, onSessionClick }: GenericToolCallProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
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

  // Result rendered as markdown (only when expanded)
  const resultHtml = useMemo(() => {
    if (!open || !result) return '';
    return renderMarkdownWithRefs(result.length > 3000 ? result.slice(0, 3000) : result);
  }, [result, open]);

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
          </div>
          {resultHtml && (
            <div className="chat-tool-block-section">
              <div className="chat-tool-block-section-label">Result</div>
              <div className="chat-tool-block-result markdown-body"
                   dangerouslySetInnerHTML={{ __html: resultHtml }} />
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
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
}

/** Collapsible group for a Task tool call with child messages from subagent JSONL */
function TaskGroup({ tool, onTaskClick, onSessionClick }: SessionToolCallProps) {
  const [open, setOpen] = useState(false);
  const description = typeof tool.input?.description === 'string'
    ? tool.input.description
    : typeof tool.input?.prompt === 'string'
      ? (tool.input.prompt as string).slice(0, 80) + ((tool.input.prompt as string).length > 80 ? '...' : '')
      : 'Task';
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
        <span className="task-group-label">Task</span>
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
              <SessionMessage key={ci} message={child} onTaskClick={onTaskClick} onSessionClick={onSessionClick} />
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

function SessionToolCall({ tool, onTaskClick, onSessionClick }: SessionToolCallProps) {
  // Task tool with childMessages or agentId → render as collapsible TaskGroup
  if (tool.name === 'Task' && (tool.childMessages || tool.agentId || tool.result)) {
    return <TaskGroup tool={tool} onTaskClick={onTaskClick} onSessionClick={onSessionClick} />;
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

  return <GenericToolCall tool={tool} onTaskClick={onTaskClick} onSessionClick={onSessionClick} />;
}

export const SessionMessage = memo(function SessionMessage({ message, onTaskClick, onSessionClick }: SessionMessageProps) {
  const { role, text, timestamp, tools, thinking, model, usage } = message;
  const navigate = useNavigate();
  const time = formatTime(timestamp);
  const isUser = role === 'user';

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
          <SessionToolCall key={i} tool={t} onTaskClick={onTaskClick} onSessionClick={onSessionClick} />
        ))}
        {text && (
          <div
            className="markdown-body"
            dangerouslySetInnerHTML={{ __html: renderMarkdownWithRefs(text) }}
          />
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
