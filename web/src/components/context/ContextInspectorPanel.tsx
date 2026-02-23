import type { ContextInspectorResponse } from '@/api/context';
import { ContextSection } from './ContextSection';
import { ToolCard } from './ToolCard';
import { ApiMessageBlock } from './ApiMessageBlock';

interface ContextInspectorPanelProps {
  data: ContextInspectorResponse | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

export function ContextInspectorPanel({ data, loading, error, onRefresh }: ContextInspectorPanelProps) {
  if (error) {
    return (
      <div className="context-inspector">
        <div className="context-inspector-header">
          <span className="context-inspector-title">Agent Context Inspector</span>
          <button className="btn btn-sm" onClick={onRefresh}>Retry</button>
        </div>
        <div className="text-sm" style={{ color: 'var(--error)', padding: '12px 16px' }}>
          Error: {error}
        </div>
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="context-inspector">
        <div className="context-inspector-header">
          <span className="context-inspector-title">Agent Context Inspector</span>
        </div>
        <div style={{ padding: '24px', textAlign: 'center' }}>
          <span className="spinner" style={{ width: 20, height: 20, borderWidth: 2, display: 'inline-block' }} />
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { sections, totalTokens } = data;

  return (
    <div className="context-inspector">
      <div className="context-inspector-header">
        <span className="context-inspector-title">Agent Context Inspector</span>
        <span className="context-token-badge context-token-badge-total">
          Total: ~{totalTokens.toLocaleString()} tokens
        </span>
        <button
          className="btn btn-sm"
          onClick={onRefresh}
          disabled={loading}
          title="Refresh context"
        >
          {loading ? '...' : 'Refresh'}
        </button>
      </div>

      <div className="context-inspector-body">
        <ContextSection title="Model Config" tokens={sections.modelConfig.tokens}>
          <pre className="context-pre">
            {`model: ${sections.modelConfig.content.model}\nmax_tokens: ${sections.modelConfig.content.max_tokens}\nregion: ${sections.modelConfig.content.region}`}
          </pre>
        </ContextSection>

        <ContextSection title="Role & Rules" tokens={sections.roleAndRules.tokens}>
          <pre className="context-pre">{sections.roleAndRules.content}</pre>
        </ContextSection>

        <ContextSection title="Skills" tokens={sections.skills.tokens}>
          <pre className="context-pre">{sections.skills.content || '(No skills loaded)'}</pre>
        </ContextSection>

        <ContextSection title="Compaction Summary" tokens={sections.compactionSummary.tokens}>
          <pre className="context-pre">{sections.compactionSummary.content || '(No compaction yet)'}</pre>
        </ContextSection>

        <ContextSection title="Task Categories & Projects" tokens={sections.taskCategories.tokens}>
          <pre className="context-pre">{sections.taskCategories.content || '(No active tasks)'}</pre>
        </ContextSection>

        <ContextSection title="Global Memory" tokens={sections.globalMemory.tokens}>
          <pre className="context-pre">{sections.globalMemory.content || '(Empty)'}</pre>
        </ContextSection>

        <ContextSection
          title="Project Summaries"
          tokens={sections.projectSummaries.tokens}
          count={sections.projectSummaries.count}
        >
          <pre className="context-pre">{sections.projectSummaries.content || '(No projects)'}</pre>
        </ContextSection>

        <ContextSection title="Daily Logs" tokens={sections.dailyLogs.tokens}>
          <pre className="context-pre">{sections.dailyLogs.content || '(No recent activity)'}</pre>
        </ContextSection>

        <ContextSection title="Tools" tokens={sections.tools.tokens} count={sections.tools.count}>
          <div className="context-tools-list">
            {sections.tools.content.map((tool) => (
              <ToolCard key={tool.name} tool={tool} />
            ))}
          </div>
        </ContextSection>

        <ContextSection
          title="API Messages"
          tokens={sections.apiMessages.tokens}
          count={sections.apiMessages.count}
        >
          <div className="context-messages-list">
            {sections.apiMessages.content.length === 0 ? (
              <div className="text-sm text-muted" style={{ padding: 8 }}>(No messages yet)</div>
            ) : (
              sections.apiMessages.content.map((msg, i) => (
                <ApiMessageBlock key={i} message={msg} index={i} />
              ))
            )}
          </div>
        </ContextSection>
      </div>
    </div>
  );
}
