import { useState, useEffect, useMemo } from 'react';
import type { AgentDefinition, AgentStatefulConfig, CreateAgentInput, UpdateAgentInput, ContextSourceId, ContextSourceConfig, SkillMeta } from '@/api/agents';

interface AgentFormProps {
  agent?: AgentDefinition;        // undefined = create, defined = edit
  cloneFrom?: AgentDefinition;    // pre-fill from clone source
  toolNames: string[];
  availableModels?: string[];
  skillsMeta?: SkillMeta[];
  onSave: (input: CreateAgentInput | UpdateAgentInput) => Promise<void>;
  onCancel: () => void;
}

type ToolMode = 'all' | 'allow' | 'deny';

// Tool categories for the picker
const TOOL_CATEGORIES: Record<string, string[]> = {
  Task: ['query_tasks', 'get_task', 'create_task', 'update_task', 'delete_task'],
  Memory: ['search', 'memory'],
  Sessions: ['list_sessions', 'get_session_summary', 'start_session', 'send_to_session', 'get_session_history', 'update_session'],
  Config: ['get_config', 'update_config', 'rename_category'],
  Files: ['read_file', 'write_file', 'edit_file'],
  Execution: ['exec', 'apply_patch', 'process'],
  Integration: ['slack', 'tts', 'analyze_image'],
  Web: ['web_search', 'web_fetch'],
  Cron: ['list_cron_jobs', 'manage_cron_job'],
  Agents: ['list_agents', 'get_agent', 'create_agent', 'update_agent', 'delete_agent'],
};

