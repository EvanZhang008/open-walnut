import { apiGet, apiPost, apiPut, apiDelete } from './client';

export interface CommandDef {
  name: string;
  description: string;
  content: string;
  source: 'builtin' | 'user';
}

export async function fetchCommands(): Promise<CommandDef[]> {
  const res = await apiGet<{ commands: CommandDef[] }>('/api/commands');
  return res.commands;
}

export async function createCommandApi(input: {
  name: string;
  content: string;
  description?: string;
}): Promise<CommandDef> {
  const res = await apiPost<{ command: CommandDef }>('/api/commands', input);
  return res.command;
}

export async function updateCommandApi(
  name: string,
  input: { content?: string; description?: string },
): Promise<CommandDef> {
  const res = await apiPut<{ command: CommandDef }>(`/api/commands/${name}`, input);
  return res.command;
}

export async function deleteCommandApi(name: string): Promise<void> {
  await apiDelete(`/api/commands/${name}`);
}
