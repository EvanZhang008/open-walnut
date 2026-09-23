import { useState, useMemo, useCallback } from 'react';
import { usePersistentState, oneOf } from '@/hooks/usePersistentState';
import { useAgents } from '@/hooks/useAgents';
import { AgentCard } from '@/components/agents/AgentCard';
import { AgentForm } from '@/components/agents/AgentForm';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import type { AgentDefinition, CreateAgentInput, UpdateAgentInput } from '@/api/agents';

type FilterTab = 'all' | 'builtin' | 'config';

// Console agents show in the home chat switcher; everything else runs in the background.
// 'general' is always a console agent regardless of its flag.
const isConsoleAgent = (a: AgentDefinition) => a.id === 'general' || a.console === true;

export function AgentsPage() {
  const { agents, availableModels, skills, loading, error, create, update, remove, clone } = useAgents();
  const [filter, setFilter] = usePersistentState<FilterTab>(
    'walnut-agents-page-filter', 'all', oneOf(['all', 'builtin', 'config']),
  );
  const [showForm, setShowForm] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AgentDefinition | undefined>(undefined);
  const [cloningFrom, setCloningFrom] = useState<AgentDefinition | undefined>(undefined);

  const isBuiltinOrOverride = (a: AgentDefinition) => a.source === 'builtin' || !!a.overrides_builtin;
  const isConfigOnly = (a: AgentDefinition) => a.source === 'config' && !a.overrides_builtin;

  const filtered = useMemo(() => {
    if (filter === 'all') return agents;
    if (filter === 'builtin') return agents.filter(isBuiltinOrOverride);
    return agents.filter(isConfigOnly);
  }, [agents, filter]);

  // Split the (already filtered) list into console vs background sections.
  const consoleAgents = useMemo(() => filtered.filter(isConsoleAgent), [filtered]);
  const backgroundAgents = useMemo(() => filtered.filter((a) => !isConsoleAgent(a)), [filtered]);

  const counts = useMemo(() => ({
    all: agents.length,
    builtin: agents.filter(isBuiltinOrOverride).length,
    config: agents.filter(isConfigOnly).length,
  }), [agents]);

  const handleSave = useCallback(async (input: CreateAgentInput | UpdateAgentInput) => {
    if (editingAgent) {
      await update(editingAgent.id, input as UpdateAgentInput);
    } else {
      await create(input as CreateAgentInput);
    }
    setShowForm(false);
    setEditingAgent(undefined);
    setCloningFrom(undefined);
  }, [editingAgent, create, update]);

  const handleEdit = useCallback((agent: AgentDefinition) => {
    setEditingAgent(agent);
    setCloningFrom(undefined);
    setShowForm(true);
  }, []);

  const handleClone = useCallback((agent: AgentDefinition) => {
    setEditingAgent(undefined);
    setCloningFrom(agent);
    setShowForm(true);
  }, []);

  const handleCancel = useCallback(() => {
    setShowForm(false);
    setEditingAgent(undefined);
    setCloningFrom(undefined);
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    await remove(id);
  }, [remove]);

  const handleReset = useCallback(async (id: string) => {
    await remove(id);
  }, [remove]);

  if (loading) return <LoadingSpinner />;
  if (error) return <div className="empty-state"><p>Error: {error}</p></div>;

  return (
    <div>
      <div className="page-header flex justify-between items-center">
        <div>
          <h1 className="page-title">Agents</h1>
          <p className="page-subtitle">Manage subagent definitions</p>
        </div>
        {!showForm && (
          <button className="btn btn-primary" onClick={() => { setEditingAgent(undefined); setCloningFrom(undefined); setShowForm(true); }}>
            + New Agent
          </button>
        )}
      </div>

      {showForm && (
        <div className="mb-4">
          <AgentForm
            agent={editingAgent}
            cloneFrom={cloningFrom}
            availableModels={availableModels}
            skillsMeta={skills}
            onSave={handleSave}
            onCancel={handleCancel}
          />
        </div>
      )}

      <div className="agent-filter-tabs">
        {(['all', 'builtin', 'config'] as const).map((tab) => (
          <button
            key={tab}
            className={`agent-filter-tab${filter === tab ? ' active' : ''}`}
            onClick={() => setFilter(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)} ({counts[tab]})
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">&#129302;</div>
          <p>{filter === 'all' ? 'No agents defined yet' : `No ${filter} agents`}</p>
          {filter === 'all' && (
            <p className="text-sm mt-2">Create an agent to define specialized AI assistants</p>
          )}
        </div>
      ) : (
        <>
          {renderAgentSection('Console agents', 'shown in the home chat switcher', consoleAgents)}
          {renderAgentSection('Background agents', 'run automatically, not in the switcher', backgroundAgents)}
        </>
      )}
    </div>
  );

  // Render a labeled section of agent cards; hides itself when the group is empty.
  function renderAgentSection(title: string, subtitle: string, group: AgentDefinition[]) {
    if (group.length === 0) return null;
    return (
      <section className="agent-section">
        <div className="agent-section-header">
          <h2 className="agent-section-title">{title}</h2>
          <span className="agent-section-subtitle">{subtitle}</span>
        </div>
        <div className="agent-list">
          {group.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              onEdit={handleEdit}
              onClone={handleClone}
              onDelete={handleDelete}
              onReset={handleReset}
            />
          ))}
        </div>
      </section>
    );
  }
}
