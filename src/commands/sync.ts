import chalk from 'chalk';
import { outputJson } from '../utils/json-output.js';
import type { GlobalOptions } from '../core/types.js';
import {
  initSync,
  sync,
  getSyncStatus,
  isGitAvailable,
} from '../integrations/git-sync.js';

async function runGitSync(options: Record<string, unknown>, globals: GlobalOptions): Promise<{ ran: boolean; result?: unknown }> {
  if (!isGitAvailable()) {
    if (!globals.json) {
      console.log(chalk.red('Error: git is not installed or not in PATH.'));
    }
    return { ran: false, result: { error: 'git is not installed or not in PATH' } };
  }

  // --init: initialize git repo
  if (options.init) {
    const remoteUrl = typeof options.init === 'string' ? options.init : undefined;
    try {
      initSync(remoteUrl);
      if (!globals.json) {
        console.log(chalk.green('\u2713') + ' Git repo initialized in ~/.open-walnut');
        if (remoteUrl) {
          console.log(`  Remote: ${remoteUrl}`);
        }
      }
      return { ran: true, result: { initialized: true, remote: remoteUrl ?? null } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!globals.json) {
        console.log(chalk.red('Init failed: ') + msg);
      }
      return { ran: true, result: { error: msg } };
    }
  }

  const status = getSyncStatus();
  if (!status.initialized) {
    if (!globals.json) {
      console.log(chalk.yellow('Git not initialized.') + ' Run: open-walnut sync --init');
    }
    return { ran: false, result: { error: 'Not initialized. Run: open-walnut sync --init' } };
  }

  if (!globals.json) {
    console.log(chalk.cyan('\uD83D\uDD04') + ' Git syncing...');
  }

  try {
    const result = sync();
    if (!globals.json) {
      if (result.pulled) console.log(`  \u2193 Pulled changes`);
      if (result.pushed) console.log(`  \u2191 Pushed changes`);
      if (result.conflicts) console.log(chalk.yellow('  \u26A0 Conflicts were auto-resolved'));
      if (!result.pulled && !result.pushed && !result.conflicts) {
        console.log('  Already up to date');
      }
      console.log(chalk.green('\u2713') + ' Git sync complete');
    }
    return { ran: true, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!globals.json) {
      console.log(chalk.red('\u2717 Git sync failed: ') + msg);
    }
    return { ran: true, result: { error: msg } };
  }
}

async function runTodoSync(globals: GlobalOptions): Promise<{ ran: boolean; result?: unknown }> {
  try {
    const { getMsTodoSyncStatus, syncTasks } = await import('../integrations/microsoft-todo.js');
    const status = await getMsTodoSyncStatus();

    if (!status.configured) {
      if (!globals.json) {
        console.log(chalk.dim('  To-Do: not configured (add ms_todo.client_id to config)'));
      }
      return { ran: false, result: { todo: 'not_configured' } };
    }

    if (!status.authenticated) {
      if (!globals.json) {
        console.log(chalk.yellow('  To-Do: not authenticated.') + ' Run: open-walnut auth');
      }
      return { ran: false, result: { todo: 'not_authenticated' } };
    }

    if (!globals.json) {
      console.log(chalk.cyan('\uD83D\uDD04') + ' To-Do syncing...');
    }

    const { listTasks, updateTaskRaw, addTaskFull } = await import('../core/task-manager.js');
    const localTasks = await listTasks();
    const syncResult = await syncTasks(localTasks, updateTaskRaw, addTaskFull);

    if (!globals.json) {
      if (syncResult.pushed) console.log(`  \u2191 Pushed ${syncResult.pushed} task(s) to To-Do`);
      if (syncResult.pulled) console.log(`  \u2193 Pulled ${syncResult.pulled} task(s) from To-Do`);
      if (syncResult.errors.length) {
        for (const e of syncResult.errors) {
          console.log(chalk.yellow(`  \u26A0 ${e}`));
        }
      }
      if (!syncResult.pushed && !syncResult.pulled && !syncResult.errors.length) {
        console.log('  Already up to date');
      }
      console.log(chalk.green('\u2713') + ' To-Do sync complete');
    }

    return { ran: true, result: { todo: syncResult } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!globals.json) {
      console.log(chalk.red('\u2717 To-Do sync failed: ') + msg);
    }
    return { ran: true, result: { todo: { error: msg } } };
  }
}

export async function runSync(
  options: Record<string, unknown>,
  globals: GlobalOptions,
): Promise<void> {
  const onlyGit = options.git === true && !options.todo;
  const onlyTodo = options.todo === true && !options.git;

  // --status: show combined sync status
  if (options.status) {
    const gitStatus = isGitAvailable() ? getSyncStatus() : null;

    let todoStatus = null;
    try {
      const { getMsTodoSyncStatus } = await import('../integrations/microsoft-todo.js');
      todoStatus = await getMsTodoSyncStatus();
    } catch {
      // Not available
    }

    if (globals.json) {
      outputJson({ git: gitStatus, todo: todoStatus });
    } else {
      console.log(chalk.bold('Sync Status'));
      console.log();
      console.log(chalk.bold('  Git'));
      if (gitStatus) {
        console.log(`    Initialized:  ${gitStatus.initialized ? chalk.green('yes') : chalk.dim('no')}`);
        console.log(`    Remote:       ${gitStatus.remoteConfigured ? chalk.green('yes') : chalk.dim('no')}`);
        console.log(`    Branch:       ${gitStatus.branch}`);
        console.log(`    Pending:      ${gitStatus.pendingChanges} changes`);
        console.log(`    Last sync:    ${gitStatus.lastSyncAt ?? chalk.dim('never')}`);
      } else {
        console.log(`    ${chalk.dim('git not available')}`);
      }
      console.log();
      console.log(chalk.bold('  Microsoft To-Do'));
      if (todoStatus) {
        console.log(`    Configured:   ${todoStatus.configured ? chalk.green('yes') : chalk.dim('no')}`);
        console.log(`    Authenticated:${todoStatus.authenticated ? chalk.green(' yes') : chalk.dim(' no')}`);
        console.log(`    Last sync:    ${todoStatus.lastSync ?? chalk.dim('never')}`);
        console.log(`    Delta links:  ${todoStatus.deltaLinksCount}`);
      } else {
        console.log(`    ${chalk.dim('not configured')}`);
      }
    }
    return;
  }

  // --init: git only
  if (options.init) {
    await runGitSync(options, globals);
    return;
  }

  // Default: run both (or whichever is flagged)
  const results: Record<string, unknown> = {};

  if (!onlyTodo) {
    const gitResult = await runGitSync(options, globals);
    results.git = gitResult.result;
  }

  if (!onlyGit) {
    const todoResult = await runTodoSync(globals);
    results.todo = todoResult.result;
  }

  if (globals.json) {
    outputJson(results);
  }
}
