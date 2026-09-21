/**
 * Claude Code's own settings, as data: every row of the CLI's `/config` screen
 * (2.1.258) that lives in a file Walnut can edit, mapped to the file and JSON
 * key the CLI reads it from.
 *
 * Storage facts this file encodes (verified against the 2.1.258 binary):
 *   - Most rows are written to the USER settings file `~/.claude/settings.json`,
 *     including sixteen keys that older versions kept in `~/.claude.json`; the
 *     CLI still READS those from the old file as a fallback, so each one
 *     declares it under `legacy` (read there, never written there).
 *   - A handful of terminal-only preferences are still written to
 *     `~/.claude.json` ("global config"), declared with `file: 'global'`.
 *   - Four rows (tips, reduce motion, output style, default view) are written
 *     by the CLI's screen to the PROJECT's `.claude/settings.local.json`; they
 *     declare that with `cliWritesTo`, so Walnut's default scope follows the
 *     CLI whenever a session's working directory is known. Every settings
 *     source shares one schema, so the user file is a valid home for them too;
 *     with no working directory (the Settings page) they go there as the
 *     user-wide default.
 *   - Project files: `.claude/settings.json` (shared, committed with the repo)
 *     and `.claude/settings.local.json` (per-checkout) override the user file
 *     for the same key, local over shared. Walnut reads both for attribution
 *     and writes only the local one; a running CLI watches the project's
 *     `.claude/` directory (even before it exists) and applies changes on its
 *     next turn.
 *   - `--permission-mode` (which Walnut passes on every launch) and
 *     `--dangerously-skip-permissions` beat `permissions.defaultMode`, so that
 *     row governs the user's terminal sessions, not Walnut's. Its help says so.
 *
 * Deliberately NOT listed: org-memory rows (per-project store, storage not
 * verified), the external-includes approval (per-project, dialog-only) and the
 * custom-API-key approval lists (credential material, never a settings row).
 */

import type { EngineSettingsSchema, EngineSettingItem, EngineSettingOption } from '../engine-settings-schema.js'

const USER = 'user'
const GLOBAL = 'global'
const PROJECT = 'project'
const PROJECT_LOCAL = 'project-local'

const legacyGlobal = (path: string) => ({ file: GLOBAL, path })

const opt = (value: string, label = value, help?: string): EngineSettingOption => (help ? { value, label, help } : { value, label })

const PERMISSION_MODES: readonly EngineSettingOption[] = [
  opt('default', 'Default', 'Ask before anything sensitive'),
  opt('acceptEdits', 'Accept edits', 'Auto-accept file edits, still ask for the rest'),
  opt('plan', 'Plan', 'Explore and plan only, no edits or commands'),
  opt('auto', 'Auto', 'Classify each call and auto-allow the safe ones'),
  opt('dontAsk', "Don't ask", 'Never prompt; deny whatever is not pre-approved'),
  opt('bypassPermissions', 'Bypass permissions', 'Full trust: never ask, allow everything'),
]

