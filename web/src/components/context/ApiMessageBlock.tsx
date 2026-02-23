import type { ApiMessage } from '@/api/context';

interface ApiMessageBlockProps {
  message: ApiMessage;
  index: number;
}

function renderContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content, null, 2);

  return (content as Array<Record<string, unknown>>)
    .map((block) => {
      if (block.type === 'text') return block.text as string;
      if (block.type === 'tool_use') {
        const input = JSON.stringify(block.input, null, 2);
        return `[tool_use: ${block.name}]\n${input}`;
      }
      if (block.type === 'tool_result') {
        const raw = typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content, null, 2);
        return `[tool_result: ${block.tool_use_id}]\n${raw}`;
      }
      return JSON.stringify(block, null, 2);
    })
    .join('\n\n');
}

export function ApiMessageBlock({ message, index }: ApiMessageBlockProps) {
  const roleClass = message.role === 'user' ? 'context-msg-user' : 'context-msg-assistant';

  return (
    <div className={`context-api-message ${roleClass}`}>
      <div className="context-msg-header">
        <span className="context-msg-index">#{index + 1}</span>
        <span className="context-msg-role">{message.role}</span>
      </div>
      <pre className="context-pre context-msg-content">{renderContent(message.content)}</pre>
    </div>
  );
}
