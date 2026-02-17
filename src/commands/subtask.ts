import type { GlobalOptions } from '../core/types.js';

/**
 * Legacy subtask commands — subtasks are now child tasks in the plugin system.
 * These stubs remain to prevent CLI crashes if the commands are still registered.
 */

export async function runSubtaskAdd(
  _taskId: string,
  _title: string,
  _globalOptions: GlobalOptions,
): Promise<void> {
  console.log('Subtask commands have been removed. Use child tasks instead (walnut add --parent <id>).');
}

export async function runSubtaskDone(
  _taskId: string,
  _subtaskId: string,
  _globalOptions: GlobalOptions,
): Promise<void> {
  console.log('Subtask commands have been removed. Use child tasks instead.');
}

export async function runSubtaskRemove(
  _taskId: string,
  _subtaskId: string,
  _globalOptions: GlobalOptions,
): Promise<void> {
  console.log('Subtask commands have been removed. Use child tasks instead.');
}

export async function runSubtaskList(
  _taskId: string,
  _globalOptions: GlobalOptions,
): Promise<void> {
  console.log('Subtask commands have been removed. Use child tasks instead.');
}
