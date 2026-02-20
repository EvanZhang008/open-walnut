export type ProcessStatus = 'running' | 'stopped';
export type WorkStatus = 'in_progress' | 'agent_complete' | 'await_human_action' | 'completed' | 'error';
export type SessionMode = 'bypass' | 'accept' | 'default' | 'plan';
export type SessionProvider = 'cli' | 'sdk' | 'embedded';

export interface SessionRecord {
  claudeSessionId: string;
  taskId: string;
  project: string;
  process_status: ProcessStatus;
  work_status: WorkStatus;
  mode: SessionMode;
  activity?: string;
  last_status_change?: string;
  startedAt: string;
  lastActiveAt: string;
  messageCount: number;
  cwd?: string;
  host?: string;
  /** Full hostname resolved from config.hosts (for display tooltips). */
  hostname?: string;
  title?: string;
  description?: string;
  slug?: string;
  planFile?: string;
  planCompleted?: boolean;
  fromPlanSessionId?: string;
  provider?: SessionProvider;
  human_note?: string;
}

export interface SessionTreeTask {
  taskId: string;
  taskTitle: string;
  taskStatus: string;
  taskPriority: string;
  taskStarred: boolean;
  sessions: SessionRecord[];
}

export interface SessionTreeProject {
  project: string;
  tasks: SessionTreeTask[];
}

export interface SessionTreeCategory {
  category: string;
  projects: SessionTreeProject[];
  directTasks: SessionTreeTask[];
}

export interface SessionTreeResponse {
  tree: SessionTreeCategory[];
  orphanSessions: SessionRecord[];
}

export interface SessionSummaryInfo {
  slug: string;
  project: string;
  summary: string;
  status: string;
  date: string;
  task_ids: string[];
}

export interface SessionHistoryTool {
  name: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  result?: string;
  planContent?: string;
  /** agentId linking to subagent JSONL */
  agentId?: string;
  /** Child messages from subagent JSONL (populated for Task tools) */
  childMessages?: SessionHistoryMessage[];
}

export interface SessionHistoryMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  tools?: SessionHistoryTool[];
  thinking?: string;
  model?: string;
  usage?: { input_tokens: number; output_tokens: number };
}
