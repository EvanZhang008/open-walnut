import { useMemo, useState, useCallback, memo, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { Task } from '@open-walnut/core';
import type { MessageBlock, ThinkingBlock, ToolCallBlock, ImageBlock, TaskContext, ImageAttachment } from '@/hooks/useChat';
import { useLightbox } from '@/hooks/useLightbox';
import { useEntityClickHandler } from '@/hooks/useEntityClickHandler';
import { useNotesAwareFileOpen } from '@/hooks/useNotesAwareFileOpen';
import { Lightbox } from '@/components/common/Lightbox';
import { FileViewer } from '@/components/common/FileViewer';
import { entityRefsToHtml, renderToolResultWithRefs, extractMarkdownFields, renderMarkdownWithRefs } from '@/utils/markdown';
import { parseAskQuestionInput } from './QuestionPopover';
import { SubagentBlock } from './SubagentBlock';
import { getErrorSuggestion } from '@/utils/error-suggestions';
import { ErrorSuggestionLink } from '@/components/common/ErrorSuggestionLink';
export interface RouteInfo {
  direction: 'sent' | 'received';
  event: string;
  sessionId?: string;
  taskId?: string;
  payload?: Record<string, unknown>;
}

interface ChatMessageProps {
  role: 'user' | 'assistant';
  content: string;
  blocks?: MessageBlock[];
  images?: ImageAttachment[];
  taskContext?: TaskContext;
  routeInfo?: RouteInfo;
  timestamp?: string;
  source?: 'cron' | 'triage' | 'session' | 'session-error' | 'agent-error' | 'subagent' | 'compaction' | 'compacting' | 'heartbeat' | 'quick-start' | 'quick-start-echo';
  cronJobName?: string;
  notification?: boolean;
  queued?: boolean;
  onCancel?: () => void;
  taskLookup?: Map<string, Task>;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
}

// Configure marked for safe rendering
marked.setOptions({
  breaks: true,
  gfm: true,
});

// Task ID pattern with human-readable title: [<id>|<title>]
// e.g. [m1k5q7zr8-a3f1|HomeLab / Fix tax filing] — renders as a clickable pill showing the title
const TASK_ID_TITLED_RE = /\[([a-z0-9]{7,10}-[a-f0-9]{4})\|([^\]]+)\]/;
// ⚠ PERF: marked calls each inline extension's start() once per inline token
// with src = the ENTIRE remaining text. An unbounded scan there is quadratic
// in message size (a 15KB transcript message costs seconds; this froze page
// boot for 10-16s on 2026-07-23 — and marked.use() mutates the GLOBAL marked
// singleton, so these extensions also run inside renderMarkdownWithRefs for
// every session message). Two rules keep it linear:
//   1. tokenizer() only accepts matches at index 0 → use a ^-anchored twin
//      (O(1) reject instead of scanning the tail).
//   2. start() scans a BOUNDED WINDOW of the tail. When nothing matches in
//      the window, it returns the window boundary as a bogus hint — marked
//      cuts the inlineText token there and calls start() again on the rest,
//      so the lexer advances in ≤window steps (linear total) and a match
//      beyond the window is still found by a later call. Without the bogus
//      hint, inlineText (which does NOT stop at '/') would swallow a
//      special-char-free run past the match and the token would be lost.
const START_SCAN_WINDOW = 2048;
// Slack so a match STARTING inside the window isn't cut mid-path by the slice.
const START_SCAN_SLACK = 1024;
const TASK_ID_TITLED_AT_START_RE = new RegExp(`^${TASK_ID_TITLED_RE.source}`);

// Image path patterns that should render as inline <img> tags:
// 1. /api/images/<hash>.ext — uploaded images served by the app
// 2. /api/local-image?path=... — already-proxied local image URLs
// 3. Absolute Unix paths with 2+ segments (/dir/file.png) — local files proxied via /api/local-image
//    Allows spaces in paths (common in macOS screenshots like "Screenshot 2026-02-17 at 11.12.47 PM.png")
const IMAGE_PATH_RE = /(\/api\/(?:images|local-image\?path=)[\w./%?=&-]+\.(?:png|jpe?g|gif|webp)|\/[\w. /-]+\/[\w. -]+\.(?:png|jpe?g|gif|webp))/i;
// Anchored twin for tokenizer() (see PERF note above). The `\/[\w. /-]+\/…`
// alternative backtracks heavily on long path-ish runs (dir listings, file
// dumps); anchoring bounds the scan to the run at src[0] instead of the tail.
const IMAGE_PATH_AT_START_RE = new RegExp(`^${IMAGE_PATH_RE.source}`, 'i');
// Cheap start() precheck: most messages contain no image extension at all —
// a simple alternation test (no backtracking) prunes the expensive scan.
const IMAGE_EXT_HINT_RE = /\.(?:png|jpe?g|gif|webp)/i;
// Global-flag twin for the start() scan loop — lastIndex stepping replaces
// the old slice(offset) loop, which copied the remaining string per step.
const IMAGE_PATH_SCAN_RE = new RegExp(IMAGE_PATH_RE.source, 'ig');

/** Check if a local URL matches an image path that should be rendered inline */
function isImageHref(href: string): boolean {
  // Only match local paths (starting with /) to avoid hijacking external URLs
  return href.startsWith('/') && IMAGE_PATH_RE.test(href);
}

/** Extract /api/images/... path from a full URL like http://localhost:3456/api/images/xxx.png */
function extractApiImagePath(href: string): string | null {
  const m = href.match(/\/api\/images\/[\w.%-]+\.(?:png|jpe?g|gif|webp)/i);
  return m ? m[0] : null;
}

/** HTML-escape a string for safe insertion */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Build an inline image tag from an image path */
function renderImageTag(imgPath: string): string {
  const isApiUrl = imgPath.startsWith('/api/');
  const src = isApiUrl ? imgPath : `/api/local-image?path=${encodeURIComponent(imgPath)}`;
  const escapedSrc = escapeHtml(src);
  const filename = imgPath.split('/').pop()?.split('?')[0] || imgPath;
  return `<img src="${escapedSrc}" alt="${escapeHtml(filename)}" class="inline-image" data-lightbox-src="${escapedSrc}" loading="lazy" />`;
}

/** Build image + caption block: image preview with the path text shown below */
function renderImageBlock(imgPath: string, captionText: string): string {
  return `<span class="inline-image-block">${renderImageTag(imgPath)}<span class="inline-image-path">${escapeHtml(captionText)}</span></span>`;
}

