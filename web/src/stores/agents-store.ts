/**
 * Agent definitions store — ONE in-browser truth for the agent list.
 *
 * Two surfaces read it and both can be live at once: /agents (the management
 * page) and the homepage chat's agent switcher (`AgentTabBar`, rendered from
 * MainPage which never unmounts). They used to hold independent private copies
 * with no shared event, so creating or renaming an agent on /agents left the tab
 * bar showing the old list until a full page reload.
 *
 * The agent list and the form's metadata (tool names, models, skills) load
 * SEPARATELY on purpose: the homepage needs only the list, and pulling three
 * extra catalogues into every home load to serve one settings page is waste.
 */
import * as agentsApi from '@/api/agents';
import type { AgentDefinition, CreateAgentInput, SkillMeta, UpdateAgentInput } from '@/api/agents';
import { log } from '@/utils/log';

export interface AgentsSnapshot {
  agents: AgentDefinition[];
  toolNames: string[];
  availableModels: string[];
  skills: SkillMeta[];
  /** The list has resolved once (`[]` is a real answer, not "still loading"). */
  agentsLoaded: boolean;
  metaLoaded: boolean;
  error: string | null;
}

let snapshot: AgentsSnapshot = {
  agents: [], toolNames: [], availableModels: [], skills: [],
  agentsLoaded: false, metaLoaded: false, error: null,
};
const subscribers = new Set<() => void>();
let listInflight: Promise<void> | null = null;
let wantsRefetch = false;
let metaInflight: Promise<void> | null = null;

function emit(): void {
  for (const fn of [...subscribers]) fn();
}

function setSnapshot(patch: Partial<AgentsSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  emit();
}

export function subscribeAgents(fn: () => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

export function getAgentsSnapshot(): AgentsSnapshot {
  return snapshot;
}

/**
 * Fetch the agent list. Concurrent callers share the request; a force that lands
 * mid-flight queues exactly one fresh response behind it.
 */
export function loadAgents(force = false): Promise<void> {
  if (listInflight) {
    if (force) wantsRefetch = true;
    return listInflight;
  }
  if (!force && snapshot.agentsLoaded) return Promise.resolve();
  listInflight = (async () => {
    try {
      do {
        wantsRefetch = false;
        const agents = await agentsApi.fetchAgents();
        setSnapshot({ agents, agentsLoaded: true, error: null });
      } while (wantsRefetch);
    } catch (err) {
      wantsRefetch = false;
      log.warn('agents', 'agent list load failed', { error: String(err).slice(0, 200) });
      setSnapshot({ agentsLoaded: true, error: err instanceof Error ? err.message : String(err) });
    } finally {
      listInflight = null;
    }
  })();
  return listInflight;
}

/** Tool names, models and skills — only the /agents form needs these. */
export function loadAgentMeta(): Promise<void> {
  if (metaInflight) return metaInflight;
  if (snapshot.metaLoaded) return Promise.resolve();
  metaInflight = (async () => {
    try {
      const [toolNames, availableModels, skills] = await Promise.all([
        agentsApi.fetchToolNames(),
        agentsApi.fetchAvailableModels(),
        agentsApi.fetchAvailableSkills(),
      ]);
      setSnapshot({ toolNames, availableModels, skills, metaLoaded: true });
    } catch (err) {
      log.warn('agents', 'agent metadata load failed', { error: String(err).slice(0, 200) });
      setSnapshot({ metaLoaded: true, error: err instanceof Error ? err.message : String(err) });
    } finally {
      metaInflight = null;
    }
  })();
  return metaInflight;
}

function mergeAgent(agent: AgentDefinition): void {
  setSnapshot({
    agents: snapshot.agents.some((a) => a.id === agent.id)
      ? snapshot.agents.map((a) => (a.id === agent.id ? agent : a))
      : [...snapshot.agents, agent],
  });
}

function patchAgent(id: string, patch: Partial<AgentDefinition>): void {
  if (!snapshot.agents.some((a) => a.id === id)) return;
  setSnapshot({ agents: snapshot.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)) });
}

function dropAgent(id: string): void {
  setSnapshot({ agents: snapshot.agents.filter((a) => a.id !== id) });
}

/** Put a removed/changed row back exactly where it was. */
function restoreAgent(before: AgentDefinition, index: number): void {
  if (snapshot.agents.some((a) => a.id === before.id)) {
    setSnapshot({ agents: snapshot.agents.map((a) => (a.id === before.id ? before : a)) });
    return;
  }
  const agents = [...snapshot.agents];
  agents.splice(Math.min(index, agents.length), 0, before);
  setSnapshot({ agents });
}

export async function createAgentDefinition(input: CreateAgentInput): Promise<AgentDefinition> {
  const agent = await agentsApi.createAgentDef(input);
  mergeAgent(agent);
  return agent;
}

export async function updateAgentDefinition(id: string, input: UpdateAgentInput): Promise<AgentDefinition> {
  const index = snapshot.agents.findIndex((a) => a.id === id);
  const before = index === -1 ? null : snapshot.agents[index];
  if (before) patchAgent(id, input as Partial<AgentDefinition>);
  try {
    const agent = await agentsApi.updateAgentDef(id, input);
    mergeAgent(agent);
    return agent;
  } catch (err) {
    log.warn('agents', 'agent update failed, rolling back', { id, error: String(err).slice(0, 200) });
    if (before) restoreAgent(before, index);
    throw err;
  }
}

/**
 * Delete a config agent. A deleted override of a builtin comes BACK as the
 * builtin, so the list is re-read once the DELETE lands rather than assumed gone.
 */
export async function deleteAgentDefinition(id: string): Promise<void> {
  const index = snapshot.agents.findIndex((a) => a.id === id);
  const before = index === -1 ? null : snapshot.agents[index];
  dropAgent(id);
  try {
    await agentsApi.deleteAgentDef(id);
    if (before?.overrides_builtin) await loadAgents(true);
  } catch (err) {
    log.warn('agents', 'agent delete failed, rolling back', { id, error: String(err).slice(0, 200) });
    if (before) restoreAgent(before, index);
    throw err;
  }
}

export async function cloneAgentDefinition(id: string, newId: string, newName?: string): Promise<AgentDefinition> {
  const agent = await agentsApi.cloneAgentDef(id, newId, newName);
  mergeAgent(agent);
  return agent;
}

/** Tests only: forget everything the store learned. */
export function __resetAgentsStore(): void {
  snapshot = {
    agents: [], toolNames: [], availableModels: [], skills: [],
    agentsLoaded: false, metaLoaded: false, error: null,
  };
  subscribers.clear();
  listInflight = null;
  wantsRefetch = false;
  metaInflight = null;
}
