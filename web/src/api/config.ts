import { apiGet, apiPut, apiPost } from './client';
import type { Config } from '@walnut/core';

export async function fetchConfig(): Promise<Config> {
  const res = await apiGet<{ config: Config }>('/api/config');
  return res.config;
}

export async function updateConfig(config: Partial<Config>): Promise<{ ok: boolean }> {
  return apiPut<{ ok: boolean }>('/api/config', config);
}

export interface TestConnectionResult {
  ok: boolean;
  error?: string;
  latencyMs?: number;
}

export async function testConnection(
  params: { bedrock_region?: string; bedrock_bearer_token?: string },
): Promise<TestConnectionResult> {
  return apiPost<TestConnectionResult>('/api/config/test-connection', params);
}