marked.use({
  renderer: {
    // Override codespan renderer: detect image paths inside backtick code spans.
    // Only matches when the entire code span is an image path (avoids false positives
    // on code like `convert /tmp/foo.png to jpg`).
    codespan({ text }) {
      const decoded = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
      const m = decoded.trim().match(IMAGE_PATH_RE);
      if (m && m[0] === decoded.trim()) {
        return renderImageBlock(m[1], decoded.trim());
      }
      return false as unknown as string;
    },
    // Override link renderer: when href points to an image path, render as image + caption
    link({ href, tokens }) {
      if (href) {
        // Check local image paths
        if (isImageHref(href)) {
          const text = this.parser.parseInline(tokens).replace(/<[^>]*>/g, '');
          const caption = (text && text !== href) ? text : href;
          return renderImageBlock(href, caption);
        }
        // Check full URLs containing /api/images/ (e.g. http://localhost:3456/api/images/xxx.png)
        const apiPath = extractApiImagePath(href);
        if (apiPath) {
          const text = this.parser.parseInline(tokens).replace(/<[^>]*>/g, '');
          const caption = (text && text !== href) ? text : href;
          return renderImageBlock(apiPath, caption);
        }
      }
      // marked v15: return false to fall through to the default link renderer
      return false as unknown as string;
    },
  },
  extensions: [
    {
      name: 'taskLink',
      level: 'inline',
      start(src: string) {
        // Bounded window (see PERF note): full-tail scans here are quadratic.
        const windowed = src.length > START_SCAN_WINDOW + START_SCAN_SLACK;
        const hay = windowed ? src.slice(0, START_SCAN_WINDOW + START_SCAN_SLACK) : src;
        // Precheck: no '[' → no possible match in the window; skips the regex.
        if (hay.includes('[')) {
          const idx = hay.match(TASK_ID_TITLED_RE)?.index;
          // Windowed: reject slack-region hits (cut mid-window is unreliable);
          // the boundary hint below re-scans them next round. Unwindowed: hay
          // is the full src, any hit is trustworthy.
          if (idx !== undefined && (!windowed || idx < START_SCAN_WINDOW)) return idx;
        }
        // Nothing in the window: hint the boundary so marked cuts the text
        // token there and re-runs start() on the rest (see PERF note).
        return windowed ? START_SCAN_WINDOW : undefined;
      },
      tokenizer(src: string) {
        // marked v15: start() hints where the token begins, but tokenizer receives
        // src already sliced to that position — match must be at index 0. Use the
        // anchored twin so a non-match rejects in O(1) instead of scanning the tail.
        const match = TASK_ID_TITLED_AT_START_RE.exec(src);
        if (match && match.index === 0) {
          return {
            type: 'taskLink',
            raw: match[0],
            taskId: match[1],
            title: match[2],
          };
        }
      },
      renderer(token) {
        const { taskId, title } = token as unknown as { taskId: string; title: string };
        const escaped = escapeHtml(title);
        return `<a href="/tasks/${taskId}" class="task-link" data-task-id="${taskId}">${escaped}</a>`;
      },
    },
    {
      name: 'imagePath',
      level: 'inline',
      start(src: string) {
        // Bounded window (see PERF note): full-tail scans here are quadratic.
        const windowed = src.length > START_SCAN_WINDOW + START_SCAN_SLACK;
        const hay = windowed ? src.slice(0, START_SCAN_WINDOW + START_SCAN_SLACK) : src;
        // Precheck: no image extension in the window → no possible match. This
        // is the common case; skips the backtracking-prone path regex entirely.
        if (IMAGE_EXT_HINT_RE.test(hay)) {
          // Find first match preceded by whitespace or start-of-text (not
          // mid-URL/code). lastIndex stepping — no per-step slice() copies.
          IMAGE_PATH_SCAN_RE.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = IMAGE_PATH_SCAN_RE.exec(hay)) !== null) {
            // Windowed: slack-region hits defer to the boundary hint (a match
            // cut mid-window is unreliable). Unwindowed: hay is the full src.
            if (windowed && m.index >= START_SCAN_WINDOW) break;
            if (m.index === 0 || /\s/.test(hay[m.index - 1])) return m.index;
            IMAGE_PATH_SCAN_RE.lastIndex = m.index + 1;
          }
        }
        // Nothing in the window: hint the boundary so marked cuts the text
        // token there and re-runs start() on the rest (see PERF note).
        return windowed ? START_SCAN_WINDOW : undefined;
      },
      tokenizer(src: string) {
        // Must match at start of src (marked slices to our start() index) —
        // anchored twin rejects non-matches without scanning the whole tail.
        const match = IMAGE_PATH_AT_START_RE.exec(src);
        if (!match) return;
        return {
          type: 'imagePath',
          raw: match[0],
          path: match[1],
        };
      },
      renderer(token) {
        const { path: imgPath } = token as unknown as { path: string };
        return renderImageBlock(imgPath, imgPath);
      },
    },
  ],
});

function formatTimestamp(ts: string | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function renderMarkdown(text: string): string {
  const preprocessed = entityRefsToHtml(text);
  const raw = marked.parse(preprocessed);
  return typeof raw === 'string' ? DOMPurify.sanitize(raw, { ADD_ATTR: ['data-task-id', 'data-session-id', 'data-lightbox-src', 'loading'] }) : '';
}

/** Inline-only markdown: renders bold, links, task pills — no <p> wrapper.
 *  Used for single-line contexts like collapsed summaries. */
export function renderInlineMarkdown(text: string): string {
  const preprocessed = entityRefsToHtml(text);
  const raw = marked.parseInline(preprocessed);
  return typeof raw === 'string' ? DOMPurify.sanitize(raw, { ADD_ATTR: ['data-task-id', 'data-session-id', 'data-lightbox-src', 'loading'] }) : '';
}

/**
 * Render user message text preserving ALL newlines exactly as typed.
 * Unlike renderMarkdown, this does NOT use the markdown parser — user messages
 * are plain text where every \n must appear as a line break. Multiple consecutive
 * blank lines are preserved (not collapsed into paragraph breaks).
 *
 * Entity refs (<task-ref>, <session-ref>) are still converted to clickable pills.
 */
export function renderUserMessage(text: string): string {
  // 1. Process entity refs BEFORE escaping (they contain < > which we need to keep)
  const withRefs = entityRefsToHtml(text);

  // 2. Split around already-converted <a> tags so we only escape plain text parts
  //    Entity refs produce <a href="..." class="..." data-...>label</a>
  const parts = withRefs.split(/(<a\s[^>]*>.*?<\/a>)/g);
  const escaped = parts.map(part => {
    if (part.startsWith('<a ')) return part; // keep entity ref anchors as-is
    return part
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }).join('');

  // 3. Convert every newline to <br> — this is the key: ALL newlines preserved
  const withBreaks = escaped.replace(/\n/g, '<br>');

  // 4. Sanitize
  return DOMPurify.sanitize(withBreaks, {
    ADD_ATTR: ['data-task-id', 'data-session-id'],
    ADD_TAGS: ['br'],
  });
}

function CompactionDetails({ details }: { details: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="chat-compaction-details">
      <button className="chat-compaction-details-toggle" onClick={() => setOpen(p => !p)}>
        <span className="chat-compaction-details-icon">{open ? '\u25BC' : '\u25B6'}</span>
        <span className="chat-compaction-details-label">
          {open ? 'Hide compaction details' : 'Show compaction details'}
        </span>
      </button>
      {open && (
        <div
          className="chat-compaction-details-content markdown-body"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(details) }}
        />
      )}
    </div>
  );
}

// Phase symbols matching StatusBadge (inline, no import needed)
const PHASE_SYMBOLS: Record<string, string> = {
  TODO: '\u25CB', IN_PROGRESS: '\u25D0', AGENT_COMPLETE: '\u2713',
  AWAIT_HUMAN_ACTION: '\u229A', HUMAN_VERIFIED: '\u2705',
  POST_WORK_COMPLETED: '\uD83D\uDCE6', COMPLETE: '\u2713\u2713',
};

// Truncation limits matching buildTaskContextPrefix in src/web/routes/chat.ts:128-188
const TRUNC = { description: 300, summary: 200, note: 500, conversationLog: 400 } as const;

function truncText(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) + ' [truncated]' : text;
}

/** Tail-truncate conversation log, snapping to nearest ### heading (matches backend logic) */
function truncConversationLog(log: string): string {
  if (log.length <= TRUNC.conversationLog) return log;
  const raw = log.slice(log.length - TRUNC.conversationLog);
  const headingIdx = raw.indexOf('### ');
  const tail = headingIdx >= 0 ? raw.slice(headingIdx) : raw;
  return '[older entries omitted]\n' + tail.trim();
}

