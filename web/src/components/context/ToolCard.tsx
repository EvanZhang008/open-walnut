import { useState } from 'react';
import type { ToolSchema } from '@/api/context';

interface ToolCardProps {
  tool: ToolSchema;
}

export function ToolCard({ tool }: ToolCardProps) {
  const [showSchema, setShowSchema] = useState(false);

  return (
    <div className="context-tool-card">
      <button
        className="context-tool-header"
        onClick={() => setShowSchema((p) => !p)}
      >
        <span className="context-tool-name">{tool.name}</span>
        <span className="context-tool-toggle">{showSchema ? '\u25BC' : '\u25B6'}</span>
      </button>
      <div className="context-tool-desc">{tool.description}</div>
      {showSchema && (
        <pre className="context-pre">{JSON.stringify(tool.input_schema, null, 2)}</pre>
      )}
    </div>
  );
}
