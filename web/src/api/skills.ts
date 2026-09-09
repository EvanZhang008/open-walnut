import { apiGet, apiPost, apiPut, apiPatch, apiDelete } from './client';

export interface SkillInfo {
  dirName: string;
  name: string;
  description: string;
  source: 'workspace' | 'walnut' | 'claude' | 'plugin';
  location: string;
  content: string;
  metadata?: Record<string, unknown>;
  eligible: boolean;
  enabled: boolean;
  hasReferences: boolean;
}

export interface RefFile {
  name: string;
  size: number;
}

export async function fetchSkills(): Promise<SkillInfo[]> {
  const res = await apiGet<{ skills: SkillInfo[] }>('/api/skills');
  return res.skills;
}

export async function fetchSkill(dirName: string): Promise<SkillInfo> {
  const res = await apiGet<{ skill: SkillInfo }>(`/api/skills/${encodeURIComponent(dirName)}`);
  return res.skill;
}

export async function createSkillApi(input: {
  dirName: string;
  content: string;
  target?: 'claude' | 'walnut';
}): Promise<SkillInfo> {
  const res = await apiPost<{ skill: SkillInfo }>('/api/skills', input);
  return res.skill;
}

export async function updateSkillApi(dirName: string, content: string): Promise<SkillInfo> {
  const res = await apiPut<{ skill: SkillInfo }>(`/api/skills/${encodeURIComponent(dirName)}`, { content });
  return res.skill;
}

export async function toggleSkillApi(dirName: string, enabled: boolean): Promise<SkillInfo> {
  const res = await apiPatch<{ skill: SkillInfo }>(`/api/skills/${encodeURIComponent(dirName)}`, { enabled });
  return res.skill;
}

export async function deleteSkillApi(dirName: string): Promise<void> {
  await apiDelete(`/api/skills/${encodeURIComponent(dirName)}`);
}

export async function fetchReferences(dirName: string): Promise<RefFile[]> {
  const res = await apiGet<{ files: RefFile[] }>(`/api/skills/${encodeURIComponent(dirName)}/references`);
  return res.files;
}

export async function fetchReferenceContent(dirName: string, filename: string): Promise<string> {
  const res = await apiGet<{ content: string }>(
    `/api/skills/${encodeURIComponent(dirName)}/references/${encodeURIComponent(filename)}`,
  );
  return res.content;
}