const SESSION_ITEMS: readonly EngineSettingItem[] = [
  {
    key: 'alwaysThinkingEnabled', label: 'Thinking mode', type: 'boolean', default: true,
    file: USER, path: 'alwaysThinkingEnabled', scope: 'sessions',
    env: ['MAX_THINKING_TOKENS', 'CLAUDE_CODE_DISABLE_THINKING', 'DISABLE_INTERLEAVED_THINKING'],
    help: 'Let the model think before it answers. Walnut sessions honor this; MAX_THINKING_TOKENS=0 in the environment turns it off regardless.',
  },
  {
    key: 'autoCompactEnabled', label: 'Auto-compact', type: 'boolean', default: true,
    file: USER, path: 'autoCompactEnabled', legacy: legacyGlobal('autoCompactEnabled'), scope: 'sessions',
    env: ['DISABLE_AUTO_COMPACT'],
    help: 'Summarize the conversation automatically when the context window fills. Off means a long session eventually stops at the context limit.',
  },
  {
    key: 'verbose', label: 'Verbose output', type: 'boolean', default: false,
    file: USER, path: 'verbose', legacy: legacyGlobal('verbose'), scope: 'sessions',
    help: 'Include full tool inputs and outputs in the transcript instead of the short summaries.',
  },
  {
    key: 'permissions.defaultMode', label: 'Default permission mode', type: 'select', default: 'default',
    options: PERMISSION_MODES, file: USER, path: 'permissions.defaultMode', scope: 'sessions', launchOverride: '--permission-mode',
    help: 'Mode a session starts in when nothing else picks one. Walnut passes --permission-mode on every launch, so this changes terminal sessions only; use the mode pill in a Walnut session instead.',
  },
  {
    key: 'outputStyle', label: 'Output style', type: 'select', default: 'default', allowCustom: true, cliWritesTo: PROJECT_LOCAL,
    options: [
      opt('default', 'Default', 'Plain, task-focused replies'),
      opt('Explanatory', 'Explanatory', 'Adds short educational insights about the code'),
      opt('Learning', 'Learning', 'Teaches by asking you to write small pieces'),
    ],
    file: USER, path: 'outputStyle', scope: 'sessions',
    help: 'How replies are written: a built-in style or the name of a custom one from ~/.claude/output-styles. Claude Code keeps this per project, so with a working directory known the save lands in that project\'s .claude/settings.local.json; without one it becomes your user-wide default.',
  },
  {
    key: 'language', label: 'Language', type: 'text', default: '', placeholder: 'English',
    suggestions: ['English', 'Chinese', 'Japanese', 'Korean', 'Spanish', 'French', 'German', 'Portuguese', 'Italian', 'Russian'],
    file: USER, path: 'language', scope: 'sessions',
    help: 'Language the model replies in, as a name or ISO code (ja, zh-TW). Empty means English.',
  },
  {
    key: 'model', label: 'Default model', type: 'text', default: '', placeholder: 'engine default',
    suggestions: ['opus', 'sonnet', 'haiku'],
    file: USER, path: 'model', scope: 'sessions', env: ['ANTHROPIC_MODEL'],
    help: 'Model for sessions that do not pick one in Walnut\'s model picker: an alias (opus, sonnet, haiku) or a full provider model id. Empty lets the CLI choose.',
  },
  {
    key: 'fastMode', label: 'Fast mode', type: 'boolean', default: false,
    file: USER, path: 'fastMode', scope: 'sessions',
    help: 'Use the fast output tier when the current model offers one.',
  },
  {
    key: 'fileCheckpointingEnabled', label: 'Rewind code (checkpoints)', type: 'boolean', default: true,
    file: USER, path: 'fileCheckpointingEnabled', legacy: legacyGlobal('fileCheckpointingEnabled'), scope: 'sessions',
    launchOverride: 'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
    help: 'Snapshot files each turn so a session can be rewound. Walnut turns this on for its own sessions with CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING; the switch here covers terminal sessions.',
  },
  {
    key: 'switchModelsOnFlag', label: 'Switch models when a message is flagged', type: 'boolean', default: true,
    file: USER, path: 'switchModelsOnFlag', scope: 'sessions',
    help: 'When a reply is refused by the model\'s safety filter, retry that turn once on a fallback model.',
  },
  {
    key: 'enableWorkflows', label: 'Dynamic workflows', type: 'boolean', default: null, defaultLabel: 'decided by your plan',
    file: USER, path: 'enableWorkflows', scope: 'sessions',
    env: ['CLAUDE_CODE_DISABLE_WORKFLOWS', 'CLAUDE_CODE_WORKFLOWS'],
    help: 'Let the model run multi-agent workflows (the Workflow tool).',
  },
  {
    key: 'workflowKeywordTriggerEnabled', label: 'Ultracode keyword trigger', type: 'boolean', default: true,
    file: USER, path: 'workflowKeywordTriggerEnabled', scope: 'sessions',
    help: 'Typing "ultracode" in a prompt opts that turn into a multi-agent workflow.',
  },
  {
    key: 'workflowSizeGuideline', label: 'Dynamic workflow size', type: 'select', default: 'medium',
    options: [opt('small'), opt('medium'), opt('large'), opt('unrestricted')],
    file: GLOBAL, path: 'workflowSizeGuideline', scope: 'sessions',
    help: 'How many agents a workflow may spawn. Stored in ~/.claude.json.',
  },
  {
    key: 'enableArtifact', label: 'Artifacts', type: 'boolean', default: null, defaultLabel: 'on when your plan includes it',
    file: USER, path: 'enableArtifact', scope: 'sessions',
    help: 'Let the model produce artifacts (documents the client renders on their own).',
  },
  {
    key: 'precomputeCompactionEnabled', label: 'Precompute compaction', type: 'boolean', default: null, defaultLabel: 'decided by the CLI',
    file: USER, path: 'precomputeCompactionEnabled', scope: 'sessions',
    help: 'Prepare the compaction summary in the background before the context window fills.',
  },
  {
    key: 'useAutoModeDuringPlan', label: 'Use auto mode during plan', type: 'boolean', default: true,
    file: USER, path: 'useAutoModeDuringPlan', scope: 'sessions',
    help: 'In plan mode, let the auto classifier approve read-only actions instead of asking for each.',
  },
  {
    key: 'worktree.baseRef', label: 'Worktree base ref', type: 'select', default: 'fresh',
    options: [opt('fresh', 'Fresh', 'Branch from the default branch\'s latest commit'), opt('head', 'HEAD', 'Branch from the current checkout')],
    file: USER, path: 'worktree.baseRef', scope: 'sessions',
    help: 'What a --worktree session branches from.',
  },
  {
    key: 'teammateMode', label: 'Teammate mode', type: 'select', default: 'auto',
    options: [opt('auto'), opt('in-process'), opt('tmux'), opt('iterm2')],
    file: USER, path: 'teammateMode', legacy: legacyGlobal('teammateMode'), scope: 'sessions',
    help: 'Where sub-agent teammates run. Walnut sessions have no terminal panes, so auto or in-process is what applies to them.',
  },
  {
    key: 'dialogExpiry', label: 'Dialog expiry', type: 'select', default: '5m',
    options: [opt('60s', '1 minute'), opt('5m', '5 minutes'), opt('10m', '10 minutes'), opt('never', 'Never')],
    file: USER, path: 'dialogExpiry', scope: 'sessions', env: ['CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS'],
    help: 'How long a question or permission dialog waits before it expires.',
  },
  {
    key: 'crossSessionInbound', label: 'Messages from your other sessions', type: 'select', default: null, defaultLabel: 'follows the permission mode',
    options: [opt('accept', 'Accept'), opt('hold', 'Hold for review'), opt('refuse', 'Refuse')],
    file: USER, path: 'crossSessionInbound', scope: 'sessions',
    help: 'Whether another Claude Code session on this machine may send this one a message.',
  },
  {
    key: 'modelProposedGoals', label: 'Claude-proposed goals', type: 'select', default: 'auto',
    options: [opt('auto', 'Auto'), opt('alwaysAsk', 'Always ask'), opt('disabled', 'Disabled')],
    file: USER, path: 'modelProposedGoals', scope: 'sessions',
    help: 'Whether the model may propose follow-up goals on its own.',
  },
]

