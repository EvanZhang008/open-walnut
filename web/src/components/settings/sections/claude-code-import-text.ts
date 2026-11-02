/** Words for the "Import from Claude Code" preview (ClaudeCodeImportGroup.tsx); pure, so a unit test pins them. */
import type { ClaudeCodeImportPreview } from '@/api/claude-code-import';

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** A setting's value as the row shows it: "not set" for none, JSON for the rest. */
export function settingValueText(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'not set';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** One sentence: what comes over, counted. */
export function importSummaryLine(p: ClaudeCodeImportPreview, name: string): string {
  // A folder's detail starts with its count ("12 skills"); one with no count is one item.
  const skillCount = [...p.skills, ...p.commands].reduce((sum, i) => {
    const n = /^(\d+)/.exec(i.detail)?.[1];
    return sum + (n === undefined ? 1 : Number(n));
  }, 0);
  const credentials = p.credentials.kind === 'bedrock' ? 'Amazon Bedrock credentials'
    : p.credentials.kind === 'anthropic-key' ? 'an Anthropic API key'
      : p.credentials.kind === 'sign-in' ? 'no API credentials (Claude Code signs in with an account, which pi cannot share)'
        : 'no credentials';
  const parts = [
    credentials,
    plural(p.mcpServers.length, 'MCP server'),
    plural(skillCount, 'skill or command', 'skills and commands'),
    plural(p.instructions.length, 'instruction source'),
  ];
  return `${name} gets ${parts.join(', ')}. ${plural(p.cannotCarry.length, 'thing')} cannot carry over.`;
}