interface TaskContextSectionProps {
  ctx: TaskContext;
  onSessionClick?: (sessionId: string) => void;
}

function TaskContextSection({ ctx, onSessionClick }: TaskContextSectionProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const subtasksDone = ctx.subtasks?.filter(s => s.done).length ?? 0;
  const subtasksTotal = ctx.subtasks?.length ?? 0;

  const handleSessionClick = useCallback((id: string) => {
    if (onSessionClick) onSessionClick(id);
    else navigate(`/sessions?id=${id}`);
  }, [onSessionClick, navigate]);

  const hasDescription = !!ctx.description;
  const hasSummary = !!ctx.summary;
  const hasNote = !!ctx.note;
  const hasConvLog = !!ctx.conversation_log;
  const hasPlanSession = !!ctx.plan_session_id;
  const hasExecSession = !!ctx.exec_session_id;
  const hasSessions = hasPlanSession || hasExecSession;
  const hasSubtasks = (ctx.subtasks?.length ?? 0) > 0;

  return (
    <div className="chat-task-context">
      <button className="chat-task-context-toggle" onClick={() => setOpen(p => !p)}>
        <span className="chat-task-context-icon">{open ? '\u25BC' : '\u25B6'}</span>
        <span className="chat-task-context-label">
          Task Context &middot; {ctx.title}
        </span>
        <span className="chat-task-context-badges">
          {ctx.phase && (
            <span className={`badge badge-phase-${ctx.phase.toLowerCase()}`}>
              {PHASE_SYMBOLS[ctx.phase] ?? '?'} {ctx.phase.replace(/_/g, ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase())}
            </span>
          )}
          {ctx.priority && ctx.priority !== 'none' && (
            <span className="badge" style={{ color: ctx.priority === 'high' ? 'var(--error)' : ctx.priority === 'medium' ? 'var(--warning)' : 'var(--fg-muted)' }}>
              {ctx.priority === 'high' ? '!!' : ctx.priority === 'medium' ? '!' : '\u2013'} {ctx.priority}
            </span>
          )}
          {ctx.starred && <span style={{ fontSize: 11, color: 'var(--warning)' }}>{'\u2605'}</span>}
          {subtasksTotal > 0 && (
            <span style={{ fontSize: 10, color: 'var(--fg-muted)' }}>{subtasksDone}/{subtasksTotal}</span>
          )}
        </span>
      </button>
      {open && (
        <div className="chat-task-context-content">
          {/* Metadata row */}
          <div className="chat-task-context-meta">
            <span><strong>ID:</strong> {ctx.id}</span>
            {ctx.category && (
              <span><strong>Category:</strong> {ctx.category}{ctx.project && ctx.project !== ctx.category ? ` / ${ctx.project}` : ''}</span>
            )}
            {ctx.source && <span><strong>Source:</strong> {ctx.source}</span>}
            {ctx.due_date && <span><strong>Due:</strong> {ctx.due_date}</span>}
            {ctx.created_at && <span><strong>Created:</strong> {ctx.created_at.slice(0, 10)}</span>}
          </div>

          {/* Text sections — truncation matches backend buildTaskContextPrefix */}
          {hasDescription && (
            <div className="chat-task-context-section">
              <div className="chat-task-context-section-label">Description</div>
              <div className="chat-task-context-text">{truncText(ctx.description, TRUNC.description)}</div>
            </div>
          )}
          {hasSummary && (
            <div className="chat-task-context-section">
              <div className="chat-task-context-section-label">Summary</div>
              <div className="chat-task-context-text">{truncText(ctx.summary, TRUNC.summary)}</div>
            </div>
          )}
          {hasNote && (
            <div className="chat-task-context-section">
              <div className="chat-task-context-section-label">Note</div>
              <div className="chat-task-context-text">{truncText(ctx.note, TRUNC.note)}</div>
            </div>
          )}
          {hasConvLog && (
            <div className="chat-task-context-section">
              <div className="chat-task-context-section-label">Conversation Log (recent)</div>
              <div className="chat-task-context-text">{truncConversationLog(ctx.conversation_log!)}</div>
            </div>
          )}

          {/* Session slots */}
          {hasSessions && (
            <div className="chat-task-context-section">
              <div className="chat-task-context-section-label">Sessions</div>
              {hasPlanSession && (
                <div className="chat-task-context-session">
                  <span className="chat-task-context-session-type">Plan</span>
                  <span className="chat-task-context-session-id" onClick={() => handleSessionClick(ctx.plan_session_id!)}>
                    {ctx.plan_session_id!.slice(0, 8)}&hellip;
                  </span>
                  {ctx.plan_session_status && (
                    <span className="chat-task-context-session-status">
                      ({ctx.plan_session_status.process_status})
                    </span>
                  )}
                </div>
              )}
              {hasExecSession && (
                <div className="chat-task-context-session">
                  <span className="chat-task-context-session-type">Exec</span>
                  <span className="chat-task-context-session-id" onClick={() => handleSessionClick(ctx.exec_session_id!)}>
                    {ctx.exec_session_id!.slice(0, 8)}&hellip;
                  </span>
                  {ctx.exec_session_status && (
                    <span className="chat-task-context-session-status">
                      ({ctx.exec_session_status.process_status})
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Subtasks */}
          {hasSubtasks && (
            <div className="chat-task-context-section">
              <div className="chat-task-context-section-label">Subtasks ({subtasksDone}/{subtasksTotal})</div>
              <div className="chat-task-context-subtasks text-xs">
                {ctx.subtasks!.map(s => (
                  <div key={s.id} style={{ opacity: s.done ? 0.5 : 1 }}>
                    [{s.done ? 'x' : ' '}] {s.title}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface RouteInfoSectionProps {
  info: RouteInfo;
  taskLookup?: Map<string, Task>;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
}

function RouteInfoSection({ info, taskLookup, onTaskClick, onSessionClick }: RouteInfoSectionProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const arrow = info.direction === 'sent' ? '\u2191' : '\u2193';
  const label = `${arrow} Routed via ${info.event}`;

  const resolvedTask = info.taskId && taskLookup ? resolveTaskId(info.taskId, taskLookup) : undefined;

  return (
    <div className="chat-route-info">
      <button className="chat-route-info-toggle" onClick={() => setOpen(p => !p)}>
        <span className="chat-route-info-icon">{open ? '\u25BC' : '\u25B6'}</span>
        <span className="chat-route-info-label">{label}</span>
      </button>
      {open && (
        <div className="chat-route-info-content">
          <div className="text-xs text-muted" style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '4px 0' }}>
            {info.sessionId && (
              <span>
                <strong>Session:</strong>{' '}
                <span
                  className="session-id-pill"
                  title={info.sessionId}
                  onClick={() => onSessionClick ? onSessionClick(info.sessionId!) : navigate(`/sessions?id=${info.sessionId}`)}
                >
                  {info.sessionId.slice(0, 12)}&hellip;
                </span>
              </span>
            )}
            {info.taskId && (
              <span>
                <strong>Task:</strong>{' '}
                {resolvedTask ? (
                  <span
                    className="task-id-pill"
                    title={`${info.taskId} → ${resolvedTask.title}`}
                    onClick={(e) => { e.stopPropagation(); onTaskClick?.(resolvedTask.id); }}
                  >
                    {resolvedTask.title}
                  </span>
                ) : info.taskId}
              </span>
            )}
          </div>
          {info.payload && Object.keys(info.payload).length > 0 && (
            <pre className="chat-route-info-pre">{JSON.stringify(info.payload, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

/** Merge adjacent thinking blocks (the model emits one per segment) into a
 *  single block so the timeline shows ONE "Thinking ›" row, not a stack.
 *  Empty (signature-only) thinking blocks render null and never split a run. */
export function mergeAdjacentThinking<T extends { type: string; content?: string }>(blocks: readonly T[]): T[] {
  const out: T[] = [];
  for (const b of blocks) {
    if (b.type === 'thinking') {
      if (!(b.content ?? '').trim()) continue;
      const prev = out[out.length - 1];
      if (prev?.type === 'thinking') {
        out[out.length - 1] = { ...prev, content: `${prev.content}\n\n${b.content}` };
        continue;
      }
    }
    out.push(b);
  }
  return out;
}

export function ThinkingSection({ block }: { block: ThinkingBlock }) {
  const [open, setOpen] = useState(false);
  // Signature-only thinking blocks have no displayable text — render nothing
  // rather than an expandable-but-blank row.
  if (!block.content || !block.content.trim()) return null;
  return (
    <div className="tool-run-row">
      <button className="tool-run-toggle" onClick={() => setOpen((p) => !p)}>
        <span className="tool-run-label">Thinking</span>
        <span className={`tool-run-chevron${open ? ' tool-run-chevron--open' : ''}`}>{'\u203A'}</span>
      </button>
      {open && (
        <div className="tool-run-body">
          <div className="chat-thinking-content">{block.content}</div>
        </div>
      )}
    </div>
  );
}

/** Resolve a task ID (exact or prefix) from the lookup map */
function resolveTaskId(id: string, lookup: Map<string, Task>): Task | undefined {
  // Exact match first
  const exact = lookup.get(id);
  if (exact) return exact;
  // Prefix scan fallback (agent sometimes uses partial IDs)
  for (const [key, task] of lookup) {
    if (key.startsWith(id)) return task;
  }
  return undefined;
}

/** Keys in tool call inputs that should be resolved as task IDs */
const TASK_ID_KEYS = new Set(['task_id', 'taskId', 'parent_task_id']);

/** Keys in tool call inputs that should be rendered as session links */
const SESSION_ID_KEYS = new Set(['session_id', 'sessionId', 'from_plan', 'plan_session', 'exec_session', 'plan_session_id', 'exec_session_id']);

/** Regex to match task-ID-bearing keys in JSON text */
const TASK_ID_JSON_RE = /("(?:task_id|taskId|parent_task_id)":\s*")([^"]+)(")/g;

/** Regex to match bare "id" key when value matches task ID format */
const BARE_ID_JSON_RE = /("id":\s*")([a-z0-9]{7,10}-[a-f0-9]{4})(")/g;

/** Regex to match session-ID-bearing keys in JSON text */
const SESSION_ID_JSON_RE = /("(?:session_id|sessionId|from_plan|plan_session|exec_session|plan_session_id|exec_session_id)":\s*")([^"]+)(")/g;

/**
 * Render JSON text with task IDs and session IDs replaced by clickable pills.
 * Returns ReactNode[] suitable for rendering inside a <pre>.
 */
function renderJsonWithTaskLinks(
  input: Record<string, unknown>,
  taskLookup?: Map<string, Task>,
  onTaskClick?: (taskId: string) => void,
  onSessionClick?: (sessionId: string) => void,
  onFileOpen?: (path: string, line?: number) => void,
): ReactNode {
  const jsonStr = JSON.stringify(input, null, 2);

  // Collect all replacements from both regexes, then apply in order
  type Replacement = { index: number; length: number; prefix: string; suffix: string; node: ReactNode };
  const replacements: Replacement[] = [];

  let match: RegExpExecArray | null;

  // Task ID matches
  if (taskLookup && onTaskClick) {
    TASK_ID_JSON_RE.lastIndex = 0;
    while ((match = TASK_ID_JSON_RE.exec(jsonStr)) !== null) {
      const rawId = match[2];
      const task = resolveTaskId(rawId, taskLookup);
      if (!task) continue;
      const m = match;
      replacements.push({
        index: m.index,
        length: m[0].length,
        prefix: m[1],
        suffix: m[3],
        node: (
          <span
            key={`task-pill-${m.index}`}
            className="task-id-pill"
            title={`${rawId} → ${task.title}`}
            onClick={(e) => { e.stopPropagation(); onTaskClick(task.id); }}
          >
            {task.title}
          </span>
        ),
      });
    }

    // Bare "id" matches (task ID format only)
    BARE_ID_JSON_RE.lastIndex = 0;
    while ((match = BARE_ID_JSON_RE.exec(jsonStr)) !== null) {
      const rawId = match[2];
      const task = resolveTaskId(rawId, taskLookup);
      if (!task) continue;
      const m = match;
      replacements.push({
        index: m.index,
        length: m[0].length,
        prefix: m[1],
        suffix: m[3],
        node: (
          <span
            key={`task-pill-bare-${m.index}`}
            className="task-id-pill"
            title={`${rawId} → ${task.title}`}
            onClick={(e) => { e.stopPropagation(); onTaskClick(task.id); }}
          >
            {task.title}
          </span>
        ),
      });
    }
  }

  // Session ID matches
  if (onSessionClick) {
    SESSION_ID_JSON_RE.lastIndex = 0;
    while ((match = SESSION_ID_JSON_RE.exec(jsonStr)) !== null) {
      const rawId = match[2];
      const m = match;
      replacements.push({
        index: m.index,
        length: m[0].length,
        prefix: m[1],
        suffix: m[3],
        node: (
          <span
            key={`session-pill-${m.index}`}
            className="session-id-pill"
            title={rawId}
            onClick={(e) => { e.stopPropagation(); onSessionClick(rawId); }}
          >
            {rawId.slice(0, 12)}&hellip;
          </span>
        ),
      });
    }
  }

  // File path matches — any quoted absolute path with a file extension, regardless
  // of the key name (walnut tools use varied keys: file_path, source, path, …).
  // Make them clickable to open the shared FileViewer overlay. Skip images.
  if (onFileOpen) {
    const FILE_PATH_JSON_RE = /(")(\/(?:[\w@.+ -]+\/)+[\w@.+ -]+\.[\w]+)(")/g;
    const SKIP_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp']);
    while ((match = FILE_PATH_JSON_RE.exec(jsonStr)) !== null) {
      const filePath = match[2];
      const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
      if (SKIP_EXT.has(ext)) continue;
      const m = match;
      replacements.push({
        index: m.index,
        length: m[0].length,
        prefix: m[1],
        suffix: m[3],
        node: (
          <a
            key={`file-link-${m.index}`}
            className="file-link"
            href="#"
            title={filePath}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onFileOpen(filePath); }}
          >
            {filePath}
          </a>
        ),
      });
    }
  }

  if (replacements.length === 0) return jsonStr;

  // Sort by position, apply in order
  replacements.sort((a, b) => a.index - b.index);

  const parts: ReactNode[] = [];
  let lastIndex = 0;
  for (const r of replacements) {
    if (r.index > lastIndex) parts.push(jsonStr.slice(lastIndex, r.index));
    parts.push(r.prefix);
    parts.push(r.node);
    parts.push(r.suffix);
    lastIndex = r.index + r.length;
  }
  if (lastIndex < jsonStr.length) parts.push(jsonStr.slice(lastIndex));

  return parts;
}

/**
 * Build collapsed input summary with task ID and session ID pills resolved.
 * Returns ReactNode[] for inline rendering.
 */
function buildInputSummary(
  input: Record<string, unknown>,
  taskLookup?: Map<string, Task>,
  onTaskClick?: (taskId: string) => void,
  onSessionClick?: (sessionId: string) => void,
): ReactNode {
  const entries = Object.entries(input);
  const parts: ReactNode[] = [];

  for (let i = 0; i < entries.length; i++) {
    const [k, v] = entries[i];
    const val = typeof v === 'string' ? v : JSON.stringify(v);
    const truncated = val.length > 60 ? val.slice(0, 60) + '...' : val;

    // Check if this key is a task ID and we can resolve it
    if (TASK_ID_KEYS.has(k) && typeof v === 'string' && taskLookup && onTaskClick) {
      const task = resolveTaskId(v, taskLookup);
      if (task) {
        if (i > 0) parts.push(', ');
        parts.push(`${k}: `);
        parts.push(
          <span
            key={`summary-pill-${i}`}
            className="task-id-pill"
            title={`${v} → ${task.title}`}
            onClick={(e) => {
              e.stopPropagation();
              onTaskClick(task.id);
            }}
          >
            {task.title}
          </span>
        );
        continue;
      }
    }

    // Check if this key is a session ID — render as clickable pill
    if (SESSION_ID_KEYS.has(k) && typeof v === 'string' && onSessionClick) {
      if (i > 0) parts.push(', ');
      parts.push(`${k}: `);
      parts.push(
        <span
          key={`summary-session-pill-${i}`}
          className="session-id-pill"
          title={v}
          onClick={(e) => {
            e.stopPropagation();
            onSessionClick(v);
          }}
        >
          {v.slice(0, 12)}&hellip;
        </span>
      );
      continue;
    }

    if (i > 0) parts.push(', ');
    parts.push(`${k}: ${truncated}`);
  }

  return parts.length > 0 ? <>{parts}</> : null;
}

interface ToolCallSectionProps {
  block: ToolCallBlock;
  taskLookup?: Map<string, Task>;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  onFileOpen?: (path: string, line?: number) => void;
}

export function ToolCallSection({ block, taskLookup, onTaskClick, onSessionClick, onFileOpen }: ToolCallSectionProps) {
  const navigate = useNavigate();
  // Auto-expand get_session_history with plan_only: true so plan content is immediately visible
  const defaultOpen = block.name === 'session_history' && block.input?.plan_only === true;
  const [open, setOpen] = useState(defaultOpen);

  const handleSessionClick = useCallback((sessionId: string) => {
    if (onSessionClick) {
      onSessionClick(sessionId);
    } else {
      navigate(`/sessions?id=${sessionId}`);
    }
  }, [navigate, onSessionClick]);

  // Unified click handler for entity ref links (.task-link, .session-link, .file-link) in tool results
  const handleResultClick = useEntityClickHandler(onTaskClick, onSessionClick, onFileOpen);

  // Collapsed summary: resolve task IDs and session IDs as pills
  const inputSummaryNode = block.input
    ? buildInputSummary(block.input, taskLookup, onTaskClick, handleSessionClick)
    : null;

  // Expanded JSON: resolve task IDs / session IDs / file paths inline as clickable nodes.
  // Always use the renderer so file paths become clickable even without taskLookup.
  const expandedJson = block.input
    ? renderJsonWithTaskLinks(block.input, taskLookup, onTaskClick, handleSessionClick, onFileOpen)
    : null;

  // Render tool result as markdown with entity refs as clickable pills
  const resultHtml = useMemo(
    () => block.result ? renderToolResultWithRefs(block.result) : null,
    [block.result],
  );

  // Phase 2: Detect long multiline string values in input and render as markdown
  // Only computed when expanded (open) to avoid eager parsing cost
  const markdownFields = useMemo(() => {
    if (!open || !block.input) return [];
    return extractMarkdownFields(block.input);
  }, [block.input, open]);

  return (
    <div className={`chat-tool-block chat-tool-block-${block.status}`}>
      <button className="chat-tool-block-header" onClick={() => setOpen((p) => !p)}>
        <span className="chat-tool-block-icon">
          {block.status === 'calling' ? (
            <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2, display: 'inline-block', verticalAlign: 'middle' }} />
          ) : block.status === 'error' ? '\u2717' : '\u2713'}
        </span>
        <span className="chat-tool-block-name">{block.name}</span>
        {!open && inputSummaryNode && (
          <span className="chat-tool-block-summary">{inputSummaryNode}</span>
        )}
        <span className="chat-tool-block-arrow">{open ? '\u25BC' : '\u25B6'}</span>
      </button>
      {open && (
        <div className="chat-tool-block-body">
          {expandedJson && (
            <div className="chat-tool-block-section">
              <div className="chat-tool-block-section-label">Input</div>
              <pre className="chat-tool-block-pre">{expandedJson}</pre>
              {markdownFields.map(f => (
                <div key={f.key} className="chat-tool-block-field-markdown">
                  <div className="chat-tool-block-field-label">{f.key}</div>
                  <div className="chat-tool-block-result markdown-body" onClick={handleResultClick}
                       dangerouslySetInnerHTML={{ __html: f.html }} />
                </div>
              ))}
            </div>
          )}
          {resultHtml && (
            <div className="chat-tool-block-section">
              <div className="chat-tool-block-section-label">Result</div>
              <div className="chat-tool-block-result markdown-body" onClick={handleResultClick} dangerouslySetInnerHTML={{ __html: resultHtml }} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Extract content from <MESSAGE-TO-USER>...</MESSAGE-TO-USER> tags in text blocks */
const MESSAGE_TO_USER_RE = /<MESSAGE-TO-USER>([\s\S]*?)<\/MESSAGE-TO-USER>/g;
function extractMessageToUser(blocks: MessageBlock[]): string | null {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      MESSAGE_TO_USER_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = MESSAGE_TO_USER_RE.exec(block.content)) !== null) {
        parts.push(match[1].trim());
      }
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/**
 * Fully-collapsible group for system-initiated messages (cron, heartbeat, etc.).
 * ALL content (tool calls, thinking, text, images) collapses by default.
 * Only <MESSAGE-TO-USER> content is shown above the collapsed group.
 */
function SystemMessageGroup({ blocks, sourceLabel, taskLookup, onTaskClick, onSessionClick, onFileOpen, onContentClick }: {
  blocks: MessageBlock[];
  sourceLabel: string;
  taskLookup?: Map<string, Task>;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  onFileOpen?: (path: string, line?: number) => void;
  onContentClick: (e: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);

  const toolCalls = blocks.filter((b): b is ToolCallBlock => b.type === 'tool_call');
  const runningCount = toolCalls.filter(b => b.status === 'calling').length;
  const errorCount = toolCalls.filter(b => b.status === 'error').length;
  const totalToolCalls = toolCalls.length;
  const isStreaming = runningCount > 0;

  // Extract <MESSAGE-TO-USER> content from text blocks
  const messageToUser = useMemo(() => extractMessageToUser(blocks), [blocks]);

  // Auto: expand while streaming, collapse when done
  const isOpen = manualOpen !== null ? manualOpen : isStreaming;
  const handleToggle = () => setManualOpen(prev => prev !== null ? !prev : !isOpen);

  if (blocks.length === 0) return null;

  const statusIcon = isStreaming
    ? <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2, display: 'inline-block', verticalAlign: 'middle' }} />
    : errorCount > 0 ? '\u2717' : '\u2713';

  const summaryParts: string[] = [];
  if (totalToolCalls > 0) summaryParts.push(`${totalToolCalls} tool call${totalToolCalls !== 1 ? 's' : ''}`);
  if (errorCount > 0) summaryParts.push(`${errorCount} error${errorCount !== 1 ? 's' : ''}`);
  const summaryText = isStreaming
    ? `${totalToolCalls - runningCount}/${totalToolCalls} tool calls`
    : summaryParts.join(', ') || 'completed';

  return (
    <>
      {messageToUser && (
        <MemoizedTextBlock content={messageToUser} onClick={onContentClick} />
      )}
      <div className={`chat-tool-group${isStreaming ? ' chat-tool-group-streaming' : errorCount > 0 ? ' chat-tool-group-error' : ''}`}>
        <button className="chat-tool-group-toggle" onClick={handleToggle}>
          <span className={`chat-tool-group-icon${errorCount > 0 ? ' chat-tool-group-icon-error' : ''}`}>
            {statusIcon}
          </span>
          <span className="chat-tool-group-summary">{summaryText}</span>
          <span className="chat-tool-group-arrow">{isOpen ? '\u25BC' : '\u25B6'}</span>
        </button>
        {isOpen && (
          <div className="chat-tool-group-body">
            {mergeAdjacentThinking(blocks).map((block, i) => {
              switch (block.type) {
                case 'thinking':
                  return <ThinkingSection key={i} block={block} />;
                case 'tool_call':
                  if (block.name === 'subagent_create') return <SubagentBlock key={i} block={block} />;
                  return <ToolCallSection key={i} block={block} taskLookup={taskLookup} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={onFileOpen} />;
                case 'text':
                  return <MemoizedTextBlock key={i} content={block.content} onClick={onContentClick} />;
                case 'image': {
                  const imgBlock = block as ImageBlock;
                  if (imgBlock.url) {
                    return <img key={i} className="chat-message-image" src={imgBlock.url} alt="Attached image" />;
                  }
                  if (!imgBlock.data || imgBlock.data === '[compacted]') {
                    return <div key={i} className="text-xs text-muted">[image: {imgBlock.mediaType}]</div>;
                  }
                  const b64Src = `data:${imgBlock.mediaType};base64,${imgBlock.data}`;
                  return <img key={i} className="chat-message-image" src={b64Src} alt="Attached image" />;
                }
                default:
                  return null;
              }
            })}
          </div>
        )}
      </div>
    </>
  );
}

/** Memoized text block that caches renderMarkdownWithRefs output (incl. clickable file paths) */
function MemoizedTextBlock({ content, onClick }: { content: string; onClick: (e: React.MouseEvent<HTMLDivElement>) => void }) {
  const html = useMemo(() => renderMarkdownWithRefs(content), [content]);
  return (
    <div
      className="markdown-body"
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function ChatMessageInner({ role, content, blocks, images, taskContext, routeInfo, timestamp, source, cronJobName, notification, queued, onCancel, taskLookup, onTaskClick, onSessionClick }: ChatMessageProps) {
  const { lightboxSrc, openLightbox, closeLightbox } = useLightbox();

  // File path click → open the shared FileViewer overlay. Self-contained so every
  // page that renders ChatMessage (MainPage chat + session columns, ChatPage) gets
  // clickable file paths without threading a callback through the props chain.
  // Vault notes divert to the Notes page instead of the overlay.
  const [fileViewerState, setFileViewerState] = useState<{ path: string; line?: number } | null>(null);
  const openFileViewer = useCallback((path: string, line?: number) => {
    setFileViewerState({ path, line });
  }, []);
  const handleFileOpen = useNotesAwareFileOpen(openFileViewer);

  const isCron = source === 'cron';
  const isHeartbeat = source === 'heartbeat';
  const isNotification = notification || source === 'session' || source === 'session-error' || source === 'agent-error';
  const isErrorNotification = source === 'session-error' || source === 'agent-error';
  const time = formatTimestamp(timestamp);

  // Unified entity click handler for .task-link, .session-link, and .file-link anchors
  const handleEntityClick = useEntityClickHandler(onTaskClick, onSessionClick, handleFileOpen);

  // Intercept clicks on task-link, session-link anchors, and lightbox images
  // NOTE: ALL hooks must be declared before any early returns (Rules of Hooks).
  const handleContentClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;

    // Lightbox: click on an image with data-lightbox-src
    const lightboxImg = target.closest('img[data-lightbox-src]') as HTMLImageElement | null;
    if (lightboxImg) {
      const src = lightboxImg.getAttribute('data-lightbox-src');
      if (src) {
        e.preventDefault();
        openLightbox(src);
      }
      return;
    }

    // Delegate entity ref clicks (task-link, session-link) to shared handler
    handleEntityClick(e);
  }, [handleEntityClick, openLightbox]);

  const html = useMemo(() => {
    // Skip markdown rendering for special message types that use early returns
    if (source === 'compacting' || source === 'compaction') return null;
    if (source === 'heartbeat' && (notification || role === 'user')) return null;
    // If no blocks, render content directly (legacy/history messages)
    if (!blocks || blocks.length === 0) {
      // User messages: preserve ALL newlines exactly as typed (no markdown collapsing)
      // AI messages + triage user entries: full markdown rendering
      // Single Source of Truth: render full content as-is. Console never strips content.
      // Triage messages now contain all sections (notification + analysis); collapsing
      // is handled by the collapsed summary above, not by filtering content here.
      return (role === 'user' && source !== 'triage') ? renderUserMessage(content) : renderMarkdownWithRefs(content);
    }
    return null;
  }, [content, blocks, source, notification, role]);

  // System-initiated: only cron and heartbeat — fully collapse (automated, noisy).
  // Everything else (triage, session results, normal chat) renders expanded.
  const isSystemInitiated = source === 'cron' || source === 'heartbeat';

  // ── Early returns for special message types ──
  // These MUST come after all hooks (Rules of Hooks: same number of hooks every render).

  // Compaction in-progress — spinner divider
  if (source === 'compacting') {
    return (
      <div className="chat-compaction-divider">
        <div className="chat-compaction-divider-header">
          <span className="chat-compaction-divider-line" />
          <span className="chat-compaction-divider-text" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2, display: 'inline-block', verticalAlign: 'middle' }} />
            Compacting conversation history...
          </span>
          <span className="chat-compaction-divider-line" />
        </div>
      </div>
    );
  }

  // Compaction divider — header + collapsible markdown summary
  if (source === 'compaction') {
    const newlineIdx = content.indexOf('\n');
    const header = newlineIdx >= 0 ? content.slice(0, newlineIdx) : content;
    const details = newlineIdx >= 0 ? content.slice(newlineIdx + 1).trim() : '';

    return (
      <div className="chat-compaction-divider">
        <div className="chat-compaction-divider-header">
          <span className="chat-compaction-divider-line" />
          <span
            className="chat-compaction-divider-text"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(header) }}
          />
          <span className="chat-compaction-divider-line" />
        </div>
        {details && (
          <CompactionDetails details={details} />
        )}
      </div>
    );
  }

  // Heartbeat compact system-line style
  if (isHeartbeat) {
    const isHeartbeatOk = notification && role === 'assistant';
    const isHeartbeatTrigger = role === 'user';

    if (isHeartbeatOk || isHeartbeatTrigger) {
      return (
        <div className="chat-heartbeat-line">
          <span className="chat-heartbeat-icon">{'\u2764\uFE0F'}</span>
          <span className="chat-heartbeat-text">{isHeartbeatTrigger ? 'Heartbeat check' : 'All clear'}</span>
          {time && <span className="chat-heartbeat-time">{time}</span>}
        </div>
      );
    }
    // Substantive heartbeat response falls through to normal rendering below
  }

  // Quick Start system banner — compact, centered, no bubble chrome
  if (source === 'quick-start' && role === 'user') {
    return null;
  }

  // Interrupt marker \u2014 render as muted system banner instead of a misleading
  // blue "You" bubble. Claude CLI writes `[Request interrupted by user]`
  // whenever its AbortController fires without a reason \u2014 that includes SIGINT
  // from walnut's health-monitor idle reap, not just a user-clicked Interrupt.
  // Showing it as a user message makes automated reaps indistinguishable from
  // the user's own action.
  if (role === 'user' && content.trim() === '[Request interrupted by user]') {
    return (
      <div className="chat-interrupt-banner">
        <span className="chat-interrupt-icon">{'\u23F9'}</span>
        <span className="chat-interrupt-text">Turn interrupted</span>
        {time && <span className="chat-interrupt-time">{time}</span>}
      </div>
    );
  }

  // Determine the display label for the message header
  const isTriage = source === 'triage';
  const isSubagent = source === 'subagent';
  const isQuickStartEcho = source === 'quick-start-echo';
  // Generic long user-message rule: an explicitly-typed user prompt with no special
  // source tag, that's long enough to dominate the viewport, gets the same auto-collapse
  // treatment as Quick Start echoes.
  const AUTO_COLLAPSE_CHARS = 600;
  const AUTO_COLLAPSE_LINES = 20;
  const isLongPlainUser =
    role === 'user' && !source &&
    (content.length > AUTO_COLLAPSE_CHARS || content.split('\n').length > AUTO_COLLAPSE_LINES);
  const roleLabel = isHeartbeat
    ? '\u2764\uFE0F Heartbeat'
    : isCron
      ? `Scheduled \u2014 ${cronJobName ?? 'Job'}`
      : isTriage
        ? 'Triage'
        : isSubagent
          ? 'Subagent'
          : isNotification
            ? (isErrorNotification ? 'Error' : 'Session')
            : role === 'user' ? 'You' : 'Walnut';

  // Auto-collapse notification messages (session results, subagent) AND all triage messages.
  // Triage always collapses regardless of notification flag — the full analysis is noisy.
  // Quick Start local echoes and any long plain user message also auto-collapse so they
  // don't fill the viewport — the full content is still available behind the chevron.
  const shouldAutoCollapse =
    isCron || (isNotification && !isErrorNotification) || isTriage || isQuickStartEcho || isLongPlainUser;
  const [isCollapsed, setIsCollapsed] = useState(shouldAutoCollapse);
  // Streaming cron/heartbeat responses get their source tag AFTER the message is
  // created (agent:response retro-tags it), so the initial useState saw false.
  // Sync the collapse state when auto-collapse turns on late (render-time state
  // adjustment — React re-renders immediately, before painting the expanded body).
  const [prevAutoCollapse, setPrevAutoCollapse] = useState(shouldAutoCollapse);
  if (shouldAutoCollapse !== prevAutoCollapse) {
    setPrevAutoCollapse(shouldAutoCollapse);
    if (shouldAutoCollapse) setIsCollapsed(true);
  }

  // CSS class: cron, heartbeat, notification, and triage messages get their own style
  const messageClass = isHeartbeat
    ? 'chat-message chat-message-heartbeat'
    : isCron
      ? 'chat-message chat-message-cron'
      : (isNotification || isTriage)
        ? `chat-message chat-message-notification${isErrorNotification ? ' chat-message-notification-error' : ''}`
        : `chat-message chat-message-${role}`;

  // Extract collapsed summary for auto-collapsed messages
  const collapsedSummary = useMemo(() => {
    if (!shouldAutoCollapse) return '';
    if (isQuickStartEcho) {
      // Content shape: "Quick Start on `<cwd>`[ (<host>)]:\n> <user text>"
      // Show only the header line (no excerpt of the pasted body).
      const headerLine = content.split('\n')[0] ?? content;
      const cleaned = headerLine.replace(/`/g, '').replace(/:\s*$/, '');
      return `⚡ ${cleaned}`.slice(0, 160);
    }
    if (isTriage) {
      // Extract task label from <task-ref label="..."/> or legacy [id|label] format
      const xmlRefMatch = content.match(/<task-ref[^>]*label="([^"]*)"/);
      const legacyRefMatch = !xmlRefMatch ? content.match(/\[([^|\]]+)\|([^\]]+)\]/) : null;
      const taskLabel = xmlRefMatch?.[1] ?? legacyRefMatch?.[2] ?? '';

      // Extract notification message (unified-path triage with notify)
      const notifyLabelIdx = content.indexOf('**Main AI Notification:**');
      if (notifyLabelIdx !== -1) {
        const afterLabel = content.slice(notifyLabelIdx + '**Main AI Notification:**'.length);
        const msg = afterLabel.split(/\n\n+/).find(p => p.trim())?.trim() ?? '';
        if (msg) return taskLabel ? `${taskLabel} — ${msg}`.slice(0, 200) : msg.slice(0, 200);
      }
      // Legacy compat: old → AI: format
      const notifyMatch = content.match(/>\s*\*\*→ AI:\*\*\s*(.+)/);
      if (notifyMatch) {
        const msg = notifyMatch[1].trim();
        return taskLabel ? `${taskLabel} — ${msg}`.slice(0, 200) : msg.slice(0, 200);
      }

      // UI-only triage: extract first line of analysis as summary
      const analysisIdx = content.indexOf('**Triage Analysis:**');
      if (analysisIdx !== -1) {
        const afterAnalysis = content.slice(analysisIdx + '**Triage Analysis:**'.length);
        const snippet = afterAnalysis.split(/\n\n+/).find(p => p.trim())?.trim().split('\n')[0] ?? '';
        if (snippet) return taskLabel ? `${taskLabel} — ${snippet}`.slice(0, 200) : snippet.slice(0, 200);
      }

      // Fallback: phase/outcome or just task label
      const phaseMatch = content.match(/Phase:\s*(.+)/);
      const phase = phaseMatch ? phaseMatch[1].trim() : '';
      if (taskLabel && phase) return `${taskLabel} — ${phase}`.slice(0, 200);
      if (taskLabel) return taskLabel.slice(0, 150);
    }
    // Default: first line, stripped of bold markers
    const firstLine = content.split('\n').find(l => l.trim()) ?? '';
    return firstLine.replace(/\*\*/g, '').slice(0, 120);
  }, [content, shouldAutoCollapse, isTriage, isQuickStartEcho]);

  // Notification header with optional UI Only badge + collapse toggle + collapsed summary
  const notificationHeader = (isCron || isNotification || isTriage || isQuickStartEcho || isLongPlainUser) ? (
    <div className="chat-message-header chat-notification-header" onClick={shouldAutoCollapse ? () => setIsCollapsed(c => !c) : undefined} style={shouldAutoCollapse ? { cursor: 'pointer' } : undefined}>
      <div className="chat-message-role">
        {roleLabel}
        {notification && <span className="chat-ui-only-badge">UI Only</span>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, overflow: 'hidden', flex: 1 }}>
        {isCollapsed && collapsedSummary && (
          <span
            className="chat-collapsed-summary"
            onClick={handleContentClick}
            dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(collapsedSummary) }}
          />
        )}
        {time && <div className="chat-message-time">{time}</div>}
        {shouldAutoCollapse && <span className="chat-collapse-toggle">{isCollapsed ? '\u25B6' : '\u25BC'}</span>}
      </div>
    </div>
  ) : null;

  // Render block-based assistant messages
  if (role === 'assistant' && blocks && blocks.length > 0) {
    return (
      <>
        <div className={messageClass}>
          {notificationHeader ?? (
            <div className="chat-message-header">
              <div className="chat-message-role">{roleLabel}</div>
              {time && <div className="chat-message-time">{time}</div>}
            </div>
          )}
          {(!isCollapsed || !shouldAutoCollapse) && (
            <div className="chat-message-content">
              {routeInfo && <RouteInfoSection info={routeInfo} taskLookup={taskLookup} onTaskClick={onTaskClick} onSessionClick={onSessionClick} />}
              {isSystemInitiated ? (
                /* System-initiated: fully collapse ALL blocks, show only <MESSAGE-TO-USER> */
                <SystemMessageGroup
                  blocks={blocks}
                  sourceLabel={roleLabel}
                  taskLookup={taskLookup}
                  onTaskClick={onTaskClick}
                  onSessionClick={onSessionClick}
                  onFileOpen={handleFileOpen}
                  onContentClick={handleContentClick}
                />
              ) : (
                /* User-initiated: render all blocks directly (tool calls expanded by default) */
                mergeAdjacentThinking(blocks).map((block, i) => {
                  switch (block.type) {
                    case 'thinking':
                      return <ThinkingSection key={i} block={block} />;
                    case 'tool_call': {
                      // Render create_subagent as SubagentBlock
                      if (block.name === 'subagent_create') return <SubagentBlock key={i} block={block} />;
                      // Render user_ask as inline status (popover handled by MainPage)
                      if (block.name === 'user_ask') {
                        const questions = parseAskQuestionInput(block.input)
                        if (questions) {
                          if (block.status === 'calling') {
                            return (
                              <div key={i} className="question-inline-pending">
                                <span className="question-inline-icon">&#x2753;</span>
                                Agent is asking you a question...
                              </div>
                            )
                          }
                          // Answered — compact summary
                          const summary = questions.map((q, qi) => {
                            const k = q.header ?? String(qi)
                            // Try to extract answer from result text
                            const resultText = block.result ?? ''
                            const match = resultText.match(new RegExp(`${k}:\\s*(.+?)(?:\\s*[·|]|$)`))
                            return `${k}: ${match?.[1]?.trim() ?? '...'}`
                          }).join(' · ')
                          return (
                            <div key={i} className="question-inline-answered">
                              <span className="question-inline-icon">&#x2713;</span>
                              Answered: {summary}
                            </div>
                          )
                        }
                      }
                      return <ToolCallSection key={i} block={block} taskLookup={taskLookup} onTaskClick={onTaskClick} onSessionClick={onSessionClick} onFileOpen={handleFileOpen} />;
                    }
                    case 'text':
                      return <MemoizedTextBlock key={i} content={block.content} onClick={handleContentClick} />;
                    case 'image': {
                      const imgBlock = block as ImageBlock;
                      if (imgBlock.url) {
                        return (
                          <img key={i} className="chat-message-image" src={imgBlock.url} alt="Attached image"
                            data-lightbox-src={imgBlock.url} onClick={() => openLightbox(imgBlock.url!)} />
                        );
                      }
                      if (!imgBlock.data || imgBlock.data === '[compacted]') {
                        return <div key={i} className="text-xs text-muted">[image: {imgBlock.mediaType}]</div>;
                      }
                      const b64Src = `data:${imgBlock.mediaType};base64,${imgBlock.data}`;
                      return (
                        <img key={i} className="chat-message-image" src={b64Src} alt="Attached image"
                          data-lightbox-src={b64Src} onClick={() => openLightbox(b64Src)} />
                      );
                    }
                    default:
                      return null;
                  }
                })
              )}
            </div>
          )}
        </div>
        {lightboxSrc && <Lightbox src={lightboxSrc} onClose={closeLightbox} />}
        {fileViewerState && (
          <FileViewer
            path={fileViewerState.path}
            line={fileViewerState.line}
            onClose={() => setFileViewerState(null)}
          />
        )}
      </>
    );
  }

  return (
    <>
      <div className={messageClass}>
        {notificationHeader ?? (
          <div className="chat-message-header">
            <div className="chat-message-role">{roleLabel}</div>
            {time && <div className="chat-message-time">{time}</div>}
          </div>
        )}
        {role === 'user' ? (
          (!isCollapsed || !shouldAutoCollapse) && <div className="chat-message-content">
            {taskContext && <TaskContextSection ctx={taskContext} onSessionClick={onSessionClick} />}
            {routeInfo && <RouteInfoSection info={routeInfo} taskLookup={taskLookup} onTaskClick={onTaskClick} onSessionClick={onSessionClick} />}
            {images && images.length > 0 && (
              <div className="chat-message-images">
                {images.map((img, i) => {
                  // URL-based images (persisted to disk)
                  if (img.url) {
                    return (
                      <img
                        key={i}
                        className="chat-message-image"
                        src={img.url}
                        alt={img.name}
                        data-lightbox-src={img.url}
                        onClick={() => openLightbox(img.url!)}
                      />
                    );
                  }
                  // Base64 images (in-memory, current session)
                  if (img.data && img.data !== '[compacted]') {
                    const b64Src = `data:${img.mediaType};base64,${img.data}`;
                    return (
                      <img
                        key={i}
                        className="chat-message-image"
                        src={b64Src}
                        alt={img.name}
                        data-lightbox-src={b64Src}
                        onClick={() => openLightbox(b64Src)}
                      />
                    );
                  }
                  // Compacted placeholder
                  return <div key={i} className="text-xs text-muted">[image: {img.mediaType}]</div>;
                })}
              </div>
            )}
            <div
              className="markdown-body"
              onClick={handleContentClick}
              dangerouslySetInnerHTML={{ __html: html ?? '' }}
            />
            {queued && (
              <span className="chat-queued-badge">
                queued
                {onCancel && <button className="chat-queued-cancel" onClick={onCancel} type="button" aria-label="Cancel queued message">&times;</button>}
              </span>
            )}
          </div>
        ) : (
          (!isCollapsed || !shouldAutoCollapse) && (
            <div className="chat-message-content">
              {routeInfo && <RouteInfoSection info={routeInfo} taskLookup={taskLookup} onTaskClick={onTaskClick} onSessionClick={onSessionClick} />}
              <div
                className="markdown-body"
                onClick={handleContentClick}
                dangerouslySetInnerHTML={{ __html: html ?? '' }}
              />
              {isErrorNotification && (() => {
                const domain = source === 'session-error' ? 'session' as const : undefined;
                const sug = getErrorSuggestion(content, { domain });
                return sug ? <ErrorSuggestionLink {...sug} /> : null;
              })()}
            </div>
          )
        )}
      </div>
      {lightboxSrc && <Lightbox src={lightboxSrc} onClose={closeLightbox} />}
      {fileViewerState && (
        <FileViewer
          path={fileViewerState.path}
          line={fileViewerState.line}
          onClose={() => setFileViewerState(null)}
        />
      )}
    </>
  );
}

/** Custom comparator for React.memo — shallow-compares all props */
function arePropsEqual(prev: ChatMessageProps, next: ChatMessageProps): boolean {
  return (
    prev.role === next.role &&
    prev.content === next.content &&
    prev.blocks === next.blocks &&
    prev.images === next.images &&
    prev.taskContext === next.taskContext &&
    prev.routeInfo === next.routeInfo &&
    prev.timestamp === next.timestamp &&
    prev.source === next.source &&
    prev.cronJobName === next.cronJobName &&
    prev.notification === next.notification &&
    prev.queued === next.queued &&
    prev.onCancel === next.onCancel &&
    prev.taskLookup === next.taskLookup &&
    prev.onTaskClick === next.onTaskClick &&
    prev.onSessionClick === next.onSessionClick
  );
}

export const ChatMessage = memo(ChatMessageInner, arePropsEqual);
