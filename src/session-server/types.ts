/**
 * Session Server — WebSocket protocol types.
 *
 * Defines the command/response/event protocol between Walnut (client)
 * and the Session Server (wraps @anthropic-ai/claude-agent-sdk).
 *
 * Wire format (JSON over WebSocket):
 *   Command:  { type: 'cmd', id, method, params }   Walnut → Session Server
 *   Response: { type: 'res', id, ok, data?, error? } Session Server → Walnut
 *   Event:    { type: 'event', sessionId, name, data } Session Server → Walnut
 */

// ── Wire frames ──

export interface CommandFrame {
  type: 'cmd'
  id: string
  method: string
  params: unknown
}

export interface ResponseFrame {
  type: 'res'
  id: string
  ok: boolean
  data?: unknown
  error?: string
}

export interface EventFrame {
  type: 'event'
  sessionId: string
  name: SessionEventName
  data: unknown
}

export type WireFrame = CommandFrame | ResponseFrame | EventFrame

// ── Command methods & params ──

export interface SessionStartParams {
  message: string
  cwd?: string
  mode?: 'bypass' | 'accept' | 'default' | 'plan'
  systemPrompt?: string
  sessionId?: string  // Resume existing session
  permissionMode?: string
}

export interface SessionStartResult {
  sessionId: string
}

export interface SessionSendParams {
  sessionId: string
  message: string
}

export interface SessionInterruptParams {
  sessionId: string
}

export interface SessionSetModeParams {
  sessionId: string
  mode: 'bypass' | 'accept' | 'default' | 'plan'
}

export interface SessionStopParams {
  sessionId: string
}

export interface SessionRespondToQuestionParams {
  sessionId: string
  questionId: string
  answers: Record<string, string>
}

export interface SessionRespondToPermissionParams {
  sessionId: string
  requestId: string
  allow: boolean
  message?: string
}

export interface SessionListResult {
  sessions: SessionInfo[]
}

export interface SessionInfo {
  sessionId: string
  status: 'idle' | 'running' | 'error'
  cwd?: string
  mode?: string
}

export type CommandMethod =
  | 'session.start'
  | 'session.send'
  | 'session.interrupt'
  | 'session.setMode'
  | 'session.stop'
  | 'session.respondToQuestion'
  | 'session.respondToPermission'
  | 'session.list'
  | 'ping'

// ── Event types (Session Server → Walnut) ──

export type SessionEventName =
  | 'session:init'
  | 'session:text-delta'
  | 'session:tool-use'
  | 'session:tool-result'
  | 'session:ask-question'
  | 'session:permission-request'
  | 'session:plan-complete'
  | 'session:compact'
  | 'session:result'
  | 'session:error'
  | 'session:status'

// ── Event data payloads ──

export interface SessionInitData {
  sessionId: string
  model?: string
  cwd?: string
  tools?: string[]
}

export interface SessionTextDeltaData {
  sessionId: string
  delta: string
}

export interface SessionToolUseData {
  sessionId: string
  toolUseId: string
  name: string
  input: unknown
  parentToolUseId?: string  // Set for subagent tool calls
}

export interface SessionToolResultData {
  sessionId: string
  toolUseId: string
  result: string
}

export interface SessionAskQuestionData {
  sessionId: string
  questionId: string
  questions: AskQuestionItem[]
}

export interface AskQuestionItem {
  question: string
  header?: string
  options: Array<{ label: string; description?: string }>
  multiSelect?: boolean
}

export interface SessionPermissionRequestData {
  sessionId: string
  requestId: string
  toolName: string
  input: unknown
  suggestions?: string[]
}

export interface SessionPlanCompleteData {
  sessionId: string
  planContent: string
}

export interface SessionCompactData {
  sessionId: string
  trigger?: string
  preTokens?: number
}

export type SessionResultSubtype =
  | 'success'
  | 'error'
  | 'error_max_turns'
  | 'error_max_budget'
  | 'interrupted'

export interface SessionResultData {
  sessionId: string
  result: string
  subtype: SessionResultSubtype
  cost?: number
  duration?: number
  usage?: { input_tokens: number; output_tokens: number }
  modelUsage?: Record<string, { input_tokens: number; output_tokens: number }>
}

export interface SessionErrorData {
  sessionId: string
  error: string
}

export interface SessionStatusData {
  sessionId: string
  status: 'running' | 'idle' | 'error'
  activity?: string
}

// ── Mock scenario types (for testing) ──

/**
 * A scripted event that the mock session server emits during a scenario.
 * `delay` is milliseconds to wait before emitting (simulates real timing).
 * `waitForCommand` pauses emission until the specified command method arrives.
 */
export interface ScriptedEvent {
  name: SessionEventName
  data: unknown
  delay?: number
  /** Block event emission until a command of this method is received. */
  waitForCommand?: CommandMethod
}

/**
 * A test scenario defines what happens when session.start is called.
 * The mock server plays back the scripted events in order.
 */
export interface MockScenario {
  /** Unique name for the scenario (used in tests). */
  name: string
  /** Events emitted after session.start. */
  events: ScriptedEvent[]
  /** Additional events emitted after session.send (multi-turn). */
  sendEvents?: ScriptedEvent[]
}
