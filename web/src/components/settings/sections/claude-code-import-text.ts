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
        : p.gateway ? 'Claude models' : 'no credentials';
  const parts = [
    p.gateway ? `${credentials} through your gateway at ${p.gateway.baseUrl}` : credentials,
    plural(p.mcpServers.length, 'MCP server'),
    plural(skillCount, 'skill or command', 'skills and commands'),
    plural(p.instructions.length, 'instruction source'),
  ];
  return `${name} gets ${parts.join(', ')}. ${plural(p.cannotCarry.length, 'thing')} cannot carry over.`;
}

/**
 * The gateway change in plain words: which provider pi's models.json gets, where it sends
 * requests, and which models it lists. Empty when Claude Code names no gateway.
 */
export function gatewayChangeLine(p: ClaudeCodeImportPreview, name: string): string {
  const g = p.gateway;
  if (!g) return '';
  const speaks = g.api === 'bedrock-converse-stream' ? 'Amazon Bedrock requests' : 'Anthropic API requests';
  const models = `${plural(g.modelIds.length, 'model')} (${g.modelIds.join(', ')})`;
  const head = g.change === 'add' ? `Adds the provider ${g.provider} to ${g.path}`
    : g.change === 'update' ? `Updates the provider ${g.provider} in ${g.path}`
      : `${g.path} already has the provider ${g.provider}`;
  return `${head}: it sends ${speaks} to your gateway at ${g.baseUrl}, as Claude Code does (${g.from}), with ${models}. ${name} starts on it, so no request goes to the cloud provider directly. Other providers in the file stay as they are.`;
}
