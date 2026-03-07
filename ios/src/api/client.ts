/**
 * REST API client with Bearer auth.
 */

import { getServerUrl, getApiKey } from '../utils/secure-store'
import type { ChatHistoryResponse, Task } from './types'

async function getHeaders(): Promise<Record<string, string>> {
  const apiKey = await getApiKey()
  return {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  }
}

async function getBaseUrl(): Promise<string> {
  const url = await getServerUrl()
  if (!url) throw new Error('Server URL not configured')
  // Strip trailing slash
  return url.replace(/\/$/, '')
}

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const baseUrl = await getBaseUrl()
  const headers = await getHeaders()
  const resp = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { ...headers, ...options?.headers },
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`API ${resp.status}: ${body}`)
  }

  return resp.json() as Promise<T>
}

// ── Typed API methods ──

export async function fetchChatHistory(page = 1, pageSize = 50): Promise<ChatHistoryResponse> {
  return apiFetch(`/api/chat/history?page=${page}&pageSize=${pageSize}`)
}

export async function fetchTasks(): Promise<Task[]> {
  return apiFetch('/api/tasks')
}

export async function testConnection(serverUrl: string, apiKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const resp = await fetch(`${serverUrl.replace(/\/$/, '')}/api/system/health`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (resp.ok) return { ok: true }
    if (resp.status === 401 || resp.status === 403) return { ok: false, error: 'Invalid API key' }
    return { ok: false, error: `Server returned ${resp.status}` }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, error: 'Connection timed out' }
    }
    return { ok: false, error: err instanceof Error ? err.message : 'Connection failed' }
  }
}

export async function registerPushToken(token: string): Promise<void> {
  await apiFetch('/api/push/register', {
    method: 'POST',
    body: JSON.stringify({ token, platform: 'ios' }),
  })
}
