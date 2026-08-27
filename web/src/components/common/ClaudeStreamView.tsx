/**
 * ClaudeStreamView — shared renderer for Claude Code JSONL streaming output.
 *
 * Renders an array of StreamingBlock[] (text, tool_call, system) into a
 * visual representation. Reuses GenericToolCall from SessionMessage for
 * tool call rendering.
 *
 * Used by:
 * - SubagentBlock (main chat inline subagent)
 * - Future: SessionChatHistory can adopt this for shared rendering
 */

import { memo, useMemo } from 'react';
import type { StreamingBlock } from '@/hooks/useSessionStream';
import { GenericToolCall } from '../sessions/SessionMessage';
import { useRenderedMarkdown } from '@/hooks/useEntityLabels';
import { useSelectionFrozen } from '@/utils/selection-guard';

interface ClaudeStreamViewProps {
  blocks: StreamingBlock[];
  isStreaming?: boolean;
  sessionCwd?: string;
}

/** Group consecutive text blocks into a single markdown render */
function groupBlocks(blocks: StreamingBlock[]): Array<
  | { kind: 'text'; content: string; index: number }
  | { kind: 'thinking'; content: string; index: number }
  | { kind: 'tool_call'; block: StreamingBlock & { type: 'tool_call' }; index: number }
  | { kind: 'system'; block: StreamingBlock & { type: 'system' }; index: number }
> {
  const groups: ReturnType<typeof groupBlocks> = [];
  let textAccum = '';
  let textStartIdx = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type === 'text') {
      if (!textAccum) textStartIdx = i;
      textAccum += block.content;
    } else {
      // Flush accumulated text
      if (textAccum) {
        groups.push({ kind: 'text', content: textAccum, index: textStartIdx });
        textAccum = '';
      }
      if (block.type === 'tool_call') {
        groups.push({ kind: 'tool_call', block, index: i });
      } else if (block.type === 'system') {
        groups.push({ kind: 'system', block, index: i });
      } else if (block.type === 'thinking') {
        groups.push({ kind: 'thinking', content: block.content, index: i });
      }
    }
  }
  // Flush remaining text
  if (textAccum) {
    groups.push({ kind: 'text', content: textAccum, index: textStartIdx });
  }
  return groups;
}

export const ClaudeStreamView = memo(function ClaudeStreamView({
  blocks,
  isStreaming,
  sessionCwd,
}: ClaudeStreamViewProps) {
  const grouped = useMemo(() => groupBlocks(blocks), [blocks]);

  if (grouped.length === 0 && isStreaming) {
    return (
      <div className="claude-stream-view claude-stream-view--empty">
        <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2, display: 'inline-block', verticalAlign: 'middle' }} />
        <span style={{ marginLeft: 6, opacity: 0.6, fontSize: 12 }}>Running...</span>
      </div>
    );
  }

  return (
    <div className="claude-stream-view">
      {grouped.map((item) => {
        if (item.kind === 'text') {
          return <StreamTextBlock key={`text-${item.index}`} content={item.content} />;
        }
        if (item.kind === 'tool_call') {
          return (
            <GenericToolCall
              key={`tool-${item.index}`}
              tool={{ name: item.block.name, input: item.block.input ?? {} }}
              status={item.block.status}
              result={item.block.result}
              sessionCwd={sessionCwd}
            />
          );
        }
        if (item.kind === 'system') {
          const detail = (item.block as { detail?: string }).detail;
          return (
            <div
              key={`sys-${item.index}`}
              className={`claude-stream-system claude-stream-system--${item.block.variant}`}
            >
              {item.block.message}
              {detail && (
                <details style={{ marginTop: 2, fontSize: 11, opacity: 0.75 }}>
                  <summary style={{ cursor: 'pointer' }}>details</summary>
                  <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 4 }}>{detail}</pre>
                </details>
              )}
            </div>
          );
        }
        if (item.kind === 'thinking') {
          // open by default — see rationale in SessionChatHistory thinking render.
          return (
            <details
              open
              key={`think-${item.index}`}
              className="claude-stream-thinking"
              style={{ margin: '6px 0', opacity: 0.7, fontStyle: 'italic', fontSize: 13, borderLeft: '2px solid rgba(128,128,128,0.3)', paddingLeft: 8 }}
            >
              <summary style={{ cursor: 'pointer', userSelect: 'none' }}>thinking…</summary>
              <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{item.content}</div>
            </details>
          );
        }
        return null;
      })}
      {isStreaming && grouped.length > 0 && (
        <span className="spinner" style={{ width: 10, height: 10, borderWidth: 2, display: 'inline-block', marginTop: 4 }} />
      )}
    </div>
  );
});

/** Render a text block as markdown. Frozen while a selection lives inside it —
 *  streaming deltas otherwise swap innerHTML and destroy the selection. */
const StreamTextBlock = memo(function StreamTextBlock({ content }: { content: string }) {
  const { value: displayContent, hostRef } = useSelectionFrozen(content);
  const html = useRenderedMarkdown(displayContent);
  return (
    <div
      ref={hostRef}
      className="claude-stream-text markdown-body"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
