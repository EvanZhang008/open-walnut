/**
 * "Import from Claude Code": the browser's client for GET/POST
 * /api/engines/:id/claude-code-import?host=.
 *
 * The shapes MIRROR src/core/agents/claude-code-import.ts (ImportPreview,
 * ImportResult); copied, not imported, because that module reads files with node
 * APIs. Every error body is `{ error: string }` written for a person: show
 * `error.message` as it is.
 */
import { apiGet, apiPost } from './client';

export interface ClaudeCodeImportItem { name: string; detail: string; source: string }
export interface ClaudeCodeCannotCarry { what: string; why: string; nearest: string }
export interface ClaudeCodeSettingChange { key: string; from: unknown; to: unknown }

export interface ClaudeCodeImportPreview {
  host: string;
  pi: { installed: boolean; version: string | null; needsUpdateForMcp: boolean };
  claudeCode: { found: boolean; settingsPath: string };
  agentDir: string;
  extension: { path: string; state: 'absent' | 'current' | 'outdated' | 'foreign'; version: number };
  settings: { path: string; changes: ClaudeCodeSettingChange[]; unreadable?: string };
  /**
   * Claude Code's gateway as a pi provider in models.json (null or absent: Claude Code names
   * none, or an older server). Only the entry named `provider` is Walnut's.
   */
  gateway?: null | {
    path: string;
    provider: string;
    from: 'ANTHROPIC_BEDROCK_BASE_URL' | 'ANTHROPIC_BASE_URL';
    api: 'bedrock-converse-stream' | 'anthropic-messages';
    baseUrl: string;
    modelIds: string[];
    change: 'add' | 'update' | 'none';
    unreadable?: string;
  };
  credentials: { kind: 'bedrock' | 'anthropic-key' | 'sign-in' | 'none'; vars: Array<{ name: string; value?: string }>; note: string };
  mcpServers: ClaudeCodeImportItem[];
  skippedMcpServers: ClaudeCodeImportItem[];
  skills: ClaudeCodeImportItem[];
  commands: ClaudeCodeImportItem[];
  instructions: ClaudeCodeImportItem[];
  cannotCarry: ClaudeCodeCannotCarry[];
  /** Files the preview could not read; its counts may be short. */
  warnings?: string[];
  upToDate: boolean;
}

export interface ClaudeCodeImportResult { written: string[]; preview: ClaudeCodeImportPreview }

/** Over the server's own 30 s deadline for a slow remote host. */
const TIMEOUT_MS = 35_000;

const path = (engine: string) => `/api/engines/${encodeURIComponent(engine)}/claude-code-import`;

export function fetchClaudeCodeImport(engine: string, host: string, signal?: AbortSignal): Promise<ClaudeCodeImportPreview> {
  return apiGet<ClaudeCodeImportPreview>(path(engine), { host }, { signal, timeoutMs: TIMEOUT_MS });
}

export function applyClaudeCodeImport(engine: string, host: string): Promise<ClaudeCodeImportResult> {
  return apiPost<ClaudeCodeImportResult>(`${path(engine)}?host=${encodeURIComponent(host)}`, {}, { timeoutMs: TIMEOUT_MS });
}
