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
    .option('-l, --list <project>', 'Project (the only grouping layer; omit for Inbox)')
    .option('--project <project>', 'Project (alias for --list)')
    .option('-d, --due <date>', 'Due date (YYYY-MM-DD)')
    .action(async (title: string, options: Record<string, unknown>, cmd: Command) => {
      const { runAdd } = await import('./add.js');
      await runAdd(title, options, cmd.optsWithGlobals());
    });

  program
    .command('tasks')
    .description('List tasks')
    .option('-s, --status <status>', 'Filter by status (todo/in_progress/done)')
    .option('--project <project>', 'Filter by project (pass "" for Inbox)')
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
    .command('wait <id>')
    .description('Block until a task settles (AGENT_COMPLETE/COMPLETE) or a reply request (rq-…) resolves')
    .option('--timeout <secs>', 'Give up after this many seconds (default 1800; exit code 7)')
    .action(async (id: string, options: Record<string, unknown>, cmd: Command) => {
      const { runWait } = await import('./wait.js');
      await runWait(id, options, cmd.optsWithGlobals());
    });

  program
    .command('start <task_id>')
    .description('Start a NEW session for a task (live session → use session_send)')
    .option('--message <message>', 'First instruction for the session')
    .action(async (taskId: string, options: Record<string, unknown>, cmd: Command) => {
      const { runStart } = await import('./start.js');
      await runStart(taskId, options, cmd.optsWithGlobals());
    });

  const backup = program
    .command('backup')
    .description('S3 backup of the data directory');
  const backupCredFlags = (c: Command): Command => c
    .option('--bucket <bucket>', 'S3 bucket (overrides config backup.bucket)')
    .option('--region <region>', 'AWS region')
    .option('--prefix <prefix>', 'Key prefix (default: walnut)')
    .option('--profile <profile>', 'AWS profile (bare-machine restores)');
  backupCredFlags(backup.command('run').description('Run a backup now'))
    .action(async (options: Record<string, unknown>) => {
      const { runBackupRun } = await import('./backup.js');
      await runBackupRun(options);
    });
  backupCredFlags(backup.command('list').description('List restore points'))
    .action(async (options: Record<string, unknown>) => {
      const { runBackupList } = await import('./backup.js');
      await runBackupList(options);
    });
  backupCredFlags(backup.command('restore').description('Restore a backup into a fresh directory'))
    .option('--at <versionId>', 'Manifest version to restore (from `backup list`)')
    .option('--to <dir>', 'Target directory (default: ~/.open-walnut-restored-<ts>)')
    .option('--force', 'Allow restoring into a non-empty directory')
    .action(async (options: Record<string, unknown>) => {
      const { runBackupRestore } = await import('./backup.js');
      await runBackupRestore(options);
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

  // -- Device token commands (cloud-mode authentication) --
  const deviceCmd = program
    .command('device')
    .description('Manage device tokens for cloud-mode authentication');

  deviceCmd
    .command('add <name>')
    .description('Pair a new device — prints its Bearer token ONCE')
    .action(async (name: string, _options: Record<string, unknown>, cmd: Command) => {
      const { runDeviceAdd } = await import('./device.js');
      await runDeviceAdd(name, cmd.optsWithGlobals());
    });

  deviceCmd
    .command('revoke <name>')
    .description('Revoke a paired device')
    .action(async (name: string, _options: Record<string, unknown>, cmd: Command) => {
      const { runDeviceRevoke } = await import('./device.js');
      await runDeviceRevoke(name, cmd.optsWithGlobals());
    });

  deviceCmd
    .command('list')
    .description('List paired devices (no secrets shown)')
    .action(async (_options: Record<string, unknown>, cmd: Command) => {
      const { runDeviceList } = await import('./device.js');
      await runDeviceList(cmd.optsWithGlobals());
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
    .command('mcp')
    .description('Start a stdio MCP server exposing Walnut tools (for AI coding agents)')
    .option('--readonly', 'Expose read-only tools only')
    .option('--api-url <url>', 'Walnut server base URL (default: OPEN_WALNUT_API_URL or http://127.0.0.1:3456)')
    .action(async (options: Record<string, unknown>) => {
      const { runMcp } = await import('./mcp.js');
      await runMcp(options as { readonly?: boolean; apiUrl?: string });
    });

  // The registry catalog: same list/help/call contract as the MCP surface,
  // driven from the shared op registry (src/ops/). `allowUnknownOption` +
  // variadic args: subcommand parsing happens in runTools, not commander.
  program
    .command('tools [args...]')
    .description('List, inspect, and invoke Walnut operations (list | help <op> | call <op> \'{json}\')')
    .allowUnknownOption(true)
    .action(async (args: string[] | undefined, _options: Record<string, unknown>, cmd) => {
      const { runTools } = await import('./tools.js');
      await runTools(args ?? [], cmd.optsWithGlobals());
    });

  // One name everywhere: `walnut guide` / `walnut wait` / `walnut tools` work
  // identically on the hub (this entry) and on remote hosts (the daemon's shim).
  program
    .command('guide')
    .description('Print the full Walnut manual (recipes + safety rules)')
    .action(async (_options: Record<string, unknown>, cmd) => {
      const { runGuide } = await import('./guide.js');
      await runGuide(cmd.optsWithGlobals());
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
