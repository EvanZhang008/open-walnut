import { useState, useEffect, useCallback } from 'react';
import * as skillsApi from '@/api/skills';
import type { SkillInfo } from '@/api/skills';
import { refreshSkillCommands } from '@/commands/skill-bridge';

interface UseSkillsReturn {
  skills: SkillInfo[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
  create: (input: { dirName: string; content: string; target?: 'claude' | 'walnut' }) => Promise<SkillInfo>;
  update: (dirName: string, content: string) => Promise<SkillInfo>;
  toggle: (dirName: string, enabled: boolean) => Promise<SkillInfo>;
  remove: (dirName: string) => Promise<void>;
}

export function useSkills(): UseSkillsReturn {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
    skillsApi.fetchSkills()
      .then(setSkills)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
    // Keep the "/" palette in sync with skill CRUD/toggles
    refreshSkillCommands();
  }, []);

  useEffect(() => { refetch(); }, [refetch]);

  const create = useCallback(async (input: { dirName: string; content: string; target?: 'claude' | 'walnut' }) => {
    const skill = await skillsApi.createSkillApi(input);
    refetch();
    return skill;
  }, [refetch]);

  const update = useCallback(async (dirName: string, content: string) => {
    const skill = await skillsApi.updateSkillApi(dirName, content);
    refetch();
    return skill;
  }, [refetch]);

  const toggle = useCallback(async (dirName: string, enabled: boolean) => {
    const skill = await skillsApi.toggleSkillApi(dirName, enabled);
    refetch();
    return skill;
  }, [refetch]);

  const remove = useCallback(async (dirName: string) => {
    await skillsApi.deleteSkillApi(dirName);
    refetch();
  }, [refetch]);

  return { skills, loading, error, refetch, create, update, toggle, remove };
}
