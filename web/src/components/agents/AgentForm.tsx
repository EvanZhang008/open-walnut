import { useState, useEffect, useRef, type SetStateAction } from 'react';
import { MicField, type BoxMicHandle } from '@/components/common/BoxMic';
import { useDraftValue } from '@/hooks/useDraft';
import { draftKey } from '@/utils/drafts';
import type { AgentDefinition, CreateAgentInput, UpdateAgentInput, ContextSourceId, ContextSourceConfig } from '@/api/agents';

interface AgentFormProps {
  agent?: AgentDefinition;        // undefined = create, defined = edit
  cloneFrom?: AgentDefinition;    // pre-fill from clone source
  onSave: (input: CreateAgentInput | UpdateAgentInput) => Promise<void>;
  onCancel: () => void;
}

// Context source definitions
const CONTEXT_SOURCE_DEFS: { id: ContextSourceId; label: string; auto: boolean; defaultBudget: number; description: string }[] = [
  { id: 'task_details', label: 'Task Details', auto: true, defaultBudget: 1500, description: 'Task metadata, subtasks, description, summary, notes' },
  // Legacy store: reads memory/projects/<project>/MEMORY.md (flattened from the
  // pre-v5 two-segment layout). The 2026-07 skills migration superseded it but did
  // not empty it. Still real for projects whose content was never moved to a skill.
  { id: 'project_memory', label: 'Project Memory', auto: true, defaultBudget: 2000, description: 'Legacy project MEMORY.md (pre-skills projects only)' },
  { id: 'project_task_list', label: 'Project Task List', auto: false, defaultBudget: 1500, description: 'All non-completed tasks in the same project' },
  { id: 'global_memory', label: 'Global Memory', auto: false, defaultBudget: 2000, description: 'Global MEMORY.md' },
  { id: 'daily_log', label: 'Daily Log', auto: false, defaultBudget: 3000, description: 'Recent daily activity logs' },
  { id: 'session_history', label: 'Session History', auto: false, defaultBudget: 4000, description: 'History of the triggering session' },
  { id: 'conversation_log', label: 'Conversation Log', auto: false, defaultBudget: 1000, description: "Task's conversation_log field" },
  { id: 'main_global_memory', label: 'Main Agent Memory', auto: false, defaultBudget: 2000, description: "General agent's MEMORY.md (read-only)" },
  { id: 'main_daily_log', label: 'Main Agent Daily Log', auto: false, defaultBudget: 3000, description: "General agent's daily activity logs (read-only)" },
];

type ContextSourcesState = Record<ContextSourceId, { enabled: boolean; budget: number | '' }>;

/**
 * Every field the form edits, kept as ONE draft until Save or Cancel. An agent is
 * a persona for a Claude Code session, so these are all it has: the session picks
 * model, tools and directory. A draft an older form kept may still hold its
 * runner/model/stateful fields; they are never read or sent.
 */
interface KeptAgent {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  contextSources: ContextSourcesState;
}

/** The form filled from the agent being edited or cloned (empty for a new one). */
function keptFrom(source: AgentDefinition | undefined, cloneFrom: AgentDefinition | undefined): KeptAgent {
  const contextSources: Record<string, { enabled: boolean; budget: number | '' }> = {};
  for (const def of CONTEXT_SOURCE_DEFS) {
    contextSources[def.id] = { enabled: def.auto, budget: '' };
  }
  const empty: KeptAgent = {
    id: '', name: '', description: '', systemPrompt: '',
    contextSources: contextSources as ContextSourcesState,
  };
  if (!source) return empty;
  // Initialize context sources from agent definition
  for (const src of source.context_sources ?? []) {
    if (contextSources[src.id]) {
      contextSources[src.id] = { enabled: src.enabled, budget: src.token_budget ?? '' };
    }
  }
  return {
    ...empty,
    id: cloneFrom ? `${source.id}-copy` : source.id,
    name: cloneFrom ? `${source.name} (Copy)` : source.name,
    description: source.description ?? '',
    systemPrompt: source.system_prompt ?? '',
  };
}

