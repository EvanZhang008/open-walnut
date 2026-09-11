import { useMemo } from 'react';
import type { ContextInspectorResponse } from '@/api/context';
import { useRenderedMarkdown } from '@/hooks/useEntityLabels';
import { ContextSection } from './ContextSection';

interface ContextInspectorPanelProps {
  data: ContextInspectorResponse | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

/** Memoized markdown block for context sections */
function ContextMarkdown({ content, fallback }: { content: string; fallback?: string }) {
  const text = content || fallback || '';
  const html = useRenderedMarkdown(text);
  return (
    <div
      className="context-markdown markdown-body"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

interface ParsedSkill {
  name: string;
  type: string;
  description: string;
  location: string;
}

/**
 * Skills section renderer — the prompt is a markdown preamble followed by an
 * <available_skills> XML index. Rendered as raw markdown the XML collapses into
 * an unreadable wall of text, so parse it and show a grouped, scannable list.
 */
function SkillsIndexView({ content }: { content: string }) {
  const parsed = useMemo(() => {
    // lastIndexOf: the preamble TEXT mentions "<available_skills>" — the real
    // XML block is the final occurrence, at the end of the prompt.
    const xmlStart = content.lastIndexOf('<available_skills>');
    if (xmlStart === -1) return null;
    const preamble = content.slice(0, xmlStart).trim();
    try {
      const doc = new DOMParser().parseFromString(content.slice(xmlStart), 'text/xml');
      if (doc.querySelector('parsererror')) return null;
      const categories = [...doc.querySelectorAll('category')].map((cat) => ({
        name: cat.getAttribute('name') ?? 'general',
        skills: [...cat.querySelectorAll('skill')].map((s): ParsedSkill => ({
          name: s.querySelector('name')?.textContent ?? '',
          type: s.querySelector('type')?.textContent ?? '',
          description: s.querySelector('description')?.textContent ?? '',
          location: s.querySelector('location')?.textContent ?? '',
        })),
      }));
      return { preamble, categories };
    } catch {
      return null;
    }
  }, [content]);

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
                <span className={`context-skill-type context-skill-type-${s.type}`}>{s.type}</span>
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
