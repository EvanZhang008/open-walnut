import { apiGet } from './client';

export interface SlashCommandItem {
  name: string;
  description: string;
  source: 'skill' | 'walnut' | 'claude-root' | 'project' | 'built-in';
}

export async function fetchSlashCommands(cwd?: string): Promise<SlashCommandItem[]> {
  const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
  const res = await apiGet<{ items: SlashCommandItem[] }>(`/api/slash-commands${params}`);
  return res.items;
}
