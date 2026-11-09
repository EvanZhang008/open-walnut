/**
 * The slash commands a Codex session answers itself (the direct client in
 * src/providers/codex-app-server/commands.ts and the codex-acp adapter take the same set), with
 * the words the composer's palette shows for each. No imports: the session worker bundle and
 * the engine registry both read it.
 */
export interface EngineSlashCommand {
  readonly name: string
  readonly description: string
}

export const CODEX_COMMANDS: ReadonlyArray<EngineSlashCommand> = [
  { name: 'plan', description: 'Turn plan mode on or off' },
  { name: 'compact', description: 'Summarize the conversation to free context' },
  { name: 'review', description: 'Review uncommitted changes, or follow the instructions given' },
  { name: 'review-branch', description: 'Review the changes against a base branch' },
  { name: 'review-commit', description: 'Review one commit' },
  { name: 'status', description: 'Show the model, modes and token use' },
  { name: 'mcp', description: 'List the MCP servers Codex has' },
  { name: 'skills', description: 'List the skills Codex finds here' },
  { name: 'goal', description: 'Set a goal Codex works toward (codex-acp transport only)' },
  { name: 'logout', description: 'How to sign Codex out on this host' },
]