export function AgentForm({ agent, cloneFrom, onSave, onCancel }: AgentFormProps) {
  const source = cloneFrom || agent;
  const isEdit = !!agent;

  // The form is a draft of this agent (its clone, or the new one) until Save or
  // Cancel, so leaving the page or a reload keeps what was typed.
  const baseline = keptFrom(source, cloneFrom);
  const kept = useDraftValue<KeptAgent>(
    draftKey('agent-form', agent ? agent.id : cloneFrom ? `clone-${cloneFrom.id}` : 'new'),
    baseline,
  );
  // Over the baseline, so a draft kept by an older form never lacks a field.
  const { id, name, description, systemPrompt } = { ...baseline, ...kept.value };
  const contextSources = { ...baseline.contextSources, ...kept.value.contextSources };
  const setKept = kept.setValue;
  const slice = <K extends keyof KeptAgent>(field: K) => (next: SetStateAction<KeptAgent[K]>) =>
    setKept((prev) => ({
      ...prev,
      [field]: typeof next === 'function' ? (next as (p: KeptAgent[K]) => KeptAgent[K])(prev[field]) : next,
    }));
  const setId = slice('id');
  const setName = slice('name');
  const setDescription = slice('description');
  const setSystemPrompt = slice('systemPrompt');
  const setContextSources = slice('contextSources');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const descRef = useRef<HTMLInputElement | null>(null);
  const descMic = useRef<BoxMicHandle | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const promptMic = useRef<BoxMicHandle | null>(null);

  // Another agent fills the form (from the draft hook): a dictation on its way belongs to the old one.
  useEffect(() => {
    if (!source) return;
    descMic.current?.clear();
    promptMic.current?.clear();
  }, [source, cloneFrom]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!id.trim()) { setError('ID is required'); return; }
    if (!name.trim()) { setError('Name is required'); return; }
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id.trim())) {
      setError('ID must be a lowercase slug (letters, numbers, hyphens, underscores)');
      return;
    }

    setSaving(true);
    setError(null);

    // Build context_sources array from non-auto sources that are toggled
    const ctxSources: ContextSourceConfig[] = [];
    for (const def of CONTEXT_SOURCE_DEFS) {
      if (def.auto) continue; // auto sources are always loaded, no need to persist
      const state = contextSources[def.id];
      if (state.enabled) {
        const entry: ContextSourceConfig = { id: def.id, enabled: true };
        if (state.budget !== '' && Number(state.budget) !== def.defaultBudget) {
          entry.token_budget = Number(state.budget);
        }
        ctxSources.push(entry);
      }
    }

    const input: CreateAgentInput = {
      id: id.trim(),
      name: name.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(systemPrompt.trim() ? { system_prompt: systemPrompt.trim() } : {}),
      ...(ctxSources.length > 0 ? { context_sources: ctxSources } : {}),
    };

    const sentKey = kept.key;
    try {
      // A transcription still on its way lands after the save, unsaved: drop it now.
      descMic.current?.clear();
      promptMic.current?.clear();
      await onSave(input);
      kept.clear(sentKey);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  const isBuiltinEdit = isEdit && agent?.source === 'builtin';

  return (
    <div className="agent-form card">
      <h3 className="agent-form-title">
        {isEdit ? 'Edit Agent' : cloneFrom ? 'Clone Agent' : 'New Agent'}
      </h3>
      <form onSubmit={handleSubmit}>
        {error && <div className="agent-form-error">{error}</div>}
        {isBuiltinEdit && (
          <div className="agent-form-info">
            This is a builtin agent. Saving will create a config override — the original builtin definition is preserved and can be restored via &quot;Reset to Default&quot;.
          </div>
        )}

        {/* Section 1: Identity */}
        <div className="agent-form-section">
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="agent-id">ID (slug)</label>
              <input
                data-draft-key={kept.key ?? undefined}
                id="agent-id"
                type="text"
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="e.g. session-summarizer"
                disabled={isEdit}
                className="font-mono"
              />
            </div>
            <div className="form-group">
              <label htmlFor="agent-name">Name</label>
              <input
                data-draft-key={kept.key ?? undefined}
                id="agent-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Session Summarizer"
              />
            </div>
          </div>
          <div className="form-group">
            <label htmlFor="agent-desc">Description (optional)</label>
            <MicField inline boxRef={descRef} text={description} setText={setDescription} handleRef={descMic}>
              <input
                data-draft-key={kept.key ?? undefined}
                ref={descRef}
                id="agent-desc"
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does this agent do?"
              />
            </MicField>
          </div>
        </div>

        {/* Section 2: System Prompt */}
        <div className="agent-form-section">
          <div className="form-group">
            <label htmlFor="agent-prompt">System Prompt (optional)</label>
            <MicField boxRef={promptRef} text={systemPrompt} setText={setSystemPrompt} handleRef={promptMic}>
              <textarea
                data-draft-key={kept.key ?? undefined}
                ref={promptRef}
                id="agent-prompt"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="Custom instructions for this agent..."
                rows={6}
                style={{ resize: 'vertical', fontFamily: 'var(--font-mono)' }}
              />
            </MicField>
          </div>
        </div>

        {/* Section 3: Context Sources */}
        <div className="agent-form-section">
          <div className="form-group">
            <label>Context Sources</label>
            <p className="text-muted" style={{ fontSize: '0.85rem', margin: '0 0 8px' }}>
              Select which context to inject when this agent is invoked with a task.
            </p>
            <div className="context-sources-list">
              {CONTEXT_SOURCE_DEFS.map((def) => {
                const state = contextSources[def.id];
                return (
                  <div key={def.id} className="context-source-row">
                    <label className="context-source-toggle">
                      <input
                        type="checkbox"
                        checked={def.auto || state.enabled}
                        disabled={def.auto}
                        onChange={(e) => {
                          if (def.auto) return;
                          setContextSources((prev) => ({
                            ...prev,
                            [def.id]: { ...prev[def.id], enabled: e.target.checked },
                          }));
                        }}
                      />
                      <span>{def.label}</span>
                      {def.auto && <span className="context-source-auto-badge">AUTO</span>}
                    </label>
                    {!def.auto && state.enabled && (
                      <input
                        data-draft-key={kept.key ?? undefined}
                        type="number"
                        className="context-source-budget"
                        min="100"
                        placeholder={String(def.defaultBudget)}
                        value={state.budget}
                        onChange={(e) => {
                          setContextSources((prev) => ({
                            ...prev,
                            [def.id]: { ...prev[def.id], budget: e.target.value ? Number(e.target.value) : '' },
                          }));
                        }}
                        title={`Token budget (default: ${def.defaultBudget})`}
                      />
                    )}
                    <span className="text-muted context-source-desc">{def.description}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="form-actions">
          <button type="button" className="btn" onClick={() => { kept.clear(); onCancel(); }} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving...' : isEdit ? 'Update' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
