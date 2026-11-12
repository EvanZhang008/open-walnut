import { useMemo } from 'react';
import { AgentText } from '@/components/common/AgentText';
import type { ContextInspectorResponse } from '@/api/context';
import { ContextSection } from './ContextSection';
import { parseSkillsIndex } from './skills-index-parse';

interface ContextInspectorPanelProps {
  data: ContextInspectorResponse | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

/** Memoized markdown block for context sections */
function ContextMarkdown({ content, fallback }: { content: string; fallback?: string }) {
  const text = content || fallback || '';
  // The context as the model sees it: task ids stay ids (clickable), no titles.
  return <AgentText className="context-markdown" unknownSource taskIds="links" text={text} />;
}

/**
 * Skills section renderer: the prompt is a preamble followed by the skills index (one line per
 * skill, or the XML form). Rendered as raw markdown it reads as a wall of text, so parse it and
 * show a grouped, scannable list (skills-index-parse.ts).
 */
function SkillsIndexView({ content }: { content: string }) {
  const parsed = useMemo(
    () => parseSkillsIndex(content, (xml) => new DOMParser().parseFromString(xml, 'text/xml')),
    [content],
  );

  if (!parsed) return <ContextMarkdown content={content} fallback="(No skills loaded)" />;

  return (
    <div className="context-skills-index">
      <ContextMarkdown content={parsed.preamble} />
      {parsed.categories.map((cat) => (
        <div key={cat.name} className="context-skills-category">
          <div className="context-skills-category-name">
            {cat.name} <span className="context-skills-count">({cat.skills.length})</span>
          </div>
          {cat.skills.map((s) => (
            <div key={s.location || s.name} className="context-skill-row">
              <div className="context-skill-head">
                <span className="context-skill-name">{s.name}</span>
                {s.type && <span className={`context-skill-type context-skill-type-${s.type}`}>{s.type}</span>}
              </div>
              <div className="context-skill-desc">{s.description}</div>
              <div className="context-skill-location">{s.location}</div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
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
  const isClaudeCode = data.engine === 'claude-code';

  return (
    <div className="context-inspector">
      <div className="context-inspector-header">
        <span className="context-inspector-title">Agent Context Inspector</span>
        <span
          className="context-token-badge"
          title="A chat turn runs in a coding-agent session; this shows that session's launch config."
        >
          {isClaudeCode ? 'Claude Code engine' : `${data.engine ?? 'unknown'} engine`}
        </span>
        <span className="context-token-badge context-token-badge-total">
          System prompt: ~{totalTokens.toLocaleString()} tokens
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
            {`model: ${sections.modelConfig.content.model}\nsession: ${sections.modelConfig.content.region}`}
          </pre>
        </ContextSection>

        <ContextSection title="Persona Prompt (launch --append-system-prompt)" tokens={sections.roleAndRules.tokens}>
          <ContextMarkdown content={sections.roleAndRules.content} />
        </ContextSection>

        <ContextSection title="Skills" tokens={sections.skills.tokens}>
          <SkillsIndexView content={sections.skills.content} />
        </ContextSection>

        <ContextSection title="Global Memory (MEMORY.md)" tokens={sections.globalMemory.tokens}>
          <ContextMarkdown content={sections.globalMemory.content} fallback="(Empty)" />
        </ContextSection>
      </div>
    </div>
  );
}
