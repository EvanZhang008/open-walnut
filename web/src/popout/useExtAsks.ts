/**
 * The asks the side panel's drawer and the popup's Continue list show: the same lists Home's Ask
 * slot draws (AskWalnutSlot), from the same task store and agent registry. Main, the main agent, is
 * Walnut's own pinned row; every other ask of the agent on show follows, the most recently used
 * first.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { Task } from '@open-walnut/core';
import { askTitle } from '@open-walnut/ask-list';
import { pickMain } from '@open-walnut/org-tree';
import { useTasksContext } from '@/contexts/TasksContext';
import { useEvent } from '@/hooks/useWebSocket';
import { getAgentsSnapshot, loadAgents, subscribeAgents } from '@/stores/agents-store';
import { resolveTaskSessionId } from '@/utils/session-status';
import type { DrawerRow } from '@/components/chat/AskWalnutDrawer';
import { GENERAL_AGENT_ID, GENERAL_ASK_AGENT, selectAgentTasks, slotAgents, type AskAgent } from '@/components/chat/ask-walnut-slot-model';
import { needsCount } from './ext-tasks-model';

export interface ExtAsks {
  agents: AskAgent[];
  agent: AskAgent;
  isGeneral: boolean;
  rows: DrawerRow[];
  mainTask: Task | null;
  /** What needs the person, as the Tasks view counts it. */
  needs: number;
  /** The board or the agent list has not answered yet. */
  loading: boolean;
  tasks: readonly Task[];
}

export function useExtAsks(agentId: string): ExtAsks {
  const { tasks, loading } = useTasksContext();
  const snap = useSyncExternalStore(subscribeAgents, getAgentsSnapshot, getAgentsSnapshot);
  useEffect(() => { void loadAgents(Boolean(getAgentsSnapshot().error)); }, []);
  useEvent('agents:changed', () => { void loadAgents(true); });
  const agents = useMemo(() => slotAgents(snap.agents), [snap.agents]);
  const agent = useMemo(() => agents.find((a) => a.id === agentId) ?? agents[0] ?? GENERAL_ASK_AGENT, [agents, agentId]);
  const isGeneral = agent.id === GENERAL_AGENT_ID;
  const mainTask = useMemo(() => pickMain(tasks) ?? null, [tasks]);
  const rows = useMemo<DrawerRow[]>(() => {
    const own = selectAgentTasks(tasks, agent).filter((t) => !(isGeneral && t.org_role === 'main'));
    return own.map((t) => ({ id: t.id, title: askTitle(t, agent), task: t }));
  }, [tasks, agent, isGeneral]);
  const needs = useMemo(() => (loading ? 0 : needsCount(tasks)), [tasks, loading]);
  return { agents, agent, isGeneral, rows, mainTask, needs, loading: loading || !snap.agentsLoaded, tasks };
}

/** The session an ask's conversation runs in, or null for a task that has none yet. */
export function sessionOfTask(task: Task | null | undefined): string | null {
  return task ? resolveTaskSessionId(task) : null;
}

/** Main's line under its row: what needs the person across their work. */
export function mainLineOf(needs: number): string {
  return `Your main agent: ${needs === 0 ? 'nothing needs you' : needs === 1 ? '1 thing needs you' : `${needs} things need you`}`;
}
