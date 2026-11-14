import { useMemo, useRef, type MouseEvent, type KeyboardEvent } from 'react';
import type { Task } from '@open-walnut/core';
import { useEntityLabelsVersion } from '@/hooks/useEntityLabels';
import { useStableHtml } from '@/hooks/useStableHtml';
import { useEntityClickHandler } from '@/hooks/useEntityClickHandler';
import { useAgentFileOpener } from '@/hooks/useAgentFileOpener';
import { renderMarkdownWithRefs, type RenderMarkdownOptions } from '@/utils/markdown';
import { claimAgentLinkClick } from '@/utils/open-anywhere';

/**
 * `task` / `host` / `sessionId` / `cwd` name where the words came from, so a path in them opens
 * on that machine (hooks/useAgentFileOpener.ts); `unknownSource`: Walnut did not record the writer,
 * so a path reads nothing until a machine is chosen and no picture loads. No named writer is
 * unknown by default. A caller's own
 * `onClick` replaces the click handler whole: it must carry the same source itself.
 */
export function AgentText({ text, className, testId, compact = false, inline = false, onClick, title, task, host, sessionId, cwd, unknownSource, taskIds }: {
  text: string;
  /** How a bare task id renders (renderMarkdownWithRefs `taskIds`); absent = pills, as before. */
  taskIds?: RenderMarkdownOptions['taskIds'];
  task?: Task | null;
  host?: string;
  sessionId?: string;
  cwd?: string;
  unknownSource?: boolean;
  className?: string;
  title?: string;
  testId?: string;
  compact?: boolean;
  inline?: boolean;
  onClick?: (e: MouseEvent<HTMLElement>) => void;
}) {
  const labels = useEntityLabelsVersion();
  const file = useAgentFileOpener({ task, host, sessionId, cwd, unknownSource: unknownSource ?? (!task && host === undefined && !sessionId) });
  const { cwd: renderCwd, host: renderHost, images } = file.render;
  const html = useMemo(
    () => renderMarkdownWithRefs(text, renderCwd, renderHost, { inlineImages: !compact && images, inline, ...(taskIds ? { taskIds } : {}) }),
    [text, compact, inline, labels, renderCwd, renderHost, images, taskIds],
  );
  const inner = useStableHtml(html);
  const onEntityClick = useEntityClickHandler(undefined, file.onFileOpen, file.fileHost, file.fileSessionId, file.refusesAll);
  const press = useRef<{ x: number; y: number; dragged: boolean } | null>(null);
  const Tag = inline ? 'span' : 'div';
  return <Tag
    className={`markdown-body ${className ?? ''}`}
    title={title}
    data-testid={testId}
    data-agent-text="true"
    onPointerDownCapture={(e) => { press.current = e.button === 0 ? { x: e.clientX, y: e.clientY, dragged: false } : null; }}
    onPointerMoveCapture={(e) => {
      const start = press.current;
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) >= 4) start.dragged = true;
    }}
    onPointerCancel={() => { press.current = null; }}
    onClick={(e: MouseEvent<HTMLElement>) => {
      const start = press.current;
      press.current = null;
      const dragged = start && (start.dragged || Math.hypot(e.clientX - start.x, e.clientY - start.y) >= 4);
      const selection = window.getSelection();
      // A selection left by a previous gesture must not swallow the next ordinary click.
      if (e.detail > 0 && (dragged || e.shiftKey) && selection?.isCollapsed === false && (e.currentTarget.contains(selection.anchorNode) || e.currentTarget.contains(selection.focusNode))) {
        claimAgentLinkClick(e.nativeEvent);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      (onClick ?? onEntityClick)(e);
      if ((e.target as HTMLElement).closest('a, button, summary, img')) e.stopPropagation();
    }}
    onKeyDown={(e: KeyboardEvent<HTMLElement>) => {
      if ((e.key === 'Enter' || e.key === ' ') && (e.target as HTMLElement).closest('a, button, summary')) e.stopPropagation();
    }}
    dangerouslySetInnerHTML={inner}
  />;
}
