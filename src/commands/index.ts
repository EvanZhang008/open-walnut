import { Option, type Command } from 'commander';

/**
 * Register all CLI subcommands on the program.
 * Each command uses dynamic import for lazy loading.
 */
export function registerCommands(program: Command): void {
  program
    .command('add <title>')
    .description('Add a new task')
    .option('-p, --priority <level>', 'Priority (immediate/important/backlog/none)', 'none')
    .option('-c, --category <category>', 'Category (top-level group, e.g. Work, Life)')
    .option('-l, --list <project>', 'Project/list within category (e.g. HomeLab, Costco)')
    .option('--project <project>', 'Project/list within category (alias for --list)')
    .option('-d, --due <date>', 'Due date (YYYY-MM-DD)')
    .action(async (title: string, options: Record<string, unknown>, cmd: Command) => {
      const { runAdd } = await import('./add.js');
      await runAdd(title, options, cmd.optsWithGlobals());
    });

  program
    .command('tasks')
    .description('List tasks')
    .option('-s, --status <status>', 'Filter by status (todo/in_progress/done)')
    .option('-c, --category <category>', 'Filter by category')
    .action(async (options: Record<string, unknown>, cmd: Command) => {
      const { runTasks } = await import('./tasks.js');
      await runTasks(options, cmd.optsWithGlobals());
    });

  program
    .command('done <id>')
    .description('Mark a task as done')
    .action(async (id: string, _options: Record<string, unknown>, cmd: Command) => {
      const { runDone } = await import('./done.js');
      await runDone(id, cmd.optsWithGlobals());
    });

  program
    .command('recall <query>')
    .description('Search memory and tasks')
    .action(async (query: string, _options: Record<string, unknown>, cmd: Command) => {
      const { runRecall } = await import('./recall.js');
      await runRecall(query, cmd.optsWithGlobals());
    });

  program
    .command('projects')
    .description('List projects with linked tasks and sessions')
    .action(async (_options: Record<string, unknown>, cmd: Command) => {
      const { runProjects } = await import('./projects.js');
      await runProjects(cmd.optsWithGlobals());
    });

  program
    .command('sessions')
    .description('List tracked sessions')
    .action(async (_options: Record<string, unknown>, cmd: Command) => {
      const { runSessions } = await import('./sessions.js');
      await runSessions(cmd.optsWithGlobals());
    });

  program
    .command('start <task_id>')
    .description('Start a Claude Code session for a task')
    .option('--resume', 'Resume an existing session')
    .option('--prompt <prompt>', 'Initial prompt for the session')
    .action(async (taskId: string, options: Record<string, unknown>, cmd: Command) => {
      const { runStart } = await import('./start.js');
      await runStart(taskId, options, cmd.optsWithGlobals());
    });

  program
    .command('sync')
    .description('Sync ~/.open-walnut via git and/or Microsoft To-Do')
    .option('--init [remote]', 'Initialize git repo (optionally with remote URL)')
    .option('--status', 'Show sync status')
    .option('--git', 'Sync git only')
    .option('--todo', 'Sync Microsoft To-Do only')
    .action(async (options: Record<string, unknown>, cmd: Command) => {
      const { runSync } = await import('./sync.js');
      await runSync(options, cmd.optsWithGlobals());
    });

  program
    .command('chat [question]')
    .description('Chat with Walnut (interactive or one-shot)')
    .option('--debug', 'Show token usage and cache stats')
    .action(async (question: string | undefined, options: Record<string, unknown>, cmd: Command) => {
      const { runChat } = await import('./chat.js');
      await runChat(question, { ...cmd.optsWithGlobals(), debug: !!options.debug });
    });

  program
    .command('auth')
    .description('Authenticate with Microsoft To-Do')
    .action(async (_options: Record<string, unknown>, cmd: Command) => {
      const { runAuth } = await import('./auth.js');
      await runAuth(cmd.optsWithGlobals());
    });

  // -- Subtask commands --
  const subtaskCmd = program
    .command('subtask')
    .description('Manage subtasks on a task');

  subtaskCmd
    .command('add <task_id> <title>')
    .description('Add a subtask to a task')
    .action(async (taskId: string, title: string, _options: Record<string, unknown>, cmd: Command) => {
      const { runSubtaskAdd } = await import('./subtask.js');
      await runSubtaskAdd(taskId, title, cmd.optsWithGlobals());
    });

  subtaskCmd
    .command('done <task_id> <subtask_id>')
    .description('Toggle a subtask done/not-done')
    .action(async (taskId: string, subtaskId: string, _options: Record<string, unknown>, cmd: Command) => {
      const { runSubtaskDone } = await import('./subtask.js');
      await runSubtaskDone(taskId, subtaskId, cmd.optsWithGlobals());
    });

  subtaskCmd
    .command('rm <task_id> <subtask_id>')
    .description('Remove a subtask')
    .action(async (taskId: string, subtaskId: string, _options: Record<string, unknown>, cmd: Command) => {
      const { runSubtaskRemove } = await import('./subtask.js');
      await runSubtaskRemove(taskId, subtaskId, cmd.optsWithGlobals());
    });

  subtaskCmd
    .command('list <task_id>')
    .description('List subtasks of a task')
    .action(async (taskId: string, _options: Record<string, unknown>, cmd: Command) => {
      const { runSubtaskList } = await import('./subtask.js');
      await runSubtaskList(taskId, cmd.optsWithGlobals());
    });

  // -- List management commands --
  const listsCmd = program
    .command('lists')
    .description('Manage Microsoft To-Do lists')
    .action(async (_options: Record<string, unknown>, cmd: Command) => {
      const { runLists } = await import('./lists.js');
      await runLists(cmd.optsWithGlobals());
    });

  listsCmd
    .command('create <name>')
    .description('Create a new To-Do list')
    .action(async (name: string, _options: Record<string, unknown>, cmd: Command) => {
      const { runListsCreate } = await import('./lists.js');
      await runListsCreate(name, cmd.optsWithGlobals());
    });

  listsCmd
    .command('rename <id_or_name> <new_name>')
    .description('Rename a To-Do list')
    .action(async (idOrName: string, newName: string, _options: Record<string, unknown>, cmd: Command) => {
      const { runListsRename } = await import('./lists.js');
      await runListsRename(idOrName, newName, cmd.optsWithGlobals());
    });

  listsCmd
    .command('delete <id_or_name>')
    .description('Delete a To-Do list')
    .action(async (idOrName: string, _options: Record<string, unknown>, cmd: Command) => {
      const { runListsDelete } = await import('./lists.js');
      await runListsDelete(idOrName, cmd.optsWithGlobals());
    });

  program
    .command('web')
    .description('Start the web server')
    .option('--port <port>', 'Server port', '3456')
    .option('--dev', 'Development mode (no static file serving)')
    .option('--ephemeral', 'Start an isolated ephemeral server (temp data copy, random port)')
    .addOption(new Option('--_ephemeral-child').hideHelp())
    .action(async (options: Record<string, unknown>) => {
      const { runWeb } = await import('./web.js');
      await runWeb(options as { port?: string; dev?: boolean; ephemeral?: boolean; _ephemeralChild?: boolean });
    });

  program
    .command('logs')
    .description('View structured logs')
    .option('-f, --follow', 'Follow log output (tail)')
    .option('-j, --json', 'Output raw JSON lines')
    .option('-n, --limit <count>', 'Number of lines to show (default: 100)')
    .option('-s, --subsystem <name>', 'Filter by subsystem (e.g. bus, agent, session)')
    .action(async (options: Record<string, unknown>) => {
      const { runLogs } = await import('./logs.js');
      await runLogs(options as { follow?: boolean; json?: boolean; limit?: string; subsystem?: string });
    });

  program
    .command('session-server')
    .description('Start the session server (WebSocket wrapping Claude Agent SDK)')
    .option('--port <port>', 'Server port', '7890')
    .option('--data-dir <dir>', 'Data directory for state persistence')
    .action(async (options: Record<string, unknown>) => {
      const { runSessionServerCommand } = await import('./session-server.js');
      await runSessionServerCommand(options as { port?: string; dataDir?: string });
    });

}
