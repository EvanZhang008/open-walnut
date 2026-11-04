/**
 * The side panel's Tasks view (PopoutExtTasks): which of the person's tasks it lists and what
 * each row says, kept apart from React so it is tested on its own. The lists are Home's: what
 * needs them (To read drawn with it, as everywhere), then their Focus tasks; each task once.
 */
import type { Task } from '@open-walnut/core';
import { needsLineText, shownState, stateWord } from '@open-walnut/user-status';
import { taskUserState } from '@/utils/session-status';

export const EXT_TASKS_MAX = 30;

export interface ExtTaskRow { task: Task; state: ReturnType<typeof shownState>; label: string; line: string }

function rowOf(task: Task): ExtTaskRow {
  const state = shownState(taskUserState(task));
  const s = task.user_status;
  const line = s ? (state === 'needs' ? needsLineText(s) : (s.waitingOn ?? s.ask ?? '')) : '';
  return { task, state, label: stateWord(state, !!s?.snoozed), line: line.replace(/\s+/g, ' ').trim() };
}

const newest = (a: Task, b: Task) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? ''));

export function extTaskLists(tasks: readonly Task[]): { needs: ExtTaskRow[]; focus: ExtTaskRow[] } {
  const open = tasks.filter((t) => taskUserState(t) !== 'done' && !t.plugin_only);
  const needs = open.filter((t) => shownState(taskUserState(t)) === 'needs').sort(newest);
  const seen = new Set(needs.map((t) => t.id));
  const focus = open.filter((t) => !seen.has(t.id) && t.pinned && t.focus_tier === 'focus').sort(newest);
  return { needs: needs.slice(0, EXT_TASKS_MAX).map(rowOf), focus: focus.slice(0, EXT_TASKS_MAX).map(rowOf) };
}

/** A task for later, made from the page the person is on: its title, and the address to come back to. */
export function pageTaskInput(page: { url: string; title?: string }): { title: string; description: string } {
  let host = page.url;
  try { host = new URL(page.url).host; } catch { /* the address as it is */ }
  const title = (page.title?.trim() || host).slice(0, 200);
  return { title, description: `From the browser: ${page.url}` };
}
