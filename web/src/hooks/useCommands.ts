import { useState, useEffect, useCallback } from 'react';
import * as commandsApi from '@/api/commands';
import { refreshMarkdownCommands } from '@/commands/markdown-bridge';
import type { CommandDef } from '@/api/commands';

interface UseCommandsReturn {
  commands: CommandDef[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
  create: (input: { name: string; content: string; description?: string }) => Promise<CommandDef>;
  update: (name: string, input: { content?: string; description?: string }) => Promise<CommandDef>;
  remove: (name: string) => Promise<void>;
}

export function useCommands(): UseCommandsReturn {
  const [commands, setCommands] = useState<CommandDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
    commandsApi.fetchCommands()
      .then(setCommands)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refetch(); }, [refetch]);

  const create = useCallback(async (input: { name: string; content: string; description?: string }) => {
    const cmd = await commandsApi.createCommandApi(input);
    refetch();
    refreshMarkdownCommands();
    return cmd;
  }, [refetch]);

  const update = useCallback(async (name: string, input: { content?: string; description?: string }) => {
    const cmd = await commandsApi.updateCommandApi(name, input);
    refetch();
    refreshMarkdownCommands();
    return cmd;
  }, [refetch]);

  const remove = useCallback(async (name: string) => {
    await commandsApi.deleteCommandApi(name);
    refetch();
    refreshMarkdownCommands();
  }, [refetch]);

  return { commands, loading, error, refetch, create, update, remove };
}
