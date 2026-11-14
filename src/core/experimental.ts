/** Browser-safe registry. An experiment changes no default until it graduates. */
export const EXPERIMENTAL_FEATURES = [
  {
    id: 'leader_status_follows_workers',
    name: 'Leader status follows workers',
    description: 'Show Working while any worker works, Waiting while all open workers wait, and To read when every worker has finished. Requests that need you keep priority.',
    default: false,
  },
  {
    id: 'chat_reading_split',
    name: 'Reading split in session chats',
    description: 'Read a message on top while you ask below: "Send in split" in the Send menu, and "Read in split" on a message (its hover strip and its right-click menu). The pane on top keeps its place while the chat below goes on.',
    default: false,
  },
  {
    id: 'router_tidies_noise_mail',
    name: 'Mail router tidies noise',
    description: 'When a mail router judges an email to be noise, Walnut marks it read and moves it from the inbox to the archive. Nothing is deleted or sent, and its recorded reason says what was done.',
    default: false,
  },
  {
    id: 'isolated_workspace_by_default',
    name: 'Code tasks start in an isolated workspace',
    description: 'A new task whose folder is in a git repository, or one a workspace plugin claims, starts in its own workspace (a git worktree, or the plugin\'s), so tasks never edit the same checkout. A project\'s settings can turn it on or off for that project; a start can opt out with workspace: false.',
    default: false,
  },
] as const;

export type ExperimentalFeatureId = typeof EXPERIMENTAL_FEATURES[number]['id'];
/** Unknown boolean flags stay on disk for newer versions, but have no effect here. */
export type ExperimentalFlags = Record<string, boolean>;

export function experimentalEnabled(flags: ExperimentalFlags | undefined, id: ExperimentalFeatureId): boolean {
  const feature = EXPERIMENTAL_FEATURES.find((f) => f.id === id)!;
  return typeof flags?.[id] === 'boolean' ? flags[id] : feature.default;
}

export function validExperimentalFlags(value: unknown): value is ExperimentalFlags {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every((flag) => typeof flag === 'boolean');
}
