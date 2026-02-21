import { apiGet, apiPut } from './client';
import type { Config } from '@walnut/core';

export async function fetchConfig(): Promise<Config> {
  const res = await apiGet<{ config: Config }>('/api/config');
  return res.config;
}

export async function updateConfig(config: Partial<Config>): Promise<{ ok: boolean }> {
  return apiPut<{ ok: boolean }>('/api/config', config);
}
