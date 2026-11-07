/**
 * The asks the side panel's drawer and the popup's Continue list show: the same lists Home's Ask
 * slot draws (AskWalnutSlot), from the same task store and agent registry. Main, the main agent, is
 * Walnut's own pinned row; every other ask of the agent on show follows, the most recently used
 * first.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Task } from '@open-walnut/core';
import { pickMain } from '@open-walnut/org-tree';
import { useTasksContext } from '@/contexts/TasksContext';
import { useEvent } from '@/hooks/useWebSocket';
import { getAgentsSnapshot, loadAgents, subscribeAgents } from '@/stores/agents-store';
import { resolveTaskSessionId } from '@/utils/session-status';
import type { DrawerRow } from '@/components/chat/AskWalnutDrawer';
import { GENERAL_AGENT_ID, GENERAL_ASK_AGENT, selectAgentTasks, slotAgents, type AskAgent } from '@/components/chat/ask-walnut-slot-model';
import { needsCount } from './ext-tasks-model';
import { keepWords, keptWords, wordsOfMessages, wordsStamp, wordsToRead } from './ext-ask-words';
import { latestReplies } from './ask-words-read';
import { panelAskTitle } from './ext-panel-model';

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
  /**
   * The rows are what they will be: the board has answered, and the agent they belong to is known
   * (Walnut's own is known without the agent list, which can take seconds longer).
   */
  rowsReady: boolean;
  tasks: readonly Task[];
}

/**
 * `questionsRev` changes when this panel noted an ask's first question (rememberFirstQuestion), so
 * a row still untitled reads it at once rather than at the board's next change.
 */
export function useExtAsks(agentId: string, questionsRev = 0): ExtAsks {
  const { tasks, loading } = useTasksContext();
  const snap = useSyncExternalStore(subscribeAgents, getAgentsSnapshot, getAgentsSnapshot);
  useEffect(() => { void loadAgents(Boolean(getAgentsSnapshot().error)); }, []);
  useEvent('agents:changed', () => { void loadAgents(true); });
  const agents = useMemo(() => slotAgents(snap.agents), [snap.agents]);
  const agent = useMemo(() => agents.find((a) => a.id === agentId) ?? agents[0] ?? GENERAL_ASK_AGENT, [agents, agentId]);
  const isGeneral = agent.id === GENERAL_AGENT_ID;
  const mainTask = useMemo(() => pickMain(tasks) ?? null, [tasks]);
  const [wordsRev, setWordsRev] = useState(0);
  // New row objects when an ask's words were read, so the rows draw their line again (askRowDetail).
  const rows = useMemo<DrawerRow[]>(() => {
    const own = selectAgentTasks(tasks, agent).filter((t) => !(isGeneral && t.org_role === 'main'));
    return own.map((t) => ({ id: t.id, title: panelAskTitle(t, agent).title, task: t }));
  }, [tasks, agent, isGeneral, questionsRev, wordsRev]); // eslint-disable-line react-hooks/exhaustive-deps
  const needs = useMemo(() => (loading ? 0 : needsCount(tasks)), [tasks, loading]);
  const rowsReady = !loading && (snap.agentsLoaded || agentId === GENERAL_AGENT_ID);
  useAskWords(rows, rowsReady, () => setWordsRev((n) => n + 1), WORDS_ROWS);
  return { agents, agent, isGeneral, rows, mainTask, needs, loading: loading || !snap.agentsLoaded, rowsReady, tasks };
}

/** How long after the rows are up the first conversation is read: the view's own first paint goes first. */
const WORDS_AFTER_MS = 400;
/** The rows read: as many as the drawer shows without scrolling, more than any Continue list. */
const WORDS_ROWS = 8;

/**
 * Read the latest words of the first `max` rows' conversations that moved since (ext-ask-words.ts),
 * one at a time, each a small tail of its conversation (ask-words-read.ts); `onRead` once per row
 * read. The drawer's and Continue's rows (useExtAsks) and the Tasks view's rows read through it.
 */
export function useAskWords(rows: ReadonlyArray<{ id: string; task?: Task }>, ready: boolean, onRead: () => void, max: number): void {
  // Which rows, as they stand: a row read meanwhile does not restart the reads under way.
  const sig = ready ? rows.slice(0, max).map((r) => `${r.id}@${r.task ? wordsStamp(r.task) : ''}`).join('|') : '';
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;
  useEffect(() => {
    if (!sig) return;
    const jobs = wordsToRead(rowsRef.current, sessionOfTask, (id) => keptWords(id), max);
    if (!jobs.length) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        for (const job of jobs) {
          if (controller.signal.aborted) return;
          // Read meanwhile by the other frame (the Ask view and the Tasks view keep one store).
          if (keptWords(job.taskId)?.stamp === job.stamp) { onReadRef.current(); continue; }
          try {
            const r = await latestReplies(job.sessionId, { tail: 4, signal: controller.signal });
            // Unknown now (the server out of time): read again next time, never kept as nothing.
            if (!r) continue;
            keepWords(job.taskId, wordsOfMessages(r), job.stamp);
            onReadRef.current();
          } catch { /* aborted, or unreadable now: its status line shows, read again next time */ }
        }
      })();
    }, WORDS_AFTER_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [sig, max]);
}

/** The session an ask's conversation runs in, or null for a task that has none yet. */
export function sessionOfTask(task: Task | null | undefined): string | null {
  return task ? resolveTaskSessionId(task) : null;
}

/**
 * Main's line under its CEO row: what needs the person across their work. It never says "main
 * agent": the agent list calls Walnut "Your main AI", and two "main" things read as one agent with
 * two names (review 2026-11-06).
 */
export function mainLineOf(needs: number): string {
  return `Sees all your work: ${needs === 0 ? 'nothing needs you' : needs === 1 ? '1 thing needs you' : `${needs} things need you`}`;
}