const UPDATE_ITEMS: readonly EngineSettingItem[] = [
  {
    key: 'autoUpdates', label: 'Auto-update', type: 'boolean', default: true,
    file: GLOBAL, path: 'autoUpdates', scope: 'updates', env: ['DISABLE_AUTOUPDATER', 'DISABLE_UPDATES'],
    help: 'Let the CLI update itself in the background. Stored in ~/.claude.json.',
  },
  {
    key: 'autoUpdatesChannel', label: 'Auto-update channel', type: 'select', default: 'latest',
    options: [opt('latest', 'Latest', 'Every release as it ships'), opt('stable', 'Stable', 'Releases that have soaked')],
    file: USER, path: 'autoUpdatesChannel', scope: 'updates', env: ['DISABLE_AUTOUPDATER', 'DISABLE_UPDATES'],
    help: 'Which release channel the updater follows.',
  },
]

const TERMINAL_ITEMS: readonly EngineSettingItem[] = [
  {
    key: 'spinnerTipsEnabled', label: 'Show tips', type: 'boolean', default: true, cliWritesTo: PROJECT_LOCAL,
    file: USER, path: 'spinnerTipsEnabled', scope: 'terminal',
    help: 'Show usage tips next to the spinner while the model works.',
  },
  {
    key: 'prefersReducedMotion', label: 'Reduce motion', type: 'boolean', default: false, cliWritesTo: PROJECT_LOCAL,
    file: USER, path: 'prefersReducedMotion', scope: 'terminal',
    help: 'Tone down spinner and transition animations.',
  },
  {
    key: 'awaySummaryEnabled', label: 'Session recap', type: 'boolean', default: true,
    file: USER, path: 'awaySummaryEnabled', scope: 'terminal', env: ['CLAUDE_CODE_ENABLE_AWAY_SUMMARY'],
    help: 'Show a recap of what happened while you were away when you come back to a session.',
  },
  {
    key: 'promptSuggestionEnabled', label: 'Prompt suggestions', type: 'boolean', default: true,
    file: USER, path: 'promptSuggestionEnabled', scope: 'terminal',
    help: 'Suggest a next prompt after each reply.',
  },
  {
    key: 'autoContinueAtUsageLimit', label: 'Continue automatically at usage limit', type: 'boolean', default: true,
    file: USER, path: 'autoContinueAtUsageLimit', scope: 'terminal',
    help: 'When the usage limit resets, continue the interrupted turn without asking.',
  },
  {
    key: 'terminalProgressBarEnabled', label: 'Terminal progress bar', type: 'boolean', default: true,
    file: USER, path: 'terminalProgressBarEnabled', legacy: legacyGlobal('terminalProgressBarEnabled'), scope: 'terminal',
    help: 'Report progress through the terminal\'s own progress indicator where supported.',
  },
  {
    key: 'showStatusInTerminalTab', label: 'Show status in terminal tab', type: 'boolean', default: false,
    file: GLOBAL, path: 'showStatusInTerminalTab', scope: 'terminal', env: ['CLAUDE_CODE_DISABLE_TERMINAL_TITLE'],
    help: 'Put the session status in the terminal tab title. Stored in ~/.claude.json.',
  },
  {
    key: 'showTurnDuration', label: 'Show turn duration', type: 'boolean', default: true,
    file: USER, path: 'showTurnDuration', legacy: legacyGlobal('showTurnDuration'), scope: 'terminal',
    help: 'Print how long each turn took.',
  },
  {
    key: 'showMessageTimestamps', label: 'Show message timestamps', type: 'boolean', default: false,
    file: USER, path: 'showMessageTimestamps', legacy: legacyGlobal('showMessageTimestamps'), scope: 'terminal',
    help: 'Show a timestamp on each message.',
  },
  {
    key: 'timeFormat', label: 'Time format', type: 'select', default: 'auto', allowCustom: true,
    options: [opt('auto', 'Auto'), opt('12-hour', '12-hour'), opt('24-hour', '24-hour'), opt('24-hour-utc', '24-hour UTC')],
    file: USER, path: 'timeFormat', scope: 'terminal',
    help: 'How times are displayed. A custom value is a strftime pattern containing %.',
  },
  {
    key: 'theme', label: 'Theme', type: 'select', default: 'dark', allowCustom: true,
    options: [
      opt('auto', 'Auto'), opt('dark', 'Dark'), opt('light', 'Light'),
      opt('dark-daltonized', 'Dark (colorblind-friendly)'), opt('light-daltonized', 'Light (colorblind-friendly)'),
      opt('dark-ansi', 'Dark ANSI'), opt('light-ansi', 'Light ANSI'),
    ],
    file: USER, path: 'theme', legacy: legacyGlobal('theme'), scope: 'terminal',
    help: 'Terminal color theme. A custom value is custom:<name>.',
  },
  {
    key: 'preferredNotifChannel', label: 'Local notifications', type: 'select', default: 'auto',
    options: [
      opt('auto', 'Auto'), opt('iterm2', 'iTerm2'), opt('iterm2_with_bell', 'iTerm2 with bell'), opt('terminal_bell', 'Terminal bell'),
      opt('kitty', 'Kitty'), opt('ghostty', 'Ghostty'), opt('notifications_disabled', 'Disabled'),
    ],
    file: USER, path: 'preferredNotifChannel', legacy: legacyGlobal('preferredNotifChannel'), scope: 'terminal',
    help: 'How the terminal is told a session needs you.',
  },
  {
    key: 'inputNeededNotifEnabled', label: 'Push when actions required', type: 'boolean', default: false,
    file: USER, path: 'inputNeededNotifEnabled', legacy: legacyGlobal('inputNeededNotifEnabled'), scope: 'terminal',
    help: 'Send a push notification when a session waits for you.',
  },
  {
    key: 'agentPushNotifEnabled', label: 'Push when Claude decides', type: 'boolean', default: false,
    file: USER, path: 'agentPushNotifEnabled', legacy: legacyGlobal('agentPushNotifEnabled'), scope: 'terminal',
    help: 'Let the model decide when something is worth a push notification.',
  },
  {
    key: 'respectGitignore', label: 'Respect .gitignore in file picker', type: 'boolean', default: true,
    file: GLOBAL, path: 'respectGitignore', scope: 'terminal',
    help: 'Hide ignored files from the @-mention file picker. Stored in ~/.claude.json.',
  },
  {
    key: 'copyFullResponse', label: 'Skip the /copy picker', type: 'boolean', default: false,
    file: GLOBAL, path: 'copyFullResponse', scope: 'terminal',
    help: '/copy copies the whole last response instead of offering a picker. Stored in ~/.claude.json.',
  },
  {
    key: 'copyOnSelect', label: 'Copy on select', type: 'boolean', default: true,
    file: GLOBAL, path: 'copyOnSelect', scope: 'terminal',
    help: 'In fullscreen mode, selecting text copies it. Stored in ~/.claude.json.',
  },
  {
    key: 'autoScrollEnabled', label: 'Auto-scroll', type: 'boolean', default: true,
    file: USER, path: 'autoScrollEnabled', legacy: legacyGlobal('autoScrollEnabled'), scope: 'terminal',
    help: 'In fullscreen mode, follow new output as it arrives.',
  },
  {
    key: 'defaultToAgentsView', label: 'Open agents view by default', type: 'boolean', default: false,
    file: GLOBAL, path: 'defaultToAgentsView', scope: 'terminal', env: ['CLAUDE_CODE_DISABLE_AGENT_VIEW'],
    help: 'Start in the background-agents view. Stored in ~/.claude.json.',
  },
  {
    key: 'leftArrowOpensAgents', label: 'Left arrow opens agents', type: 'boolean', default: true,
    file: GLOBAL, path: 'leftArrowOpensAgents', scope: 'terminal',
    help: 'Pressing the left arrow on an empty prompt opens the agents view. Stored in ~/.claude.json.',
  },
  {
    key: 'defaultView', label: 'Default view', type: 'select', default: null, defaultLabel: 'transcript', cliWritesTo: PROJECT_LOCAL,
    options: [opt('chat', 'Chat'), opt('transcript', 'Transcript')],
    file: USER, path: 'defaultView', scope: 'terminal',
    help: 'Which view a session opens in.',
  },
  {
    key: 'editorMode', label: 'Editor mode', type: 'select', default: 'normal',
    options: [opt('normal', 'Normal'), opt('vim', 'Vim')],
    file: USER, path: 'editorMode', legacy: legacyGlobal('editorMode'), scope: 'terminal',
    help: 'Key bindings in the prompt editor.',
  },
  {
    key: 'askUserQuestionTimeout', label: 'Question auto-continue timeout', type: 'select', default: 'never',
    options: [opt('60s', '1 minute'), opt('5m', '5 minutes'), opt('10m', '10 minutes'), opt('never', 'Never')],
    file: USER, path: 'askUserQuestionTimeout', scope: 'terminal',
    help: 'How long an AskUserQuestion prompt waits before the model continues with its own best guess.',
  },
  {
    key: 'externalEditorContext', label: 'Show last response in external editor', type: 'boolean', default: false,
    file: GLOBAL, path: 'externalEditorContext', scope: 'terminal',
    help: 'Include the last response when opening the prompt in an external editor. Stored in ~/.claude.json.',
  },
  {
    key: 'prStatusFooterEnabled', label: 'Show PR status footer', type: 'boolean', default: true,
    file: GLOBAL, path: 'prStatusFooterEnabled', scope: 'terminal',
    help: 'Show the current branch\'s pull-request status in the footer. Stored in ~/.claude.json.',
  },
  {
    key: 'diffTool', label: 'Diff tool', type: 'select', default: 'auto',
    options: [opt('auto', 'Auto'), opt('terminal', 'Terminal')],
    file: GLOBAL, path: 'diffTool', scope: 'terminal',
    help: 'Where diffs open when an IDE is connected. Stored in ~/.claude.json.',
  },
  {
    key: 'autoConnectIde', label: 'Auto-connect to IDE', type: 'boolean', default: false,
    file: GLOBAL, path: 'autoConnectIde', scope: 'terminal', env: ['CLAUDE_CODE_AUTO_CONNECT_IDE'],
    help: 'From an external terminal, connect to a running IDE automatically. Stored in ~/.claude.json.',
  },
  {
    key: 'autoInstallIdeExtension', label: 'Auto-install IDE extension', type: 'boolean', default: true,
    file: GLOBAL, path: 'autoInstallIdeExtension', scope: 'terminal',
    help: 'Install the IDE extension when a supported IDE is detected. Stored in ~/.claude.json.',
  },
  {
    key: 'claudeInChromeDefaultEnabled', label: 'Claude in Chrome enabled by default', type: 'boolean', default: false,
    file: GLOBAL, path: 'claudeInChromeDefaultEnabled', scope: 'terminal',
    help: 'Start sessions with the Chrome browser extension connected. Stored in ~/.claude.json.',
  },
  {
    key: 'feedbackDrafts', label: 'Claude-drafted feedback', type: 'select', default: 'notify',
    options: [opt('notify', 'Notify'), opt('quiet', 'Quiet'), opt('off', 'Off')],
    file: USER, path: 'feedbackDrafts', scope: 'terminal', env: ['CLAUDE_CODE_SEND_FEEDBACK'],
    help: 'Whether the model may draft product feedback for you, and whether it tells you.',
  },
  {
    key: 'remoteControlAtStartup', label: 'Enable Remote Control for all sessions', type: 'boolean', default: null, defaultLabel: 'platform default',
    file: USER, path: 'remoteControlAtStartup', legacy: legacyGlobal('remoteControlAtStartup'), scope: 'terminal',
    help: 'Start every terminal session with Remote Control on.',
  },
  {
    key: 'remoteHomeSettingsMode', label: "Use this machine's settings in cloud sessions", type: 'select', default: 'keep_local',
    options: [opt('keep_local', 'Keep local'), opt('forward', 'Forward')],
    file: GLOBAL, path: 'remoteHomeSettingsMode', scope: 'terminal',
    help: 'Whether a cloud session receives this machine\'s settings. Stored in ~/.claude.json.',
  },
]

