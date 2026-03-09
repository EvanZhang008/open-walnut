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
  envTokenHint?: string;
}

export async function testConnection(
  params: { bedrock_region?: string; bedrock_bearer_token?: string },
): Promise<TestConnectionResult> {
  return apiPost<TestConnectionResult>('/api/config/test-connection', params);
}

// ── Multi-provider API ──

export interface ProviderStatus {
  api: string;
  base_url?: string;
  status: 'ready' | 'no_key' | 'not_implemented';
  key_hint?: string;
  auto_detected: boolean;
}

export async function fetchProviders(): Promise<Record<string, ProviderStatus>> {
  const res = await apiGet<{ providers: Record<string, ProviderStatus> }>('/api/config/providers');
  return res.providers;
}

export async function testProvider(
  providerName: string,
  providerConfig?: { api: string; api_key?: string; base_url?: string; region?: string; bearer_token?: string },
): Promise<TestConnectionResult> {
  return apiPost<TestConnectionResult>('/api/config/test-provider', {
    provider_name: providerName,
    provider_config: providerConfig,
  });
}
