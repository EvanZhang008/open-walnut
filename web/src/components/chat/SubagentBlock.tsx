/**
 * SubagentBlock — collapsible wrapper for inline subagent tool calls.
 *
 * Renders as a collapsible "agent box" in the main chat, containing:
 * - Header: tool name + prompt summary + status indicator
 * - Body: ClaudeStreamView rendering the streamed blocks
 * - Footer: cost/duration badge (extracted from the final system block)
 */

import { useState, useMemo, memo } from 'react';
import type { ToolCallBlock } from '@/api/chat';
import type { StreamingBlock } from '@/hooks/useSessionStream';
import { ClaudeStreamView } from '../common/ClaudeStreamView';

interface SubagentBlockProps {
  block: ToolCallBlock;
}

const EMPTY_BLOCKS: StreamingBlock[] = [];

export const SubagentBlock = memo(function SubagentBlock({ block }: SubagentBlockProps) {
  // Auto-open when actively streaming so the user sees output immediately
  const [open, setOpen] = useState(() => block.status === 'calling');
  const isStreaming = block.status === 'calling';
  const streamBlocks = block.streamBlocks ?? EMPTY_BLOCKS;

  // Extract prompt from input for header summary
  const promptSummary = useMemo(() => {
    const prompt = block.input?.prompt;
    if (typeof prompt !== 'string') return '';
    return prompt.length > 80 ? prompt.slice(0, 80) + '...' : prompt;
  }, [block.input?.prompt]);

  // Extract model and background from input
  const model = (block.input?.model as string) ?? 'opus';
  const background = block.input?.background === true;

  // Extract cost/duration from result text (format: "\n[Cost: $X.XXXX | Duration: X.Xs]")
  const meta = useMemo(() => {
    if (!block.result) return null;
    const match = block.result.match(/\[Cost: \$([0-9.]+) \| Duration: ([0-9.]+)s\]/);
    if (match) return { cost: match[1], duration: match[2] };
    return null;
  }, [block.result]);

  const statusIcon = isStreaming ? (
    <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2, display: 'inline-block', verticalAlign: 'middle' }} />
  ) : block.status === 'done' ? '\u2713' : '\u2717';

  return (
    <div className={`chat-tool-block subagent-block subagent-block--${block.status}`}>
      <button className="chat-tool-block-header subagent-block-header" onClick={() => setOpen((p) => !p)}>
        <span className="chat-tool-block-icon">{statusIcon}</span>
        <span className="chat-tool-block-name">create_subagent</span>
        <span className="subagent-model-badge">{model}</span>
        {background && <span className="subagent-bg-badge">bg</span>}
        {!open && promptSummary && (
          <span className="chat-tool-block-summary">{promptSummary}</span>
        )}
        {!isStreaming && meta && (
          <span className="subagent-meta">
            ${meta.cost} · {meta.duration}s
          </span>
        )}
        <span className="chat-tool-block-arrow">{open ? '\u25BC' : '\u25B6'}</span>
      </button>
      {open && (
        <div className="chat-tool-block-body subagent-block-body">
          {/* Show full prompt when expanded */}
          {block.input?.prompt && (
            <div className="subagent-prompt">
              <div className="chat-tool-block-section-label">Prompt</div>
              <pre className="chat-tool-block-pre">{block.input.prompt as string}</pre>
            </div>
          )}
          {/* Stream content or fallback to plain result */}
          {streamBlocks.length > 0 || isStreaming ? (
            <div className="subagent-stream-content">
              <ClaudeStreamView blocks={streamBlocks} isStreaming={isStreaming} />
            </div>
          ) : block.result ? (
            <div className="subagent-result">
              <div className="chat-tool-block-section-label">Result</div>
              <pre className="chat-tool-block-pre">{block.result}</pre>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
});
