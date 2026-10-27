import { useState, useEffect, useMemo, useRef, type SetStateAction } from 'react';
import { MicField, type BoxMicHandle } from '@/components/common/BoxMic';
import { useDraftValue } from '@/hooks/useDraft';
import { draftKey } from '@/utils/drafts';
import type { AgentDefinition, AgentStatefulConfig, CreateAgentInput, UpdateAgentInput, ContextSourceId, ContextSourceConfig, SkillMeta } from '@/api/agents';

interface AgentFormProps {
  agent?: AgentDefinition;        // undefined = create, defined = edit
  cloneFrom?: AgentDefinition;    // pre-fill from clone source
  availableModels?: string[];
  skillsMeta?: SkillMeta[];
  onSave: (input: CreateAgentInput | UpdateAgentInput) => Promise<void>;
  onCancel: () => void;
}

function SkillsPicker({ skillsMeta, selectedSkills, onChangeSkills, skillFilter, onChangeFilter }: {
  skillsMeta: SkillMeta[];
  selectedSkills: string[];
  onChangeSkills: (skills: string[]) => void;
  skillFilter: string;
  onChangeFilter: (filter: string) => void;
}) {
  const filteredSkills = useMemo(() => {
    if (!skillFilter.trim()) return skillsMeta;
    const q = skillFilter.toLowerCase();
    return skillsMeta.filter((s) =>
      s.dirName.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
    );
  }, [skillsMeta, skillFilter]);

  const selectedSet = useMemo(() => new Set(selectedSkills), [selectedSkills]);
  const visibleDirNames = useMemo(() => filteredSkills.map((s) => s.dirName), [filteredSkills]);
  const allVisibleSelected = visibleDirNames.length > 0 && visibleDirNames.every((d) => selectedSet.has(d));

  function toggleAll() {
    if (allVisibleSelected) {
      // Deselect all visible (keep selections for non-visible skills)
      const visibleSet = new Set(visibleDirNames);
      onChangeSkills(selectedSkills.filter((s) => !visibleSet.has(s)));
    } else {
      // Select all visible (merge with existing selections)
      const merged = new Set(selectedSkills);
      for (const d of visibleDirNames) merged.add(d);
      onChangeSkills([...merged]);
    }
  }

  return (
    <div className="agent-form-section">
      <div className="form-group">
        <label>Skills</label>
        <p className="text-muted" style={{ fontSize: '0.85rem', margin: '0 0 8px' }}>
          Select skills to include in this agent&apos;s system prompt.
        </p>
        <input
          data-no-draft="search"
          type="text"
          className="skills-picker-filter"
          placeholder="Filter skills..."
          value={skillFilter}
          onChange={(e) => onChangeFilter(e.target.value)}
        />
        <div className="skills-picker-toolbar">
          <button type="button" className="skills-toggle-all-btn" onClick={toggleAll}>
            {allVisibleSelected ? 'Deselect All' : `Select All (${visibleDirNames.length})`}
          </button>
          <span className="text-muted" style={{ fontSize: '0.8rem' }}>
            {selectedSkills.length} of {skillsMeta.length} selected
          </span>
        </div>
        <div className="skills-picker">
          {filteredSkills.map((s) => (
            <label key={s.dirName} className="skills-picker-row">
              <input
                type="checkbox"
                checked={selectedSet.has(s.dirName)}
                onChange={(e) => {
                  if (e.target.checked) {
                    onChangeSkills([...selectedSkills, s.dirName]);
                  } else {
                    onChangeSkills(selectedSkills.filter((d) => d !== s.dirName));
                  }
                }}
              />
              <span className="skills-picker-name">{s.dirName}</span>
              <span className="skills-picker-desc text-muted">{s.description}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Extract a friendly display name from a Bedrock model ID. */
function modelDisplayName(modelId: string): string {
  // e.g. "global.anthropic.claude-opus-4-6-v1" → "claude-opus-4-6 (global)"
  // e.g. "us.anthropic.claude-sonnet-4-5-20250929-v1:0" → "claude-sonnet-4-5-20250929 (us)"
  const parts = modelId.split('.');
  if (parts.length >= 3) {
    const prefix = parts[0]; // global, us, etc.
    const rest = parts.slice(2).join('.'); // claude-opus-4-6-v1
    // Strip version suffix (-v1, -v1:0, etc.)
    const cleaned = rest.replace(/-v\d+(?::\d+)?$/, '');
    return `${cleaned} (${prefix})`;
  }
  return modelId;
}

const CUSTOM_MODEL_VALUE = '__custom__';

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

/** Every field the form edits, kept as ONE draft until Save or Cancel. */
interface KeptAgent {
  id: string;
  name: string;
  description: string;
  runner: 'embedded' | 'cli';
  model: string;
  region: string;
  maxTokens: number | '';
  maxToolRounds: number | '';
  workingDirectory: string;
  systemPrompt: string;
  selectedSkills: string[];
  hasStateful: boolean;
  memoryProject: string;
  memoryBudget: number | '';
  memorySource: string;
  contextSources: ContextSourcesState;
  customModel: string;
  useCustom: boolean;
}

/** The form filled from the agent being edited or cloned (empty for a new one). */
function keptFrom(source: AgentDefinition | undefined, cloneFrom: AgentDefinition | undefined, availableModels: string[]): KeptAgent {
  const contextSources: Record<string, { enabled: boolean; budget: number | '' }> = {};
  for (const def of CONTEXT_SOURCE_DEFS) {
    contextSources[def.id] = { enabled: def.auto, budget: '' };
  }
  const empty: KeptAgent = {
    id: '', name: '', description: '', runner: 'embedded', model: '', region: '',
    maxTokens: '', maxToolRounds: '', workingDirectory: '', systemPrompt: '', selectedSkills: [],
    hasStateful: false, memoryProject: '', memoryBudget: '', memorySource: '',
    contextSources: contextSources as ContextSourcesState, customModel: '', useCustom: false,
  };
  if (!source) return empty;
  // Initialize context sources from agent definition
  for (const src of source.context_sources ?? []) {
    if (contextSources[src.id]) {
      contextSources[src.id] = { enabled: src.enabled, budget: src.token_budget ?? '' };
    }
  }
  const custom = !!source.model && availableModels.length > 0 && !availableModels.includes(source.model);
  return {
    ...empty,
    id: cloneFrom ? `${source.id}-copy` : source.id,
    name: cloneFrom ? `${source.name} (Copy)` : source.name,
    description: source.description ?? '',
    runner: source.runner,
    model: source.model ?? '',
    customModel: custom ? source.model ?? '' : '',
    useCustom: custom,
    region: source.region ?? '',
    maxTokens: source.max_tokens ?? '',
    maxToolRounds: source.max_tool_rounds ?? '',
    workingDirectory: source.working_directory ?? '',
    systemPrompt: source.system_prompt ?? '',
    selectedSkills: source.skills ?? [],
    // Initialize stateful memory
    hasStateful: !!source.stateful,
    memoryProject: source.stateful?.memory_project ?? '',
    memoryBudget: source.stateful?.memory_budget_tokens ?? '',
    memorySource: source.stateful?.memory_source ?? '',
  };
}

export function AgentForm({ agent, cloneFrom, availableModels = [], skillsMeta = [], onSave, onCancel }: AgentFormProps) {
  const source = cloneFrom || agent;
  const isEdit = !!agent;

  // The form is a draft of this agent (its clone, or the new one) until Save or
  // Cancel, so leaving the page or a reload keeps what was typed.
  const baseline = keptFrom(source, cloneFrom, availableModels);
  const kept = useDraftValue<KeptAgent>(
    draftKey('agent-form', agent ? agent.id : cloneFrom ? `clone-${cloneFrom.id}` : 'new'),
    baseline,
  );
  // Over the baseline, so a draft kept by an older form never lacks a field.
  const {
    id, name, description, runner, model, region, maxTokens, maxToolRounds, workingDirectory, systemPrompt,
    selectedSkills, hasStateful, memoryProject, memoryBudget, memorySource, customModel, useCustom,
  } = { ...baseline, ...kept.value };
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
  const setRunner = slice('runner');
  const setModel = slice('model');
  const setRegion = slice('region');
  const setMaxTokens = slice('maxTokens');
  const setMaxToolRounds = slice('maxToolRounds');
  const setWorkingDirectory = slice('workingDirectory');
  const setSystemPrompt = slice('systemPrompt');
  const setSelectedSkills = slice('selectedSkills');
  const setHasStateful = slice('hasStateful');
  const setMemoryProject = slice('memoryProject');
  const setMemoryBudget = slice('memoryBudget');
  const setMemorySource = slice('memorySource');
  const setContextSources = slice('contextSources');
  const setCustomModel = slice('customModel');
  const setUseCustom = slice('useCustom');
  const [skillFilter, setSkillFilter] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const descRef = useRef<HTMLInputElement | null>(null);
  const descMic = useRef<BoxMicHandle | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const promptMic = useRef<BoxMicHandle | null>(null);

  // Determine the select value: explicit custom mode, known model, or default
  const selectValue = useCustom
    ? CUSTOM_MODEL_VALUE
    : model === '' ? '' : availableModels.includes(model) ? model : CUSTOM_MODEL_VALUE;

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

    // Build stateful config
    let stateful: AgentStatefulConfig | undefined;
    if (runner === 'embedded' && hasStateful && memoryProject.trim()) {
      stateful = { memory_project: memoryProject.trim() };
      if (memoryBudget !== '' && Number(memoryBudget) !== 4000) {
        stateful.memory_budget_tokens = Number(memoryBudget);
      }
      if (memorySource.trim()) {
        stateful.memory_source = memorySource.trim();
      }
    }

    const input: CreateAgentInput = {
      id: id.trim(),
      name: name.trim(),
      runner,
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
      ...(region.trim() ? { region: region.trim() } : {}),
      ...(maxTokens !== '' ? { max_tokens: Number(maxTokens) } : {}),
      ...(maxToolRounds !== '' ? { max_tool_rounds: Number(maxToolRounds) } : {}),
      ...(runner === 'cli' && workingDirectory.trim() ? { working_directory: workingDirectory.trim() } : {}),
      ...(systemPrompt.trim() ? { system_prompt: systemPrompt.trim() } : {}),
      ...(ctxSources.length > 0 ? { context_sources: ctxSources } : {}),
      ...(runner === 'embedded' && selectedSkills.length > 0 ? { skills: selectedSkills } : {}),
      ...(stateful ? { stateful } : {}),
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

        {/* Section 2: Execution */}
        <div className="agent-form-section">
          <div className="form-group">
            <label>Runner</label>
            <div className="agent-form-radio-group">
              <label className="agent-form-radio">
                <input type="radio" name="runner" value="embedded" checked={runner === 'embedded'} onChange={() => setRunner('embedded')} />
                <span>Embedded (in-process)</span>
              </label>
              <label className="agent-form-radio">
                <input type="radio" name="runner" value="cli" checked={runner === 'cli'} onChange={() => setRunner('cli')} />
                <span>CLI (Claude Code)</span>
              </label>
            </div>
          </div>
          <div className="form-group">
            <label htmlFor="agent-model">Model (optional)</label>
            {availableModels.length > 0 ? (
              <>
                <select
                  id="agent-model"
                  className="model-select"
                  value={selectValue}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === CUSTOM_MODEL_VALUE) {
                      setUseCustom(true);
                      setModel(customModel);
                    } else {
                      setUseCustom(false);
                      setModel(v);
                      setCustomModel('');
                    }
                  }}
                >
                  <option value="">— Default (inherit) —</option>
                  {availableModels.map((m) => (
                    <option key={m} value={m}>{modelDisplayName(m)}</option>
                  ))}
                  <option value={CUSTOM_MODEL_VALUE}>Custom...</option>
                </select>
                {selectValue === CUSTOM_MODEL_VALUE && (
                  <input
                    data-draft-key={kept.key ?? undefined}
                    type="text"
                    className="font-mono"
                    style={{ marginTop: 6 }}
                    value={customModel}
                    onChange={(e) => { setCustomModel(e.target.value); setModel(e.target.value); }}
                    placeholder="us.anthropic.claude-sonnet-4-5-20250929-v1:0"
                  />
                )}
              </>
            ) : (
              <input
                data-draft-key={kept.key ?? undefined}
                id="agent-model"
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="us.anthropic.claude-sonnet-4-5-20250929-v1:0"
                className="font-mono"
              />
            )}
          </div>
          <div className="form-group">
            <label htmlFor="agent-region">Region (optional)</label>
            <input
              data-draft-key={kept.key ?? undefined}
              id="agent-region"
              type="text"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              placeholder="us-west-2"
            />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="agent-max-tokens">Max Tokens</label>
              <input
                data-draft-key={kept.key ?? undefined}
                id="agent-max-tokens"
                type="number"
                min="1"
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value ? Number(e.target.value) : '')}
                placeholder="16384"
              />
            </div>
            <div className="form-group">
              <label htmlFor="agent-max-rounds">Max Tool Rounds</label>
              <input
                data-draft-key={kept.key ?? undefined}
                id="agent-max-rounds"
                type="number"
                min="1"
                value={maxToolRounds}
                onChange={(e) => setMaxToolRounds(e.target.value ? Number(e.target.value) : '')}
                placeholder="10"
              />
            </div>
          </div>
          {runner === 'cli' && (
            <div className="form-group">
              <label htmlFor="agent-cwd">Working Directory</label>
              <input
                data-draft-key={kept.key ?? undefined}
                id="agent-cwd"
                type="text"
                value={workingDirectory}
                onChange={(e) => setWorkingDirectory(e.target.value)}
                placeholder="/path/to/project"
              />
            </div>
          )}
        </div>

        {/* Section 3: System Prompt */}
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

        {/* Section 4: Context Sources */}
        {runner === 'embedded' && (
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
        )}

        {/* Section 6: Skills (embedded only) */}
        {runner === 'embedded' && skillsMeta.length > 0 && (
          <SkillsPicker
            skillsMeta={skillsMeta}
            selectedSkills={selectedSkills}
            onChangeSkills={setSelectedSkills}
            skillFilter={skillFilter}
            onChangeFilter={setSkillFilter}
          />
        )}

        {/* Section 7: Stateful Memory (embedded only) */}
        {runner === 'embedded' && (
          <div className="agent-form-section">
            <div className="form-group">
              <label className="stateful-toggle">
                <input
                  type="checkbox"
                  checked={hasStateful}
                  onChange={(e) => setHasStateful(e.target.checked)}
                />
                <span>Stateful Memory</span>
              </label>
              <p className="text-muted" style={{ fontSize: '0.85rem', margin: '4px 0 0' }}>
                Enable persistent memory across invocations.
              </p>
            </div>
            {hasStateful && (
              <div className="stateful-fields">
                <div className="form-group">
                  <label htmlFor="agent-mem-project">Memory Project Path</label>
                  <input
                    data-draft-key={kept.key ?? undefined}
                    id="agent-mem-project"
                    type="text"
                    value={memoryProject}
                    onChange={(e) => setMemoryProject(e.target.value)}
                    placeholder="{auto}/triage"
                    className="font-mono"
                  />
                  <p className="text-muted" style={{ fontSize: '0.8rem', margin: '2px 0 0' }}>
                    Use &#123;auto&#125; to resolve to the task&apos;s project (or &quot;inbox&quot;)
                  </p>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="agent-mem-budget">Token Budget</label>
                    <input
                      data-draft-key={kept.key ?? undefined}
                      id="agent-mem-budget"
                      type="number"
                      min="100"
                      value={memoryBudget}
                      onChange={(e) => setMemoryBudget(e.target.value ? Number(e.target.value) : '')}
                      placeholder="4000"
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="agent-mem-source">Memory Source</label>
                    <input
                      data-draft-key={kept.key ?? undefined}
                      id="agent-mem-source"
                      type="text"
                      value={memorySource}
                      onChange={(e) => setMemorySource(e.target.value)}
                      placeholder="(default: agent ID)"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

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
