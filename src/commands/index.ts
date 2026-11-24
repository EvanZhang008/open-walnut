import { Option, type Command } from 'commander';

/**
 * Register all CLI subcommands on the program.
 * Each command uses dynamic import for lazy loading.
 */
export function registerCommands(program: Command): void {
  program
    .command('add <title>')
    .description('Save a task placeholder without starting work; agents use tools call task_create')
    .option('-p, --priority <level>', 'Priority (immediate/important/backlog/none)', 'none')
    .option('-l, --list <project>', 'Project (omit for Inbox)')
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
    .option('--project <project>', 'Filter by project ("Inbox", or "", for the Inbox)')
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
    .command('trigger-check <template> [params]')
    .description('Run a plugin trigger template once (the check command a template trigger stores; reads the trigger input on stdin)')
    .action(async (template: string, params: string | undefined) => {
      const { runTriggerCheck } = await import('./trigger-check.js');
      await runTriggerCheck(template, params);
    });

  program
    .command('approve [what...]')
    .description('Ask a person to approve before going on: exit 0 on Approve, 1 on Deny, 2 when nobody answers in time, 4 when asked with --request-only')
    // An older script's flags, kept so it still runs: every approval is a tap on any device the person is signed in on.
    .option('--biometric', 'No effect (any device you are signed in on approves with a tap)')
    .option('--face-id', 'No effect, like --biometric')
    .option('--touch-id', 'No effect, like --biometric')
    .option('--timeout <duration>', 'Give up after this long (10s to 24h, like 90s, 10m, 2h; default 10m)')
    .option('--detail <file>', 'A file with the detail to show (- reads stdin)')
    .option('--from <label>', 'A short name for the asking script, shown to the person')
    .option('--why <reason>', 'Why it asks, in a line, shown to the person (default: the session\'s last words)')
    .option('--single-use', 'An approval bound to this run\'s --detail and used once, at most 5 minutes')
    .option('--signing-key <path>', 'No effect (an older script\'s pinned device; any device you are signed in on approves)')
    .option('--request-only', 'Ask and exit at once with 4 (pending), printing the id; rerun with --approval <id>')
    .option('--approval <id>', 'Rerun after an approval asked with --request-only: waits for it, then uses it')
    .allowUnknownOption(false)
    .action(async () => {
      const { runApproveCommand } = await import('./approve.js');
      // The shared parser reads the raw words, the same ones the remote hosts' CLI gets.
      const at = process.argv.indexOf('approve');
      await runApproveCommand(at >= 0 ? process.argv.slice(at + 1) : []);
    });

  program
    .command('pass [args...]')
    .description('Passwords for scripts and agents: list what they may use, get one, or run a command with secrets in its env (masked in its output)')
    .allowUnknownOption(true)
    .helpOption(false)
    .action(async () => {
      const { runPassCommand } = await import('./pass.js');
      // The shared parser reads the raw words, the same ones the remote hosts' CLI gets.
      const at = process.argv.indexOf('pass');
      await runPassCommand(at >= 0 ? process.argv.slice(at + 1) : []);
    });

  program
    .command('browser [args...]')
    .description('Your own browser for scripts and agents (the Walnut extension with agents on): open a page, read it, click, type, screenshot')
    .allowUnknownOption(true)
    .helpOption(false)
    .action(async () => {
      const { runBrowserCommand } = await import('./browser.js');
      const at = process.argv.indexOf('browser');
      await runBrowserCommand(at >= 0 ? process.argv.slice(at + 1) : []);
    });

  const approvals = program
    .command('approvals')
    .description('Approvals waiting for you');
  approvals
    .command('list')
    .description('Pending approvals (--all adds the decided ones)')
    .option('--all', 'Include approvals decided in the last 30 days')
    .action(async (options: Record<string, unknown>, cmd: Command) => {
      const { runApprovalsList } = await import('./approve.js');
      await runApprovalsList(!!options.all, cmd.optsWithGlobals());
    });

  program
    .command('wait <ids...>')
    .description('Block until tasks settle (NEED_ACTION/COMPLETE) or reply requests (rq-…) resolve; several ids wait for all')
    .option('--any', 'With several ids, return when the first one settles')
    .option('--timeout <secs>', 'Give up after this many seconds (default 1800; exit code 7)')
    .action(async (ids: string[], options: Record<string, unknown>, cmd: Command) => {
      const { runWait } = await import('./wait.js');
      await runWait(ids, options, cmd.optsWithGlobals());
    });

  program
    .command('start <task_id>')
    .description('Start work on an existing task (already started: use task_send)')
    .option('--message <message>', 'First instruction for the session')
    .action(async (taskId: string, options: Record<string, unknown>, cmd: Command) => {
      const { runStart } = await import('./start.js');
      await runStart(taskId, options, cmd.optsWithGlobals());
    });

  const backup = program
    .command('backup')
    .description('Backups of the data directory (to S3, Cloudflare R2 or Google Drive, encrypted if chosen; or the older S3 copy)');
  const backupCredFlags = (c: Command): Command => c
    .option('--bucket <bucket>', 'S3 bucket (overrides config backup.bucket)')
    .option('--region <region>', 'AWS region')
    .option('--prefix <prefix>', 'Key prefix (default: walnut)')
    .option('--profile <profile>', 'AWS profile (bare-machine restores)')
    .option('--key <recoveryKey>', 'Recovery key of encrypted backups (default: this machine\'s saved key)')
    .option('--type <r2|s3|gdrive>', 'Backups at this kind of place, from these flags instead of config.yaml')
    .option('--encrypt', 'Encrypt under a recovery key (default: as set in Settings; unset, encrypted only where encrypted backups already are)')
    .option('--no-encrypt', 'Store unencrypted, with no key (the backups already made of the other kind stay)')
    .option('--account-id <id>', 'Cloudflare account id (with --type r2)')
    .option('--endpoint <url>', 'S3-compatible endpoint (with --type r2 or s3)')
    .option('--access-key-id <id>', 'Access key id (with --type r2, or s3 with --endpoint)')
    .option('--secret-access-key <secret>', 'Secret access key (with --access-key-id)');
  backupCredFlags(backup.command('run').description('Run a backup now'))
    .action(async (options: Record<string, unknown>) => {
      const { runBackupRun } = await import('./backup.js');
      await runBackupRun(options);
    });
  backupCredFlags(backup.command('list').description('List restore points'))
    .action(async (options: Record<string, unknown>) => {
      const { runBackupList, plainFailure } = await import('./backup.js');
      await runBackupList(options).catch(plainFailure('List'));
    });
  backupCredFlags(backup.command('restore').description('Restore a backup into a fresh directory'))
    .option('--at <id>', 'Backup to restore, from `backup list` (default: the newest)')
    .option('--to <dir>', 'Target directory (default: ~/open-walnut-restored-<ts>)')
    .option('--force', 'Allow restoring into a non-empty directory')
    .action(async (options: Record<string, unknown>) => {
      const { runBackupRestore, plainFailure } = await import('./backup.js');
      await runBackupRestore(options).catch(plainFailure('Restore'));
    });
  backup.command('drill')
    .description('Restore the newest backup into a temporary folder, check it, then delete it (your data and backups are only read)')
    .option('--snapshot <id>', 'Backup to drill, from `backup list` (default: the newest)')
    .option('--key <recoveryKey>', 'Recovery key of encrypted backups (default: this machine\'s saved key)')
    .option('--json', 'Print the result as JSON')
    .option('--no-record', 'Do not keep the result for Settings (local/restore-drill.json)')
    .option('--no-boot', 'Do not start the restored copy as a trial server (its boot check reads "not run")')
    .action(async (options: Record<string, unknown>) => {
      const { runBackupDrill, plainFailure } = await import('./backup.js');
      await runBackupDrill(options).catch(plainFailure('Drill'));
    });

  const standby = program
    .command('standby')
    .description('A standby copy of the data folder in another local folder: batches of one moment, checked for direct edits');
  standby.command('snapshot').description('Take one batch into a target folder')
    .requiredOption('--to <dir>', 'Target folder (made on first use)')
    .option('--home <dir>', 'Home to copy (default: this Walnut\'s)')
    .action(async (options: Record<string, unknown>) => {
      const { runStandbySnapshot } = await import('./standby.js');
      await runStandbySnapshot(options);
    });
  standby.command('verify <dir>').description('Find, save and repair files changed directly in a standby copy')
    .option('--deep', 'Hash every file, not only those whose stat moved')
    .action(async (dir: string, options: Record<string, unknown>) => {
      const { runStandbyVerify } = await import('./standby.js');
      await runStandbyVerify(dir, options);
    });
  standby.command('status <dir>').description('The current batch of a standby copy: age, files, bytes')
    .action(async (dir: string) => {
      const { runStandbyStatus } = await import('./standby.js');
      await runStandbyStatus(dir);
    });
  standby.command('receive <op> <dir>').description('The receiving side of a standby copy on this machine, run by the leader through this machine\'s daemon (init, apply, verify, reported, job)')
    .option('--export <file>', 'init: write the asked lists into this file of the target\'s .incoming/')
    .option('--chunks', 'init: export the chunk ids the target holds')
    .option('--files', 'init: export the current batch\'s files')
    .option('--have-manifest <json>', 'init: skip the files when the current manifest is still this one')
    .option('--upload <file>', 'apply: the batch upload in the target\'s .incoming/')
    .option('--verify', 'apply: run a verify pass after the batch')
    .option('--status <file>', 'apply: keep the run\'s state in this file of the target\'s .incoming/ (a background run); job: the run to ask about')
    .option('--deep', 'verify: hash every file')
    .option('--at <time>', 'reported: the drift report handed to Walnut Health')
    .action(async (op: string, dir: string, options: Record<string, unknown>) => {
      const { runStandbyReceive } = await import('./standby.js');
      await runStandbyReceive(op, dir, options);
    });

  const leader = program
    .command('leader')
    .description('A switchable leader (experiment switchable_leader): hand the lead to another machine, back, or see where it stands');
  leader.command('switch').description('Stop this leader, hand its data and write permission to another machine, start it there')
    .option('--to <machine>', 'The machine id (leader_switch.machines) that leads next')
    .option('--back', 'Switch back to the machine this Walnut was switched from')
    .option('--resume', 'Finish, or roll back, a switch that was cut off')
    .option('--cancel', 'Cancel a switch that has not committed')
    .option('--status', 'This machine\'s switch jobs, the witnesses\' record, and each machine\'s newest note')
    .option('--home <dir>', 'The leader\'s home (default: this Walnut\'s)')
    .option('--job <side>', 'Run one machine\'s job of a switch: source or target (the command starts it)')
    .option('--switch <id>', 'The switch of a job')
    .option('--forwarded-by <machine>', 'A source job of a switch begun on that machine (its leader started the job)')
    .option('--standby-dir <dir>', 'The standby folder of a target job, or of this machine when the switch is run here, on the machine that will lead')
    .option('--check', 'A target job\'s candidate check only: read, report, change nothing')
    .action(async (options: Record<string, unknown>) => {
      const { runLeaderSwitchCommand } = await import('./leader.js');
      await runLeaderSwitchCommand(options);
    });
  leader.command('status').description('The switch under way, the handed-over marker, and what the witnesses hold')
    .option('--home <dir>', 'The home to read (default: this Walnut\'s)')
    .action(async (options: Record<string, unknown>) => {
      const { runLeaderStatus } = await import('./leader.js');
      await runLeaderStatus(options);
    });
  leader.command('witnesses').description('The witnesses of the write permission').command('init')
    .description('Set up the witness directories leader_switch.witnesses names (each once)')
    .option('--home <dir>', 'The home whose config names them (default: this Walnut\'s)')
    .action(async (options: Record<string, unknown>) => {
      const { runLeaderWitnessesInit } = await import('./leader.js');
      await runLeaderWitnessesInit(options);
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
    .option('--owner', 'On a cloud companion: it is the Mac this companion belongs to')
    .option('--production', 'From a Walnut session: the user asked to pair this device with their real Walnut')
    .action(async (name: string, options: { owner?: boolean; production?: boolean }, cmd: Command) => {
      const { runDeviceAdd } = await import('./device.js');
      await runDeviceAdd(name, cmd.optsWithGlobals(), { owner: options.owner === true, production: options.production === true });
    });

  deviceCmd
    .command('owner <name>')
    .description('On a cloud companion: name the paired Mac it belongs to')
    .action(async (name: string, _options: Record<string, unknown>, cmd: Command) => {
      const { runDeviceOwner } = await import('./device.js');
      await runDeviceOwner(name, cmd.optsWithGlobals());
    });

  deviceCmd
    .command('kind <name> <kind>')
    .description('Say what a paired device is: phone or computer (corrects a pairing recorded as the wrong one)')
    .action(async (name: string, kind: string, _options: Record<string, unknown>, cmd: Command) => {
      const { runDeviceKind } = await import('./device.js');
      await runDeviceKind(name, kind, cmd.optsWithGlobals());
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
    .alias('serve')
    .description('Start the web server (`walnut serve` is the same command)')
    .option('--port <port>', 'Server port', '3456')
    .option('--dev', 'Development mode (no static file serving)')
    .option('--ephemeral', 'Start an isolated ephemeral server (temp data copy, random port)')
    .addOption(new Option('--_ephemeral-child').hideHelp())
    .addOption(new Option('--_trial-start').hideHelp())
    .option('--replica', 'Run as a replica on this host that follows your Mac (started by this host\'s Walnut daemon)')
    .action(async (options: Record<string, unknown>) => {
      const { runWeb } = await import('./web.js');
      await runWeb(options as { port?: string; dev?: boolean; ephemeral?: boolean; _ephemeralChild?: boolean; _trialStart?: boolean; replica?: boolean });
    });

  program
    .command('demo [action]')
    .description('Open an isolated Demo, or reset it to a new-user first run')
    .addOption(new Option('--_child').hideHelp())
    .addOption(new Option('--_headless').hideHelp())
    .addOption(new Option('--_root <path>').hideHelp())
    .addOption(new Option('--_ephemeral-child').hideHelp())
    .action(async (action: string | undefined, options: { _child?: boolean; _headless?: boolean; _root?: string }, cmd: Command) => {
      try {
        await (await import('./demo.js')).runDemo(action, options);
      } catch (error) {
        // The Demo's own child keeps its full diagnostics; a person gets one line and exit 1.
        if (options._child) throw error;
        cmd.error(error instanceof Error ? error.message : String(error));
      }
    });

  program
    .command('host-server')
    .description('Run as a server on this host that follows your Mac (started by this host\'s Walnut daemon)')
    .action(async () => {
      const { runHostServer } = await import('../host-server/main.js');
      await runHostServer();
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

  // Bare `mcp`: Walnut's own stdio MCP server (session configs launch exactly `open-walnut mcp`).
  // `mcp list` / `mcp <server> tools …`: the MCP servers Walnut runs for its plugins, as a CLI.
  program
    .command('mcp [args...]')
    .description('Start a stdio MCP server exposing Walnut tools; or `mcp list` / `mcp <server> tools list|help|call` for the MCP servers Walnut runs')
    .option('--readonly', 'Expose read-only tools only')
    .option('--core', 'List only the most used tools, plus tool_help and tool_call that reach every other one')
    .option('--api-url <url>', 'Walnut server base URL (default: OPEN_WALNUT_API_URL or http://127.0.0.1:3456)')
    .allowUnknownOption(true)
    .action(async (args: string[] | undefined, options: Record<string, unknown>) => {
      if (args && args.length > 0) {
        const { runMcpClient } = await import('./mcp-client.js');
        await runMcpClient(args, { apiUrl: options.apiUrl as string | undefined });
        return;
      }
      const { runMcp } = await import('./mcp.js');
      await runMcp(options as { readonly?: boolean; apiUrl?: string; core?: boolean });
    });

  // The Plugin Store from a terminal (src/commands/plugins.ts).
  const pluginCmd = program
    .command('plugin')
    .description('Add and list plugin sources (the Apps page)');
  pluginCmd
    .command('add <source>')
    .description('Install a plugin source: a git URL, an npm package, a share snippet, or an open-walnut://install-plugin link')
    .option('--ref <ref>', 'Git branch or tag')
    .action(async (source: string, options: { ref?: string }, cmd: Command) => {
      const { runPluginAdd } = await import('./plugins.js');
      await runPluginAdd(source, options, cmd.optsWithGlobals());
    });
  pluginCmd
    .command('list')
    .description('List plugin sources and the state of each plugin')
    .action(async (_options: Record<string, unknown>, cmd: Command) => {
      const { runPluginList } = await import('./plugins.js');
      await runPluginList(cmd.optsWithGlobals());
    });

  // The registry catalog: same list/help/call contract as the MCP surface,
  // driven from the shared op registry (src/ops/). `allowUnknownOption` +
  // variadic args: subcommand parsing happens in runTools, not commander.
  program
    .command('tools [args...]')
    .description('List, inspect, and invoke Walnut operations (list | help <op> | call <op> \'{json}\')')
    .allowUnknownOption(true)
    // Commander's built-in help option would swallow `--help` ANYWHERE in the
    // args, so `tools call <op> --help` printed commander's usage instead of the
    // op's schema. runTools answers both forms itself.
    .helpOption(false)
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
    .command('doctor')
    .description('Print a paste-ready report: build, claude, node, PATH, and what each host can run')
    .option('--no-redact', 'Keep usernames and hostnames (masked by default, safe for a public issue)')
    .option('--hosts', 'Only the remote hosts block')
    .action(async (options: Record<string, unknown>, cmd) => {
      const { runDoctor } = await import('./doctor.js');
      await runDoctor(options as { redact?: boolean; hosts?: boolean }, cmd.optsWithGlobals());
    });

  program
    .command('update')
    .description('Check npm for a newer Open Walnut and install it (a source checkout is told the git steps instead)')
    .option('--check', 'Only report whether a newer version is published')
    .option('--channel <channel>', 'Follow stable (tagged releases) or nightly (main, published daily) instead of the installed build\'s channel')
    .option('--auto', 'Update only as an automatic update would: not when updates.auto is false, and not to a version held back')
    .action(async (options: Record<string, unknown>, cmd) => {
      const { runUpdate } = await import('./update.js');
      await runUpdate(options as { check?: boolean; channel?: string; auto?: boolean }, cmd.optsWithGlobals());
    });

  program
    .command('daemon [args...]')
    .description('Manage this host daemon service (status | install | update | uninstall | restart)')
    .allowUnknownOption(true)
    .action(async (args: string[] | undefined) => {
      const { runDaemonServiceArgs } = await import('../providers/daemon-service-cli.js');
      process.exitCode = await runDaemonServiceArgs(args ?? []);
    });

  // The host network on this machine (src/commands/net.ts).
  const netCmd = program
    .command('net')
    .description('This machine on your Walnut host network (join | status | hub-forward)')
  netCmd
    .command('join <companion-or-ticket> [code]')
    .description('Join this machine to your Walnut machines with an invite (the invite link runs this): a companion and its code, or the ticket of a Mac with no companion')
    .option('--steps', 'Continue the numbered steps of the invite script')
    .action(async (target: string, code: string | undefined, options: { steps?: boolean }) => {
      const { runNetJoin } = await import('./net.js');
      process.exitCode = await runNetJoin(target, code, { steps: !!options.steps });
    });
  netCmd
    .command('status')
    .description("This machine's host network, as its daemon says")
    .action(async () => {
      const { runNetStatus } = await import('./net.js');
      process.exitCode = await runNetStatus();
    });
  netCmd
    .command('hub-forward [action] [ports...]')
    .description("This machine's hub forwards: a 127.0.0.1 port here that reaches one port on the primary's own loopback (list | add <local_port> [port] | remove <local_port>)")
    .action(async (action: string | undefined, ports: string[] | undefined) => {
      const { runNetHubForward } = await import('./net-hub.js');
      process.exitCode = await runNetHubForward(action, ports ?? []);
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