function ToolPicker({ value, onChange, toolNames }: { value: string[]; onChange: (tools: string[]) => void; toolNames: string[] }) {
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // Group tools into categories; uncategorized goes to "Other"
  const categorized = useMemo(() => {
    const assigned = new Set(Object.values(TOOL_CATEGORIES).flat());
    const other = toolNames.filter((t) => !assigned.has(t));
    const cats = { ...TOOL_CATEGORIES };
    if (other.length > 0) cats['Other'] = other;
    return cats;
  }, [toolNames]);

  const filteredCategories = useMemo(() => {
    if (!filter.trim()) return categorized;
    const q = filter.toLowerCase();
    const result: Record<string, string[]> = {};
    for (const [cat, tools] of Object.entries(categorized)) {
      const matched = tools.filter((t) => t.toLowerCase().includes(q));
      if (matched.length > 0) result[cat] = matched;
    }
    return result;
  }, [categorized, filter]);

  const selected = new Set(value);

  function toggle(tool: string) {
    if (selected.has(tool)) {
      onChange(value.filter((t) => t !== tool));
    } else {
      onChange([...value, tool]);
    }
  }

  function removeSelected(tool: string) {
    onChange(value.filter((t) => t !== tool));
  }

  function toggleCategory(cat: string) {
    setCollapsed((prev) => ({ ...prev, [cat]: !prev[cat] }));
  }

  return (
    <div className="tool-picker">
      <input
        type="text"
        className="tool-picker-filter"
        placeholder="Filter tools..."
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {value.length > 0 && (
        <div className="tool-picker-selected">
          <span className="tool-picker-selected-label">Selected ({value.length}):</span>
          {value.map((t) => (
            <span key={t} className="tool-picker-chip" onClick={() => removeSelected(t)}>
              {t} &times;
            </span>
          ))}
        </div>
      )}
      <div className="tool-picker-categories">
        {Object.entries(filteredCategories).map(([cat, tools]) => (
          <div key={cat} className="tool-picker-category">
            <button
              type="button"
              className="tool-picker-category-header"
              onClick={() => toggleCategory(cat)}
            >
              <span>{collapsed[cat] ? '▸' : '▾'}</span>
              <span>{cat}</span>
              <span className="text-muted">({tools.length})</span>
            </button>
            {!collapsed[cat] && (
              <div className="tool-picker-tools">
                {tools.map((tool) => (
                  <label key={tool} className="tool-picker-tool">
                    <input
                      type="checkbox"
                      checked={selected.has(tool)}
                      onChange={() => toggle(tool)}
                    />
                    <span>{tool}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
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
  { id: 'project_memory', label: 'Project Memory', auto: true, defaultBudget: 2000, description: 'Project MEMORY.md content' },
  { id: 'project_task_list', label: 'Project Task List', auto: false, defaultBudget: 1500, description: 'All non-completed tasks in the same project' },
  { id: 'global_memory', label: 'Global Memory', auto: false, defaultBudget: 2000, description: 'Global MEMORY.md' },
  { id: 'daily_log', label: 'Daily Log', auto: false, defaultBudget: 3000, description: 'Recent daily activity logs' },
  { id: 'session_history', label: 'Session History', auto: false, defaultBudget: 4000, description: 'History of the triggering session' },
  { id: 'conversation_log', label: 'Conversation Log', auto: false, defaultBudget: 1000, description: "Task's conversation_log field" },
];

export function AgentForm({ agent, cloneFrom, toolNames, availableModels = [], skillsMeta = [], onSave, onCancel }: AgentFormProps) {
  const source = cloneFrom || agent;
  const isEdit = !!agent;

  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [runner, setRunner] = useState<'embedded' | 'cli'>('embedded');
  const [model, setModel] = useState('');
  const [region, setRegion] = useState('');
  const [maxTokens, setMaxTokens] = useState<number | ''>('');
  const [maxToolRounds, setMaxToolRounds] = useState<number | ''>('');
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [toolMode, setToolMode] = useState<ToolMode>('all');
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [skillFilter, setSkillFilter] = useState('');
  const [hasStateful, setHasStateful] = useState(false);
  const [memoryProject, setMemoryProject] = useState('');
  const [memoryBudget, setMemoryBudget] = useState<number | ''>('');
  const [memorySource, setMemorySource] = useState('');
  const [contextSources, setContextSources] = useState<Record<ContextSourceId, { enabled: boolean; budget: number | '' }>>(() => {
    const initial: Record<string, { enabled: boolean; budget: number | '' }> = {};
    for (const def of CONTEXT_SOURCE_DEFS) {
      initial[def.id] = { enabled: def.auto, budget: '' };
    }
    return initial as Record<ContextSourceId, { enabled: boolean; budget: number | '' }>;
  });

  const [customModel, setCustomModel] = useState('');
  const [useCustom, setUseCustom] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Determine the select value: explicit custom mode, known model, or default
  const selectValue = useCustom
    ? CUSTOM_MODEL_VALUE
    : model === '' ? '' : availableModels.includes(model) ? model : CUSTOM_MODEL_VALUE;

  useEffect(() => {
    if (!source) return;
    setId(cloneFrom ? `${source.id}-copy` : source.id);
    setName(cloneFrom ? `${source.name} (Copy)` : source.name);
    setDescription(source.description ?? '');
    setRunner(source.runner);
    setModel(source.model ?? '');
    if (source.model && availableModels.length > 0 && !availableModels.includes(source.model)) {
      setCustomModel(source.model);
      setUseCustom(true);
    } else {
      setUseCustom(false);
    }
    setRegion(source.region ?? '');
    setMaxTokens(source.max_tokens ?? '');
    setMaxToolRounds(source.max_tool_rounds ?? '');
    setWorkingDirectory(source.working_directory ?? '');
    setSystemPrompt(source.system_prompt ?? '');
    if (source.allowed_tools?.length) {
      setToolMode('allow');
      setSelectedTools(source.allowed_tools);
    } else if (source.denied_tools?.length) {
      setToolMode('deny');
      setSelectedTools(source.denied_tools);
    } else {
      setToolMode('all');
      setSelectedTools([]);
    }
    // Initialize context sources from agent definition
    if (source.context_sources?.length) {
      setContextSources((prev) => {
        const next = { ...prev };
        for (const src of source.context_sources!) {
          if (next[src.id]) {
            next[src.id] = { enabled: src.enabled, budget: src.token_budget ?? '' };
          }
        }
        return next;
      });
    }
    // Initialize skills
    setSelectedSkills(source.skills ?? []);
    // Initialize stateful memory
    if (source.stateful) {
      setHasStateful(true);
      setMemoryProject(source.stateful.memory_project ?? '');
      setMemoryBudget(source.stateful.memory_budget_tokens ?? '');
      setMemorySource(source.stateful.memory_source ?? '');
    } else {
      setHasStateful(false);
      setMemoryProject('');
      setMemoryBudget('');
      setMemorySource('');
    }
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
      ...(toolMode === 'allow' && selectedTools.length ? { allowed_tools: selectedTools } : {}),
      ...(toolMode === 'deny' && selectedTools.length ? { denied_tools: selectedTools } : {}),
      ...(ctxSources.length > 0 ? { context_sources: ctxSources } : {}),
      ...(runner === 'embedded' && selectedSkills.length > 0 ? { skills: selectedSkills } : {}),
      ...(stateful ? { stateful } : {}),
    };

    try {
      await onSave(input);
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
            <input
              id="agent-desc"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this agent do?"
            />
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
            <textarea
              id="agent-prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="Custom instructions for this agent..."
              rows={6}
              style={{ resize: 'vertical', fontFamily: 'var(--font-mono)' }}
            />
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

        {/* Section 6: Tool Access */}
        <div className="agent-form-section">
          <div className="form-group">
            <label>Tool Access</label>
            <div className="agent-form-radio-group">
              <label className="agent-form-radio">
                <input type="radio" name="toolMode" value="all" checked={toolMode === 'all'} onChange={() => { setToolMode('all'); setSelectedTools([]); }} />
                <span>All tools</span>
              </label>
              <label className="agent-form-radio">
                <input type="radio" name="toolMode" value="allow" checked={toolMode === 'allow'} onChange={() => setToolMode('allow')} />
                <span>Allow list (only these tools)</span>
              </label>
              <label className="agent-form-radio">
                <input type="radio" name="toolMode" value="deny" checked={toolMode === 'deny'} onChange={() => setToolMode('deny')} />
                <span>Deny list (all except these)</span>
              </label>
            </div>
          </div>
          {toolMode !== 'all' && (
            <ToolPicker
              value={selectedTools}
              onChange={setSelectedTools}
              toolNames={toolNames}
            />
          )}
        </div>

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
                    id="agent-mem-project"
                    type="text"
                    value={memoryProject}
                    onChange={(e) => setMemoryProject(e.target.value)}
                    placeholder="{auto}/triage"
                    className="font-mono"
                  />
                  <p className="text-muted" style={{ fontSize: '0.8rem', margin: '2px 0 0' }}>
                    Use &#123;auto&#125; to resolve to &#123;category&#125;/&#123;project&#125; from the task
                  </p>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="agent-mem-budget">Token Budget</label>
                    <input
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
          <button type="button" className="btn" onClick={onCancel} disabled={saving}>
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