export const CLAUDE_SETTINGS: EngineSettingsSchema = {
  files: [
    // CLAUDE_CONFIG_DIR relocates BOTH files: settings.json lives inside it, and
    // the CLI resolves .claude.json as join(CLAUDE_CONFIG_DIR || homedir, '.claude.json').
    {
      id: USER, path: '~/.claude/settings.json', format: 'json', label: 'user settings', homeEnv: { name: 'CLAUDE_CONFIG_DIR', replaces: '~/.claude' },
      // The settings.json family layers per project; ~/.claude.json does not.
      overlays: [PROJECT_LOCAL, PROJECT],
    },
    { id: GLOBAL, path: '~/.claude.json', format: 'json', label: 'global config', homeEnv: { name: 'CLAUDE_CONFIG_DIR', replaces: '~' } },
    // Project layers, consulted only when a session's working directory is known.
    // The shared file is the team's, committed with the repo: read, never written.
    { id: PROJECT, path: '<cwd>/.claude/settings.json', format: 'json', label: 'this project (shared)', scope: 'project', readOnly: true },
    { id: PROJECT_LOCAL, path: '<cwd>/.claude/settings.local.json', format: 'json', label: 'this project (local)', scope: 'project' },
  ],
  note: 'The same keys the claude CLI\'s /config screen edits, saved to ~/.claude/settings.json on the selected host (a few terminal preferences live in ~/.claude.json). Running sessions reload the file on their own; a project\'s .claude/settings.json can override any of these.',
  // Verified on 2.1.258: the CLI watches every settings layer, including a
  // project file created after it started, and reads these keys per request.
  appliesOn: 'next-turn',
  groups: [
    {
      id: 'sessions', title: 'Sessions',
      help: 'Read by claude -p, so these shape Walnut\'s sessions as well as the terminal. "Default" means the key is absent from the file and the CLI decides.',
      items: SESSION_ITEMS,
    },
    {
      id: 'updates', title: 'Updates',
      help: 'The CLI\'s self-updater. An environment variable such as DISABLE_AUTOUPDATER wins over both rows.',
      items: UPDATE_ITEMS,
    },
    {
      id: 'terminal', title: 'Terminal only',
      help: 'Read only by the interactive claude command in a terminal. Walnut sessions run without a terminal UI, so these do not change them.',
      items: TERMINAL_ITEMS,
    },
  ],
}
