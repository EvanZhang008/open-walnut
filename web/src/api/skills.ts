import { apiGet } from './client';

export interface SkillInfo {
  dirName: string;
  name: string;
  description: string;
  source: 'workspace' | 'walnut' | 'claude' | 'plugin';
  location: string;
  content: string;
  metadata?: Record<string, unknown>;
  eligible: boolean;
  hasReferences: boolean;
}

/** `priority: 'low'` for the "/" palette's background load: nobody is looking at
 *  that list when it is fetched, so it must not hold a slot the page is waiting
 *  for (see the admission notes in ./client). */
export async function fetchSkills(opts?: { priority?: 'low'; onDispatch?: () => void }): Promise<SkillInfo[]> {
  const res = await apiGet<{ skills: SkillInfo[] }>('/api/skills', undefined, opts);
  return res.skills;
}
