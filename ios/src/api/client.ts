/**
 * REST client for /api/v1 (docs/reference/api-v1.md). Bearer auth on every request.
 */

import { getBaseUrl, getToken, normalizeServerUrl } from './config'
import {
  ApiError,
  type ApiErrorBody,
  type ApiMessage,
  type ConversationSummary,
  type NoteContent,
  type NoteTreeNode,
  type NoteWriteResult,
  type ServerStatus,
} from './types'

const TIMEOUT_MS = 15_000

interface RequestOverrides {
  base?: string
  token?: string
}

async function request<T>(path: string, options: RequestInit = {}, over: RequestOverrides = {}): Promise<T> {
  const base = over.base ?? getBaseUrl()
  if (!base) throw new ApiError(0, 'not_configured', 'Server not configured')
  const token = over.token ?? getToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let resp: Response
  try {
    resp = await fetch(`${base}/api/v1${path}`, {
      ...options,
      headers: { ...headers, ...options.headers },
      signal: controller.signal,
    })
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    throw new ApiError(0, aborted ? 'timeout' : 'network', aborted ? 'Request timed out' : 'Network unreachable')
  } finally {
    clearTimeout(timer)
  }

  if (!resp.ok) {
    let body: ApiErrorBody | null = null
    try {
      body = (await resp.json()) as ApiErrorBody
    } catch {
      // Non-JSON error body (proxy page etc.)
    }
    const code = body?.error?.code ?? (resp.status === 401 ? 'unauthorized' : 'http_error')
    const message = body?.error?.message ?? `Server returned ${resp.status}`
    const { error: _e, ...extra } = body ?? {}
    throw new ApiError(resp.status, code, message, extra)
  }

  return (await resp.json()) as T
}

// ── Status / pairing ──

export function fetchStatus(): Promise<ServerStatus> {
  return request<ServerStatus>('/status')
}

/** Connection test against explicit URL + token (setup flow, before saving). */
export function testStatus(serverUrl: string, token?: string): Promise<ServerStatus> {
  return request<ServerStatus>('/status', {}, { base: normalizeServerUrl(serverUrl), token })
}

export function claimDevice(
  serverUrl: string,
  setupToken: string,
  deviceName: string
): Promise<{ deviceName: string; token: string }> {
  return request(
    '/setup/claim',
    { method: 'POST', body: JSON.stringify({ setupToken, deviceName }) },
    { base: normalizeServerUrl(serverUrl) }
  )
}

// ── Chat ──

export function fetchConversations(limit = 50): Promise<ConversationSummary[]> {
  return request<ConversationSummary[]>(`/conversations?limit=${limit}`)
}

export function createConversation(title?: string): Promise<{ id: string }> {
  return request('/conversations', {
    method: 'POST',
    body: JSON.stringify(title ? { title } : {}),
  })
}

export function fetchMessages(conversationId: string, limit = 50, before?: string): Promise<ApiMessage[]> {
  const cursor = before ? `&before=${encodeURIComponent(before)}` : ''
  return request<ApiMessage[]>(`/conversations/${encodeURIComponent(conversationId)}/messages?limit=${limit}${cursor}`)
}

export function sendMessage(conversationId: string, text: string): Promise<{ turnId: string }> {
  return request(`/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  })
}

// ── Notes ──

export async function fetchNotesTree(): Promise<NoteTreeNode[]> {
  const resp = await request<{ tree: NoteTreeNode[] }>('/notes')
  return resp.tree
}

/** Note paths may contain slashes — encode each segment, keep separators. */
function encodeNotePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

export function fetchNote(path: string): Promise<NoteContent> {
  return request<NoteContent>(`/notes/content/${encodeNotePath(path)}`)
}

export function saveNote(path: string, content: string, expectedHash?: string): Promise<NoteWriteResult> {
  return request<NoteWriteResult>(`/notes/content/${encodeNotePath(path)}`, {
    method: 'PUT',
    body: JSON.stringify(expectedHash ? { content, expectedHash } : { content }),
  })
}

export function createNote(path: string, content?: string): Promise<{ path: string } & NoteWriteResult> {
  return request('/notes', {
    method: 'POST',
    body: JSON.stringify(content != null ? { path, content } : { path }),
  })
}

export function deleteNote(path: string): Promise<{ ok: boolean }> {
  return request(`/notes/${encodeNotePath(path)}`, { method: 'DELETE' })
}
